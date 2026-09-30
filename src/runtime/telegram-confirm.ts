/**
 * Server-side confirmation gate for destructive Telegram instructions.
 *
 * The orchestrator is the only channel the user commands the agent through, and
 * an instruction (spoken or typed) can be misread. So destructive tools never
 * run on the model's own initiative: the bot holds the call, shows the user
 * exactly which tool and arguments it is about to run, and executes it only
 * after a separate message that says yes.
 *
 * Rules enforced here, not in the prompt:
 *   - a destructive call is parked, never executed;
 *   - only an exact written yes/no authorizes; any other message neither
 *     executes nor discards the parked call;
 *   - a message that arrived as voice can never authorize, because a
 *     transcription is not a deliberate confirmation;
 *   - one yes authorizes exactly one action;
 *   - the parked call expires, so a stale "si" never fires an old intent.
 */

export type InstructionOrigin = "text" | "voice";

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  openedAt: number;
}

export const CONFIRM_REQUIRED: ReadonlySet<string> = new Set([
  "tiktok_post",
  "tiktok_photo_post",
  "tiktok_delete",
  "tiktok_delete_comment",
  "tiktok_unfollow",
  "tiktok_playlist_manage",
  "tiktok_profile",
  "tiktok_update_avatar",
  "tiktok_cancel_scheduled",
]);

const YES = new Set([
  "si", "sí", "s", "dale", "dales", "ok", "okey", "va", "hecho", "listo",
  "confirmo", "confirmá", "confirmar", "autorizo", "adelante", "yes", "y",
]);

const NO = new Set([
  "no", "nel", "nop", "nunca", "nada", "cancela", "cancelar", "olvidalo",
  "olvídalo", "dejalo", "dejálo", "para", "stop", "cancel",
]);

/** Normalize to a comparable token: lowercase, no accents, no punctuation. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^[¿¡\s]+|[!?.,;:¿¡\s]+$/g, "")
    .trim();
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 120 ? `"${flat.slice(0, 117)}..."` : `"${flat}"`;
  }
  const json = JSON.stringify(value);
  return json && json.length > 120 ? `${json.slice(0, 117)}...` : String(json);
}

/** Deterministic, model-free description of what a parked call would do. */
export function describeAction(tool: string, args: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length ? `${tool} con ${parts.join(", ")}` : `${tool} sin argumentos`;
}

export type ConfirmationVerdict = "confirm" | "cancel" | "other";

export class ConfirmationGate {
  private parked: PendingAction | null = null;

  constructor(
    private readonly required: ReadonlySet<string> = CONFIRM_REQUIRED,
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  needsConfirmation(tool: string): boolean {
    return this.required.has(tool);
  }

  open(tool: string, args: Record<string, unknown> | undefined): PendingAction {
    const action: PendingAction = { tool, args: args || {}, openedAt: this.now() };
    this.parked = action;
    return action;
  }

  get pending(): PendingAction | null {
    if (!this.parked) return null;
    if (this.now() - this.parked.openedAt > this.ttlMs) {
      this.parked = null;
      return null;
    }
    return this.parked;
  }

  clear(): void {
    this.parked = null;
  }

  /**
   * Classify the user's next message. A voice message never authorizes: it
   * reports "other" so the parked action survives until the user types.
   */
  classify(text: string, origin: InstructionOrigin): ConfirmationVerdict {
    if (origin !== "text") return "other";
    const token = normalize(text);
    if (!token) return "other";
    if (YES.has(token)) return "confirm";
    if (NO.has(token)) return "cancel";
    return "other";
  }

  /** Hand over the parked call exactly once; the next yes finds nothing. */
  take(): PendingAction | null {
    const action = this.pending;
    this.parked = null;
    return action;
  }
}