/**
 * Minimal, provider-agnostic LLM chat client. Talks to any OpenAI-compatible
 * /chat/completions endpoint (OpenAI, Ollama, LM Studio, vLLM, ...). The bot
 * uses it to reason about Telegram instructions and decide which TikTok tool to
 * run. No credentials are hard-coded: the token comes from OPENAI_API_KEY and
 * the base URL from OPENAI_BASE_URL (falls back to the OpenAI default).
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ToolCallSpec {
  name: string;
  arguments: Record<string, any>;
}

export interface LlmTurnResult {
  text?: string;
  toolCall?: ToolCallSpec;
}

/** Structured request: ask the model to either reply in text or call one tool. */
export interface LlmRequest {
  system: string;
  user: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export function llmConfigFromEnv(): LlmConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.TELEGRAM_BOT_MODEL || "gpt-4o-mini",
  };
}

function functionsFor(req: LlmRequest): Array<Record<string, unknown>> {
  return req.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.parameters,
      },
    },
  }));
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: LlmConfig) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 120000;
    this.fetchImpl = config.fetchImpl || fetch;
  }

  /**
   * Run one reasoning turn. Returns the model's reply: either plain text or a
   * request to call a single tool with an argument object. The caller executes
   * the tool and, if needed, can run another turn to summarize the result.
   */
  async complete(req: LlmRequest): Promise<LlmTurnResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: 0,
    };
    const functions = functionsFor(req);
    if (functions.length > 0) {
      body.tools = functions;
      body.tool_choice = "auto";
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const message = payload?.error?.message || `LLM returned HTTP ${response.status}`;
      throw new Error(message);
    }

    const choice = payload?.choices?.[0];
    const messageContent = choice?.message;
    if (!messageContent) throw new Error("LLM returned no choices");

    const toolCalls: any[] = messageContent.tool_calls || [];
    if (toolCalls.length > 0) {
      const call = toolCalls[0];
      let parsed: any = {};
      try {
        parsed = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsed = {};
      }
      return {
        toolCall: { name: call.function?.name || "", arguments: parsed || {} },
      };
    }

    return { text: (messageContent.content || "").trim() };
  }
}
