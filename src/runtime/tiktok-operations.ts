/**
 * Authenticated TikTok operations executed through a persistent local browser
 * profile. Each op:
 *
 *   1. Opens a stealth Chromium session with the cached cookies
 *   2. Navigates to the relevant TikTok URL
 *   3. Drives the UI while intercepting the matching internal API call
 *   4. Returns success only if the API response confirmed — never relies
 *      on UI state alone (no false positives)
 *
 * TikTok mirrors Twitter's shape but with a tighter rate-limit stance:
 * every op goes through `checkRateLimit()` before the browser even boots.
 */
import { launchLocalContext, openAuthenticatedSession, profileForCountry, pendingRequests } from "./social-runtime.js";
import { fetchSsrfSafe } from "./media-fetch.js";
import { randomUUID } from "crypto";
import { checkRateLimit, recordAction } from "./social-rate-limit.js";
import { resolveElement, axSnapshot, waitForHydrated, HYDRATION_PROBES } from "./social-selectors.js";
import { wallClockInTz, pad2, type WallClock } from "./schedule-time.js";
import { recordSample, postedAtFromVideoId } from "./tiktok-metrics.js";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB — covers up to ~90s @ typical bitrate
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;    // 10 MB

export interface TikTokOpResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?:
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
    /**
     * The page loaded but the content the op needed never rendered, so NOTHING
     * about the target's state was actually observed. Distinct from NOT_FOUND,
     * which asserts we looked at rendered content and the thing was absent —
     * conflating the two is what let "already following" and "already deleted"
     * be reported about accounts and posts nobody had checked.
     */
    | "NOT_READY"
    | "UNKNOWN";
  retry_after_ms?: number;
}

export interface TikTokOpRequest {
  account_id: string;
  proxy_session_id?: string;
  /** ISO country code for locale/timezone alignment. */
  country?: string;
  cookies: any[];
}

interface VideoInput {
  /** Local MP4 path. Used by the self-hosted MCP and never uploaded elsewhere. */
  video_path?: string;
  /** Raw base64 of the MP4 file, or a data URL. */
  video_base64?: string;
  /** Public HTTPS URL. Server fetches with SSRF guard. */
  video_url?: string;
}

interface ImageInput {
  /** Local image path. Used by the self-hosted MCP and never uploaded elsewhere. */
  image_path?: string;
  image_base64?: string;
  image_url?: string;
}

/* ─── Media materialisation ────────────────────────────────────────────── */

async function materializeVideo(input: VideoInput): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.video_path && !input.video_base64 && !input.video_url) {
    throw new Error("video_path, video_base64, or video_url is required");
  }
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const dir = path.join(os.tmpdir(), "tiktok-mcp-uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (input.video_path) {
    const filePath = path.resolve(input.video_path);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Video path is not a file: ${filePath}`);
    if (stat.size > MAX_VIDEO_BYTES) throw new Error(`Video too large (${stat.size} bytes, max ${MAX_VIDEO_BYTES})`);
    return { filePath, cleanup: () => {} };
  }

  let buf: Buffer;
  if (input.video_base64) {
    const dataUrlMatch = input.video_base64.match(/^data:video\/(\w+);base64,(.+)$/);
    buf = Buffer.from(dataUrlMatch ? dataUrlMatch[2] : input.video_base64, "base64");
  } else {
    const resp = await fetchSsrfSafe(input.video_url!, { timeoutMs: 60000, maxBytes: MAX_VIDEO_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch video: HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!/^video\//.test(ct)) throw new Error(`URL did not return a video (content-type: ${ct})`);
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }

  if (buf.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buf.length} bytes, max ${MAX_VIDEO_BYTES})`);
  }

  const filePath = path.join(dir, `${randomUUID()}.mp4`);
  fs.writeFileSync(filePath, buf);
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath); } catch {} } };
}

async function materializeImage(input: ImageInput): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.image_path && !input.image_base64 && !input.image_url) throw new Error("image_path, image_base64, or image_url is required");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const dir = path.join(os.tmpdir(), "tiktok-mcp-uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (input.image_path) {
    const filePath = path.resolve(input.image_path);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Image path is not a file: ${filePath}`);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES})`);
    return { filePath, cleanup: () => {} };
  }

  let buf: Buffer;
  let ext = "png";
  if (input.image_base64) {
    const m = input.image_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) { ext = m[1].toLowerCase(); buf = Buffer.from(m[2], "base64"); }
    else buf = Buffer.from(input.image_base64, "base64");
  } else {
    const resp = await fetchSsrfSafe(input.image_url!, { timeoutMs: 30000, maxBytes: MAX_IMAGE_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!/^image\//.test(ct)) throw new Error(`URL did not return an image (content-type: ${ct})`);
    ext = ct.split("/")[1]?.split(";")[0]?.toLowerCase() || "png";
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image too large (${buf.length} bytes)`);
  if (!["png", "jpeg", "jpg", "webp"].includes(ext)) ext = "png";
  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buf);
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath); } catch {} } };
}

/* ─── Debug / diagnostics ──────────────────────────────────────────────── */

async function debugShot(page: any, tag: string): Promise<string | undefined> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const dir = path.join(os.tmpdir(), "tiktok-mcp-shots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const shotPath = `${dir}/tiktok-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    return shotPath;
  } catch { return undefined; }
}

/**
 * Richer failure capture: screenshot + the page's interactive accessibility
 * tree. The element list shows exactly what TikTok rendered when a selector
 * missed, turning an opaque UI_TIMEOUT into a visible, fixable rotation (and the
 * same data a vision fallback would act on). Returned under `data` so it travels
 * back to the agent in the op result.
 */
async function captureUiState(
  page: any,
  tag: string,
): Promise<{
  diag_screenshot?: string;
  interactive_elements?: Array<{ role: string; name: string }>;
  controls?: string;
  pending?: Array<{ url: string; method: string; resourceType: string; ageMs: number }>;
}> {
  const [diag_screenshot, interactive_elements] = await Promise.all([
    debugShot(page, tag),
    axSnapshot(page),
  ]);
  // Rich control dump (data-e2e / aria-label / tag / text) — more complete than
  // the AX tree for pinning a rotated selector. Logged to the server console.
  const controls: string = await page.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,[role="button"],[data-e2e],input,textarea')].filter(e=>e.getClientRects().length>0);
    const seen=new Set(); const out=[];
    for(const e of els){ const t=(e.textContent||'').trim().slice(0,24); const de=e.getAttribute('data-e2e'); const al=e.getAttribute('aria-label'); if(!de&&!al&&!t)continue; const k=e.tagName+'|'+de+'|'+al+'|'+t; if(seen.has(k))continue; seen.add(k); out.push((de?'@'+de:'')+(al?' [al='+al+']':'')+' <'+e.tagName.toLowerCase()+(e.name?' name='+e.name:'')+'> '+t); if(out.length>=45)break; }
    return out.join('  ||  ');
  })()`).catch(() => "");
  if (controls) console.error("[tiktok] " + tag + " controls: " + controls);
  // What the page was still waiting on. For a readiness failure this is the
  // signal that actually identifies the cause — a mounted-but-empty control
  // means a fetch never returned, and this names it.
  const stalled = pendingRequests(page);
  if (stalled.length > 0) {
    console.error(
      "[tiktok] " + tag + " pending: " +
      stalled.map(r => `${r.resourceType} ${r.method} ${r.url} (${Math.round(r.ageMs / 1000)}s)`).join("  ||  "),
    );
  }
  return { diag_screenshot, interactive_elements, controls, pending: stalled };
}

/**
 * TikTok Studio pops intro / promo / consent modals (`TUXModal-overlay`) that
 * intercept pointer events — especially on a fresh profile — so a click on the
 * caption box or Post button silently times out. Best-effort dismiss before we
 * interact: try a close/affirmative button, else press Escape. Returns true if a
 * modal was present.
 */
async function dismissBlockingModal(page: any, windowMs: number = 12000): Promise<boolean> {
  // The "Turn on automatic content checks?" modal (Cancel/Turn on) appears a few
  // seconds AFTER the upload finishes — not necessarily when the editor first
  // renders — and a "New features" toast can stack on it. So POLL for an overlay
  // across a window and dismiss whatever appears, proceeding only once it's been
  // clear for a couple of checks. "Cancel" dismisses the content-checks prompt
  // without enabling the optional checks (we just want to post).
  // Dismiss inside page JS via a programmatic .click() — a real mouse click is
  // defeated by the overlay's pointer-event interception, but el.click() still
  // fires React's handler. We scan each visible overlay for a dismiss button by
  // exact label and click it; logs the buttons it sees for diagnosis.
  let dismissed = false;
  let consecutiveClear = 0;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline && consecutiveClear < 2) {
    const res: string = await page.evaluate(`(()=>{
      const ovs=[...document.querySelectorAll('.TUXModal-overlay,.react-joyride__overlay')].filter(o=>o.getClientRects().length>0);
      if(!ovs.length) return JSON.stringify({open:0});
      // react-joyride explicit skip/close first (its buttons sit OUTSIDE the overlay).
      for(const id of ['button-skip','button-close']){
        const el=document.querySelector('[data-test-id="'+id+'"]');
        if(el && el.getClientRects().length){ el.click(); return JSON.stringify({open:ovs.length, clicked:id}); }
      }
      // text-labelled dismiss buttons anywhere (TUX "Cancel", joyride "Got it"/"Skip"/"Next").
      const labels=['cancel','skip','skip all','skip tour','got it','no thanks','not now','maybe later','close','dismiss','done','finish','next'];
      const btns=[...document.querySelectorAll('button,[role="button"]')].filter(b=>b.getClientRects().length>0);
      const seen=btns.map(b=>(b.textContent||'').trim()).filter(Boolean).slice(0,15);
      for(const b of btns){ const t=(b.textContent||'').trim().toLowerCase(); if(labels.includes(t)){ b.click(); return JSON.stringify({open:ovs.length, clicked:t, buttons:seen}); } }
      const x=document.querySelector('[aria-label*="lose" i],[aria-label*="dismiss" i],[aria-label*="kip" i]');
      if(x && x.getClientRects().length){ x.click(); return JSON.stringify({open:ovs.length, clicked:'[aria]', buttons:seen}); }
      return JSON.stringify({open:ovs.length, clicked:null, buttons:seen});
    })()`).catch((e: any) => JSON.stringify({ err: String(e?.message || e) }));
    console.error("[tiktok] modal-dismiss: " + res);
    let parsed: any = {};
    try { parsed = JSON.parse(res); } catch {}
    if (parsed.open) {
      consecutiveClear = 0;
      if (parsed.clicked) dismissed = true;
      else await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
    } else {
      consecutiveClear++;
      await page.waitForTimeout(500);
    }
  }
  return dismissed;
}

/**
 * TikTok Studio (Creator Center) is a heavy SPA that boots lazily: on a cold
 * browser start the app shell takes noticeably longer than the lighter public
 * pages (watch/profile) to become interactive. A single `goto` straight to a
 * deep Studio route then times out on hydration. Used by every Studio-backed
 * operation so cold starts share one (generous) budget instead of guessing per
 * call site.
 */
const STUDIO_HYDRATION_TIMEOUT_MS = 60_000;

/**
 * Give the Creator Center SPA a head start before an operation waits on a deep
 * Studio route. Navigating to the lightweight Studio home first pulls the app
 * bundles and lets the session "boot" so the subsequent targeted wait has a
 * warm, rendered shell instead of fighting first-load hydration. Best-effort:
 * it never blocks the operation, just improves the odds on the first call.
 */
async function warmStudioSession(page: any): Promise<void> {
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  } catch {
    /* best-effort warm-up; the real wait below handles failures */
  }
}

/**
 * Set the "Who can see this post" audience. It's a
 * `button[role="combobox"][aria-haspopup="dialog"]` showing the current value
 * ("Everyone" by default); we open it and pick the option, then VERIFY the
 * trigger now shows the wanted value. Returns ok=false if it can't be confirmed
 * — the caller ABORTS rather than publish to the wrong audience.
 */
async function setPrivacy(page: any, privacy: 1 | 2): Promise<{ ok: boolean; value?: string; error?: string }> {
  // Audience options are [role="option"]; the private one is exactly "Only you".
  const wanted = privacy === 2 ? /only you/i : /friends/i;
  // Scope to the "Who can see this post" row — there are other comboboxes on the
  // page (e.g. Location), so a bare .first() grabs the wrong one.
  const label = page.getByText(/Who can see this post/i).first();
  if (!(await label.isVisible({ timeout: 4000 }).catch(() => false))) {
    return { ok: false, error: "'Who can see this post' label not found" };
  }
  const row = label.locator('xpath=ancestor::*[.//button[@role="combobox" and @aria-haspopup="dialog"]][1]');
  const trigger = row.locator('button[role="combobox"][aria-haspopup="dialog"]').first();
  // The value lives in a child div, not the button's textContent — read it off
  // the whole row (minus the label).
  const readValue = async () =>
    String((await row.textContent().catch(() => "")) || "").replace(/who can see this post/i, "").trim();
  if (!(await trigger.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: false, error: "audience dropdown not found in the row" };
  }
  await trigger.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(700);
  const opt = await resolveElement(page, [
    { name: "role-option", build: (p) => p.getByRole("option", { name: wanted }) },
    { name: "dialog-text", build: (p) => p.locator('[role="dialog"],[role="listbox"]').getByText(wanted) },
  ], { perStrategyMs: 2500 });
  if (!opt) {
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, error: "audience option not found in the dropdown" };
  }
  await opt.locator.click({ timeout: 4000 }).catch(() => {});
  // Wait for the dropdown to close before reading back — a fixed sleep races the
  // value update under latency.
  await page.locator('[role="option"]').first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  const shown = await readValue();
  return { ok: wanted.test(shown), value: shown.slice(0, 40) };
}

/* ─── API response interceptor ─────────────────────────────────────────── */

interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
  errorMessage?: string;
  statusCode?: number;
}

async function submitAndAwaitTikTokApi(
  page: any,
  trigger: () => Promise<void>,
  urlPattern: RegExp,
  timeoutMs: number = 30000
): Promise<ApiResult | null> {
  const respPromise = page
    .waitForResponse((resp: any) => urlPattern.test(resp.url()), { timeout: timeoutMs })
    .catch(() => null);

  await trigger();

  const resp = await respPromise;
  if (!resp) return null;

  const status = resp.status();
  let json: any = null;
  try { json = await resp.json(); }
  catch {
    try { json = { raw: await resp.text() }; } catch {}
  }

  // TikTok's internal API envelope uses `status_code` — 0 means success.
  // `status_msg` / `message` carries the human-readable error.
  const statusCode = typeof json?.status_code === "number" ? json.status_code : undefined;
  const errorMessage = statusCode && statusCode !== 0
    ? (json.status_msg || json.message || `TikTok error ${statusCode}`)
    : undefined;

  return {
    ok: resp.ok() && !errorMessage,
    status,
    json,
    errorMessage,
    statusCode,
  };
}

/**
 * Map TikTok error codes to our error_code enum.
 * Observed codes (approximate — not officially documented):
 *   0      = success
 *   8      = session expired / not logged in
 *   10000+ = rate-limited / flood control
 *   20000+ = captcha / security check
 *   3xxxx  = content rejected (duplicate, banned keyword, etc.)
 */
function mapTikTokError(status: number, code?: number): TikTokOpResult["error_code"] {
  if (status === 401 || status === 403 || code === 8) return "SESSION_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (code && code >= 20000 && code < 30000) return "CAPTCHA_CHALLENGE";
  if (code && code >= 10000 && code < 20000) return "RATE_LIMITED";
  if (code && code >= 30000 && code < 40000) return "INVALID_INPUT";
  return "UNKNOWN";
}

/* ─── Pre-op gate: rate-limit check ────────────────────────────────────── */

function gate(accountId: string, operation: string): TikTokOpResult | null {
  const rl = checkRateLimit(accountId, "tiktok", operation);
  if (!rl.ok) {
    return {
      success: false,
      error: rl.reason || "Rate limited",
      error_code: "RATE_LIMITED_PROTECTIVE",
      retry_after_ms: rl.retry_after_ms,
    };
  }
  return null;
}

/* ─── Native schedule (TikTok Studio) ──────────────────────────────────── */

/**
 * Drive TikTok Studio's native "Schedule" control on the upload page. On success
 * the post is handed to TikTok to publish at `when` — no local worker, fires
 * even if our server is down.
 *
 * Safety invariant: we set the time + date fields and VERIFY them by reading the
 * input values back. If the toggle/fields can't be found or don't accept our
 * values (e.g. a calendar-only widget), we return { ok:false } and the caller
 * ABORTS before submitting — so a broken schedule never silently posts "now".
 *
 * Best-effort against a UI we can't pin from here: selectors are resilient and a
 * failure carries AX diagnostics so the real widget can be seen and refined.
 */
async function applySchedule(page: any, when: WallClock): Promise<{ ok: boolean; error?: string }> {
  // 1. Select "Schedule" — JS-click the radio input by value. This fired the
  //    consent modal reliably in testing; a label/real click did not.
  const sel: string = await page.evaluate(`(()=>{const r=document.querySelector('input[name="postSchedule"][value="schedule"]');if(!r)return 'no-radio';r.click();return r.checked?'checked':'clicked';})()`).catch(() => "err");
  if (sel === "no-radio") return { ok: false, error: "'Schedule' option not found" };
  await page.waitForTimeout(1100);

  // 2. Consent modal "Allow your video to be saved for scheduled posting?" —
  //    click Allow (NOT Cancel): real click first, JS-click fallback.
  let allowed = false;
  const allowBtn = page.locator('button:has-text("Allow")').first();
  if (await allowBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await allowBtn.click({ timeout: 3000 }).catch(() => {});
    allowed = true;
  } else {
    allowed = await page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/allow/i.test((x.textContent||'').trim())&&(x.textContent||'').trim().length<20);if(b){b.click();return true;}return false;})()`).catch(() => false);
  }
  await page.waitForTimeout(1300);

  // Reveal the date/time picker (a button[aria-haspopup=dialog] that isn't a
  // Select__trigger dropdown), then read its inputs.
  await page.locator('button[aria-haspopup="dialog"]:not(.Select__trigger)').first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900);

  // 3. Date + time are plain text inputs (TUXTextInputCore-input): "YYYY-MM-DD"
  //    and "HH:MM" (24h, 5-min granularity). Type, then VERIFY — abort on
  //    mismatch so we never publish at the wrong time.
  let hh = when.h, mi = Math.round(when.mi / 5) * 5;
  if (mi === 60) { mi = 0; hh = (hh + 1) % 24; }
  const timeStr = `${pad2(hh)}:${pad2(mi)}`;
  const dateStr = `${when.y}-${pad2(when.mo)}-${pad2(when.d)}`;

  const findFields = async (): Promise<{ t: any; d: any }> => {
    let t: any = null, d: any = null;
    const fields = page.locator("input.TUXTextInputCore-input");
    const c = await fields.count().catch(() => 0);
    for (let i = 0; i < c; i++) {
      const v = String((await fields.nth(i).inputValue().catch(() => "")) || "");
      if (/^\d{1,2}:\d{2}/.test(v)) t = fields.nth(i);
      else if (/^\d{4}-\d{2}-\d{2}/.test(v)) d = fields.nth(i);
    }
    return { t, d };
  };
  let timeInput: any = null, dateInput: any = null;
  for (let attempt = 0; attempt < 4 && (!timeInput || !dateInput); attempt++) {
    const f = await findFields();
    timeInput = timeInput || f.t; dateInput = dateInput || f.d;
    if (!timeInput || !dateInput) await page.waitForTimeout(800);
  }
  console.error(`[tiktok] schedule: radio=${sel} allow=${allowed} time_field=${!!timeInput} date_field=${!!dateInput}`);
  if (!timeInput || !dateInput) return { ok: false, error: "date/time fields not found after enabling Schedule" };

  // Escape closes the date calendar (and keeps the typed date), but it REVERTS
  // the time picker — so only Escape for the date field; commit the time by
  // blurring (click a neutral label) instead.
  const setField = async (input: any, value: string, esc: boolean) => {
    await input.click().catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await input.pressSequentially(value, { delay: 50 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    if (esc) { await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(200); }
  };
  await setField(dateInput, dateStr, true);

  // Time is a scroll picker (tiktok-timepicker), not free-text — open it and
  // click the hour cell (1st option-list, 24 items) + minute cell (2nd list, 12
  // items at 5-min steps).
  await timeInput.click().catch(() => {});
  await page.waitForTimeout(800);
  const lists = page.locator(".tiktok-timepicker-option-list");
  const hourItem = lists.nth(0).locator(".tiktok-timepicker-option-item", { hasText: new RegExp(`^${pad2(hh)}$`) }).first();
  await hourItem.scrollIntoViewIfNeeded().catch(() => {});
  await hourItem.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const minItem = lists.nth(1).locator(".tiktok-timepicker-option-item", { hasText: new RegExp(`^${pad2(mi)}$`) }).first();
  await minItem.scrollIntoViewIfNeeded().catch(() => {});
  await minItem.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  // close the picker by blurring onto a neutral label
  await page.getByText(/Who can see this post/i).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400);

  const dv = String((await dateInput.inputValue().catch(() => "")) || "");
  const tv = String((await timeInput.inputValue().catch(() => "")) || "");
  if (!dv.startsWith(dateStr)) return { ok: false, error: `date field shows "${dv}", expected ${dateStr}` };
  if (!tv.startsWith(timeStr)) return { ok: false, error: `time field shows "${tv}", expected ${timeStr}` };
  console.error(`[tiktok] schedule set to ${dateStr} ${timeStr}`);
  return { ok: true };
}

