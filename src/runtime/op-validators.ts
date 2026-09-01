/**
 * Pure, side-effect-free OH Vercel validators and error mapping shared by the
 * TikTok operations. Kept separate from the browser operations so the decisions
 * that gate an op can be unit-tested without booting Chromium or holding a
 * session.
 */

/** Normalized handles the TikTok UI accepts: 2–24 chars of [A-Za-z0-9._]. */
const HANDLE_RE = /^[A-Za-z0-9._]{2,24}$/;

/**
 * A full video permalink, e.g. https://www.tiktok.com/@handle/video/123..
 * Matches both the `www.` and the no-subdomain form.
 */
const VIDEO_PERMALINK_RE = /^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+/;

/**
 * Strip surrounding whitespace and a leading "@" to get a bare handle. Trims
 * BEFORE stripping the "@" so input like "  @brand  " normalizes to "brand"
 * (the previous trim-after-@ order left a stray "@" when there was leading
 * whitespace, which then made the handle invalid or produced a wrong URL).
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

/**
 * Whether a normalized (bare) handle is structurally valid for a TikTok profile
 * URL. Pass the result of `normalizeHandle` unless you are sure the input has no
 * leading "@".
 */
export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

/**
 * Whether `video_url` is a TikTok /video/ permalink that the ops can navigate to
 * and scrape. Rejects non-TikTok hosts, missing handle, and missing video id.
 */
export function isValidVideoPermalink(videoUrl: string): boolean {
  return VIDEO_PERMALINK_RE.test(videoUrl);
}

export type OpErrorCode =
  | "SESSION_EXPIRED"
  | "RATE_LIMITED"
  | "RATE_LIMITED_PROTECTIVE"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UPLOAD_FAILED"
  | "UI_TIMEOUT"
  | "LAUNCH_FAILED"
  | "CAPTCHA_CHALLENGE"
  | "SCHEDULE_FAILED"
  | "NOT_READY"
  | "UNKNOWN";

/**
 * Map TikTok error codes to our error_code enum.
 * Observed codes (approximate — not officially documented):
 *   0      = success
 *   8      = session expired / not logged in
 *   10000+ = rate-limited / flood control
 *   20000+ = captcha / security check
 *   3xxxx  = content rejected (duplicate, banned keyword, etc.)
 */
export function mapTikTokError(status: number, code?: number): OpErrorCode {
  if (status === 401 || status === 403 || code === 8) return "SESSION_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (code && code >= 20000 && code < 30000) return "CAPTCHA_CHALLENGE";
  if (code && code >= 10000 && code < 20000) return "RATE_LIMITED";
  if (code && code >= 30000 && code < 40000) return "INVALID_INPUT";
  return "UNKNOWN";
}
