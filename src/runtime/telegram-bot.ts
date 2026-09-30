import { TelegramClient, TelegramMessage } from "./telegram.js";
import { LlmClient, llmConfigFromEnv, LlmRequest, LlmTurnResult } from "./llm-client.js";
import { catalogByName, CatalogTool, catalogForPrompt } from "./tool-catalog.js";
import { awaitOperation, isPendingOperation } from "./operation-await.js";
import { ConfirmationGate, describeAction, InstructionOrigin } from "./telegram-confirm.js";
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
 *   TELEGRAM_BOT_OPERATION_TIMEOUT_MS — optional, how long to wait for an async TikTok operation (default 90000)
 *   TELEGRAM_BOT_CONFIRM_TTL_MS — optional, how long a destructive action waits for a written "si" (default 300000)
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
- Publicar, borrar, dejar de seguir, editar perfil o playlists NO se ejecutan en el mismo turno: el bot se los muestra al usuario y espera un "si" escrito. Nunca digas que la accion ya se hizo ni la des por ejecutada.

Responde siempre en espanol.`;

export interface TelegramBotOptions {
  token?: string;
  allowedChats?: string[];
  pollMs?: number;
  operationPollMs?: number;
  operationTimeoutMs?: number;
  confirmTtlMs?: number;
  fetchImpl?: typeof fetch;
  llm?: LlmClient;
  shouldRun?: (msg: TelegramMessage) => boolean;
}

export class TelegramBot {
  private readonly client: TelegramClient;
  private readonly allowed: Set<string>;
  private readonly pollMs: number;
  private readonly operationPollMs: number;
  private readonly operationTimeoutMs: number;
  private readonly confirmTtlMs: number;
  private readonly catalog = catalogByName();
  private readonly gates = new Map<string, ConfirmationGate>();
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
    this.operationPollMs = options.operationPollMs ?? 2_500;
    this.operationTimeoutMs = options.operationTimeoutMs ?? (Number(process.env.TELEGRAM_BOT_OPERATION_TIMEOUT_MS) || 90_000);
    this.confirmTtlMs = options.confirmTtlMs ?? (Number(process.env.TELEGRAM_BOT_CONFIRM_TTL_MS) || 5 * 60_000);
    this.llm = options.llm ?? (llmConfigFromEnv() ? new LlmClient(llmConfigFromEnv()!) : null);
    this.runFilter = options.shouldRun;
  }

  get llmReady(): boolean {
    return this.llm !== null;
  }

  private gateFor(chatId: number | string): ConfirmationGate {
    const key = String(chatId);
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new ConfirmationGate(undefined, this.confirmTtlMs);
      this.gates.set(key, gate);
    }
    return gate;
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
   *
   * Destructive tools are parked instead of run: the first turn returns a
   * confirmation request, and the call only executes once the user answers with
   * a written yes in a later message.
   */
  async processInstruction(
    instruction: string,
    chatId: number | string,
    options: { origin?: InstructionOrigin } = {},
  ): Promise<string> {
    if (!this.llm) return "OPENAI_API_KEY no esta configurado. No puedo razonar sin un LLM.";
    const origin = options.origin || "text";
    const gate = this.gateFor(chatId);

    const parked = gate.pending;
    if (parked) {
      const verdict = gate.classify(instruction, origin);
      if (verdict === "confirm") {
        const action = gate.take()!;
        const outcome = await this.runTool(action.tool, action.args);
        return this.summarize(`El usuario confirmo por escrito: ${describeAction(action.tool, action.args)}`, action.tool, outcome);
      }
      if (verdict === "cancel") {
        gate.clear();
        return `Cancelado. No se ejecuto nada.`;
      }
      return this.confirmationPrompt(parked.tool, parked.args, origin);
    }

    const decisions = await this.decide(instruction);
    if (decisions.toolCall) {
      const { name, arguments: args } = decisions.toolCall;
      if (gate.needsConfirmation(name)) {
        gate.open(name, args);
        return this.confirmationPrompt(name, args, origin);
      }
      const toolOutcome = await this.runTool(name, args);
      return this.summarize(instruction, name, toolOutcome);
    }
    return decisions.text || "Listo.";
  }

  private confirmationPrompt(tool: string, args: Record<string, unknown>, origin: InstructionOrigin): string {
    const action = describeAction(tool, args);
    if (origin !== "text") {
      return `Recibido por voz, asi que NO lo ejecuto: ${action}. ` +
        "Para confirmar tengo que leer un mensaje escrito: responde SI (texto) para autorizarlo, o NO para descartarlo.";
    }
    return `Falta tu confirmacion para una accion que cambia la cuenta: ${action}\n` +
      "Todavia no se ejecuto nada. Responde SI para autorizar exactamente esa accion, o NO para descartarla.";
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
      const pendingOp = isPendingOperation(result);
      if (pendingOp) {
        const settled = await awaitOperation(this.runtime, pendingOp, {
          timeoutMs: this.operationTimeoutMs,
          pollMs: this.operationPollMs,
          sleep: (ms) => this.delay(ms),
        });
        return JSON.stringify(settled, null, 2);
      }
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
        " Si el resultado trae una accion asincrona con operation_id que sigue en 'pending', indica que esta en curso y que se puede consultar su estado mas tarde.",
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