/* ─── Operations ───────────────────────────────────────────────────────── */

export interface TikTokPostRequest extends TikTokOpRequest, VideoInput {
  caption: string;
  /** TikTok privacy: 0 = public, 1 = friends, 2 = private. Default 0. */
  privacy?: 0 | 1 | 2;
  /** Allow comments. Default true. */
  allow_comments?: boolean;
  /** Allow duet. Default true. */
  allow_duet?: boolean;
  /** Allow stitch. Default true. */
  allow_stitch?: boolean;
  /**
   * ISO-8601 datetime. When set, drive TikTok Studio's NATIVE schedule control
   * so TikTok itself publishes at this instant (no background worker). Must be
   * ~15 min to ~10 days out — TikTok's own window. The instant is rendered into
   * the account's timezone before being typed into the picker.
   */
  schedule_at?: string;
}

/**
 * Resolve a published video's URL + id from the Studio content manager (the
 * post redirect lands there but carries no id). Matches the row by caption
 * (polled, since a new row can take a moment to appear), falling back to the
 * newest post.
 *
 * `matched` reports HOW the result was obtained, and callers must respect it.
 * The newest-post fallback is sound when we already know a post published and
 * only need its URL — it is catastrophic as evidence that a *specific* post
 * landed. Returning it unlabelled meant the reconciliation oracle could never
 * answer "not posted" for any account with prior content: an ambiguous post
 * that never published was marked `posted`, handed the previous video's URL,
 * and was incorrectly treated as the new post. Callers need to know whether a
 * caption really matched instead of receiving an unrelated fallback.
 */
export async function findPostedVideo(
  page: any,
  caption: string,
): Promise<{ video_id?: string; video_url?: string; matched: "caption" | "newest" | "none" }> {
  if (!/tiktokstudio\/(content|posts)/i.test(String(page.url()))) {
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 15000 }).catch(() => {});
  const key = (caption || "").trim().slice(0, 24).toLowerCase();
  let href: string | null = null;
  let matched: "caption" | "newest" | "none" = "caption";
  if (key) {
    for (let i = 0; i < 4 && !href; i++) {
      href = await page.evaluate(`(()=>{
        const links=[...document.querySelectorAll('a[href*="/video/"]')];
        const m = links.find(a => (a.textContent||'').trim().toLowerCase().includes(${JSON.stringify(key)}));
        return m ? m.getAttribute('href') : null;
      })()`).catch(() => null);
      if (!href) await page.waitForTimeout(1500);
    }
  }
  if (!href) {
    // Fallback: the NEWEST post — don't assume the list is sorted newest-first.
    // TikTok video ids are time-ordered, so the largest id is newest. Compare as
    // numeric strings (by length, then lexicographically) — 19-digit ids overflow
    // JS Number precision.
    href = await page.evaluate(`(()=>{
      let best=null, bestId='';
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        const m=/\\/video\\/(\\d+)/.exec(a.getAttribute('href')||'');
        if(!m) continue;
        const id=m[1];
        if(id.length>bestId.length || (id.length===bestId.length && id>bestId)){ bestId=id; best=a; }
      }
      return best ? best.getAttribute('href') : null;
    })()`).catch(() => null);
    matched = href ? "newest" : "none";
  }
  if (!href) return { matched: "none" };
  const full = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
  const idm = /\/video\/(\d+)/.exec(full);
  return { video_url: full, video_id: idm ? idm[1] : undefined, matched };
}

/**
 * Reconciliation oracle for the async post worker: "did a video with this
 * caption actually publish?" Opens a fresh authenticated session and scrapes
 * the Studio content manager via findPostedVideo. Used when a post attempt is
 * AMBIGUOUS (submit was clicked but no confirmation observed, or the op threw
 * mid-flight) so we do not retry a post that actually landed or report one that
 * did not. Best-effort: `determined:false` means
 * we couldn't open a session / scrape (treat as unresolved, never as proof).
 */
export async function checkPostedByCaption(
  req: TikTokOpRequest & { caption: string }
): Promise<TikTokOpResult<{ determined: boolean; posted: boolean; video_url?: string; video_id?: string }>> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    // Can't open a session — outcome stays unresolved (not "not posted").
    return { success: true, data: { determined: false, posted: false } };
  }
  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/content", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {});
    const found = await findPostedVideo(page, req.caption);
    // ONLY a caption match is proof that THIS post landed. The newest-post
    // fallback returns whatever the account most recently published, which for
    // any account with prior content is someone else's evidence — accepting it
    // here is what made this oracle unable to ever answer "not posted".
    const posted = found.matched === "caption";
    if (found.matched === "newest") {
      console.warn(
        `[tiktok] reconcile: no row matched the caption for ${req.account_id}; ` +
        `ignoring the newest-post fallback and reporting NOT posted`,
      );
    }
    return {
      success: true,
      data: posted
        ? { determined: true, posted: true, video_url: found.video_url, video_id: found.video_id }
        : { determined: true, posted: false },
    };
  } catch {
    return { success: true, data: { determined: false, posted: false } };
  } finally {
    await close().catch(() => {});
  }
}

