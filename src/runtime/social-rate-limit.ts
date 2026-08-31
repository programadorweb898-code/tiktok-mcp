import { appendAction, readActions } from "./store.js";

export interface RateLimitResult { ok: boolean; reason?: string; retry_after_ms?: number }

const MIN_SPACING_MS = 30_000;
const WINDOWS: Array<{ operations: string[]; windowMs: number; max: number }> = [
  { operations: ["post"], windowMs: 24 * 60 * 60 * 1000, max: 3 },
  { operations: ["follow"], windowMs: 60 * 60 * 1000, max: 20 },
  { operations: ["like"], windowMs: 60 * 60 * 1000, max: 60 },
  { operations: ["comment"], windowMs: 60 * 60 * 1000, max: 20 },
];

export function checkRateLimit(accountId: string, _platform: "tiktok", operation: string): RateLimitResult {
  const now = Date.now();
  const rows = readActions(accountId).sort((a, b) => b.acted_at - a.acted_at);
  const last = rows[0];
  if (last && now - last.acted_at < MIN_SPACING_MS) {
    return {
      ok: false,
      reason: "Wait 30 seconds between actions on the same account to protect it.",
      retry_after_ms: MIN_SPACING_MS - (now - last.acted_at),
    };
  }
  for (const window of WINDOWS) {
    if (!window.operations.includes(operation)) continue;
    const used = rows.filter((row) => window.operations.includes(row.operation) && row.acted_at > now - window.windowMs).length;
    if (used >= window.max) {
      return {
        ok: false,
        reason: `Protective account cap reached (${window.max} ${operation} actions in this window).`,
        retry_after_ms: window.windowMs,
      };
    }
  }
  return { ok: true };
}

export function recordAction(accountId: string, _platform: "tiktok", operation: string): void {
  appendAction(accountId, operation);
}
