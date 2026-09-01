import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidHandle,
  isValidVideoPermalink,
  mapTikTokError,
  normalizeHandle,
} from "../runtime/op-validators.js";

test("normalizeHandle strips a leading @ and trims whitespace", () => {
  assert.equal(normalizeHandle("@brand"), "brand");
  assert.equal(normalizeHandle("  @brand  "), "brand");
  assert.equal(normalizeHandle("Brand.User"), "Brand.User");
  assert.equal(normalizeHandle("@"), "");
});

test("isValidHandle accepts valid handles and rejects invalid ones", () => {
  assert.ok(isValidHandle("brand"));
  assert.ok(isValidHandle("Brand.User_01"));
  assert.ok(isValidHandle("a".repeat(24)));
  assert.ok(!isValidHandle(""));
  assert.ok(!isValidHandle("a"));
  assert.ok(!isValidHandle("a".repeat(25)));
  assert.ok(!isValidHandle("@brand"));
  assert.ok(!isValidHandle("has space"));
  assert.ok(!isValidHandle("bad/char"));
});

test("isValidVideoPermalink matches only real /video/ permalinks", () => {
  assert.ok(isValidVideoPermalink("https://www.tiktok.com/@handle/video/1234567890"));
  assert.ok(isValidVideoPermalink("https://tiktok.com/@handle/video/1234567890"));
  assert.ok(isValidVideoPermalink("https://www.tiktok.com/@Handle.User/video/1234567890?lang=en"));
  assert.ok(!isValidVideoPermalink("https://www.tiktok.com/@handle"));
  assert.ok(!isValidVideoPermalink("https://www.youtube.com/@handle/video/123"));
  assert.ok(!isValidVideoPermalink("https://www.tiktok.com/@handle/music/123"));
  assert.ok(!isValidVideoPermalink("https://www.tiktok.com/@handle/video/abc"));
  assert.ok(!isValidVideoPermalink(""));
});

test("mapTikTokError maps status codes and TikTok error codes to our enum", () => {
  assert.equal(mapTikTokError(401), "SESSION_EXPIRED");
  assert.equal(mapTikTokError(403), "SESSION_EXPIRED");
  assert.equal(mapTikTokError(200, 8), "SESSION_EXPIRED");
  assert.equal(mapTikTokError(429), "RATE_LIMITED");
  assert.equal(mapTikTokError(404), "NOT_FOUND");
  assert.equal(mapTikTokError(200, 25000), "CAPTCHA_CHALLENGE");
  assert.equal(mapTikTokError(200, 12000), "RATE_LIMITED");
  assert.equal(mapTikTokError(200, 31000), "INVALID_INPUT");
  assert.equal(mapTikTokError(500), "UNKNOWN");
  assert.equal(mapTikTokError(200, 0), "UNKNOWN");
  assert.equal(mapTikTokError(200, 5), "UNKNOWN");
});