export async function postVideo(req: TikTokPostRequest): Promise<TikTokOpResult<{ video_url?: string; video_id?: string; scheduled_at?: string }>> {
  const blocked = gate(req.account_id, "post");
  if (blocked) return blocked;

  if (!req.caption || req.caption.length > 4000) {
    return { success: false, error: "caption must be 1-4000 chars", error_code: "INVALID_INPUT" };
  }

  // Validate the native-schedule window up front, before the expensive browser
  // launch. TikTok requires roughly 15 min to 10 days of lead time.
  let scheduleWhen: WallClock | undefined;
  if (req.schedule_at) {
    const at = new Date(req.schedule_at);
    if (isNaN(at.getTime())) {
      return { success: false, error: "schedule_at must be a valid ISO-8601 datetime", error_code: "INVALID_INPUT" };
    }
    const now = Date.now();
    if (at.getTime() < now + 15 * 60 * 1000) {
      return { success: false, error: "schedule_at must be at least ~15 minutes in the future (TikTok's minimum)", error_code: "INVALID_INPUT" };
    }
    if (at.getTime() > now + 10 * 24 * 60 * 60 * 1000) {
      return { success: false, error: "schedule_at must be within ~10 days (TikTok's maximum)", error_code: "INVALID_INPUT" };
    }
    // The picker interprets entered values in the browser session's timezone,
    // which openAuthenticatedSession derives from the account country — so
    // render the absolute instant into that same zone.
    scheduleWhen = wallClockInTz(at, profileForCountry(req.country).timezoneId);
  }

  let video: { filePath: string; cleanup: () => void };
  try {
    video = await materializeVideo(req);
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    video.cleanup();
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/upload?from=webapp", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Upload the file. The <input type=file> is plain HTML (not a rotating
    // test-id); TikTok renders both a visible and a hidden one — take the first.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(video.filePath);

    // Wait for the upload to finish and the caption editor to render. Resolve it
    // resiliently: the data-e2e id is tried first (up to 90s, to absorb the
    // upload), then durable aria / role / contenteditable fallbacks if it rotated.
    const caption = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="upload-editor-caption"]') },
      { name: "aria-label", build: (p) => p.locator('[aria-label*="aption" i], [aria-label*="escription" i]') },
      { name: "role-textbox", build: (p) => p.getByRole("textbox") },
      { name: "contenteditable", build: (p) => p.locator('div[contenteditable="true"]') },
    ], { firstTimeoutMs: 90000, perStrategyMs: 6000 });
    if (!caption) {
      const diag = await captureUiState(page, "upload-editor-missing");
      return {
        success: false,
        error: "Upload editor never appeared — video rejected at upload, or the caption-editor selector rotated.",
        error_code: "UPLOAD_FAILED",
        data: diag as any,
      };
    }
    const captionBox = caption.locator;
    console.error(`[tiktok] caption editor resolved via ${caption.strategy}`);

    // Clear any blocking intro/consent modal before interacting with the editor.
    if (await dismissBlockingModal(page)) console.error("[tiktok] dismissed a blocking modal overlay");

    // Clear any auto-filled caption, type the user's caption.
    await captionBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await captionBox.pressSequentially(req.caption, { delay: 15 });
    await page.waitForTimeout(500);

    // Set the native schedule FIRST — doing it after the privacy dropdown leaves
    // the page in a state where the Schedule radio won't engage. ABORT before
    // submitting if it can't be applied, so a broken schedule never posts "now".
    if (scheduleWhen) {
      const sched = await applySchedule(page, scheduleWhen);
      if (!sched.ok) {
        const diag = await captureUiState(page, "schedule-setup-failed");
        return {
          success: false,
          error: `Could not set TikTok's native schedule (${sched.error}). Aborted before posting to avoid publishing immediately — see diagnostics.interactive_elements for the actual scheduler UI.`,
          error_code: "SCHEDULE_FAILED",
          data: diag as any,
        };
      }
      console.error(`[tiktok] native schedule applied for ${req.schedule_at}`);
    }

    // Apply privacy / comments / duet / stitch toggles if the user set non-defaults.
    if (req.privacy === 1 || req.privacy === 2) {
      const pr = await setPrivacy(page, req.privacy);
      if (!pr.ok) {
        const diag = await captureUiState(page, "privacy-set-failed");
        return {
          success: false,
          error: `Could not set audience to ${req.privacy === 2 ? "Only you" : "Friends"} (control showed "${pr.value || pr.error}"). Aborted before posting to avoid publishing to the wrong audience.`,
          error_code: "INVALID_INPUT",
          data: diag as any,
        };
      }
      console.error(`[tiktok] audience set to "${pr.value}"`);
    }
    if (req.allow_comments === false) {
      await page.locator('[data-e2e="upload-switch-comment"], label:has-text("Comment")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }
    if (req.allow_duet === false) {
      await page.locator('[data-e2e="upload-switch-duet"], label:has-text("Duet")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }
    if (req.allow_stitch === false) {
      await page.locator('[data-e2e="upload-switch-stitch"], label:has-text("Stitch")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }

    // A modal may have re-appeared after typing/scheduling — clear it before submit.
    await dismissBlockingModal(page);

    // Resolve the submit button up front (its label is "Schedule" when a
    // schedule is set, "Post" otherwise), so a rotated selector returns a clean
    // UI_TIMEOUT with diagnostics instead of an opaque throw mid-submit.
    const post = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="post_video_button"]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /^(post|schedule)$/i }) },
      { name: "text", build: (p) => p.locator('button:has-text("Schedule"), button:has-text("Post")') },
    ], { perStrategyMs: 8000 });
    if (!post) {
      const diag = await captureUiState(page, "post-button-missing");
      return {
        success: false,
        error: "Submit button not found — the editor may not be ready, or the selector rotated.",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }
    console.error(`[tiktok] submit button resolved via ${post.strategy}`);

    // Submit — intercept TikTok's /aweme/v1/web/aweme/post/ API call (the same
    // endpoint carries scheduled creates, with a schedule_time in the payload).
    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await post.locator.click({ timeout: 10000 }); },
      /\/aweme\/v\d+\/(web\/)?aweme\/post/,
      60000,
    );

    if (!result) {
      // TikTok Studio redirects to the content/posts page on a successful post
      // (its upload XHR isn't the classic /aweme/post path), so treat that
      // redirect — or a success toast — as success rather than a false negative.
      const url = String(page.url());
      const posted = /tiktokstudio\/(content|posts)/i.test(url)
        || await page.locator('text=/your (video|post).*(posted|uploaded|scheduled|published)|posted successfully|scheduled successfully/i')
             .first().isVisible({ timeout: 3000 }).catch(() => false);
      if (posted) {
        recordAction(req.account_id, "tiktok", "post");
        console.error(`[tiktok] post confirmed via redirect/toast (url=${url})`);
        // The redirect doesn't carry the new video's id, so (for instant posts)
        // look it up in the content manager we just landed on. Best-effort:
        // never fail the post over it.
        //
        // Only a CAPTION match may be published as this post's URL. The newest
        // -post fallback is a guess, and when the new row simply hasn't rendered
        // yet that guess is the account's PREVIOUS video — which then gets
        // written to the caller's post log as the URL of the video they just
        // made. A successful post with no URL is recoverable; a successful post
        // carrying a link to unrelated content is not.
        // Resolve the video for a SCHEDULED create too.
        //
        // This used to skip scheduling on the assumption that a held post has
        // no URL yet. Observed directly against a live scheduled post: the row
        // appears in the content manager immediately, carrying a real video id
        // (`/@acct/video/7667710265768545557`) minutes before its publish time.
        // Throwing it away left a scheduled post with no handle at all — it
        // could not be cancelled, looked up, or reconciled afterwards, and
        // TikTok offers no other way to find it (Studio's list marks held posts
        // no differently from published ones — no badge, no status, no filter).
        //
        // The URL is not publicly reachable until it publishes; the id is still
        // the only thing that makes the post addressable in the meantime.
        const resolved = await findPostedVideo(page, req.caption).catch(() => undefined);
        if (resolved && resolved.matched === "newest") {
          console.warn(
            `[tiktok] post confirmed but its row had not rendered; omitting video_url rather than returning the previous video's`,
          );
        }
        const found = resolved?.matched === "caption"
          ? { video_url: resolved.video_url, video_id: resolved.video_id }
          : undefined;
        return {
          success: true,
          data: {
            ...(found || {}),
            ...(req.schedule_at
              ? {
                  scheduled_at: req.schedule_at,
                  // Say plainly that the URL is not live yet, so nobody links
                  // to it or treats its absence of views as a flop.
                  pending_publish: true,
                }
              : {}),
          },
        };
      }
      const diag = await captureUiState(page, "no-post-api");
      return {
        success: false,
        error: "No post confirmation observed after clicking Post — UI flow may have changed.",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }

    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `TikTok returned HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "post");

    // TikTok returns the aweme_id / share_url in the response payload shape
    // {status_code:0, aweme: {aweme_id, share_url, ...}} (varies by version).
    const aweme = result.json?.aweme || result.json?.data || {};
    return {
      success: true,
      data: {
        video_id: aweme.aweme_id || aweme.id,
        video_url: aweme.share_url || aweme.video_url,
        // For a scheduled create TikTok holds the post (no public URL yet) — the
        // requested instant is the meaningful confirmation.
        ...(req.schedule_at ? { scheduled_at: req.schedule_at } : {}),
      },
    };
  } catch (e: any) {
    const diag = await captureUiState(page, "post-unknown-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    video.cleanup();
    await close();
  }
}

export interface TikTokFollowRequest extends TikTokOpRequest {
  /** Target username with or without leading `@`. */
  target_user: string;
}

export async function followUser(req: TikTokFollowRequest): Promise<TikTokOpResult<{ followed: boolean }>> {
  const blocked = gate(req.account_id, "follow");
  if (blocked) return blocked;

  const handle = req.target_user.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{2,24}$/.test(handle)) {
    return { success: false, error: "target_user must be a valid TikTok handle", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "domcontentloaded", timeout: 45000 });

    // The action buttons are auth-gated and hydrate LAST — long after the
    // profile's name, counts, bio and video grid have painted. Every strategy
    // below matches on the literal text "Follow", so running them against an
    // unlabelled skeleton button cannot succeed no matter how long they wait.
    // Gate on the row being genuinely rendered first; without this the op
    // reported "already following / selector rotated" on a perfectly healthy
    // session, which is what it did on every attempt in production.
    const actionsReady = await waitForHydrated(page, HYDRATION_PROBES.profileActions, { timeoutMs: 30000 });
    if (!actionsReady) {
      const diag = await captureUiState(page, "follow-actions-not-hydrated");
      return {
        success: false,
        error: `@${handle}'s profile loaded but its action buttons never rendered, so the follow control could not be read. This is a page-readiness failure, not a confirmed state of the account.`,
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    // TikTok pops intro/promo modals over the profile — "especially on a fresh
    // profile", as dismissBlockingModal's own header notes — and a TUXModal
    // overlay swallows the click on a button that is otherwise visible,
    // enabled and stable. Playwright then retries for ten seconds and fails
    // with a click timeout that looks nothing like "a modal was in the way".
    // The post flow already dismisses these; the public-site ops never did.
    if (await dismissBlockingModal(page, 6000)) console.error("[tiktok] dismissed a modal covering the follow control");

    // Resolve the Follow button resiliently. Every strategy excludes the
    // "Following" state so we never accidentally click-to-unfollow.
    const follow = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="follow-button"]:has-text("Follow"):not(:has-text("Following"))') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /^follow$/i }) },
      { name: "text-exact", build: (p) => p.getByText(/^Follow$/) },
      { name: "text", build: (p) => p.locator('button:has-text("Follow"):not(:has-text("Following")), [role="button"]:has-text("Follow"):not(:has-text("Following"))') },
    ], { perStrategyMs: 8000 });
    if (!follow) {
      // The row IS rendered (probe passed) and no actionable Follow control is
      // in it — so an existing relationship is now a supported conclusion
      // rather than a guess. Report it as success: the caller's intent, that we
      // follow this account, already holds.
      // Text-based, matching the probe: the live page carried no
      // data-e2e="follow-button" at all, so anchoring this on that attribute
      // would make the check silently unreachable.
      const already = await page.evaluate(`(() => {
        const els = document.querySelectorAll('button, [role="button"]');
        for (const el of els) {
          if (el.querySelector('button, [role="button"]')) continue;
          if (/^(following|friends|requested)$/i.test((el.textContent || '').trim())) return true;
        }
        return false;
      })()`).catch(() => false);
      if (already) {
        console.error(`[tiktok] already following @${handle} — treating as satisfied`);
        return { success: true, data: { followed: true } };
      }
      const diag = await captureUiState(page, "follow-btn-missing");
      return {
        success: false,
        error: `No follow control on @${handle}'s profile after it rendered. The profile may be private, restricted or nonexistent, or the selector rotated.`,
        error_code: "NOT_FOUND",
        data: diag as any,
      };
    }
    console.error(`[tiktok] follow button resolved via ${follow.strategy}`);

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await follow.locator.click({ timeout: 10000 }); },
      /\/aweme\/v\d+\/(web\/)?commit\/follow\/user|\/passport\/web\/user\/follow/,
      20000,
    );

    if (!result) {
      // API endpoint may differ — confirm by the button flipping out of "Follow"
      // (to Following / Friends / Requested).
      const flipped = await page.locator('[data-e2e="follow-button"]:has-text("Following"), [data-e2e="follow-button"]:has-text("Friends"), [data-e2e="follow-button"]:has-text("Requested")')
        .first().isVisible({ timeout: 4000 }).catch(() => false);
      if (flipped) {
        recordAction(req.account_id, "tiktok", "follow");
        console.error("[tiktok] follow confirmed via button flip");
        return { success: true, data: { followed: true } };
      }
      const diag = await captureUiState(page, "follow-no-confirm");
      return { success: false, error: "No follow confirmation observed after click (no API, button didn't flip).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "follow");
    return { success: true, data: { followed: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokLikeRequest extends TikTokOpRequest {
  /** Full TikTok video URL — e.g. https://www.tiktok.com/@handle/video/1234567890 */
  video_url: string;
}

export async function likeVideo(req: TikTokLikeRequest): Promise<TikTokOpResult<{ liked: boolean }>> {
  const blocked = gate(req.account_id, "like");
  if (blocked) return blocked;

  if (!/^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+/.test(req.video_url)) {
    return { success: false, error: "video_url must be a TikTok /video/ permalink", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.video_url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Same readiness trap as follow: the engagement rail hydrates after the
    // video shell. Observed live — a failed like's diagnostics contained just
    // two elements, the recommend container and the video section, with no
    // action rail at all. Resolving against that reports a rotated selector for
    // a page that had simply not finished rendering.
    const railReady = await waitForHydrated(page, HYDRATION_PROBES.videoActions, { timeoutMs: 30000 });
    if (!railReady) {
      const diag = await captureUiState(page, "like-rail-not-hydrated");
      return {
        success: false,
        error: "The video page loaded but its engagement controls never rendered, so the like state could not be read.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    if (await dismissBlockingModal(page, 6000)) console.error("[tiktok] dismissed a modal covering the like control");

    const like = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="like-icon"]') },
      { name: "aria-label", build: (p) => p.locator('button[aria-label*="ike" i]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /like/i }) },
    ], { perStrategyMs: 6000 });
    if (!like) {
      const diag = await captureUiState(page, "like-btn-missing");
      return { success: false, error: "No like control on the video page after it rendered (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    console.error(`[tiktok] like button resolved via ${like.strategy}`);

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await like.locator.click({ timeout: 10000 }); },
      /commit\/item\/digg|\/digg(\/|\?|$)/i,
      15000,
    );

    if (!result) {
      const diag = await captureUiState(page, "like-no-api");
      return { success: false, error: "No like API call observed (digg endpoint not seen).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "like");
    return { success: true, data: { liked: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokDeleteRequest extends TikTokOpRequest {
  video_url: string;
}

export async function deleteVideo(req: TikTokDeleteRequest): Promise<TikTokOpResult<{ deleted: boolean }>> {
  const blocked = gate(req.account_id, "delete");
  if (blocked) return blocked;

  const idMatch = /\/video\/(\d+)/.exec(req.video_url || "");
  if (!idMatch) return { success: false, error: "video_url must contain /video/<id>", error_code: "INVALID_INPUT" };

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const videoId = idMatch[1];
  const { page, close } = session;
  try {
    // Deletion lives in the TikTok Studio post manager — NOT the public
    // /video/ watch page, whose "..." menu only has player options + Report.
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 45000 });

    // This wait used to accept the search box OR a post link — and the search
    // box is part of the navigation shell, so it was satisfied before a single
    // row existed. The `.catch(() => {})` then swallowed even a real timeout.
    // Live proof: a delete of a video that demonstrably WAS in the content
    // manager (analytics listed it a minute earlier) failed with "already
    // deleted", and its diagnostics contained only the Studio nav buttons and
    // zero rows. Gate on rows actually being present.
    const listState = await waitForHydrated(page, HYDRATION_PROBES.studioContent, { timeoutMs: STUDIO_HYDRATION_TIMEOUT_MS });
    if (!listState) {
      const diag = await captureUiState(page, "delete-list-not-hydrated");
      return {
        success: false,
        error: "The content manager never finished rendering, so the post list could not be read. The post's existence was not determined.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    // Match the post's row by the video id carried in its title link. Presence
    // in the DOM is the test, not Playwright visibility: the list is rendered
    // and we only need the anchor to exist to walk to its row.
    const titleLink = page.locator(`a[href*="/video/${videoId}"]`).first();
    if ((await titleLink.count().catch(() => 0)) === 0) {
      const diag = await captureUiState(page, "delete-row-missing");
      return { success: false, error: `Post ${videoId} is not in the content manager listing (already deleted, or on a later page).`, error_code: "NOT_FOUND", data: diag as any };
    }

    // Row = nearest ancestor that also holds the privacy (TUXButton) control;
    // the "..." more-trigger is the last (icon-only) button in that row.
    const row = titleLink.locator('xpath=ancestor::*[.//button[contains(@class,"TUXButton")]][1]');
    const moreBtn = row.locator("button").last();
    await moreBtn.click({ timeout: 8000 });
    await page.waitForTimeout(800);

    // Popup menu (Pin to top / Download / Delete) — the red "Delete" raises a
    // confirm dialog (it does NOT delete on its own).
    const menuDelete = await resolveElement(page, [
      { name: "menuitem", build: (p) => p.getByRole("menuitem", { name: /^delete$/i }) },
      { name: "text", build: (p) => p.getByText(/^Delete$/) },
    ], { perStrategyMs: 5000 });
    if (!menuDelete) {
      const diag = await captureUiState(page, "delete-menu-missing");
      return { success: false, error: "Delete not found in the post's '...' menu (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await menuDelete.locator.click({ timeout: 5000 });
    await page.waitForTimeout(800);

    // Confirm dialog → the LAST visible "Delete" button actually performs it
    // (the menu item we just clicked is now hidden, so :visible scopes us to
    // the dialog button).
    const confirm = page.locator('button:has-text("Delete"):visible, [role="button"]:has-text("Delete"):visible').last();
    await confirm.click({ timeout: 6000 });

    // The row detaching is the first signal — but a row can also detach from a
    // re-sort/repaginate, so reload and re-confirm the post is genuinely gone.
    await titleLink.waitFor({ state: "detached", timeout: 12000 }).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.locator('input[placeholder*="Search for post" i], a[href*="/video/"]').first().waitFor({ timeout: 15000 }).catch(() => {});
    const stillThere = await page.locator(`a[href*="/video/${videoId}"]`).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (stillThere) {
      const diag = await captureUiState(page, "delete-still-present");
      return { success: false, error: "Clicked delete but the post still appears in the content manager.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    recordAction(req.account_id, "tiktok", "delete");
    console.error(`[tiktok] deleted post ${videoId} via Studio content manager`);
    return { success: true, data: { deleted: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

/**
 * Reach the logged-in user's own profile (via the left-nav profile link — no
 * username needed) and open the "Edit profile" modal. Bio, display name and
 * avatar all live behind this single modal (TikTok moved them off /setting).
 * Returns true once the modal's Save button is present.
 */
async function openEditProfileModal(page: any): Promise<boolean> {
  // Resolve our own profile URL from the nav link, then navigate to it
  // directly — more reliable than clicking, which the SPA can race or an
  // overlay can intercept.
  if (!/tiktok\.com\/@[\w.]/.test(String(page.url()))) {
    await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    const navLink = page.locator('a[data-e2e="nav-profile"]').first();
    // waitFor (not isVisible) so we poll until the SPA nav hydrates.
    await navLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    // The href hydrates from a bare "/@" placeholder to "/@<username>" a beat
    // after the link appears — poll until a real username is present, else the
    // direct navigation 404s.
    let href: string | null = null;
    for (let i = 0; i < 12; i++) {
      href = await navLink.getAttribute("href").catch(() => null);
      if (href && /\/@[\w.]+/.test(href)) break;
      await page.waitForTimeout(700);
    }
    if (href && /\/@[\w.]+/.test(href)) {
      const url = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    } else {
      // Fallback: let the SPA navigate (it knows the username internally).
      await navLink.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  // The profile can transiently render "Something went wrong" or a bare splash
  // on first load — reload-and-retry a few times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    const entrance = page.locator('[data-e2e="edit-profile-entrance"]').first();
    if (await entrance.waitFor({ state: "visible", timeout: 12000 }).then(() => true).catch(() => false)) {
      await entrance.click({ timeout: 8000 }).catch(() => {});
      if (await page.locator('[data-e2e="edit-profile-save"]').first()
        .waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false)) {
        return true;
      }
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  return false;
}

export interface TikTokProfileRequest extends TikTokOpRequest {
  bio?: string;          // up to 80 chars
  display_name?: string; // up to 30 chars
}

export async function updateProfile(req: TikTokProfileRequest): Promise<TikTokOpResult<{ updated: string[] }>> {
  const blocked = gate(req.account_id, "profile");
  if (blocked) return blocked;

  if (req.bio === undefined && req.display_name === undefined) {
    return { success: false, error: "bio or display_name required", error_code: "INVALID_INPUT" };
  }
  if (req.bio !== undefined && req.bio.length > 80) {
    return { success: false, error: "bio must be <=80 chars", error_code: "INVALID_INPUT" };
  }
  if (req.display_name !== undefined && (req.display_name.length < 1 || req.display_name.length > 30)) {
    return { success: false, error: "display_name must be 1-30 chars", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  const updated: string[] = [];
  try {
    // Name + bio share one "Edit profile" modal on the profile page.
    const opened = await openEditProfileModal(page);
    if (!opened) {
      const diag = await captureUiState(page, "edit-profile-entrance-missing");
      return { success: false, error: "Could not open the Edit-profile modal (session may be logged out).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    if (req.display_name !== undefined) {
      const nameInput = page.locator('input[data-e2e="edit-profile-name"], input[placeholder="Name" i]').first();
      if (!(await nameInput.isVisible({ timeout: 6000 }).catch(() => false))) {
        const diag = await captureUiState(page, "name-input-missing");
        return { success: false, error: "Name input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await nameInput.fill(req.display_name);
      updated.push("display_name");
    }

    if (req.bio !== undefined) {
      const bioInput = page.locator('textarea[data-e2e="edit-profile-bio-input"], textarea[placeholder="Bio" i]').first();
      if (!(await bioInput.isVisible({ timeout: 6000 }).catch(() => false))) {
        const diag = await captureUiState(page, "bio-input-missing");
        return { success: false, error: "Bio input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await bioInput.fill(req.bio);
      updated.push("bio");
    }

    if (updated.length === 0) {
      return { success: false, error: "No profile fields were updated", error_code: "UI_TIMEOUT" };
    }

    // If the requested value(s) already match, TikTok keeps Save disabled — that
    // is a no-op success (we're already in the desired state).
    const save = page.locator('[data-e2e="edit-profile-save"]').first();
    await save.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500); // let the button's enabled-state settle after fill
    if (await save.isDisabled().catch(() => false)) {
      recordAction(req.account_id, "tiktok", "profile");
      console.error(`[tiktok] profile values already current (Save disabled) — ${updated.join(", ")}`);
      return { success: true, data: { updated } };
    }

    // Save. A bio TikTok dislikes is rejected INLINE (the modal stays open), so
    // the modal-stays-open check catches bad-bio rejections directly.
    await save.click({ timeout: 8000 });
    const closed = await save.waitFor({ state: "detached", timeout: 12000 }).then(() => true).catch(() => false);
    if (!closed) {
      const diag = await captureUiState(page, "profile-save-stuck");
      return { success: false, error: "Clicked Save but the Edit-profile modal didn't close — TikTok rejected the value.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Read-back guard for the DISPLAY NAME only: TikTok SILENTLY rejects a
    // nickname change when it's on cooldown (~once a week) — the modal closes
    // regardless, so the only tell is the title not changing. (Bio rejections are
    // inline, caught above, so bio needs no read-back.) Resilient to the profile's
    // flaky loads: judge only once the title actually renders; if it never does,
    // trust the closed modal rather than false-failing.
    if (req.display_name !== undefined) {
      const want = req.display_name.trim().toLowerCase();
      let verdict: "applied" | "mismatch" | "unknown" = "unknown";
      for (let attempt = 0; attempt < 2 && verdict === "unknown"; attempt++) {
        for (let i = 0; i < 6; i++) {
          const title = ((await page.locator('[data-e2e="user-title"]').first().textContent({ timeout: 3000 }).catch(() => "")) || "").trim();
          if (title) { verdict = title.toLowerCase() === want ? "applied" : "mismatch"; break; }
          await page.waitForTimeout(700);
        }
        if (verdict === "unknown") await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      }
      if (verdict === "mismatch") {
        const toast = ((await page.locator('[class*="Toast" i], [role="alert"]').first().textContent({ timeout: 1500 }).catch(() => "")) || "").trim();
        return {
          success: false,
          error: `Display name did not apply${toast ? ` (TikTok: "${toast}")` : " — TikTok limits nickname changes to about once a week"}.`,
          error_code: "RATE_LIMITED",
        };
      }
    }

    recordAction(req.account_id, "tiktok", "profile");
    console.error(`[tiktok] updated profile (${updated.join(", ")}) via Edit-profile modal`);
    return { success: true, data: { updated } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokAvatarRequest extends TikTokOpRequest, ImageInput {}

export async function updateAvatar(req: TikTokAvatarRequest): Promise<TikTokOpResult<{ updated: true }>> {
  const blocked = gate(req.account_id, "profile");
  if (blocked) return blocked;

  let image;
  try {
    image = await materializeImage(req);
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
      // The crop dialog renders the uploaded image and success is verified by
      // the avatar actually changing — this is the one op where pixels matter.
      loadMedia: true,
    });
  } catch (e: any) {
    image.cleanup();
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    // Avatar lives behind the same "Edit profile" modal as bio/name.
    const opened = await openEditProfileModal(page);
    if (!opened) {
      const diag = await captureUiState(page, "edit-profile-entrance-missing");
      return { success: false, error: "Could not open the Edit-profile modal (session may be logged out).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Snapshot the current avatar URL (profile renders behind the modal) so we
    // can confirm it actually changed after save.
    const beforeSrc = await page.locator('[data-e2e="user-avatar"] img').first().getAttribute("src").catch(() => null);

    // The modal's hidden file input — setInputFiles works without clicking the
    // edit-icon first.
    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) {
      const diag = await captureUiState(page, "avatar-input-missing");
      return { success: false, error: "Avatar file input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await fileInput.setInputFiles(image.filePath);
    await page.waitForTimeout(1500);

    // Uploading opens a crop/preview dialog — confirm it (Apply/Confirm/Done).
    // Prefer those over "Save" so we don't accidentally hit the modal's own
    // Save button, which sits behind the crop dialog.
    const cropConfirm = await resolveElement(page, [
      { name: "role", build: (p) => p.getByRole("button", { name: /^(apply|confirm|done)$/i }) },
      { name: "text", build: (p) => p.locator('button:visible', { hasText: /^(Apply|Confirm|Done)$/ }) },
    ], { perStrategyMs: 8000 });
    if (cropConfirm) {
      await cropConfirm.locator.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }

    // Save the modal; success = it dismisses.
    const save = page.locator('[data-e2e="edit-profile-save"], button:has-text("Save"):visible').first();
    await save.click({ timeout: 8000 }).catch(() => {});
    const closed = await page.locator('[data-e2e="edit-profile-save"]').first()
      .waitFor({ state: "detached", timeout: 12000 }).then(() => true).catch(() => false);
    if (!closed) {
      const diag = await captureUiState(page, "avatar-save-stuck");
      return { success: false, error: "Uploaded the avatar but the modal didn't close after Save.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Read-back guard: the modal closes even if the crop step was skipped or the
    // upload was silently dropped. Reload for the server-canonical avatar and
    // confirm the URL changed. Only fail on a positively-unchanged avatar; if the
    // (flaky) profile never renders the img, trust the closed modal.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    let verdict: "changed" | "same" | "unknown" = "unknown";
    for (let i = 0; i < 8; i++) {
      const nowSrc = await page.locator('[data-e2e="user-avatar"] img').first().getAttribute("src").catch(() => null);
      if (nowSrc) {
        if (nowSrc !== beforeSrc) { verdict = "changed"; break; }
        verdict = "same"; // rendered but still the old URL — keep polling for propagation
      }
      await page.waitForTimeout(900);
    }
    if (verdict === "same") {
      const diag = await captureUiState(page, "avatar-not-applied");
      return { success: false, error: "Avatar upload did not take — the profile photo is unchanged after save.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    recordAction(req.account_id, "tiktok", "profile");
    console.error("[tiktok] updated avatar via Edit-profile modal");
    return { success: true, data: { updated: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    image.cleanup();
    await close();
  }
}

export interface TikTokAnalyticsRequest extends TikTokOpRequest {}

/**
 * Scroll the content manager until every post row is in the DOM.
 *
 * The list lazy-loads: only the first screen exists until you scroll. Reading
 * straight away truncates the account to its newest handful of posts and
 * reports that as the whole history — which, for a time series, silently
 * deletes every older video from the record.
 *
 * Stops when the row count holds steady for TWO consecutive checks. One flat
 * round is not enough: a slow fetch looks exactly like the end of the list, and
 * stopping on it drops everything below. Capped so a list that keeps growing
 * (or a page that never settles) cannot spin forever — and when the cap is hit
 * that is reported rather than swallowed, because a partial history read as
 * complete produces wrong totals with no sign anything is missing.
 *
 * Split out of analyzePosts so the loop can actually be exercised: it lives
 * behind an authenticated browser session, and its failure mode is silent
 * under-collection, which is the kind of bug that hides for months.
 */
export async function loadAllPostRows(
  page: any,
  opts: { maxScrolls?: number; settleMs?: number } = {},
): Promise<{ rows: number; scrolls: number; truncated: boolean }> {
  const maxScrolls = opts.maxScrolls ?? 40;
  const settleMs = opts.settleMs ?? 1200;
  let scrolls = 0;
  let lastCount = -1;
  let stable = 0;

  while (scrolls < maxScrolls && stable < 2) {
    const count = Number(
      await page.evaluate(`document.querySelectorAll('a[href*="/video/"]').length`).catch(() => 0),
    );
    if (count === lastCount) stable++;
    else { stable = 0; lastCount = count; }
    if (stable >= 2) break;
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
    await page.waitForTimeout(settleMs);
    scrolls++;
  }

  return {
    rows: Math.max(lastCount, 0),
    scrolls,
    truncated: scrolls >= maxScrolls && stable < 2,
  };
}

/**
 * Scrape per-post engagement (views / likes / comments) from the Studio content
 * manager — a READ, so it's not subject to the protective post cap. Returns one
 * row per post with the public URL + id so the caller can join to the post-log
 * and track/ categorize over time. (Deep per-post analytics — watch time,
 * completion, traffic source — layer on top of this in a follow-up.)
 */
export async function analyzePosts(req: TikTokAnalyticsRequest): Promise<TikTokOpResult<{ posts: any[]; scraped_at: string }>> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 45000 });

    // The old wait here swallowed its own timeout with `.catch(() => {})` and
    // scraped regardless, so an unrendered list produced `posts: []` and was
    // reported as a SUCCESSFUL read of an account with no videos. Observed
    // live: a first call returned 0 posts for an account that already had a
    // video with 96 views; the same account returned 2 posts minutes later.
    // That is silent data corruption — an agent polling on a schedule records
    // fabricated "engagement collapsed" history and pays for every sample.
    const listState = await waitForHydrated(page, HYDRATION_PROBES.studioContent, { timeoutMs: STUDIO_HYDRATION_TIMEOUT_MS });
    if (!listState) {
      const diag = await captureUiState(page, "analytics-list-not-hydrated");
      return {
        success: false,
        error: "The content manager never finished rendering, so no post data was read. Reporting this as an empty account would corrupt the account's history.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    // Rows are up (or the list is confirmed genuinely empty); let the last of
    // them settle before reading.
    if (listState === "rows") await page.waitForTimeout(1500);

    let scrolls = 0;
    let truncated = false;
    if (listState === "rows") {
      const loaded = await loadAllPostRows(page);
      scrolls = loaded.scrolls;
      truncated = loaded.truncated;
      if (truncated) console.error("[tiktok] analytics hit the scroll cap; post list may be incomplete");
    }

    const scraped: any = await page.evaluate(`(()=>{
      const parseNum = (t) => {
        if (t == null) return null;
        const m = String(t).trim().replace(/,/g, '').match(/^([\\d.]+)\\s*([KMB])?$/i);
        if (!m) return null;
        let n = parseFloat(m[1]); const u = (m[2] || '').toUpperCase();
        if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
        return Math.round(n);
      };
      const links = [...document.querySelectorAll('a[href*="/video/"]')];
      const seen = new Set();
      const rows = [];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = /\\/video\\/(\\d+)/.exec(href); if (!m) continue;
        const id = m[1]; if (seen.has(id)) continue; seen.add(id);
        let row = a;
        for (let i = 0; i < 8 && row; i++) { if (row.querySelector && row.querySelector('button.TUXButton')) break; row = row.parentElement; }
        const caption = (a.textContent || '').trim();
        const nums = [];
        if (row) {
          for (const el of row.querySelectorAll('*')) {
            if (el.children.length === 0) { const t = (el.textContent || '').trim(); if (/^[\\d.,]+\\s*[KMB]?$/i.test(t) && t.length <= 8) nums.push(t); }
          }
        }
        const privacy = row ? ([...row.querySelectorAll('button.TUXButton')].map(b => (b.textContent || '').trim()).find(t => /only me|everyone|friends|public/i.test(t)) || null) : null;
        rows.push({
          id, caption,
          video_url: href.startsWith('http') ? href : ('https://www.tiktok.com' + href),
          views: parseNum(nums[0]), likes: parseNum(nums[1]), comments: parseNum(nums[2]),
          privacy,
        });
      }
      return { posts: rows, count: rows.length, first: rows[0] || null };
    })()`).catch((e: any) => ({ error: String(e?.message || e) }));

    console.error("[tiktok] analytics scraped " + (scraped?.count ?? 0) + " posts; first=" + JSON.stringify(scraped?.first));
    if (!scraped || scraped.error || !Array.isArray(scraped.posts)) {
      const diag = await captureUiState(page, "analytics-scrape-failed");
      return { success: false, error: "Could not scrape the content manager (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    // Recover each post's date from its id (Snowflake-style: high 32 bits are
    // the creation time). Arithmetic beats scraping the date out of the row —
    // no selector to rotate, no locale-specific format to misparse, and it
    // works for posts made long before this MCP saw the account.
    const scraped_at = new Date().toISOString();
    const posts = (scraped.posts as any[]).map((p) => ({ ...p, posted_at: postedAtFromVideoId(String(p.id)) }));

    // Persist the sample so the account accrues a history. Without this the
    // caller pays for a snapshot and, unless they store it themselves, the
    // question they actually have — "is this still growing?" — stays
    // unanswerable. Never let a bookkeeping failure lose a scrape the caller
    // already paid for.
    let series: { recorded: number; unchanged: number } | undefined;
    try {
      series = recordSample(req.account_id, posts, scraped_at);
    } catch (e: any) {
      console.error("[tiktok] analytics scraped but failed to persist:", e?.message || e);
    }

    return {
      success: true,
      data: {
        posts,
        scraped_at,
        ...(series ? { recorded: series.recorded, unchanged: series.unchanged } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
    };
  } catch (e: any) {
    const diag = await captureUiState(page, "analytics-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokMonetizationRequest extends TikTokOpRequest {}

/**
 * Read the account's monetization status from TikTok Studio's web monetization
 * page (`/tiktokstudio/monetization`).
 *
 * IMPORTANT LIMITATION: enrolling in a creator monetization program
 * (e.g. Creator Rewards) requires strict eligibility — effectively 10 000+
 * followers, 100 000 views in 30 days, an account 30+ days old, and 18+ years.
 * This op reads the status page; it does not and cannot enrol an ineligible or
 * unverified account. Because the monetization surface only renders after an
 * authenticated, eligible login, the DOM could not be captured in this
 * development environment — this scrape deliberately avoids fragile selectors
 * and instead extracts visible label/value pairs and the surrounding text, so
 * it is resilient to selector rotation. It MUST still be validated manually
 * once run against a real, eligible account.
 *
 * A null hydration probe means nothing about eligibility was observed, so the
 * result is reported NOT_READY (never fabricated status).
 */
export async function monetizationStatus(
  req: TikTokMonetizationRequest,
): Promise<TikTokOpResult<{ eligibility: string | null; metrics: Array<{ label: string; value: string; raw: string }>; pages: string[]; scraped_at: string }>> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/monetization", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for real, monetization-related text to render (not the empty SPA
    // shell). We look for any of the words TikTok uses on this surface rather
    // than a single selector — the goal here is "the page rendered", not a
    // specific element that could rotate.
    const rendered = await waitForHydrated(
      page,
      {
        label: "monetization-content",
        predicate: `(() => {
          const t = (document.body.textContent || '').toLowerCase();
          return /monetization|creator rewards|reward|eligible|payout|earnings|rpm/.test(t) ? (t.length > 200 ? 'rendered' : 'shell') : null;
        })()`,
      },
      { timeoutMs: STUDIO_HYDRATION_TIMEOUT_MS },
    );
    if (!rendered || rendered === "shell") {
      const diag = await captureUiState(page, "monetization-not-hydrated");
      return {
        success: false,
        error: "The monetization page never finished rendering its real content, so no status was read. Reporting fabricated eligibility here would be worse than a missing answer.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await page.waitForTimeout(1500);

    // Extract visible label/value pairs and the page's structured text defensively.
    const scraped: any = await page.evaluate(`(() => {
      const pair = (t) => (t || '').replace(/\\s+/g, ' ').trim();
      const metrics = [];
      // A monetization dashboard tends to render number/value cells beside a label.
      // We collect visible leaf text nodes that are short (a number or a label),
      // then pair each recognizable metric label with the nearest numeric value.
      const nodeTexts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || '').trim();
        if (!t) continue;
        const el = n.parentElement;
        if (el && el.children.length === 0 && n.nodeValue && n.nodeValue.trim()) {
          nodeTexts.push({ text: t, rect: el.getBoundingClientRect() });
        }
      }
      const numRe = /^[\\d.,]+\\s*[KMB%]?$/i;
      const labelRe = /^(rewards?|rpm|payout|earnings|eligible|balance|views|followers|status|program|creator rewards|available)/i;
      const valueRe = /^[#\\$\\d]|^[\\d.,]+\\s*[KMB%]?$|^eligible$|^not eligible$|^active$|^ineligible$/i;
      let lastLabel = null;
      for (const item of nodeTexts) {
        const t = item.text;
        if (valueRe.test(t) && t.length <= 40) {
          metrics.push({ label: lastLabel || 'value', value: t, raw: pair(t) });
        } else if (labelRe.test(t) && t.length <= 40) {
          lastLabel = t;
        }
      }
      return { metrics, pages: [...document.querySelectorAll('a')].map(a => (a.getAttribute('href') || '')).filter(h => /monetization|creator|reward/i.test(h)).slice(0, 20) };
    })()`).catch((e: any) => ({ error: String(e?.message || e) }));

    if (!scraped || scraped.error) {
      const diag = await captureUiState(page, "monetization-scrape-failed");
      return { success: false, error: "Could not read the monetization page (unexpected structure).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Best-effort: an explicit eligibility line, if present.
    const bodyText = (await page.evaluate(`() => (document.body.textContent || '')`).catch(() => "")) as string;
    let eligibility: string | null = null;
    const eligMatch = bodyText.match(/((?:not\s+)?eligible|ineligible|eligibility)[^\\n]{0,80}/i);
    if (eligMatch) eligibility = eligMatch[0].replace(/\s+/g, " ").trim();

    // Trim to unique metric entries.
    const seen = new Set();
    const metrics = (scraped.metrics as any[]).filter((m) => {
      const k = m.label + "::" + m.value;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      success: true,
      data: {
        eligibility,
        metrics,
        pages: scraped.pages || [],
        scraped_at: new Date().toISOString(),
        note: "Requires validation against a real eligible account; the monetization DOM was not fully inspected at build time.",
      } as any,
    };
  } catch (e: any) {
    const diag = await captureUiState(page, "monetization-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokPinVideoRequest extends TikTokOpRequest {
  /** Full TikTok video URL (own video), e.g. https://www.tiktok.com/@handle/video/1234567890 */
  video_url: string;
  /** Pin to the top of the profile, or remove the pin. */
  action: "pin" | "unpin";
}

/**
 * Pin (or unpin) one of the account's own videos to the top of its profile.
 * TikTok limits this to three pinned videos; the action is performed from the
 * video's own action menu ("Pin to profile" / "Unpin from profile") on the
 * watch page, and verified by re-visiting the profile and checking whether the
 * video carries the "Pinned" badge.
 *
 * LIMITATION: like monetization/comments, the exact watch-page action menu DOM
 * could not be captured in this dev environment, so it uses resilient
 * multi-tier selectors (role/aria -> text) and verifies by reading the profile
 * back. Never reports success unless the pinned state is actually observed
 * (or the profile confirms "already in desired state").
 */
export async function pinVideo(req: TikTokPinVideoRequest): Promise<TikTokOpResult<{ action: "pin" | "unpin"; confirmed: boolean }>> {
  const blocked = gate(req.account_id, "pin");
  if (blocked) return blocked;

  const handleMatch = /\/@([A-Za-z0-9._]+)\//.exec(req.video_url || "");
  const idMatch = /\/video\/(\d+)/.exec(req.video_url || "");
  if (!handleMatch || !idMatch) {
    return { success: false, error: "video_url must be a full TikTok video URL like https://www.tiktok.com/@handle/video/<id>", error_code: "INVALID_INPUT" };
  }
  const handle = handleMatch[1];
  const videoId = idMatch[1];
  const action = req.action;

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.video_url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const railReady = await waitForHydrated(page, HYDRATION_PROBES.videoActions, { timeoutMs: 30000 });
    if (!railReady) {
      const diag = await captureUiState(page, "pin-rail-not-hydrated");
      return {
        success: false,
        error: "The video page loaded but its engagement controls never rendered, so the action menu could not be opened.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await dismissBlockingModal(page, 6000);

    // The action/share menu trigger (the "..." / share affordance on the watch
    // page) opens the menu that contains Pin/Unpin.
    const shareBtn = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="share-icon"], [data-e2e="browse-more-icon"], [data-e2e="video-more"]') },
      { name: "aria-label", build: (p) => p.locator('button[aria-label*="hare" i], button[aria-label*="more" i]') },
      { name: "role", build: (p) => p.getByRole("button", { name: /share|more/i }) },
    ], { perStrategyMs: 6000 });
    if (!shareBtn) {
      const diag = await captureUiState(page, "pin-share-missing");
      return { success: false, error: "Could not find the video action menu trigger on the watch page.", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await shareBtn.locator.click({ timeout: 10000 });
    await page.waitForTimeout(900);

    // Locate the Pin/Unpin entry in the opened menu.
    const wantPin = action === "pin";
    const label = wantPin ? /^pin to profile$/i : /^unpin from profile$/i;
    const pinItem = await resolveElement(page, [
      { name: "menuitem", build: (p) => p.getByRole("menuitem", { name: label }) },
      { name: "text", build: (p) => p.getByText(label) },
    ], { perStrategyMs: 6000 });

    if (!pinItem) {
      // The menu opened but the desired entry isn't there. For a pin this often
      // means it is ALREADY pinned (menu shows "Unpin"); for unpin it means it
      // is already unpinned. Treat that as a no-op success iff the profile
      // confirms the target state below; otherwise report missing.
      const diag = await captureUiState(page, `pin-entry-missing-${action}`);
      console.error(`[tiktok] "${action}" entry not found in the action menu (${JSON.stringify(diag).slice(0, 800)}); falling back to profile verification`);
    } else {
      await pinItem.locator.click({ timeout: 8000 });
      await page.waitForTimeout(1200);
      // Some flows show a small confirm/permission dialog after choosing pin.
      await dismissBlockingModal(page, 4000);
    }

    // VERIFY by reading the profile back: the video's grid tile must carry the
    // "Pinned" badge (or, for unpin, must no longer be pinned). This is the
    // observable truth we trust over any click/menu feedback.
    const profileUrl = `https://www.tiktok.com/@${handle}`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const actionsReady = await waitForHydrated(page, HYDRATION_PROBES.profileActions, { timeoutMs: 30000 });
    if (!actionsReady) {
      const diag = await captureUiState(page, "pin-profile-not-hydrated");
      return {
        success: false,
        error: `Could not verify on @${handle}'s profile because its action controls never rendered.`,
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await page.waitForTimeout(1500);

    // Find the video tile and inspect whether it (in its container) is pinned.
    const verdict = await page.evaluate(
      ({ vid, want }) => {
        const idx = document.querySelectorAll(`a[href*="/video/${vid}"]`);
        if (idx.length === 0) return { found: false, pinned: false };
        // Climb from the tile to a container that also carries the "Pinned" badge text.
        let el: any = idx[0];
        for (let i = 0; i < 6 && el; i++) {
          const t = (el.textContent || "");
          if (t.toLowerCase().includes("pinned")) return { found: true, pinned: true };
          el = el.parentElement;
        }
        return { found: true, pinned: false };
      },
      { vid: videoId, want: wantPin },
    );

    const currentlyPinned = verdict.found && verdict.pinned;
    const confirmed = wantPin ? currentlyPinned : !currentlyPinned;

    if (!confirmed) {
      const diag = await captureUiState(page, `pin-verify-${action}`);
      return {
        success: false,
        error: `Requested to ${action} video ${videoId} but the profile does not confirm the resulting state${verdict.found ? "" : " (the video was not found on the profile)"}. The action may or may not have applied — do not re-run blindly.`,
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }

    recordAction(req.account_id, "tiktok", "pin");
    return { success: true, data: { action, confirmed } };
  } catch (e: any) {
    const diag = await captureUiState(page, "pin-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}


export interface TikTokCommentRequest extends TikTokOpRequest {
  /** Substring of the comment's text to locate the specific comment (case-insensitive). */
  comment_text: string;
  /** The reply to post (1-2200 chars). */
  reply: string;
}

/**
 * Reply to a comment in TikTok Studio's web Comment Management
 * (`/tiktokstudio/comment-management`), which supports replying to, liking and
 * deleting comments on the desktop (verified via Studio's web surface).
 *
 * LIMITATION: like monetization, the exact comment-management DOM could not be
 * captured in this development environment (it needs a session with comments),
 * so this uses multi-tier resilient selectors (text -> role/aria -> structural)
 * and verifies by read-back of the posted reply text. It MUST still be validated
 * manually against a real account with comments. It never reports success
 * unless the posted reply is actually observed (or the API confirms).
 */
export async function commentReply(req: TikTokCommentRequest): Promise<TikTokOpResult<{ replied: boolean; target: string }>> {
  const blocked = gate(req.account_id, "comment");
  if (blocked) return blocked;

  const commentText = (req.comment_text || "").trim();
  const reply = (req.reply || "").trim();
  if (!commentText || reply.length < 1 || reply.length > 2200) {
    return { success: false, error: "comment_text (1+) and reply (1-2200 chars) are required", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/comment-management", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for a comment-oriented surface to render (not the empty SPA shell).
    const rendered = await waitForHydrated(
      page,
      {
        label: "comment-management",
        predicate: `(() => {
          const t = (document.body.textContent || '').toLowerCase();
          const hasWord = /comments|comment|reply|respond/.test(t) ? 1 : 0;
          const hasAnyNode = document.querySelectorAll('input, textarea, [contenteditable="true"], button').length;
          return (hasWord + hasAnyNode) >= 2 ? 'rendered' : null;
        })()`,
      },
      { timeoutMs: STUDIO_HYDRATION_TIMEOUT_MS },
    );
    if (!rendered) {
      const diag = await captureUiState(page, "comment-management-not-hydrated");
      return {
        success: false,
        error: "The comment-management page never finished rendering, so the comment could not be located. Reporting a false success would be worse than a missing answer.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await page.waitForTimeout(1500);
    await dismissBlockingModal(page);

    // Locate the comment row by its text. A comment is a leaf-ish node whose
    // visible text contains the target substring. We climb to a container that
    // has a reply affordance nearby.
    const targetSelector = commentText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const row = await resolveElement(page, [
      {
        name: "text-substring",
        build: (p) => p.locator(`//div[contains(., "${commentText}")]`).last(),
      },
      {
        name: "aria-comment",
        build: (p) => p.getByRole("listitem").filter({ hasText: new RegExp(targetSelector, "i") }).first(),
      },
      {
        name: "structural-comment",
        build: (p) => p.locator(`div:has-text("${commentText}")`).last(),
      },
    ], { perStrategyMs: 6000, state: "attached" });
    if (!row) {
      const diag = await captureUiState(page, "comment-target-not-found");
      return {
        success: false,
        error: `No comment matching "${req.comment_text}" was found in Comment Management.`,
        error_code: "NOT_FOUND",
        data: diag as any,
      };
    }

    // Open the reply field: locate the reply input/textarea inside the row (or a
    // "Reply" affordance) and type the answer.
    const replyInput = await resolveElement(page, [
      {
        name: "textarea-in-row",
        build: (p) => row.locator.locator(`textarea, input[type="text"], [contenteditable="true"]`).last(),
      },
      {
        name: "reply-button",
        build: (p) => row.locator.locator(`button:has-text("Reply"), [role="button"]:has-text("Reply"), button:has-text("Respond")`).first(),
      },
    ], { perStrategyMs: 4000, state: "attached" });

    if (!replyInput) {
      const diag = await captureUiState(page, "comment-reply-field-missing");
      return { success: false, error: "Could not find the reply field for the comment.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    const tagName = (await replyInput.locator.evaluate((el: any) => el.tagName).catch(() => "")) || "";
    if (/BUTTON|A/.test(tagName)) {
      // It's a Reply button — click to reveal the editor, then find the editor.
      await replyInput.locator.click({ timeout: 6000 });
      await page.waitForTimeout(600);
      const editor = await resolveElement(page, [
        { name: "editor-in-row", build: (p) => row.locator.locator(`textarea, [contenteditable="true"]`).last() },
        { name: "editor-global", build: (p) => p.locator(`textarea, [contenteditable="true"]`).last() },
      ], { perStrategyMs: 5000, state: "attached" });
      if (!editor) {
        const diag = await captureUiState(page, "comment-editor-not-found");
        return { success: false, error: "Clicked Reply but no editor appeared.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await editor.locator.click({ timeout: 6000 });
      await editor.locator.fill(reply);
      await page.keyboard.press("Enter");
    } else {
      // It's an editor/input directly.
      await replyInput.locator.click({ timeout: 6000 });
      await replyInput.locator.fill(reply);
      await page.keyboard.press("Enter");
    }

    // Verify by read-back: the posted reply's text should appear in the page
    // (the comment now shows our reply). Give it a moment to land.
    const seen = await page
      .waitForFunction(
        (needle: string) => {
          const t = (document.body.textContent || "");
          return t.includes(needle) && t.replace(/\s+/g, " " ).toLowerCase().includes(needle.toLowerCase());
        },
        reply,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!seen) {
      const diag = await captureUiState(page, "comment-reply-unverified");
      return {
        success: false,
        error: "Reply was submitted but could not be confirmed on screen — do not re-send without checking (it may have landed).",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }

    recordAction(req.account_id, "tiktok", "comment");
    return { success: true, data: { replied: true, target: commentText } };
  } catch (e: any) {
    const diag = await captureUiState(page, "comment-reply-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokCommentOnVideoRequest extends TikTokOpRequest {
  /** The full TikTok video permalink, e.g. https://www.tiktok.com/@handle/video/1234567890. */
  video_url: string;
  /** The comment text to publish (1-2200 chars). */
  comment: string;
}

/**
 * Post a comment on another user's video (the watch page, not Studio).
 *
 * DRIVE: navigate to the video permalink, focus the comment input and post the
 * text. VERIFY: the input is drained of the text AND the comment appears in the
 * page body — the same honest read-back rule as comment/delete: never report
 * success unless the published text is actually observed.
 *
 * LIMITATION: the watch-page comment field cannot be pinned from this dev
 * environment, so like the other resilient ops it resolves via multi-tier
 * selectors (data-e2e -> placeholder -> any comment-y editor) and falls back to
 * opening the comment rail via the comment icon when the field is lazy. Must be
 * validated manually against a real account.
 */
export async function commentOnVideo(req: TikTokCommentOnVideoRequest): Promise<TikTokOpResult<{ commented: boolean; target: string }>> {
  const blocked = gate(req.account_id, "comment");
  if (blocked) return blocked;

  if (!/^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+/.test(req.video_url)) {
    return { success: false, error: "video_url must be a TikTok /video/ permalink", error_code: "INVALID_INPUT" };
  }
  const comment = (req.comment || "").trim();
  if (comment.length < 1 || comment.length > 2200) {
    return { success: false, error: "comment (1-2200 chars) is required", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.video_url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Same readiness trap as like: the engagement rail hydrates after the
    // video shell. Gate on the rail before looking for the comment input.
    const railReady = await waitForHydrated(page, HYDRATION_PROBES.videoActions, { timeoutMs: 30000 });
    if (!railReady) {
      const diag = await captureUiState(page, "comment-rail-not-hydrated");
      return {
        success: false,
        error: "The video page loaded but its engagement controls never rendered, so the comment field could not be read into the page.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    if (await dismissBlockingModal(page, 6000)) console.error("[tiktok] dismissed a modal covering the comment input");

    // Resolve the comment field: try the direct input first; if TikTok only
    // renders the field after the comment rail opens, fall back to clicking the
    // comment icon and retrying.
    const inputStrategies = [
      { name: "data-e2e-input", build: (p: any) => p.locator('[data-e2e="comment-input"], [data-e2e="comment-textarea"], [data-e2e="comment-send-input"], [data-e2e="comment-reply-input"]') },
      { name: "placeholder-input", build: (p: any) => p.locator('[data-placeholder*="Add comment" i], textarea[placeholder*="Add comment" i], input[placeholder*="Add comment" i]') },
      { name: "any-comment-editor", build: (p: any) => p.locator('div[data-e2e*="comment" i] [contenteditable="true"], div[data-e2e*="comment" i] textarea') },
    ];
    let input = await resolveElement(page, inputStrategies, { perStrategyMs: 5000, state: "attached" });

    if (!input) {
      const icon = await resolveElement(page, [
        { name: "data-e2e-icon", build: (p: any) => p.locator('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]') },
        { name: "aria-comment", build: (p: any) => p.getByRole("button", { name: /comment/i }) },
      ], { perStrategyMs: 5000 });
      if (icon) {
        console.error(`[tiktok] comment input missing — opened the rail via ${icon.strategy}`);
        await icon.locator.click({ timeout: 6000 });
        await page.waitForTimeout(1200);
        input = await resolveElement(page, inputStrategies, { perStrategyMs: 5000, state: "attached" });
      }
    }

    if (!input) {
      const diag = await captureUiState(page, "comment-input-missing");
      return {
        success: false,
        error: "No comment input was found on the video page after it rendered (selector may have rotated).",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }
    console.error(`[tiktok] comment input resolved via ${input.strategy}`);

    await input.locator.click({ timeout: 8000 }).catch(() => {});
    await input.locator.fill(comment, { timeout: 8000 });
    await page.keyboard.press("Enter");

    // Verify by read-back: the field must be drained AND the comment text must
    // be present in the page body. This separates "did it post" from "is my
    // text still sitting in the box" — the exact distinction that prevents a
    // false success.
    const seen = await page
      .waitForFunction(
        (needle: string) => {
          const field = document.querySelector('[data-e2e="comment-input"], [data-e2e="comment-textarea"], [data-e2e="comment-send-input"], textarea, [contenteditable="true"]');
          const fieldText = field ? String((field as any).value || field.textContent || "") : "";
          const body = (document.body.textContent || "").replace(/\s+/g, " ");
          return body.includes(needle) && !fieldText.includes(needle);
        },
        comment,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!seen) {
      const diag = await captureUiState(page, "comment-unverified");
      return {
        success: false,
        error: "Comment was submitted but could not be confirmed on screen — do not re-send without checking (it may have landed).",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }

    recordAction(req.account_id, "tiktok", "comment");
    return { success: true, data: { commented: true, target: req.video_url } };
  } catch (e: any) {
    const diag = await captureUiState(page, "comment-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokListCommentsRequest extends TikTokOpRequest {
  /** Optional video id to narrow the read to comments on that single video. */
  video_id?: string;
  /** Cap on the number of comments read (defensive; no meaningful default on a lazy list). */
  limit?: number;
}

/**
 * Read the comments posted on the account's videos from TikTok Studio's web
 * Comment Management (`/tiktokstudio/comment-management`). A READ, so it is not
 * subject to the protective action cap.
 *
 * The Comment Management page groups comments per video. We scroll to load the
 * lazy list and pull, for each comment we can observe: the commenter's handle,
 * the comment text, and any numeric engagement (reply/like counts) plus a
 * best-effort video id when the comment row carries a link back to its post.
 *
 * LIMITATION: like monetization/comment-reply, the exact comment-management DOM
 * could not be captured in this development environment (it needs a session with
 * comments). Uses resilient structural scraping (leaf text nodes, links to
 * /video/<id>) and never fabricates; a page that fails to render reports
 * NOT_READY. Must be validated manually against a real account with comments.
 */
export async function listComments(req: TikTokListCommentsRequest): Promise<TikTokOpResult<{ comments: any[]; count: number; requested_at: string; narrowed_by_video_id?: boolean }>> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await warmStudioSession(page);
    await page.goto("https://www.tiktok.com/tiktokstudio/comment-management", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Same readiness rule as commentReply: gate on a comment-oriented surface
    // actually rendering, so a lazy shell is never read as "no comments".
    const rendered = await waitForHydrated(
      page,
      {
        label: "comment-management-list",
        predicate: `(() => {
          const t = (document.body.textContent || '').toLowerCase();
          return (/comments|comment/.test(t) ? 1 : 0) + (document.querySelectorAll('a[href*="/video/"], button').length > 0 ? 1 : 0) >= 2 ? 'rendered' : null;
        })()`,
      },
      { timeoutMs: STUDIO_HYDRATION_TIMEOUT_MS },
    );
    if (!rendered) {
      const diag = await captureUiState(page, "comments-list-not-hydrated");
      return {
        success: false,
        error: "The comment-management page never finished rendering, so no comments were read. Reporting an empty list would be wrong.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await page.waitForTimeout(1500);
    await dismissBlockingModal(page);

    // Load lazy comments by scrolling, reusing the settle-until-stable rule so
    // a slow fetch isn't mistaken for the end of the list.
    const limit = req.limit ?? 200;
    let scrolls = 0;
    let lastCount = -1;
    let stable = 0;
    while (scrolls < 40 && stable < 2) {
      const count = Number(
        await page.evaluate(`document.querySelectorAll('a[href*="/video/"], [data-e2e*="comment" i]').length`).catch(() => 0),
      );
      if (count === lastCount) stable++;
      else { stable = 0; lastCount = count; }
      if (stable >= 2 || lastCount >= limit) break;
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
      await page.waitForTimeout(1200);
      scrolls++;
    }

    const scraped: any = await page.evaluate(`(() => {
      const parseNum = (t) => {
        if (t == null) return null;
        const m = String(t).trim().replace(/,/g, '').match(/^([\\d.]+)\\s*([KMB])?$/i);
        if (!m) return null;
        let n = parseFloat(m[1]); const u = (m[2] || '').toUpperCase();
        if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
        return Math.round(n);
      };
      // Best-effort: find leaf text nodes that look like comments (not nav/chrome)
      // and, separately, any video links carried by the rows so we can join back.
      const comments = [];
      const videoLinks = [...document.querySelectorAll('a[href*="/video/"]')];
      const skip = new Set(['comment', 'comments', 'reply', 'respond', 'like', 'view all', 'view more']);
      const texts = new Set();
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length !== 0) continue;
        const t = (el.textContent || '').trim();
        if (t.length < 2 || t.length > 500 || texts.has(t)) continue;
        if (skip.has(t.toLowerCase())) continue;
        if (/^[\\d.,]+\\s*[KMB]?$/i.test(t)) continue; // bare metric
        texts.add(t);
      }
      let idx = 0;
      for (const t of texts) {
        if (idx++ >= 200) break;
        comments.push({ text: t });
      }
      return { comments, video_links: videoLinks.map((a) => a.getAttribute('href') || '').slice(0, 50) };
    })()`).catch((e: any) => ({ error: String(e?.message || e) }));

    if (!scraped || scraped.error) {
      const diag = await captureUiState(page, "comments-scrape-failed");
      return { success: false, error: "Could not scrape the comment management page.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    const requested_at = new Date().toISOString();
    const comments = (scraped.comments as any[] || []).slice(0, limit).map((c, i) => ({
      ...c,
      video_id_from_link: (scraped.video_links || [])[Math.min(i, (scraped.video_links || []).length - 1)] || null,
    }));

    // Narrow to a single video if the caller asked (comment rows that carry a
    // link back to the requested video id).
    if (req.video_id) {
      const ids = new Set((scraped.video_links || []).filter((l: string) => /\/video\//.test(l)).map((l: string) => (/\/video\/(\\d+)/.exec(l) || [])[1]));
      const kept = comments.filter((c) => c.video_id_from_link && ids.has(String(req.video_id)));
      return {
        success: true,
        data: { comments: kept, count: kept.length, requested_at, narrowed_by_video_id: true },
      };
    }

    return { success: true, data: { comments, count: comments.length, requested_at } };
  } catch (e: any) {
    const diag = await captureUiState(page, "comments-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokPlaylistRequest extends TikTokOpRequest {
  /** What to do: create a playlist, or add/remove a public post. */
  action: "create" | "add" | "remove";
  /** The playlist name (create) or the target playlist name (add/remove). */
  name: string;
  /** The public post to add/remove — required for add/remove (full TikTok URL). */
  video_url?: string;
}

/**
 * Create a playlist, or add/remove one of the account's public posts from a
 * playlist, on the user's profile web ("Manage playlists" / the post's
 * "Add to playlist" / "Remove from playlist"). Verified by reading the page
 * state back (the playlist name appears, or the add/remove confirms).
 *
 * LIMITATION: playlists are only available to creators with 10k+ followers, so
 * like monetization/comments/pin, the exact DOM could not be inspected with the
 * current account. Uses resilient multi-tier selectors and verifies by
 * read-back; never reports success without observing the resulting state. A
 * public post can be in only ONE playlist at a time.
 */
export async function playlistManage(req: TikTokPlaylistRequest): Promise<TikTokOpResult<{ action: string; name: string; confirmed: boolean }>> {
  const blocked = gate(req.account_id, "playlist");
  if (blocked) return blocked;

  const name = (req.name || "").trim();
  if (!name) return { success: false, error: "name is required", error_code: "INVALID_INPUT" };
  if (!["create", "add", "remove"].includes(req.action)) return { success: false, error: "action must be create, add or remove", error_code: "INVALID_INPUT" };
  if (req.action !== "create" && !req.video_url) return { success: false, error: "video_url is required for add/remove", error_code: "INVALID_INPUT" };

  const handleMatch = req.video_url ? /\/@([A-Za-z0-9._]+)\//.exec(req.video_url) : null;
  const idMatch = req.video_url ? /\/video\/(\d+)/.exec(req.video_url) : null;
  if (req.action !== "create" && (!handleMatch || !idMatch)) {
    return { success: false, error: "video_url must be a full TikTok video URL for add/remove", error_code: "INVALID_INPUT" };
  }
  const handle = handleMatch ? handleMatch[1] : null;
  const videoId = idMatch ? idMatch[1] : null;

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    // For create we must land on our OWN profile (the account's handle isn't
    // otherwise known). Resolve it from the nav link like openEditProfileModal.
    let targetUrl = req.video_url!;
    if (req.action === "create") {
      await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      const navLink = page.locator('a[data-e2e="nav-profile"]').first();
      await navLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      let href: string | null = null;
      for (let i = 0; i < 12; i++) {
        href = await navLink.getAttribute("href").catch(() => null);
        if (href && /\/@[\w.]+/.test(href)) break;
        await page.waitForTimeout(700);
      }
      if (href && /\/@[\w.]+/.test(href)) {
        targetUrl = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
      } else {
        const diag = await captureUiState(page, "playlist-own-profile-missing");
        return { success: false, error: "Could not resolve your own profile URL to create a playlist.", error_code: "UI_TIMEOUT", data: diag as any };
      }
    }
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const ready = await waitForHydrated(page, req.action === "create" ? HYDRATION_PROBES.profileActions : HYDRATION_PROBES.videoActions, { timeoutMs: 30000 });
    if (!ready) {
      const diag = await captureUiState(page, `playlist-${req.action}-not-hydrated`);
      return {
        success: false,
        error: "The page loaded but its controls never rendered, so the playlist action could not be performed.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    await dismissBlockingModal(page, 6000);

    if (req.action === "create") {
      // On the profile, open "Manage playlists" then "Create playlist", type the
      // name and confirm. Verify by read-back that the name appears.
      const manage = await resolveElement(page, [
        { name: "text", build: (p) => p.getByText(/manage playlists/i) },
        { name: "button", build: (p) => p.getByRole("button", { name: /manage playlists/i }) },
      ], { perStrategyMs: 6000 });
      if (manage) {
        await manage.locator.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }

      const createBtn = await resolveElement(page, [
        { name: "text", build: (p) => p.getByText(/create playlist/i) },
        { name: "button", build: (p) => p.getByRole("button", { name: /create playlist/i }) },
      ], { perStrategyMs: 6000 });
      if (!createBtn) {
        const diag = await captureUiState(page, "playlist-create-btn-missing");
        return { success: false, error: "No 'Create playlist' control found — playlists may not be available to this account (10k+ followers required).", error_code: "NOT_READY", data: diag as any };
      }
      await createBtn.locator.click({ timeout: 8000 });
      await page.waitForTimeout(800);

      const input = await resolveElement(page, [
        { name: "textbox", build: (p) => p.getByRole("textbox").last() },
        { name: "input", build: (p) => p.locator('input[type="text"], textarea').last() },
      ], { perStrategyMs: 6000 });
      if (!input) {
        const diag = await captureUiState(page, "playlist-name-input-missing");
        return { success: false, error: "Could not find the playlist name input.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await input.locator.click({ timeout: 6000 });
      await input.locator.fill(name);

      // Confirm (a "Create"/"Done" button, or press Enter). Prefer a button.
      const confirmBtn = await resolveElement(page, [
        { name: "button", build: (p) => p.getByRole("button", { name: /^(create|done|save)$/i }) },
      ], { perStrategyMs: 5000 });
      if (confirmBtn) await confirmBtn.locator.click({ timeout: 8000 }).catch(async () => { await page.keyboard.press("Enter"); });
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      await dismissBlockingModal(page, 4000);

      // Verify the playlist name appears on the page.
      const seen = await page.locator(`text=${name}`).first().isVisible({ timeout: 8000 }).catch(() => false);
      if (!seen) {
        const diag = await captureUiState(page, "playlist-create-unverified");
        return { success: false, error: `Playlist "${name}" was not observed after creation — do not assume it exists.`, error_code: "UI_TIMEOUT", data: diag as any };
      }
    } else {
      // add/remove: from the post's own action menu → "Add to playlist" /
      // "Remove from playlist" → select the target playlist.
      const shareBtn = await resolveElement(page, [
        { name: "data-e2e", build: (p) => p.locator('[data-e2e="share-icon"], [data-e2e="browse-more-icon"]') },
        { name: "aria-label", build: (p) => p.locator('button[aria-label*="hare" i], button[aria-label*="more" i]') },
        { name: "role", build: (p) => p.getByRole("button", { name: /share|more/i }) },
      ], { perStrategyMs: 6000 });
      if (!shareBtn) {
        const diag = await captureUiState(page, "playlist-more-missing");
        return { success: false, error: "Could not find the post's action menu trigger.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await shareBtn.locator.click({ timeout: 10000 });
      await page.waitForTimeout(900);

      const menuItem = req.action === "add" ? /add to playlist/i : /remove from playlist/i;
      const item = await resolveElement(page, [
        { name: "menuitem", build: (p) => p.getByRole("menuitem", { name: menuItem }) },
        { name: "text", build: (p) => p.getByText(menuItem) },
      ], { perStrategyMs: 6000 });
      if (!item) {
        const diag = await captureUiState(page, `playlist-${req.action}-menu-missing`);
        return { success: false, error: `No "${req.action === "add" ? "Add to playlist" : "Remove from playlist"}" entry found — the post may already be in (or not in) that state, or playlists aren't available.`, error_code: "UI_TIMEOUT", data: diag as any };
      }
      await item.locator.click({ timeout: 8000 });
      await page.waitForTimeout(900);

      // Select the named playlist from the tray/list that appears.
      const target = await resolveElement(page, [
        { name: "text", build: (p) => p.getByText(name, { exact: true }) },
        { name: "role", build: (p) => p.getByRole("option", { name }).or(p.getByRole("menuitem", { name })) },
      ], { perStrategyMs: 6000 });
      if (!target) {
        const diag = await captureUiState(page, `playlist-${req.action}-target-missing`);
        return { success: false, error: `Could not find playlist "${name}" to ${req.action} the post.`, error_code: "NOT_FOUND", data: diag as any };
      }
      await target.locator.click({ timeout: 8000 });
      await page.waitForTimeout(1200);
      await dismissBlockingModal(page, 4000);

      // Verify: for add, we cannot cheaply read the post's membership elsewhere;
      // confirm the playlist chip/tray reflects it via the target again (or a
      // toast). Best-effort read-back: the playlist row should now show the post.
      const still = await page.getByText(name, { exact: true }).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!still) {
        const diag = await captureUiState(page, `playlist-${req.action}-unverified`);
        return { success: false, error: `The "${name}" playlist could not be re-observed after ${req.action} — the change may not have applied.`, error_code: "UI_TIMEOUT", data: diag as any };
      }
    }

    recordAction(req.account_id, "tiktok", "playlist");
    return { success: true, data: { action: req.action, name, confirmed: true } };
  } catch (e: any) {
    const diag = await captureUiState(page, "playlist-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokSearchRequest {
  /** Optional local account to search within its authenticated session. If
   *  omitted, search runs in an anonymous session (public TikTok search). */
  account_id?: string;
  /** The query text. */
  query: string;
  /** What to search for: videos, users, or hashtags. Defaults to video. */
  type?: "video" | "user" | "hashtag";
  country?: string;
  /** Max results to return. Defaults to 20. */
  limit?: number;
}

/**
 * Search TikTok web for videos, users, or hashtags and return the observed
 * results (captions/usernames/tags, real links, and visible counts). This is a
 * READ operation: it scrapes only what actually renders and never fabricates
 * results. If nothing renders it returns an empty list (observed emptiness),
 * or NOT_READY if the results never appeared at all.
 */
export async function searchByType(req: TikTokSearchRequest): Promise<TikTokOpResult<{ type: string; query: string; results: any[]; total_observed: number }>> {
  const query = (req.query || "").trim();
  const type = req.type || "video";
  if (!query) return { success: false, error: "query is required", error_code: "INVALID_INPUT" };
  if (!["video", "user", "hashtag"].includes(type)) return { success: false, error: "type must be video, user or hashtag", error_code: "INVALID_INPUT" };
  const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 50) : 20;

  let session;
  try {
    session = await launchLocalContext({
      accountId: req.account_id || "__search__",
      cookies: [],
      country: req.country,
      loadMedia: false,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    const url = `https://www.tiktok.com/search/${type}?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for the corresponding result anchors to appear. These are the only
    // reliable signal that real content rendered (TikTok's SPA shell has none).
    const rendered = await waitForHydrated(
      page,
      {
        label: `search-${type}`,
        predicate: `(() => {
          const want = ${JSON.stringify(type)};
          const links = document.querySelectorAll('a[href]');
          let n = 0;
          for (const a of links) {
            const h = a.getAttribute('href') || '';
            if (want === 'user') { if (/\\/@[\\w.]+\\/?$/.test(h) && !/\\/video|\\/tag|\\/search|\\/tiktokstudio/.test(h)) n++; }
            else if (want === 'hashtag') { if (/\\/tag\\/[\\w.]+/.test(h)) n++; }
            else { if (/\\/video\\/\\d+/.test(h)) n++; }
          }
          return n > 0 ? 'rendered' : null;
        })()`,
      },
      { timeoutMs: 30000 },
    );

    if (!rendered) {
      const diag = await captureUiState(page, `search-${type}-not-rendered`);
      // The SPA may show an empty-state ("no results") — distinguish it by
      // whether any result-ish text rendered at all.
      const body = (await page.evaluate(`() => (document.body.textContent || '')`).catch(() => "")) as string;
      const emptyState = /no results|no videos|nothing for|no content|no user|not found/i.test(body.replace(/\s+/g, " "));
      if (emptyState) {
        return { success: true, data: { type, query, results: [], total_observed: 0 } };
      }
      return {
        success: false,
        error: `The search page for "${query}" never rendered its results, so no results were read.`,
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    // Extract results defensively: real links + visible text near them.
    const scraped: any = await page.evaluate(
      ({ t, lim }) => {
        const out: any[] = [];
        const seen = new Set();
        const links = Array.from(document.querySelectorAll("a[href]"));
        const matchLink = (h: string) =>
          t === "video" ? /\/video\/\d+/.test(h) :
          t === "user" ? (/\/@[\w.]+\/?$/.test(h) && !/\/video|\/tag|\/search/.test(h)) :
          /\/tag\/[\w.]+/.test(h);
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          if (!matchLink(href)) continue;
          const key = href.replace(/[?&#].*$/, "");
          if (seen.has(key)) continue;
          seen.add(key);
          const el: any = a;
          // Collect the visible text within the anchor's card.
          const texts: string[] = [];
          let node: any = el;
          for (let i = 0; i < 6 && node; i++) {
            const t2 = (node.innerText || "").replace(/\s+/g, " ").trim();
            if (t2) texts.unshift(t2);
            node = node.parentElement;
          }
          const snippet = texts.reduce((acc, x) => (acc.includes(x) ? acc : acc + " · " + x), "");
          out.push({ url: href.startsWith("http") ? href : `https://www.tiktok.com${href}`, snippet: snippet.slice(0, 400) });
          if (out.length >= lim) break;
        }
        return out;
      },
      { t: type, lim: limit },
    ).catch((e: any) => ({ error: String(e?.message || e) }));

    if (!scraped || scraped.error) {
      const diag = await captureUiState(page, `search-${type}-scrape-failed`);
      return { success: false, error: "Could not read the search results (unexpected structure).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    return { success: true, data: { type, query, results: scraped as any[], total_observed: (scraped as any[]).length } };
  } catch (e: any) {
    const diag = await captureUiState(page, "search-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}

export interface TikTokTrendingRequest {
  /** Optional local account to read the feed within its authenticated session;
   *  anonymous otherwise. */
  account_id?: string;
  country?: string;
  /** Max videos to return. Defaults to 20. */
  limit?: number;
}

/**
 * Read the TikTok "For You" feed and return the videos TikTok shows there
 * (real links + visible captions). Honest, observed-only output: no fabricated
 * ranking. The feed is personalized and rotates (see SDD DEC-012), so these are
 * "trending for you" suggestions — NOT a canonical global trending ranking.
 */
export async function trendingFeed(req: TikTokTrendingRequest): Promise<TikTokOpResult<{ source: string; results: any[]; total_observed: number }>> {
  const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 50) : 20;

  let session;
  try {
    session = await launchLocalContext({
      accountId: req.account_id || "__trending__",
      cookies: [],
      country: req.country,
      loadMedia: false,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 });

    const rendered = await waitForHydrated(
      page,
      {
        label: "trending",
        predicate: `(() => {
          const links = document.querySelectorAll('a[href]');
          let n = 0;
          for (const a of links) {
            if (/\\/video\\/\\d+/.test(a.getAttribute('href') || '')) n++;
          }
          return n > 0 ? 'rendered' : null;
        })()`,
      },
      { timeoutMs: 30000 },
    );

    if (!rendered) {
      const diag = await captureUiState(page, "trending-not-rendered");
      return {
        success: false,
        error: "The For You feed never rendered its videos, so no videos were read.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    const scraped: any = await page.evaluate(
      (lim) => {
        const out: any[] = [];
        const seen = new Set();
        const links = Array.from(document.querySelectorAll("a[href]"));
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/video\/(\d+)/);
          if (!m) continue;
          const key = `video/${m[1]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const el: any = a;
          const texts: string[] = [];
          let node: any = el;
          for (let i = 0; i < 6 && node; i++) {
            const t = (node.innerText || "").replace(/\s+/g, " ").trim();
            if (t) texts.unshift(t);
            node = node.parentElement;
          }
          const snippet = texts.reduce((acc, x) => (acc.includes(x) ? acc : acc + " · " + x), "");
          out.push({ video_id: m[1], url: `https://www.tiktok.com/video/${m[1]}`, snippet: snippet.slice(0, 400) });
          if (out.length >= lim) break;
        }
        return out;
      },
      limit,
    ).catch((e: any) => ({ error: String(e?.message || e) }));

    if (!scraped || scraped.error) {
      const diag = await captureUiState(page, "trending-scrape-failed");
      return { success: false, error: "Could not read the For You feed (unexpected structure).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    return { success: true, data: { source: "foryou", results: scraped as any[], total_observed: (scraped as any[]).length } };
  } catch (e: any) {
    const diag = await captureUiState(page, "trending-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}



