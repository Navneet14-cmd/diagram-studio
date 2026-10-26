import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
// Tests run with a clean environment so a local .env can't change their behaviour.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT) process.loadEnvFile(envFile);

export function loadConfig(env = process.env) {
  const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const n = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  const bool = (name, fallback) => (env[name] === undefined || env[name] === "" ? fallback : /^(1|true|yes|on)$/i.test(env[name]));
  const provider = (env.PROVIDER || "ollama").toLowerCase();

  return {
    provider,
    baseUrl: (env.BASE_URL || (provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1")).replace(/\/+$/, ""),
    model: env.MODEL || (provider === "ollama" ? "qwen2.5-coder:7b" : "gpt-4o-mini"),
    apiKey: env.API_KEY || "",
    host: env.HOST || "127.0.0.1",
    port: int("PORT", 8787, { min: 1, max: 65535 }),

    temperature: 0.2,
    numCtx: 4096,
    maxTokens: int("MAX_TOKENS", 1500, { min: 256, max: 4000 }),
    llmTimeoutMs: int("LLM_TIMEOUT_MS", 120_000, { min: 5_000, max: 600_000 }),

    maxBodyBytes: int("MAX_BODY_KB", 32, { min: 4, max: 1024 }) * 1024,
    maxPromptChars: int("MAX_PROMPT_CHARS", 2000, { min: 100, max: 20_000 }),
    maxCodeChars: int("MAX_CODE_CHARS", 12_000, { min: 1000, max: 100_000 }),

    rateLimitWindowMs: int("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000 }),
    rateLimitMax: int("RATE_LIMIT_MAX", 30, { min: 0 }), // 0 disables
    trustProxy: bool("TRUST_PROXY", false),

    allowUserKeys: bool("ALLOW_USER_KEYS", false),
    logPrompts: bool("LOG_PROMPTS", false),
  };
}

export const config = loadConfig();
