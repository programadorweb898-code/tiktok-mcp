import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LocalTikTokRuntime } from "../runtime/local-runtime.js";
import { TelegramBot } from "../runtime/telegram-bot.js";
import { LlmClient, LlmRequest, LlmTurnResult } from "../runtime/llm-client.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "tiktok-mcp-telegram-test-"));
  process.env.TIKTOK_MCP_DATA_DIR = dir;
  // Fixed token so the bot can construct its TelegramClient; polling is never
  // exercised in these tests (only the reasoning loop), so no real requests hit
  // the Telegram API.
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

after(async () => {
  delete process.env.TIKTOK_MCP_DATA_DIR;
  delete process.env.TELEGRAM_BOT_TOKEN;
  await rm(dir, { recursive: true, force: true });
});

function stubLlm(decisions: LlmTurnResult[]): LlmClient {
  // Cast a plain object so the bot's `complete` call is a no-network stub.
  return {
    complete: async (_req: LlmRequest): Promise<LlmTurnResult> => {
      const next = decisions.shift();
      if (!next) throw new Error("no more stubbed decisions");
      return next;
    },
  } as unknown as LlmClient;
}

test("telegram bot: tool decision dispatches to runtime and summarizes", async () => {
  let ran = "";
  const fakeRuntime = {
    follow: async ({ account_id, target_user }: any) => {
      ran = `${account_id}:${target_user}`;
      return { operation_id: "op-1", status: "pending" };
    },
    operationStatus: () => ({
      operation_id: "op-1",
      status: "done",
      result: { success: true },
    }),
  } as unknown as LocalTikTokRuntime;

  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    llm: stubLlm([
      { toolCall: { name: "tiktok_follow", arguments: { account_id: "brand", target_user: "@x" } } },
      { text: "Listo, empece a seguir a @x en la cuenta brand." },
    ]),
  });

  const reply = await bot.processInstruction("Seguí a @x desde la cuenta brand", 123);
  assert.equal(ran, "brand:@x");
  assert.match(reply, /@x/);
});

test("telegram bot: pending async operations are awaited and reported with the final result", async () => {
  let polls = 0;
  const fakeRuntime = {
    profileAnalytics: async () => ({ operation_id: "op-9", status: "pending" }),
    operationStatus: () => {
      polls += 1;
      if (polls < 2) return { operation_id: "op-9", status: "running", done: false };
      return { operation_id: "op-9", status: "done", done: true, result: { profile: { counts: { following: 42 } } } };
    },
  } as unknown as LocalTikTokRuntime;

  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    llm: stubLlm([
      {
        toolCall: { name: "tiktok_profile_analytics", arguments: { account_id: "brand" } },
      },
      { text: "El perfil de brand tiene 42 seguidos." },
    ]),
  });

  const reply = await bot.processInstruction("A cuantas personas sigo", 123);
  assert.equal(polls, 2);
  assert.match(reply, /42/);
});

test("telegram bot: text-only reply when no tool is needed", async () => {
  const fakeRuntime = {} as unknown as LocalTikTokRuntime;
  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    llm: stubLlm([{ text: "Hola, soy el asistente de TikTok." }]),
  });

  const reply = await bot.processInstruction("hola", 123);
  assert.equal(reply, "Hola, soy el asistente de TikTok.");
});

test("telegram bot: unknown tool still yields a reply through the summarize step", async () => {
  const fakeRuntime = {} as unknown as LocalTikTokRuntime;
  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    llm: stubLlm([
      { toolCall: { name: "tiktok_does_not_exist", arguments: {} } },
      { text: "Esa accion no esta disponible en este momento." },
    ]),
  });
  const reply = await bot.processInstruction("hacé algo raro", 123);
  assert.equal(reply, "Esa accion no esta disponible en este momento.");
});

test("telegram bot: missing LLM config is reported instead of crashing", async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot({} as unknown as LocalTikTokRuntime, {
    token: "test-token",
    llm: undefined,
  });
  // Without a configured LLM the bot refuses to start polling but still gives
  // a clear signal via processInstruction.
  const reply = await bot.processInstruction("hola", 123);
  assert.match(reply, /OPENAI_API_KEY/);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});
