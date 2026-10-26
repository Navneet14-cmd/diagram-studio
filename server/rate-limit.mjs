// Fixed-window request counter per client key (IP). In-memory: fine for one instance;
// put a shared limiter in front if you run several replicas.

export function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  let lastSweep = now();

  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, entry] of hits) if (t >= entry.resetAt) hits.delete(key);
  }

  /** @returns {{ok: boolean, remaining: number, retryAfterSec: number}} */
  function hit(key) {
    if (!max) return { ok: true, remaining: Infinity, retryAfterSec: 0 };
    const t = now();
    sweep(t);
    let entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    return { ok: entry.count <= max, remaining: Math.max(0, max - entry.count), retryAfterSec };
  }

  return { hit, get size() { return hits.size; } };
}

/** Client IP. Only trusts X-Forwarded-For when explicitly configured (behind a known proxy). */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}
