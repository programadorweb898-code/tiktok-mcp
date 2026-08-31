/**
 * Local quiz-video generation: burn a question and its answer options onto a
 * video as on-screen text overlays (ffmpeg `drawtext`), producing an MP4 of
 * trivia content ready for `tiktok_post`. This is the same flow real TikTok
 * quiz creators use — TikTok has no native interactive quiz configurable from
 * the web, so the question/options are rendered into the frames themselves.
 *
 * Windows paths trip ffmpeg's filtergraph parser: the `:` in a drive letter
 * (`C:`) collides with the `:` that separates key=value pairs. We sidestep that
 * by running ffmpeg with `cwd` set to the temp uploads dir and referencing every
 * file — video, font, text and output — by bare relative filename. Text content
 * goes through `textfile=` temp files, which also avoids the fragile CLI
 * escaping of inline `drawtext` text (`:`, `,`, `'`, `%`).
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { writeFile, copyFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMedia, type MediaInput } from "./media-mix.js";

const require = createRequire(import.meta.url);
const ffmpegStatic: string | null = require("ffmpeg-static") ?? null;

const execFileAsync = promisify(execFile);

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_OPTIONS = 4;
const MAX_TEXT_CHARS = {
  question: 140,
  option: 60,
};

export interface MakeQuizRequest {
  video: MediaInput;
  question: string;
  /** 2 to 4 answer options. */
  options: string[];
  /** Absolute path to a TTF font. Defaults to an auto-detected Windows font. */
  font?: string;
}

export interface MakeQuizResult {
  filePath: string;
  ffmpeg: string;
  question: string;
  options: string[];
  cleanup: () => void;
}

function pickDefaultFont(): string {
  const candidate = [
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ].find((c) => require("node:fs").existsSync(c));
  if (!candidate) throw new Error("No TTF font found; pass a `font` path explicitly");
  return candidate;
}

export async function makeQuizVideo(req: MakeQuizRequest): Promise<MakeQuizResult> {
  if (!ffmpegStatic) throw new Error("ffmpeg-static did not resolve a binary; cannot render a quiz video");
  const font = req.font || pickDefaultFont();

  const question = (req.question || "").trim();
  if (!question || question.length > MAX_TEXT_CHARS.question) {
    throw new Error(`question must be 1-${MAX_TEXT_CHARS.question} chars`);
  }
  const options = (req.options || []).map((o) => o.trim()).filter(Boolean);
  if (options.length < 2 || options.length > MAX_OPTIONS) {
    throw new Error(`options must contain between 2 and ${MAX_OPTIONS} answers`);
  }
  if (options.some((o) => o.length > MAX_TEXT_CHARS.option)) {
    throw new Error(`each option must be at most ${MAX_TEXT_CHARS.option} chars`);
  }

  const video = await resolveMedia(req.video, "video", MAX_VIDEO_BYTES);
  const fs = require("node:fs");

  // A dedicated working dir we run ffmpeg in (cwd), so every referenced path is
  // a bare relative filename and never trips the `:`-parsing on Windows.
  const workdir = await mkdtemp(join(tmpdir(), "tiktok-mcp-quiz-"));
  const outName = `${randomUUID()}.mp4`;
  const videoName = `${randomUUID()}${require("node:path").extname(video.filePath)}`;
  await copyFile(video.filePath, join(workdir, videoName));
  const fontName = `font-${randomUUID()}${require("node:path").extname(font)}`;
  await copyFile(font, join(workdir, fontName));

  const textFiles: string[] = [];
  const cleanup = () => {
    video.cleanup();
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  };
  const tfile = async (s: string): Promise<string> => {
    const name = `${randomUUID()}.txt`;
    await writeFile(join(workdir, name), s, "utf8");
    textFiles.push(name);
    return name;
  };

  try {
    const qFile = await tfile(question);
    const optFiles: string[] = [];
    for (const o of options) {
      const prefix = `${String.fromCharCode(65 + optFiles.length)}. ${o}`;
      optFiles.push(await tfile(prefix));
    }

    const qSize = "h*0.055";
    const oSize = "h*0.04";
    const q = [
      `drawtext=fontfile=${fontName}:textfile=${qFile}`,
      `fontsize=${qSize}`,
      `fontcolor=white`,
      `borderw=2:bordercolor=black@0.6`,
      `box=1:boxcolor=black@0.5:boxborderw=18`,
      `line_spacing=12`,
      `x=(w-text_w)/2`,
      `y=h*0.12`,
    ].join(":");

    const optChains: string[] = [q];
    const rowGap = `h*0.075`;
    const topY = `h*0.62`;
    for (let i = 0; i < optFiles.length; i++) {
      const yExpr = i === 0 ? topY : `(${topY}+${i}*${rowGap})`;
      const o = [
        `drawtext=fontfile=${fontName}:textfile=${optFiles[i]}`,
        `fontsize=${oSize}`,
        `fontcolor=white`,
        `borderw=2:bordercolor=black@0.6`,
        `box=1:boxcolor=black@0.4:boxborderw=12`,
        `x=w*0.08`,
        `y=${yExpr}`,
      ].join(":");
      optChains.push(o);
    }

    const filterGraph = `[0:v]${optChains.join(",")}[v]`;

    const args = [
      "-y",
      "-i", videoName,
      "-filter_complex", filterGraph,
      "-map", "[v]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-shortest",
      outName,
    ];

    await execFileAsync(ffmpegStatic, args, { cwd: workdir, maxBuffer: 50 * 1024 * 1024 });

    return {
      filePath: join(workdir, outName),
      ffmpeg: ffmpegStatic,
      question,
      options,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
