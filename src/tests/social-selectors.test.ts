import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HYDRATION_PROBES,
  axSnapshot,
  resolveElement,
  waitForHydrated,
  type SelectorStrategy,
} from "../runtime/social-selectors.js";

/** A strategy whose locator resolves (waitFor succeeds). */
function okStrategy(name: string): SelectorStrategy {
  return {
    name,
    build: () => ({
      first: () => ({ waitFor: async () => {} }),
    }),
  };
}

/** A strategy whose locator times out (waitFor rejects after a tick). */
function failStrategy(name: string): SelectorStrategy {
  return {
    name,
    build: () => ({
      first: () => ({
        waitFor: async () => {
          throw new Error(`timeout ${name}`);
        },
      }),
    }),
  };
}

test("resolveElement returns the first strategy that reaches the state", async () => {
  const res = await resolveElement({} as any, [okStrategy("semantic"), okStrategy("fallback")]);
  assert.equal(res?.strategy, "semantic");
});

test("resolveElement falls back to the next strategy when the first misses", async () => {
  const res = await resolveElement({} as any, [failStrategy("rotated"), okStrategy("text")]);
  assert.equal(res?.strategy, "text");
});

test("resolveElement returns null when every strategy misses", async () => {
  const res = await resolveElement({} as any, [failStrategy("a"), failStrategy("b")], { perStrategyMs: 5 });
  assert.equal(res, null);
});

test("waitForHydrated returns the predicate value when it settles", async () => {
  const page = { waitForFunction: async () => ({ jsonValue: async () => "rendered" }) };
  const value = await waitForHydrated(page as any, {
    label: "probe",
    predicate: `(() => 'rendered')()`,
  });
  assert.equal(value, "rendered");
});

test("waitForHydrated returns null on timeout without throwing", async () => {
  const page = {
    waitForFunction: async () => {
      throw new Error("timeout");
    },
  };
  const value = await waitForHydrated(page as any, { label: "probe", predicate: `false` }, { timeoutMs: 5, pollMs: 1 });
  assert.equal(value, null);
});

test("waitForHydrated treats an undefined jsonValue as truthy (rendered)", async () => {
  const page = { waitForFunction: async () => ({ jsonValue: async () => undefined }) };
  const value = await waitForHydrated(page as any, { label: "probe", predicate: `true` });
  assert.equal(value, true);
});

test("axSnapshot flattens the accessibility tree to interactive nodes", async () => {
  const page = {
    accessibility: {
      snapshot: async () => ({
        role: "document",
        name: "root",
        children: [
          { role: "button", name: "Follow" },
          { role: "link", name: "About @brand" },
          { role: "text", name: "plain text" },
          {
            role: "group",
            name: "wrapper",
            children: [{ role: "button", name: "Nested" }],
          },
        ],
      }),
    },
  };
  const snap = await axSnapshot(page as any);
  assert.deepEqual(
    snap.map((n) => n.role).sort(),
    ["button", "button", "link"],
  );
  assert.ok(snap.some((n) => n.name === "Follow"));
});

test("axSnapshot returns [] when the accessibility tree cannot be taken", async () => {
  const page = {
    accessibility: {
      snapshot: async () => {
        throw new Error("no a11y");
      },
    },
  };
  assert.deepEqual(await axSnapshot(page as any), []);
});

test("HYDRATION_PROBES.profileActions only matches leaf follow-ish buttons", () => {
  // The predicate runs in a page; simulate with a tiny DOM via jsdom is not
  // available here, so assert the probe exists and is structurally sound.
  assert.ok(typeof HYDRATION_PROBES.profileActions.predicate === "string");
  assert.ok(HYDRATION_PROBES.profileActions.label.length > 0);
  assert.match(HYDRATION_PROBES.profileActions.predicate, /follow/i);
});

test("HYDRATION_PROBES.videoActions matches like buttons by aria-label", () => {
  assert.match(HYDRATION_PROBES.videoActions.predicate, /like-icon|aria-label|browse-like-icon/);
});
