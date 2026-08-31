/**
 * Local duet/stitch composition: build a video that reacts to another user's
 * clip the way TikTok's mobile "Duet"/"Stitch" editor would, using a static
 * ffmpeg binary shipped via `ffmpeg-static`. The produced MP4 is then handed to
 * `tiktok_post` (`video_path`).
 *
 * TikTok's native Duet/Stitch edit flow only exists in the mobile app, not on
 * the desktop web (which this MCP automates). The real, verified approach on a
 * PC is to compose the equivalent media locally (split-screen for a duet, a
 * leading clip of the original followed by your take for a stitch) and upload
 * the result as a normal video — exactly what this module produces.
 *
 * Like `media-quiz.ts`, ffmpeg runs with `cwd` set to a dedicated workdir and
 * every file is referenced by bare relative filename, because Windows drive
 * letters (`C:`) trip ffmpeg's `:`-based filtergraph parsing.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { copyFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMedia, type MediaInput } from "./media-mix.js";

const require = createRequire(import.meta.url);
const ffmpegStatic: string | null = require("ffmpeg-static") ?? null;

const execFileAsync = promisify(execFile);

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type DuetMode = "duet" | "stitch";

export interface MakeDuetRequest {
  /** The other user's video you are reacting to. */
  base_video: MediaInput;
  /** Your own clip (right/top panel in a duet, the follow-on part in a stitch). */
  your_video: MediaInput;
  /** "duet" (split screen, side by side) or "stitch" (leading clip then your take). */
  mode?: DuetMode;
  /** Seconds of the base video to keep when mode is "stitch" (default 5). */
  stitch_seconds?: number;
}

export interface MakeDuetResult {
  filePath: string;
  ffmpeg: string;
  mode: DuetMode;
  cleanup: () => void;
}

