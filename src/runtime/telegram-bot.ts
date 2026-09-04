import { TelegramClient, TelegramMessage } from "./telegram.js";
import { LlmClient, llmConfigFromEnv, LlmRequest, LlmTurnResult } from "./llm-client.js";
import { catalogByName, CatalogTool, catalogForPrompt } from "./tool-catalog.js";
import type { LocalTikTokRuntime } from "./local-runtime.js";

/**
 * Telegram orchestrator bot.
 *
 * Polls Telegram for new instructions, asks an LLM to reason about them and
 * pick a TikTok tool, runs that tool against the runtime, and replies on the
 * same chat. It is agnostic to the LLM provider (any OpenAI-compatible
 * endpoint) and only touches Telegram outbound via the Bot API.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN         — required
 *   TELEGRAM_CHAT_ID           — allow a single chat (or comma list)
 *   TELEGRAM_ALLOWED_CHATS     — optional, comma list of numeric chat ids (overrides TELEGRAM_CHAT_ID)
 *   OPENAI_API_KEY             — required for the LLM
 *   OPENAI_BASE_URL            — optional, OpenAI-compatible endpoint
 *   TELEGRAM_BOT_MODEL         — optional default gpt-4o-mini
 *   TELEGRAM_BOT_POLL_MS       — optional polling interval (default 1500)
 */

function allowedChatSet(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_CHATS || process.env.TELEGRAM_CHAT_ID || "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

const SYSTEM_TEMPLATE = `Eres el asistente que controla una cuenta de TikTok a traves de herramientas locales.

El usuario te envia instrucciones por Telegram. Tu trabajo:
1. Decide si necesitas ejecutar una herramienta de TikTok para cumplir la instruccion.
2. Si si, selecciona UNA herramienta del catalogo y provee los argumentos requeridos.
3. Si no, responde directamente en espanol.

Catalogo de herramientas disponibles:
{catalog}

Reglas:
- Use exactly one tool per turn when an action is needed. Never invent tools.
- For reading data (accounts, analytics, comments, trending, search), call the read tool.
- Return tool arguments as a JSON object with the exact parameter names listed.

Responde siempre en espanol.`;

export interface TelegramBotOptions {
  token?: string;
  allowedChats?: string[];
  pollMs?: number;
  fetchImpl?: typeof fetch;
  llm?: LlmClient;
  shouldRun?: (msg: TelegramMessage) => boolean;
}

export class TelegramBot {
  private readonly client: TelegramClient;
  private readonly allowed: Set<string>;
  private readonly pollMs: number;
  private readonly catalog = catalogByName();
  private readonly llm: LlmClient | null;
  private offset = 0;
  private stopped = false;
  private readonly runFilter?: (msg: TelegramMessage) => boolean;

  constructor(
    private readonly runtime: LocalTikTokRuntime,
    private readonly options: TelegramBotOptions = {},
  ) {
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    this.client = new TelegramClient(token, { fetchImpl: options.fetchImpl, timeoutMs: 30000 });
    this.allowed = options.allowedChats
      ? new Set(options.allowedChats.map((s) => String(s)))
      : allowedChatSet();
    this.pollMs = options.pollMs ?? (Number(process.env.TELEGRAM_BOT_POLL_MS) || 1500);
    this.llm = options.llm ?? (llmConfigFromEnv() ? new LlmClient(llmConfigFromEnv()!) : null);
    this.runFilter = options.shouldRun;
  }

  get llmReady(): boolean {
    return this.llm !== null;
  }

  private authorized(chat: number | string): boolean {
    return this.allowed.size === 0 || this.allowed.has(String(chat));
  }

  /** Main loop: poll Telegram and handle each new message. Blocks until stop(). */
  async start(): Promise<void> {
    if (!this.llm) {
      throw new Error(
        "OPENAI_API_KEY is not configured. The Telegram bot needs an LLM to reason. " +
        "Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL / TELEGRAM_BOT_MODEL).",
      );
    }
    console.error(`[telegram-bot] listening (allowed chats: ${this.allowed.size ? [...this.allowed].join(",") : "ANY"})`);
    while (!this.stopped) {
      try {
        const updates = await this.client.getUpdates(this.offset, this.pollMs + 4000);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message?.text) await this.handleMessage(update);
        }
      } catch (error) {
        console.error("[telegram-bot] polling error:", error instanceof Error ? error.message : error);
        await this.delay(2000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async handleMessage(update: TelegramMessage): Promise<void> {
    const message = update.message!;
    const chatId = message.chat.id;
    if (!this.authorized(chatId)) return;
    if (this.runFilter && !this.runFilter(update)) return;
    const text = message.text!.trim();
    if (!text) return;

    try {
      const reply = await this.processInstruction(text, chatId);
      await this.client.sendMessage(reply, chatId);
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      console.error("[telegram-bot] handle error:", errText);
      await this.client.sendMessage(`Error: ${errText}`, chatId).catch(() => undefined);
    }
  }

  /**
   * Core reasoning loop. Exposed for tests: takes a user instruction and
   * returns the natural-language reply (after running any tool the LLM chose).
   */
  async processInstruction(instruction: string, chatId: number | string): Promise<string> {
    if (!this.llm) return "OPENAI_API_KEY no esta configurado. No puedo razonar sin un LLM.";
    const decisions = await this.decide(instruction);
    if (decisions.toolCall) {
      const toolOutcome = await this.runTool(decisions.toolCall.name, decisions.toolCall.arguments);
      const summary = await this.summarize(instruction, decisions.toolCall.name, toolOutcome);
      return summary;
    }
    return decisions.text || "Listo.";
  }

  private async decide(instruction: string): Promise<LlmTurnResult> {
    const tools = [...this.catalog.values()].map((t) => ({
      name: t.name,
      description: t.summary,
      parameters: paramSchema(t),
    }));
    const request: LlmRequest = {
      system: SYSTEM_TEMPLATE.replace("{catalog}", catalogForPrompt()),
      user: instruction,
      tools,
    };
    return this.llm!.complete(request);
  }

  private async runTool(name: string, args: Record<string, any>): Promise<string> {
    const tool = this.catalog.get(name);
    if (!tool) return `Herramienta desconocida: ${name}`;
    try {
      const result = await tool.run(this.runtime, args || {});
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: true, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async summarize(instruction: string, toolName: string, outcome: string): Promise<string> {
    const request: LlmRequest = {
      system:
        "Eres el asistente de TikTok. El usuario pidio: '" + instruction +
        "'. Se ejecuto la herramienta " + toolName + " y este fue el resultado en JSON:\n\n" +
        outcome +
        "\n\nExplica el resultado al usuario en espanol, de forma clara y concisa." +
        " Si el resultado indica una accion asincrona (operation_id), indica que se inicio y que habria que consultar su estado.",
      user: "Resume el resultado.",
      tools: [],
    };
    const res = await this.llm!.complete(request);
    return res.text || "Accion ejecutada.";
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }
}

function paramSchema(tool: CatalogTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of tool.params) {
    properties[param.name] = { type: param.type, description: param.description };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, required };
}
