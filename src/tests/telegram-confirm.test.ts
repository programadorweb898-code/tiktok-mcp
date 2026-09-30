import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfirmationGate, describeAction, CONFIRM_REQUIRED } from "../runtime/telegram-confirm.js";

test("gate: reads and analytics never need confirmation", () => {
  const gate = new ConfirmationGate();
  for (const tool of ["tiktok_accounts", "tiktok_profile_analytics", "tiktok_following", "tiktok_search", "tiktok_trending"]) {
    assert.equal(gate.needsConfirmation(tool), false, tool);
  }
});

test("gate: every tool that changes the account needs confirmation", () => {
  const gate = new ConfirmationGate();
  for (const tool of ["tiktok_post", "tiktok_photo_post", "tiktok_delete", "tiktok_delete_comment", "tiktok_unfollow", "tiktok_playlist_manage", "tiktok_profile"]) {
    assert.equal(gate.needsConfirmation(tool), true, tool);
  }
  assert.equal(CONFIRM_REQUIRED.has("tiktok_post"), true);
});

test("gate: only an exact written yes authorizes", () => {
  const gate = new ConfirmationGate();
  gate.open("tiktok_delete", { video_url: "https://www.tiktok.com/@a/video/1" });
  assert.equal(gate.classify("si", "text"), "confirm");
  assert.equal(gate.classify("Sí!", "text"), "confirm");
  assert.equal(gate.classify("  confirmo  ", "text"), "confirm");
  assert.equal(gate.classify("dale", "text"), "confirm");
});

test("gate: a sentence that merely contains a yes does not authorize", () => {
  const gate = new ConfirmationGate();
  gate.open("tiktok_delete", {});
  assert.equal(gate.classify("no borres nada, solo quiero saber si sigue publicado", "text"), "other");
  assert.equal(gate.classify("borrar el video ya publicado?", "text"), "other");
  assert.equal(gate.classify("", "text"), "other");
  assert.ok(gate.pending, "the parked action survives an unrelated message");
});

test("gate: a voice message never authorizes", () => {
  const gate = new ConfirmationGate();
  gate.open("tiktok_post", { caption: "hola" });
  assert.equal(gate.classify("si", "voice"), "other");
  assert.equal(gate.classify("dale", "voice"), "other");
  assert.ok(gate.pending, "the action still waits for a written yes");
});

test("gate: one confirmation authorizes exactly one action", () => {
  const gate = new ConfirmationGate();
  gate.open("tiktok_post", { caption: "a" });
  const first = gate.take();
  assert.equal(first?.tool, "tiktok_post");
  assert.equal(gate.take(), null, "a second yes finds nothing to run");
});

test("gate: a parked action expires so a stale yes cannot fire it", () => {
  let now = 1_000;
  const gate = new ConfirmationGate(undefined, 60_000, () => now);
  gate.open("tiktok_delete", { video_url: "x" });
  now += 30_000;
  assert.ok(gate.pending, "still pending inside the TTL");
  now += 40_000;
  assert.equal(gate.pending, null, "expired past the TTL");
});

test("gate: clear discards the parked action", () => {
  const gate = new ConfirmationGate();
  gate.open("tiktok_unfollow", { target_user: "@x" });
  gate.clear();
  assert.equal(gate.pending, null);
});

test("gate: describeAction renders the exact call without the model", () => {
  const text = describeAction("tiktok_post", { account_id: "brand", caption: "hola", video_path: undefined });
  assert.match(text, /tiktok_post/);
  assert.match(text, /account_id="brand"/);
  assert.match(text, /caption="hola"/);
  assert.doesNotMatch(text, /video_path/);
});

test("gate: describeAction truncates long values instead of dumping them", () => {
  const text = describeAction("tiktok_comment", { comment: "x".repeat(500) });
  assert.ok(text.length < 250, `too long: ${text.length}`);
  assert.match(text, /\.\.\."/);
});

test("gate: describeAction serializes non-string arguments", () => {
  const text = describeAction("tiktok_photo_post", { images: [{ image_path: "a.png" }], limit: 5 });
  assert.match(text, /images=\[\{"image_path":"a.png"\}\]/);
  assert.match(text, /limit=5/);
});