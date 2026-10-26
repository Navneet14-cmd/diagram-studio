import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.mjs";

test("defaults: local Ollama, safe limits, prompts not logged, user keys off", () => {
  const c = loadConfig({});
  assert.equal(c.provider, "ollama");
  assert.equal(c.baseUrl, "http://localhost:11434");
  assert.equal(c.model, "qwen2.5-coder:7b");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.maxTokens, 1500);
  assert.equal(c.rateLimitMax, 30);
  assert.equal(c.logPrompts, false);
  assert.equal(c.allowUserKeys, false);
  assert.equal(c.trustProxy, false);
});

test("openai provider defaults and trailing slash trimming", () => {
  const c = loadConfig({ PROVIDER: "OpenAI", BASE_URL: "https://example.test/v1/" });
  assert.equal(c.provider, "openai");
  assert.equal(c.baseUrl, "https://example.test/v1");
});

test("numeric settings are clamped and booleans parsed", () => {
  const c = loadConfig({ MAX_TOKENS: "999999", PORT: "abc", MAX_BODY_KB: "1", LOG_PROMPTS: "true", ALLOW_USER_KEYS: "1", RATE_LIMIT_MAX: "0" });
  assert.equal(c.maxTokens, 4000);
  assert.equal(c.port, 8787);
  assert.equal(c.maxBodyBytes, 4 * 1024);
  assert.equal(c.logPrompts, true);
  assert.equal(c.allowUserKeys, true);
  assert.equal(c.rateLimitMax, 0);
});
