import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LocalTikTokRuntime } from "./runtime/local-runtime.js";

type Shape = Record<string, z.ZodTypeAny>;
type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> };

const ACCOUNT_ID = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/)
  .describe("Local account name using letters, numbers, dots, dashes, or underscores");

function requireOne(args: Record<string, unknown>, fields: string[]): void {
  const supplied = fields.filter((field) => typeof args[field] === "string" && (args[field] as string).length > 0);
  if (supplied.length !== 1) throw new Error(`Pass exactly one of ${fields.join(", ")}`);
}

function oneOf(args: Record<string, unknown>, fields: string[]): { [k: string]: string } {
  const field = fields.find((f) => typeof args[f] === "string" && (args[f] as string).length > 0)!;
  return { [field.replace(/^(video|audio)_/, "")]: String(args[field]) };
}

function result(value: unknown): ToolResult {
  const structured = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: true, message }) }] };
}

function addTool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: Shape },
  handler: (args: Record<string, any>) => unknown | Promise<unknown>,
): void {
  (server.registerTool as any)(name, config, async (args: Record<string, any>) => {
    try { return result(await handler(args)); } catch (error) { return failure(error); }
  });
}

export type TikTokServerOptions = { runtime?: LocalTikTokRuntime };

export function createTikTokServer(options: TikTokServerOptions = {}): McpServer {
  const runtime = options.runtime || new LocalTikTokRuntime();
  const server = new McpServer(
    { name: "ai.palmyr/tiktok", title: "TikTok MCP", version: "0.3.1" },
    { instructions: "Self-hosted TikTok automation. Browser profiles, actions, media, and analytics stay on this device. Connect uses a free ephemeral QR relay so a remote human can scan a shareable link; there are no API keys or payments." },
  );

  addTool(server, "tiktok_connect", {
    title: "Connect a TikTok account",
    description: "Create a shareable TikTok QR login link. Send connect_url to the human and poll tiktok_connect_status while they scan it.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      country: z.string().length(2).optional().describe("ISO-2 country of the VPS/browser exit; keep it close to the scanning human and the account's usual region"),
      tag: z.string().max(64).optional().describe("Optional account group or niche"),
      browser_path: z.string().optional().describe("Optional Chrome/Edge/Brave executable path"),
      timeout_seconds: z.number().int().min(30).max(900).optional(),
    },
  }, (args) => runtime.connect(args as any));

  addTool(server, "tiktok_connect_status", {
    title: "Check TikTok connection",
    description: "Check whether the local browser login completed.",
    inputSchema: { token: z.string().min(1) },
  }, ({ token }) => runtime.connectStatus(token));

  addTool(server, "tiktok_accounts", {
    title: "List TikTok accounts",
    description: "List local persistent TikTok profiles and their session state.",
    inputSchema: { tag: z.string().optional() },
  }, ({ tag }) => runtime.accounts(tag));

  addTool(server, "tiktok_post", {
    title: "Post or schedule a TikTok video",
    description: "Publish a local video through the connected browser profile, or use TikTok's native scheduler.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      caption: z.string().min(1).max(2200),
      video_path: z.string().optional().describe("Local MP4 path; the file stays on this device"),
      video_url: z.string().url().optional(),
      video_base64: z.string().optional(),
      privacy: z.number().int().min(0).max(2).optional(),
      allow_comments: z.boolean().optional(),
      allow_duet: z.boolean().optional(),
      allow_stitch: z.boolean().optional(),
      schedule_at: z.string().optional().describe("ISO-8601 time, roughly 15 minutes to 10 days ahead"),
    },
  }, (args) => {
    requireOne(args, ["video_path", "video_url", "video_base64"]);
    return runtime.post(args);
  });

  addTool(server, "tiktok_mix_media", {
    title: "Mix a video with a separate audio track",
    description: "Merge an audio file into a video locally with ffmpeg (no upload). Returns the mixed MP4 path to feed to tiktok_post via video_path.",
    inputSchema: {
      video_path: z.string().optional().describe("Local video file (MP4 path)"),
      video_url: z.string().url().optional(),
      video_base64: z.string().optional(),
      audio_path: z.string().optional().describe("Local audio file path"),
      audio_url: z.string().url().optional(),
      audio_base64: z.string().optional(),
      mix: z.boolean().optional().describe("Lay the audio on top of the original video audio (true) or replace it (false, default)"),
    },
  }, (args) => {
    requireOne(args, ["video_path", "video_url", "video_base64"]);
    requireOne(args, ["audio_path", "audio_url", "audio_base64"]);
    return runtime.mix({
      video: oneOf(args, ["video_path", "video_url", "video_base64"]),
      audio: oneOf(args, ["audio_path", "audio_url", "audio_base64"]),
      mix: args.mix,
    });
  });

  addTool(server, "tiktok_make_quiz", {
    title: "Make a quiz/trivia video",
    description: "Burn a question and its answer options onto a video as on-screen text (ffmpeg) and return the rendered MP4 to feed to tiktok_post.",
    inputSchema: {
      video_path: z.string().optional().describe("Local video file (MP4 path)"),
      video_url: z.string().url().optional(),
      video_base64: z.string().optional(),
      question: z.string().min(1).max(140),
      options: z.array(z.string().min(1).max(60)).min(2).max(4).describe("2 to 4 answer options"),
      font: z.string().optional().describe("Absolute path to a TTF font (auto-detected if omitted)"),
    },
  }, (args) => {
    requireOne(args, ["video_path", "video_url", "video_base64"]);
    return runtime.makeQuiz({
      video: oneOf(args, ["video_path", "video_url", "video_base64"]),
      question: args.question,
      options: args.options,
      font: args.font,
    });
  });

  addTool(server, "tiktok_make_duet", {
    title: "Compose a duet or stitch video",
    description: "Build a duet (split screen) or stitch (leading clip + your take) MP4 locally with ffmpeg from another user's video and your clip, then feed the output_path to tiktok_post. TikTok's native Duet/Stitch editor is mobile-only, so this creates the equivalent composed video.",
    inputSchema: {
      base_video_path: z.string().optional().describe("The other user's video (local MP4 path)"),
      base_video_url: z.string().url().optional(),
      base_video_base64: z.string().optional(),
      your_video_path: z.string().optional().describe("Your own clip (local MP4 path)"),
      your_video_url: z.string().url().optional(),
      your_video_base64: z.string().optional(),
      mode: z.enum(["duet", "stitch"]).optional().describe("duet = side-by-side split screen (default); stitch = leading seconds of the base then your clip"),
      stitch_seconds: z.number().int().min(1).max(30).optional().describe("Seconds of the base video kept when mode is stitch (default 5)"),
    },
  }, (args) => {
    requireOne(args, ["base_video_path", "base_video_url", "base_video_base64"]);
    requireOne(args, ["your_video_path", "your_video_url", "your_video_base64"]);
    return runtime.makeDuet({
      base_video: oneOf(args, ["base_video_path", "base_video_url", "base_video_base64"]),
      your_video: oneOf(args, ["your_video_path", "your_video_url", "your_video_base64"]),
      mode: args.mode,
      stitch_seconds: args.stitch_seconds,
    });
  });

  addTool(server, "tiktok_operation_status", {
    title: "Check TikTok operation",
    description: "Poll a local browser job until done or failed.",
    inputSchema: { operation_id: z.string().min(1) },
  }, ({ operation_id }) => runtime.operationStatus(operation_id));

  addTool(server, "tiktok_follow", {
    title: "Follow a TikTok user",
    description: "Follow a user from a connected local profile.",
    inputSchema: { account_id: ACCOUNT_ID, target_user: z.string().min(1) },
  }, (args) => runtime.follow(args as any));

  addTool(server, "tiktok_like", {
    title: "Like a TikTok video",
    description: "Like a video from a connected local profile.",
    inputSchema: { account_id: ACCOUNT_ID, video_url: z.string().url() },
  }, (args) => runtime.like(args as any));

  addTool(server, "tiktok_comment", {
    title: "Comment on a TikTok video",
    description: "Post a comment on another user's video from a connected local profile. Verified by read-back of the published comment.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      video_url: z.string().url().describe("Full TikTok video URL, e.g. https://www.tiktok.com/@handle/video/1234567890"),
      comment: z.string().min(1).max(2200).describe("The comment text to publish"),
    },
  }, (args) => runtime.comment(args as any));

  addTool(server, "tiktok_comment_reply", {
    title: "Reply to a comment",
    description: "Reply to a comment in TikTok Studio's web Comment Management. Locates the comment by its text and posts a text reply, verified by read-back of the posted reply.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      comment_text: z.string().min(1).describe("Substring of the comment to reply to"),
      reply: z.string().min(1).max(2200).describe("The reply text to post"),
    },
  }, (args) => runtime.commentReply(args as any));

  addTool(server, "tiktok_pin_video", {
    title: "Pin or unpin a video on the profile",
    description: "Pin (or unpin) one of your own videos to the top of your TikTok profile via the video's action menu. Verified by reading the profile back for the 'Pinned' badge.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      video_url: z.string().describe("Full TikTok URL of your own video, e.g. https://www.tiktok.com/@handle/video/1234567890"),
      action: z.enum(["pin", "unpin"]).describe("pin to the top of the profile, or remove the pin"),
    },
  }, (args) => runtime.pinVideo(args as any));

  addTool(server, "tiktok_playlist_manage", {
    title: "Create, or add/remove a post from, a playlist",
    description: "Create a playlist, or add/remove one of your public posts from a playlist, on your profile. Requires 10k+ followers (TikTok's playlist eligibility). Verified by reading the page state back.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      action: z.enum(["create", "add", "remove"]).describe("create a playlist, or add/remove a public post to/from one"),
      name: z.string().min(1).describe("Playlist name (create) or target playlist name (add/remove)"),
      video_url: z.string().url().optional().describe("Full TikTok URL of the public post — required for add/remove"),
    },
  }, (args) => runtime.playlistManage(args as any));

  addTool(server, "tiktok_search", {
    title: "Search TikTok (videos, users, hashtags)",
    description: "Search TikTok web and return the observed results with real links and visible snippets. Read-only: never fabricates results; returns an empty list when nothing is found. account_id optional (anonymous session otherwise).",
    inputSchema: {
      account_id: ACCOUNT_ID.optional().describe("Optional local account to search within its session; anonymous otherwise"),
      query: z.string().min(1),
      type: z.enum(["video", "user", "hashtag"]).optional().describe("Defaults to video"),
      country: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Defaults to 20"),
    },
  }, (args) => runtime.search(args as any));

  addTool(server, "tiktok_trending", {
    title: "Read TikTok For You feed (trending for you)",
    description: "Read the TikTok 'For You' feed and return the videos TikTok shows there with real links and visible captions. Read-only, observed-only output. Note: the feed is personalized and rotates — this is 'trending for you' suggestions, not a canonical global trending ranking. account_id optional (anonymous otherwise).",
    inputSchema: {
      account_id: ACCOUNT_ID.optional().describe("Optional local account to read the feed within its session; anonymous otherwise"),
      country: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Defaults to 20"),
    },
  }, (args) => runtime.trending(args as any));

  addTool(server, "tiktok_delete", {
    title: "Delete a TikTok video",
    description: "Delete one of the connected account's videos.",
    inputSchema: { account_id: ACCOUNT_ID, video_url: z.string().url() },
  }, (args) => runtime.delete(args as any));

  addTool(server, "tiktok_update_profile", {
    title: "Update a TikTok profile",
    description: "Update the display name, bio, or both through the local browser.",
    inputSchema: { account_id: ACCOUNT_ID, display_name: z.string().max(30).optional(), bio: z.string().max(80).optional() },
  }, (args) => {
    if (args.display_name === undefined && args.bio === undefined) throw new Error("Pass display_name, bio, or both");
    return runtime.profile(args as any);
  });

  addTool(server, "tiktok_update_avatar", {
    title: "Update a TikTok avatar",
    description: "Set the profile image using a local path, URL, or base64 input.",
    inputSchema: {
      account_id: ACCOUNT_ID,
      image_path: z.string().optional().describe("Local image path; the file stays on this device"),
      image_url: z.string().url().optional(),
      image_base64: z.string().optional(),
    },
  }, (args) => {
    requireOne(args, ["image_path", "image_url", "image_base64"]);
    return runtime.avatar(args);
  });

  addTool(server, "tiktok_analytics", {
    title: "Fetch TikTok analytics",
    description: "Scrape post metrics locally and save a time-series sample.",
    inputSchema: { account_id: ACCOUNT_ID },
  }, (args) => runtime.analytics(args as any));

  addTool(server, "tiktok_monetization_status", {
    title: "Read TikTok monetization status",
    description: "Read the account's monetization status/performance from TikTok Studio web. Enrollment in a monetization program requires strict eligibility (10k+ followers, 100k views/30d, account 30+ days, 18+); this only reads the status page and never fakes eligibility.",
    inputSchema: { account_id: ACCOUNT_ID },
  }, (args) => runtime.monetization(args as any));

  addTool(server, "tiktok_series", {
    title: "Read TikTok performance history",
    description: "Read analytics stored on this device or calculate growth over a time window.",
    inputSchema: { account_id: ACCOUNT_ID, video_id: z.string().optional(), hours: z.number().positive().optional() },
  }, (args) => runtime.series(args as any));

  addTool(server, "tiktok_hooks", {
    title: "Analyze TikTok hooks",
    description: "Compare caption openings against mature posts stored locally.",
    inputSchema: {
      account_id: z.string().optional(), tag: z.string().optional(), niche: z.string().optional(),
      caption: z.string().optional(), maturity_days: z.number().positive().optional(), recency_days: z.number().positive().optional(),
    },
  }, (args) => runtime.hooks(args));

  addTool(server, "tiktok_niches", {
    title: "List TikTok niches",
    description: "List suggested account tags for local hook analysis.",
    inputSchema: {},
  }, () => runtime.niches());

  addTool(server, "tiktok_scheduled", {
    title: "List scheduled TikTok posts",
    description: "List native scheduled posts recorded by this local MCP.",
    inputSchema: { account_id: z.string().optional(), include_done: z.boolean().optional() },
  }, (args) => runtime.scheduled(args));

  addTool(server, "tiktok_cancel_scheduled", {
    title: "Cancel a scheduled TikTok post",
    description: "Cancel a native scheduled post by deleting its held video.",
    inputSchema: { operation_id: z.string().min(1), account_id: ACCOUNT_ID },
  }, ({ operation_id, account_id }) => runtime.cancelScheduled(operation_id, account_id));

  return server;
}