/** Returns whether the given media file has an audio stream (probes via ffmpeg). */
async function hasAudio(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(ffmpegStatic!, ["-hide_banner", "-i", filePath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return /Stream #\d+:\d+[^\n]*?Audio:/.test(stdout);
  } catch (error) {
    // ffmpeg prints the stream table on stderr and exits non-zero for probe-only runs.
    const msg = (error as { stderr?: string; stdout?: string }).stderr ?? (error as { stdout?: string }).stdout ?? "";
    return /Stream #\d+:\d+[^\n]*?Audio:/.test(msg);
  }
}

export async function makeDuetVideo(req: MakeDuetRequest): Promise<MakeDuetResult> {
  if (!ffmpegStatic) throw new Error("ffmpeg-static did not resolve a binary; cannot compose a duet/stitch");
  const mode: DuetMode = req.mode === "stitch" ? "stitch" : "duet";
  const stitchSeconds = Math.max(1, Math.min(30, Math.round(req.stitch_seconds ?? 5)));

  const base = await resolveMedia(req.base_video, "video", MAX_VIDEO_BYTES);
  const yours = await resolveMedia(req.your_video, "video", MAX_VIDEO_BYTES);
  const fs = require("node:fs");
  const path = require("node:path");

  const workdir = await mkdtemp(join(tmpdir(), "tiktok-mcp-duet-"));
  const outName = `${randomUUID()}.mp4`;
  const baseName = `base-${randomUUID()}${path.extname(base.filePath)}`;
  const yourName = `your-${randomUUID()}${path.extname(yours.filePath)}`;
  await copyFile(base.filePath, join(workdir, baseName));
  await copyFile(yours.filePath, join(workdir, yourName));

  const cleanup = () => {
    base.cleanup();
    yours.cleanup();
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  };

  try {
    const baseAudio = await hasAudio(join(workdir, baseName));
    const yourAudio = await hasAudio(join(workdir, yourName));

    let args: string[];
    if (mode === "stitch") {
      // Leading `stitchSeconds`s of the base, then the full your-clip.
      // Stitch always needs a single continuous audio track, so we guarantee one
      // by concatenating the clips' audio (or silence when a clip lacks audio).
      const tail = `[0:v]trim=duration=${stitchSeconds},setpts=PTS-STARTPTS,scale=w=-2:h=ih,setsar=1,fps=30[v0];` +
        `[1:v]setpts=PTS-STARTPTS,scale=w=-2:h=ih,setsar=1,fps=30[v1];` +
        `[v0][v1]concat=n=2:v=1:a=0[v]`;
      const audioChain = buildJoinAudio("stitch", baseAudio, yourAudio, stitchSeconds);
      const filter = audioChain ? `${tail};${audioChain}` : tail;
      args = [
        "-y",
        "-i", baseName,
        "-i", yourName,
        "-filter_complex", filter,
        "-map", "[v]",
        ...(audioChain ? ["-map", "[a]"] : ["-an"]),
        "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
        ...(audioChain ? ["-c:a", "aac"] : []),
        "-movflags", "+faststart",
        "-shortest",
        outName,
      ];
    } else {
      // Split screen: base on a panel, your clip on the other, audio mixed. Both
      // are normalised to the first input's height and a 9:16 frame for a clean
      // hstack.
      const tail = `[0:v]scale=w=-2:h=ih,setsar=1[f0];` +
        `[1:v]scale=w=-2:h=ih${""}:force_original_aspect_ratio=increase,crop=w=ih*9/16:h=ih,setsar=1[f1];` +
        `[f0][f1]hstack=shortest=1[v]`;
      const audioChain = buildJoinAudio("duet", baseAudio, yourAudio, 0);
      const filter = audioChain ? `${tail};${audioChain}` : tail;
      args = [
        "-y",
        "-i", baseName,
        "-i", yourName,
        "-filter_complex", filter,
        "-map", "[v]",
        ...(audioChain ? ["-map", "[a]"] : ["-an"]),
        "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
        ...(audioChain ? ["-c:a", "aac"] : []),
        "-movflags", "+faststart",
        outName,
      ];
    }

    await execFileAsync(ffmpegStatic, args, { cwd: workdir, maxBuffer: 50 * 1024 * 1024 });

    return {
      filePath: join(workdir, outName),
      ffmpeg: ffmpegStatic,
      mode,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Builds an audio filtergraph chain that yields a single `[a]` output, handling
 * clips that have no audio track by substituting silence. For "duet" the two
 * tracks are mixed together; for "stitch" they are concatenated (each clip's
 * audio trimmed to its own length). Returns null when neither clip has audio.
 */
function buildJoinAudio(
  mode: DuetMode,
  baseAudio: boolean,
  yourAudio: boolean,
  stitchSeconds: number,
): string | null {
  if (!baseAudio && !yourAudio) return null;

  const parts: string[] = [];

  // Source for clip 0: its own audio, or silence trimmed to the stitch window.
  if (baseAudio) {
    parts.push(mode === "stitch"
      ? `[0:a]atrim=duration=${stitchSeconds},asetpts=PTS-STARTPTS,aresample=44100[a0]`
      : `[0:a]aresample=44100,asetpts=PTS-STARTPTS[a0]`);
  } else {
    parts.push(mode === "stitch"
      ? `anullsrc=r=44100:cl=stereo:duration=${stitchSeconds},asetpts=PTS-STARTPTS[a0]`
      : `anullsrc=r=44100:cl=stereo[a0]`);
  }

  // Source for clip 1: its own audio (full length). A generous silent filler for
  // the no-audio case is trimmed to the clip length by `-shortest`.
  if (yourAudio) {
    parts.push(`[1:a]aresample=44100,asetpts=PTS-STARTPTS[a1]`);
  } else {
    parts.push(mode === "stitch"
      ? `anullsrc=r=44100:cl=stereo:duration=600,asetpts=PTS-STARTPTS[a1]`
      : `anullsrc=r=44100:cl=stereo[a1]`);
  }

  if (mode === "duet") {
    parts.push(`[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=0[a]`);
  } else {
    parts.push(`[a0][a1]concat=n=2:v=0:a=1[a]`);
  }
  return parts.join(";");
}
