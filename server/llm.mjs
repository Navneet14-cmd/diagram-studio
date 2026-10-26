// Minimal chat client for Ollama (/api/chat) and any OpenAI-compatible endpoint (/chat/completions).
// Every call goes through `stream()`; `complete()` just concatenates the deltas.

export class LlmError extends Error {
  constructor(message, { hint, status } = {}) {
    super(message);
    this.hint = hint;
    this.status = status;
  }
}

function ollamaHints(cfg) {
  return {
    down: `Ollama is not reachable at ${cfg.baseUrl}. Start it with:  ollama serve`,
    missing: `Model "${cfg.model}" is not pulled. Run:  ollama pull ${cfg.model}`,
  };
}

async function post(url, body, headers, signal, cfg) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const hint = cfg.provider === "ollama" ? ollamaHints(cfg).down : "Check BASE_URL in the server's .env.";
    throw new LlmError(`Could not reach the ${cfg.provider} server.`, { hint, status: 503 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (cfg.provider === "ollama" && res.status === 404 && /model/i.test(text)) {
      throw new LlmError(`Model "${cfg.model}" was not found in Ollama.`, { hint: ollamaHints(cfg).missing, status: 503 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError("The model provider rejected the API key.", { hint: "Check the API key.", status: 502 });
    }
    if (res.status === 429) throw new LlmError("The model provider is rate limiting requests. Try again shortly.", { status: 503 });
    // Provider error bodies can echo request details; log them server-side only.
    console.warn(`provider HTTP ${res.status}: ${text.slice(0, 300)}`);
    throw new LlmError(`The model provider returned an error (HTTP ${res.status}).`, { status: 502 });
  }
  return res;
}

async function* lines(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

export function createLlm(cfg) {
  async function* stream(messages, { json = false, signal } = {}) {
    if (cfg.provider === "ollama") {
      const res = await post(`${cfg.baseUrl}/api/chat`, {
        model: cfg.model,
        messages,
        stream: true,
        ...(json ? { format: "json" } : {}),
        options: { temperature: cfg.temperature, num_ctx: cfg.numCtx, num_predict: cfg.maxTokens },
      }, {}, signal, cfg);
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new LlmError(msg.error, { status: 502 });
        if (msg.message?.content) yield msg.message.content;
      }
      return;
    }
    if (cfg.provider === "openai") {
      const res = await post(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.model,
        messages,
        stream: true,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }, cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, signal, cfg);
      for await (const line of lines(res.body)) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
      return;
    }
    throw new LlmError(`Unknown PROVIDER "${cfg.provider}". Use "ollama" or "openai".`, { status: 500 });
  }

  async function complete(messages, opts) {
    let out = "";
    for await (const delta of stream(messages, opts)) out += delta;
    return out;
  }

  /** Reachability + model check, used by /api/health and the startup banner. */
  async function health() {
    try {
      if (cfg.provider === "ollama") {
        const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        const { models = [] } = await res.json();
        const names = models.flatMap((m) => [m.name, m.model]);
        const wanted = cfg.model.includes(":") ? cfg.model : `${cfg.model}:latest`;
        if (!names.includes(wanted)) return { ok: false, message: `Model "${cfg.model}" is not pulled.`, hint: ollamaHints(cfg).missing };
        return { ok: true };
      }
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return cfg.apiKey
          ? { ok: false, message: "API key rejected.", hint: "Set a valid API_KEY in .env." }
          : { ok: false, message: "No server API key is configured.", hint: "Set API_KEY in .env." };
      }
      return { ok: true };
    } catch {
      const hint = cfg.provider === "ollama" ? ollamaHints(cfg).down : "Check BASE_URL in .env.";
      return { ok: false, message: `Cannot reach the ${cfg.provider} server.`, hint };
    }
  }

  return { stream, complete, health };
}
