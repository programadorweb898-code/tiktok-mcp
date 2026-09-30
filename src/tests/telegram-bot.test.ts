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
  // `done` mirrors operationView: a finished operation always reports it, so the
  // bot stops polling instead of waiting out the whole timeout.
  const fakeRuntime = {
    follow: async ({ account_id, target_user }: any) => {
      ran = `${account_id}:${target_user}`;
      return { operation_id: "op-1", status: "pending" };
    },
    operationStatus: () => ({
      operation_id: "op-1",
      status: "done",
      done: true,
      result: { success: true },
    }),
  } as unknown as LocalTikTokRuntime;

  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
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
    operationTimeoutMs: 200,
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

test("telegram bot: an operation that never finishes is reported as pending, not waited out", async () => {
  const fakeRuntime = {
    profileAnalytics: async () => ({ operation_id: "op-stuck", status: "pending" }),
    operationStatus: () => ({ operation_id: "op-stuck", status: "running", done: false }),
  } as unknown as LocalTikTokRuntime;

  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 50,
    llm: stubLlm([
      { toolCall: { name: "tiktok_profile_analytics", arguments: { account_id: "brand" } } },
      { text: "Sigue en curso." },
    ]),
  });

  const started = Date.now();
  const reply = await bot.processInstruction("A cuantas personas sigo", 123);
  assert.ok(Date.now() - started < 5_000, "must give up on the timeout instead of hanging");
  assert.match(reply, /en curso/i);
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

function publishingRuntime(calls: string[]): LocalTikTokRuntime {
  return {
    post: async (input: any) => {
      calls.push(`${input.account_id}:${input.caption}`);
      return { operation_id: "op-post", status: "pending" };
    },
    operationStatus: () => ({
      operation_id: "op-post",
      status: "done",
      done: true,
      result: { success: true, video_url: "https://www.tiktok.com/@brand/video/7" },
    }),
  } as unknown as LocalTikTokRuntime;
}

test("telegram bot: a destructive tool is parked, never run on the same turn", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Publicado." },
    ]),
  });

  const parked = await bot.processInstruction("Publica un video con el texto primer post", 123);
  assert.deepEqual(calls, [], "the publish must not run before the user confirms");
  assert.match(parked, /primer post/);
  assert.match(parked, /SI/);
  assert.doesNotMatch(parked, /Publicado/);
});

test("telegram bot: a written yes runs exactly the parked action", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Listo, ya esta publicado." },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  const reply = await bot.processInstruction("si", 123);
  assert.deepEqual(calls, ["brand:primer post"]);
  assert.match(reply, /publicado/);
});

test("telegram bot: a second yes does not repeat the confirmed action", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Listo, ya esta publicado." },
      { text: "No hay nada pendiente de confirmar." },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  await bot.processInstruction("si", 123);
  const reply = await bot.processInstruction("si", 123);
  assert.deepEqual(calls, ["brand:primer post"]);
  assert.match(reply, /nada pendiente/);
});

test("telegram bot: a voice message cannot authorize a parked action", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Listo, ya esta publicado." },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  const reply = await bot.processInstruction("si, dale", 123, { origin: "voice" });
  assert.deepEqual(calls, [], "a transcribed yes must not publish");
  assert.match(reply, /escrito/i);
});

test("telegram bot: an unrelated message keeps the action parked and skips the LLM", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  // The stub throws when the bot asks the LLM again, so this proves the parked
  // action short-circuits the reasoning loop instead of re-planning.
  const reply = await bot.processInstruction("espera, mejor no", 123);
  assert.deepEqual(calls, []);
  assert.match(reply, /SI/);
  assert.match(reply, /NO/);
});

test("telegram bot: a written no discards the parked action", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Entendido, no hay ninguna accion pendiente." },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  const reply = await bot.processInstruction("no", 123);
  assert.match(reply, /Cancelado/);
  const after = await bot.processInstruction("si", 123);
  assert.deepEqual(calls, [], "the discarded action cannot be revived");
  assert.match(after, /ninguna accion pendiente/, "the discarded action is gone, so the yes is a normal instruction");
});

test("telegram bot: a parked action expires instead of waiting forever", async () => {
  const calls: string[] = [];
  const bot = new TelegramBot(publishingRuntime(calls), {
    token: "test-token",
    allowedChats: ["123"],
    confirmTtlMs: 1,
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_post", arguments: { account_id: "brand", caption: "primer post" } } },
      { text: "Entendido, interprete tu si como una instruccion nueva." },
    ]),
  });

  await bot.processInstruction("Publica un video con el texto primer post", 123);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reply = await bot.processInstruction("si", 123);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(reply, /publicado/, "the expired yes is treated as a plain instruction");
});

test("telegram bot: reads still run without any confirmation", async () => {
  let polls = 0;
  const fakeRuntime = {
    profileAnalytics: async () => ({ operation_id: "op-read", status: "pending" }),
    operationStatus: () => {
      polls += 1;
      return { operation_id: "op-read", status: "done", done: true, result: { profile: { counts: { followers: 7 } } } };
    },
  } as unknown as LocalTikTokRuntime;

  const bot = new TelegramBot(fakeRuntime, {
    token: "test-token",
    allowedChats: ["123"],
    operationPollMs: 1,
    operationTimeoutMs: 200,
    llm: stubLlm([
      { toolCall: { name: "tiktok_profile_analytics", arguments: { account_id: "brand" } } },
      { text: "Tenes 7 seguidores." },
    ]),
  });

  const reply = await bot.processInstruction("Cuantos seguidores tengo", 123);
  assert.equal(polls, 1);
  assert.match(reply, /7 seguidores/);
});
