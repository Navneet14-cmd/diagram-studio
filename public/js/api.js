// Thin client for the server API. Errors carry the server's `hint` (e.g. "ollama pull …").

export class ApiError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

// Bring-your-own-key: held in this module's memory only (never localStorage), so a reload forgets it.
let userKey = "";
export const setUserKey = (key) => { userKey = key.trim(); };
export const hasUserKey = () => Boolean(userKey);

function headers() {
  return { "content-type": "application/json", ...(userKey ? { "x-user-api-key": userKey } : {}) };
}

async function send(path, body, signal) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError("Can't reach the Diagram Studio server.", "Check that it is still running.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const retry = res.headers.get("retry-after");
    throw new ApiError(data.error || `Request failed (HTTP ${res.status}).`, data.hint ?? (retry ? `Try again in ${retry}s.` : undefined));
  }
  return res;
}

export async function postJson(path, body, signal) {
  return (await send(path, body, signal)).json();
}

/** POST and consume `text/event-stream`, calling onEvent(name, data) per event. Resolves with the `done` payload. */
export async function postStream(path, body, { signal, onEvent }) {
  const res = await send(path, body, signal);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = block.match(/^event: (.*)$/m)?.[1] ?? "message";
      const raw = block.match(/^data: (.*)$/m)?.[1];
      const data = raw ? JSON.parse(raw) : {};
      if (event === "error") throw new ApiError(data.error || "Generation failed.", data.hint);
      if (event === "done") done = data;
      onEvent?.(event, data);
    }
  }
  if (!done) throw new ApiError("The response ended before the diagram was finished.", "Try again.");
  return done;
}
