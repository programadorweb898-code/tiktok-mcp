#!/usr/bin/env node

import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createTikTokServer } from "./server.js";
import { TelegramBot } from "./runtime/telegram-bot.js";
import { LocalTikTokRuntime } from "./runtime/local-runtime.js";

try {
  process.loadEnvFile?.();
} catch {
  // No .env file present; rely on the process environment.
}

function configure(argv: string[]): { mode: "stdio" | "telegram" | "http"; httpPort: number } {
  let mode: "stdio" | "telegram" | "http" = "stdio";
  let httpPort = 3000;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--data-dir") process.env.TIKTOK_MCP_DATA_DIR = argv[++index];
    else if (value === "--browser-path") process.env.TIKTOK_BROWSER_PATH = argv[++index];
    else if (value === "--headless") process.env.TIKTOK_HEADLESS = "true";
    else if (value === "--telegram-bot") mode = "telegram";
    else if (value === "--http") {
      mode = "http";
      const next = argv[index + 1];
      if (next && /^\d{2,5}$/.test(next)) { httpPort = Number(next); index++; }
    } else if (value === "--help" || value === "-h") {
      process.stdout.write(
        "TikTok MCP (self-hosted)\n\n" +
        "Usage: tiktok-mcp [--data-dir PATH] [--browser-path PATH] [--headless]\n" +
        "       tiktok-mcp --telegram-bot [--data-dir PATH] [--browser-path PATH]\n" +
        "       tiktok-mcp --http [PORT] (default 3000)\n\n" +
        "The MCP runs TikTok browser automation entirely on this device. Over stdio by\n" +
        "default; --telegram-bot runs the Telegram orchestrator; --http exposes the\n" +
        "MCP over Streamable HTTP on the local network (reach it via Tailscale/VPN).\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${value}`);
  }
  return { mode, httpPort };
}

async function serveHttp(port: number): Promise<void> {
  // Streamable HTTP requires one transport (and thus one Server binding) per
  // active session. A single long-lived transport can never be re-initialized,
  // so we multiplex: on each new `initialize` we create a fresh transport +
  // McpServer, key the pair by the session id returned in the handshake, and
  // route the session's later requests to it. DELETE (session/delete) closes
  // and unregisters the session.
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server; createdAt: number }>();

  const httpServer = createServer((nodeReq, nodeRes) => {
    (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const bodyString = body.length > 0 ? body.toString("utf-8") : "";
        const hasBody = !["GET", "HEAD", "DELETE"].includes(nodeReq.method!) && body.length > 0;
        const request = new Request(`http://${nodeReq.headers.host || "localhost"}${nodeReq.url || "/"}`, {
          method: nodeReq.method,
          headers: nodeReq.headers as any,
          body: hasBody ? body : undefined,
        });
        const sessionId = request.headers.get("mcp-session-id") || undefined;
        let isInitialize = false;
        if (nodeReq.method === "POST" && bodyString.length > 0) {
          try {
            const parsed: unknown = JSON.parse(bodyString);
            const messages = Array.isArray(parsed) ? parsed : [parsed];
            isInitialize = messages.some((m) => (m as any)?.method === "initialize");
          } catch { isInitialize = false; }
        }

        let session = sessionId ? sessions.get(sessionId) : undefined;
        if (isInitialize && !session) {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            keepAliveMs: 15000,
          });
          const server = createTikTokServer();
          await server.server.connect(transport);
          session = { transport, server: server.server, createdAt: Date.now() };
        }

        if (!session) {
          const status = nodeReq.method === "DELETE" ? 404 : 404;
          nodeRes.writeHead(status, { "content-type": "application/json" });
          nodeRes.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          return;
        }

        const response = await session.transport.handleRequest(request);
        const newSessionId = response.headers.get("mcp-session-id") || undefined;
        if (newSessionId && !sessions.has(newSessionId)) {
          sessions.set(newSessionId, session);
          session.transport.onclose = () => {
            sessions.delete(newSessionId);
          };
        }
        if (nodeReq.method === "DELETE") {
          sessions.delete(sessionId!);
        }
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            nodeRes.write(Buffer.from(value));
          }
        }
        nodeRes.end();
      } catch (error) {
        nodeRes.writeHead(500, { "content-type": "text/plain" });
        nodeRes.end(`MCP error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  console.error(`[tiktok-mcp] MCP over Streamable HTTP listening on 0.0.0.0:${port} (multi-session)`);
}

async function main(): Promise<void> {
  const { mode, httpPort } = configure(process.argv.slice(2));
  if (mode === "telegram") {
    const bot = new TelegramBot(new LocalTikTokRuntime());
    await bot.start();
    return;
  }
  const server = createTikTokServer();
  if (mode === "http") {
    await serveHttp(httpPort);
    return;
  }
  await server.connect(new StdioServerTransport());
  console.error("[tiktok-mcp] local runtime ready over stdio");
}

main().catch((error) => {
  console.error("[tiktok-mcp]", error instanceof Error ? error.message : error);
  process.exit(1);
});

export { createTikTokServer } from "./server.js";
export { LocalTikTokRuntime } from "./runtime/local-runtime.js";
