// Validate a diagram and, if it fails to parse, ask the model to repair it a bounded number of times.
// `parse` and `repair` are injected so this runs against mermaid in the browser and fakes in tests.
import { sanitizeMermaid } from "./sanitize.js";

export const MAX_REPAIR_ATTEMPTS = 2;

export function errorText(err) {
  const msg = err?.message ?? err?.str ?? String(err);
  return msg.split("\n").slice(0, 6).join("\n").slice(0, 600);
}

/**
 * @param {string} code
 * @param {{ parse: (code: string) => Promise<unknown>, repair: (code: string, error: string) => Promise<string>,
 *           maxAttempts?: number, onRepair?: (info: {attempt: number, maxAttempts: number, error: string}) => void }} deps
 * @returns {Promise<{ok: true, code: string, repairs: number} | {ok: false, code: string, error: string, repairs: number}>}
 */
export async function validateWithRepair(code, { parse, repair, maxAttempts = MAX_REPAIR_ATTEMPTS, onRepair }) {
  let current = sanitizeMermaid(code);
  let repairs = 0;
  for (;;) {
    let error;
    try {
      await parse(current);
      return { ok: true, code: current, repairs };
    } catch (err) {
      error = errorText(err);
    }
    if (repairs >= maxAttempts) return { ok: false, code: current, error, repairs };
    repairs++;
    onRepair?.({ attempt: repairs, maxAttempts, error });
    try {
      const fixed = sanitizeMermaid(await repair(current, error));
      if (fixed) current = fixed;
    } catch (err) {
      return { ok: false, code: current, error: `Repair request failed: ${errorText(err)}`, repairs };
    }
  }
}
