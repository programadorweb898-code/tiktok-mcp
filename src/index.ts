#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTikTokServer } from "./server.js";
import { TelegramBot } from "./runtime/telegram-bot.js";
import { LocalTikTokRuntime } from "./runtime/local-runtime.js";

function configure(argv: string[]): { telegramBot: boolean } {
  let telegramBot = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--data-dir") process.env.TIKTOK_MCP_DATA_DIR = argv[++index];
    else if (value === "--browser-path") process.env.TIKTOK_BROWSER_PATH = argv[++index];
    else if (value === "--headless") process.env.TIKTOK_HEADLESS = "true";
    else if (value === "--telegram-bot") telegramBot = true;
    else if (value === "--help" || value === "-h") {
      process.stdout.write(
        "TikTok MCP (self-hosted)\n\n" +
        "Usage: tiktok-mcp [--data-dir PATH] [--browser-path PATH] [--headless]\n" +
        "       tiktok-mcp --telegram-bot [--data-dir PATH] [--browser-path PATH]\n\n" +
        "The MCP runs TikTok browser automation entirely on this device over stdio.\n" +
        "Use --telegram-bot to run the Telegram orchestrator instead of stdio MCP.\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${value}`);
  }
  return { telegramBot };
}

async function main(): Promise<void> {
  const { telegramBot } = configure(process.argv.slice(2));
  if (telegramBot) {
    const bot = new TelegramBot(new LocalTikTokRuntime());
    await bot.start();
    return;
  }
  const server = createTikTokServer();
  await server.connect(new StdioServerTransport());
  console.error("[tiktok-mcp] local runtime ready over stdio");
}

main().catch((error) => {
  console.error("[tiktok-mcp]", error instanceof Error ? error.message : error);
  process.exit(1);
});

export { createTikTokServer } from "./server.js";
export { LocalTikTokRuntime } from "./runtime/local-runtime.js";
