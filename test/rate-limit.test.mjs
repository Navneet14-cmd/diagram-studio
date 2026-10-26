import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, createRateLimiter } from "../server/rate-limit.mjs";

test("allows up to max requests per window, then blocks with a retry hint", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 10_000, max: 3, now: () => t });
  assert.equal(rl.hit("a").ok, true);
  assert.equal(rl.hit("a").ok, true);
  const third = rl.hit("a");
  assert.equal(third.ok, true);
  assert.equal(third.remaining, 0);
  const fourth = rl.hit("a");
  assert.equal(fourth.ok, false);
  assert.equal(fourth.retryAfterSec, 10);
  t = 4_000;
  assert.equal(rl.hit("a").retryAfterSec, 6);
});

test("keys are independent", () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
  assert.equal(rl.hit("a").ok, true);
  assert.equal(rl.hit("a").ok, false);
  assert.equal(rl.hit("b").ok, true);
});

test("window resets and old entries are swept", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  rl.hit("a");
  rl.hit("b");
  assert.equal(rl.hit("a").ok, false);
  t = 1500;
  assert.equal(rl.hit("a").ok, true);
  assert.equal(rl.size, 1); // "b" expired and was swept
});

test("max 0 disables limiting", () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 0 });
  for (let i = 0; i < 100; i++) assert.equal(rl.hit("a").ok, true);
});

test("X-Forwarded-For is only trusted when configured", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientIp(req, false), "10.0.0.1");
  assert.equal(clientIp(req, true), "203.0.113.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::1" } }, true), "::1");
});
