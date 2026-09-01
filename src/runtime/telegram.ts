export const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramSendResult {
  ok: boolean;
  message_id?: number;
  chat_id?: number | string;
  description?: string;
}

export interface TelegramMessage {
  update_id: number;
  /** Present on normal user-message updates. */
  message?: {
    message_id: number;
    chat: { id: number | string; type?: string; title?: string; first_name?: string; username?: string };
    text?: string;
    from?: { id: number; first_name?: string; username?: string };
    date?: number;
  };
}

export interface TelegramClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Minimal Telegram Bot API client. Reads the bot token from the constructor
 * (which callers resolve from `TELEGRAM_BOT_TOKEN`); never hard-codes
 * credentials. `fetchImpl` is injectable for tests, mirroring QrRelayClient.
 */
export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    private readonly options: TelegramClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  private endpoint(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
  }

  async sendMessage(text: string, chatId: number | string): Promise<TelegramSendResult> {
    const response = await this.fetchImpl(this.endpoint("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as TelegramSendResult & { error?: string };
    if (!response.ok) throw new Error(payload.description || payload.error || `Telegram returned HTTP ${response.status}`);
    if (!payload.ok) throw new Error(payload.description || "Telegram sendMessage returned ok=false");
    return payload;
  }

  async getUpdates(): Promise<TelegramMessage[]> {
    const response = await this.fetchImpl(this.endpoint("getUpdates"), {
      method: "GET",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: TelegramMessage[]; error?: string };
    if (!response.ok) throw new Error(payload.error || `Telegram returned HTTP ${response.status}`);
    if (!payload.ok) throw new Error("Telegram getUpdates returned ok=false");
    return payload.result || [];
  }
}

/** Bot token from the environment, or undefined if not configured. */
export function telegramBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

/** Default target chat id from the environment, or undefined if not configured. */
export function telegramChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID;
}
