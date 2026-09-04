import type { LocalTikTokRuntime } from "./local-runtime.js";

/**
 * Declarative catalog of TikTok actions that an LLM orchestrator can dispatch.
 * Each entry describes the tool (name, summary, param schema) so the LLM can
 * choose what to call, plus a resolved handler that invokes the matching method
 * on the runtime. Kept separate from `server.ts` so the bot does not depend on
 * the MCP stdio layer.
 */

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description: string;
}

export interface CatalogTool {
  name: string;
  summary: string;
  params: ToolParam[];
  run: (runtime: LocalTikTokRuntime, args: Record<string, any>) => unknown | Promise<unknown>;
}

function p(name: string, type: ToolParam["type"], description: string, required = false): ToolParam {
  return { name, type, description, required };
}

export const TOOL_CATALOG: CatalogTool[] = [
  {
    name: "tiktok_accounts",
    summary: "List local TikTok accounts and their connection state.",
    params: [],
    run: (r, a) => r.accounts(a.tag),
  },
  {
    name: "tiktok_post",
    summary: "Publish or schedule a video. Pass exactly one of video_path/video_url/video_base64.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("caption", "string", "Video caption", true),
      p("video_path", "string", "Local MP4 path"),
      p("video_url", "string", "Public MP4 URL"),
      p("video_base64", "string", "Base64-encoded MP4"),
      p("schedule_at", "string", "ISO-8601 schedule time (~15 min to 10 days ahead)"),
    ],
    run: (r, a) => r.post(a),
  },
  {
    name: "tiktok_photo_post",
    summary: "Publish a photo carousel (1-35 images). Pass images as array of {image_path|image_url|image_base64}.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("caption", "string", "Caption for the carousel", true),
    ],
    run: (r, a) => r.photoPost(a),
  },
  {
    name: "tiktok_follow",
    summary: "Follow a user.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("target_user", "string", "Handle to follow", true),
    ],
    run: (r, a) => r.follow({ account_id: a.account_id, target_user: a.target_user }),
  },
  {
    name: "tiktok_unfollow",
    summary: "Stop following a user.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("target_user", "string", "Handle to unfollow", true),
    ],
    run: (r, a) => r.unfollow({ account_id: a.account_id, target_user: a.target_user }),
  },
  {
    name: "tiktok_like",
    summary: "Like a video (requires a /video/<id> permalink).",
    params: [
      p("account_id", "string", "Local account name", true),
      p("video_url", "string", "Video permalink", true),
    ],
    run: (r, a) => r.like({ account_id: a.account_id, video_url: a.video_url }),
  },
  {
    name: "tiktok_unlike",
    summary: "Remove the like from a video.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("video_url", "string", "Video permalink", true),
    ],
    run: (r, a) => r.unlike({ account_id: a.account_id, video_url: a.video_url }),
  },
  {
    name: "tiktok_comment",
    summary: "Post a comment on another user's video.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("video_url", "string", "Video permalink", true),
      p("comment", "string", "Comment text (max 2200)", true),
    ],
    run: (r, a) => r.comment({ account_id: a.account_id, video_url: a.video_url, comment: a.comment }),
  },
  {
    name: "tiktok_comment_reply",
    summary: "Reply to a comment found by its text in Comment Management.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("comment_text", "string", "Substring of the comment to reply to", true),
      p("reply", "string", "The reply text", true),
    ],
    run: (r, a) => r.commentReply({ account_id: a.account_id, comment_text: a.comment_text, reply: a.reply }),
  },
  {
    name: "tiktok_comments",
    summary: "Read comments posted on the account's videos.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("video_id", "string", "Filter by video id"),
      p("limit", "number", "Max comments to read"),
    ],
    run: (r, a) => r.comments({ account_id: a.account_id, video_id: a.video_id, limit: a.limit }),
  },
  {
    name: "tiktok_delete",
    summary: "Delete one of the account's videos.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("video_url", "string", "Video permalink to delete", true),
    ],
    run: (r, a) => r.delete({ account_id: a.account_id, video_url: a.video_url }),
  },
  {
    name: "tiktok_profile",
    summary: "Update the display name and/or bio.",
    params: [
      p("account_id", "string", "Local account name", true),
      p("display_name", "string", "New display name"),
      p("bio", "string", "New bio"),
    ],
    run: (r, a) => r.profile({ account_id: a.account_id, display_name: a.display_name, bio: a.bio }),
  },
  {
    name: "tiktok_profile_analytics",
    summary: "Read the account's own public profile header (followers, likes, videos totals).",
    params: [p("account_id", "string", "Local account name", true)],
    run: (r, a) => r.profileAnalytics({ account_id: a.account_id }),
  },
  {
    name: "tiktok_studio_analytics",
    summary: "Read TikTok Studio analytics overview (views, watch time, followers, etc.).",
    params: [p("account_id", "string", "Local account name", true)],
    run: (r, a) => r.studioAnalytics({ account_id: a.account_id }),
  },
  {
    name: "tiktok_series",
    summary: "Read analytics stored on this device or growth over a time window.",
    params: [p("account_id", "string", "Local account name", true)],
    run: (r, a) => r.series({ account_id: a.account_id, video_id: a.video_id, hours: a.hours }),
  },
  {
    name: "tiktok_scheduled",
    summary: "List native scheduled TikTok posts.",
    params: [p("account_id", "string", "Local account name")],
    run: (r, a) => r.scheduled({ account_id: a.account_id, include_done: a.include_done }),
  },
  {
    name: "tiktok_operation_status",
    summary: "Check the status of an asynchronous action (post, follow, like, comment...).",
    params: [p("operation_id", "string", "Operation id to poll", true)],
    run: (r, a) => r.operationStatus(a.operation_id),
  },
  {
    name: "tiktok_search",
    summary: "Search TikTok (videos, users, hashtags) and return observed results.",
    params: [
      p("query", "string", "Search query", true),
      p("type", "string", "video|user|hashtag"),
      p("account_id", "string", "Optional account to search within its session"),
      p("limit", "number", "Max results"),
    ],
    run: (r, a) => r.search(a as { account_id?: string; query: string; type?: "video" | "user" | "hashtag"; country?: string; limit?: number }),
  },
  {
    name: "tiktok_trending",
    summary: "Read the personalized For You feed.",
    params: [p("account_id", "string", "Optional account"), p("limit", "number", "Max results")],
    run: (r, a) => r.trending({ account_id: a.account_id, limit: a.limit }),
  },
];

export function catalogByName(): Map<string, CatalogTool> {
  return new Map(TOOL_CATALOG.map((t) => [t.name, t]));
}

export function catalogForPrompt(): string {
  return TOOL_CATALOG.map((t) => {
    const params = t.params.map((x) => `${x.name}${x.required ? "*" : ""}:${x.type} — ${x.description}`).join("\n    ");
    return `- ${t.name}: ${t.summary}\n    ${params || "(no params)"}`;
  }).join("\n");
}
