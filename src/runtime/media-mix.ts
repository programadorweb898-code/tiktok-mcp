/**
 * Local media mixing: merge a separate audio track into a video (MP4) using a
 * static ffmpeg binary shipped via `ffmpeg-static`. No external install needed
 * and the media never leaves this device. The produced file is a self-contained
 * MP4 that can be handed straight to `tiktok_post` (`video_path`).
 *
 * This module deliberately stays independent of TikTok: it only materialises
 * the two inputs and runs ffmpeg. The MCP layer decides how to expose it.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fetchSsrfSafe } from "./media-fetch.js";

const require = createRequire(import.meta.url);
const ffmpegStatic: string | null = require("ffmpeg-static") ?? null;

const execFileAsync = promisify(execFile);

const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // mirrors tiktok-operations.ts
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export interface MediaInput {
  path?: string;
  base64?: string;
  url?: string;
}

export interface MixMediaRequest {
  video: MediaInput;
  audio: MediaInput;
  /** True to keep the original video audio and layer the track on top; false to replace it (default). */
  mix?: boolean;
}

export interface MixMediaResult {
  filePath: string;
  ffmpeg: string;
  audio_track: "mixed" | "replaced";
  cleanup: () => void;
}

export async function resolveMedia(
  input: MediaInput,
  kind: "video" | "audio",
  maxBytes: number,
): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.path && !input.base64 && !input.url) {
    throw new Error(`${kind}_path, ${kind}_base64, or ${kind}_url is required`);
  }
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const dir = path.join(os.tmpdir(), "tiktok-mcp-uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (input.path) {
    const filePath = path.resolve(input.path);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${kind} path is not a file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`${kind} too large (${stat.size} bytes, max ${maxBytes})`);
    return { filePath, cleanup: () => {} };
  }

  let buf: Buffer;
  if (input.base64) {
    const dataUrlMatch = input.base64.match(/^data:(video|audio)\/\w+;base64,(.+)$/);
    buf = Buffer.from(dataUrlMatch ? dataUrlMatch[2] : input.base64, "base64");
  } else {
    const resp = await fetchSsrfSafe(input.url!, { timeoutMs: 60000, maxBytes });
    if (!resp.ok) throw new Error(`Failed to fetch ${kind}: HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    const want = kind === "video" ? /^video\// : /^(audio|video)\//;
    if (!want.test(ct)) throw new Error(`${kind} URL did not return a ${kind} (content-type: ${ct})`);
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }
  if (buf.length > maxBytes) throw new Error(`${kind} too large (${buf.length} bytes, max ${maxBytes})`);
  const ext = kind === "video" ? "mp4" : "audio";
  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buf);
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath); } catch {} } };
}

/**
 * Merge `audio` into `video`, returning a new MP4 path. By default the video's
 * original audio track is replaced; with `mix: true` the provided audio is
 * layered on top of (mixed with) the original audio.
 *
 * The output file is removed by calling `result.cleanup()` when done.
 */
export async function mixMedia(req: MixMediaRequest): Promise<MixMediaResult> {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static did not resolve a binary; cannot mix media");
  }
  const video = await resolveMedia(req.video, "video", MAX_VIDEO_BYTES);
  let audio: { filePath: string; cleanup: () => void } | null = null;
  const path = require("node:path");
  const out = path.join(require("node:os").tmpdir(), "tiktok-mcp-uploads", `${randomUUID()}.mp4`);
  const fs = require("node:fs");
  try {
    audio = await resolveMedia(req.audio, "audio", MAX_AUDIO_BYTES);
    const mix = !!req.mix;

    const args = [
      "-y",
      "-i", video.filePath,
      "-i", audio.filePath,
    ];
    if (mix) {
      args.push("-filter_complex", "[1:a]volume=1.0[a1];[0:a][a1]amix=inputs=2:duration=longest:dropout_transition=0[aout]");
      args.push("-map", "0:v", "-map", "[aout]");
    } else {
      args.push("-map", "0:v", "-map", "1:a");
    }
    args.push(
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      out,
    );

    await execFileAsync(ffmpegStatic, args, { maxBuffer: 50 * 1024 * 1024 });
    return {
      filePath: out,
      ffmpeg: ffmpegStatic,
      audio_track: mix ? "mixed" : "replaced",
      cleanup: () => {
        video.cleanup();
        audio?.cleanup();
        try { fs.unlinkSync(out); } catch {}
      },
    };
  } catch (error) {
    video.cleanup();
    audio?.cleanup();
    try { fs.unlinkSync(out); } catch {}
    throw error;
  }
}
