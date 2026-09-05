import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTikTokServer } from "../server.js";
import { LocalTikTokRuntime } from "../runtime/local-runtime.js";
import { LOCATION_GUIDANCE, QrRelayClient } from "../runtime/qr-relay.js";
import { latestForAccount, recordSample, seriesFor } from "../runtime/tiktok-metrics.js";
import { listAccounts, upsertAccount } from "../runtime/store.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "tiktok-mcp-test-"));
  process.env.TIKTOK_MCP_DATA_DIR = dir;
});

after(async () => {
  delete process.env.TIKTOK_MCP_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

test("persists local accounts and sparse analytics without hosted automation calls", () => {
  upsertAccount({ id: "brand", status: "active", country: "ae", tag: "fitness" });
  assert.equal(listAccounts()[0]?.id, "brand");

  assert.deepEqual(recordSample("brand", [{ id: "7350000000000000000", views: 10, likes: 2 }]), { recorded: 1, unchanged: 0 });
  assert.deepEqual(recordSample("brand", [{ id: "7350000000000000000", views: 10, likes: 2 }]), { recorded: 0, unchanged: 1 });
  assert.equal(seriesFor("brand", "7350000000000000000").length, 1);
  assert.equal(latestForAccount("brand")[0]?.views, 10);
});

test("exposes local tools with no payment fields", async () => {
  const fake = { niches: () => ({ count: 1, niches: [{ id: "test" }] }) } as unknown as LocalTikTokRuntime;
  const server = createTikTokServer({ runtime: fake });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 41);
    assert.ok(listed.tools.every((tool) => tool.name.startsWith("tiktok_") || tool.name === "telegram_send"));
    assert.ok(listed.tools.every((tool) => !(tool.inputSchema.properties as Record<string, unknown> | undefined)?.payment));
    const called = await client.callTool({ name: "tiktok_niches", arguments: {} });
    assert.equal((called.structuredContent as any).count, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("serves the local tools over the packaged stdio entrypoint", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "index.js")],
    env: { ...process.env, TIKTOK_MCP_DATA_DIR: dir } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const called = await client.callTool({ name: "tiktok_niches", arguments: {} });
    assert.equal((called.structuredContent as any).count, 24);
  } finally {
    await client.close();
  }
});

test("creates and refreshes a split-capability QR relay session", async () => {
  const bodies: Record<string, unknown>[] = [];
  const relay = new QrRelayClient("http://127.0.0.1:3999", async (input, init) => {
    assert.equal(new URL(input.toString()).pathname, "/v1/connect/relay");
    bodies.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({
      token: "read-token",
      writer: "read-token.private-writer",
      connect_url: "https://tiktok.palmyr.ai/connect/read-token",
      expires_in_sec: 900,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const created = await relay.create();
  await relay.update(created.writer, "data:image/png;base64,AAAA");
  await relay.complete(created.writer);
  assert.equal(created.connect_url, "https://tiktok.palmyr.ai/connect/read-token");
  assert.deepEqual(bodies, [
    {},
    { token: "read-token.private-writer", qr_data_url: "data:image/png;base64,AAAA" },
    { token: "read-token.private-writer", done: true },
  ]);
  assert.match(LOCATION_GUIDANCE, /same country or a nearby region/i);
});
