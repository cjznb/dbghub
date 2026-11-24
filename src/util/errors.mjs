/**
 * Shared error helpers. All tool failures are plain objects; no stack traces cross MCP.
 */

export class DbgError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'DbgError';
    this.code = code;
    this.hint = hint || '';
  }
}

export function err(code, message, hint = '') {
  return new DbgError(code, message, hint);
}

export function toErrorPayload(e) {
  if (e instanceof DbgError) {
    const out = { code: e.code, message: e.message };
    if (e.hint) out.hint = e.hint;
    return out;
  }
  return { code: 'E_INTERNAL', message: e && e.message ? String(e.message) : String(e) };
}

export function ok(fields = {}) {
  return { ok: true, ...fields };
}

export function fail(e) {
  return { ok: false, error: toErrorPayload(e) };
}

/** Wrap an async handler so it never throws across the daemon/MCP boundary. */
export function guard(fn) {
  return async (...args) => {
    try {
      const r = await fn(...args);
      return r && typeof r === 'object' && 'ok' in r ? r : ok(r || {});
    } catch (e) {
      return fail(e);
    }
  };
}
