/**
 * Hand-written MCP stdio server (no SDK). One JSON object per line on stdout, nothing else.
 * Methods: initialize, notifications/initialized, ping, tools/list, tools/call.
 * Tools delegate to `client.callTool(name, args)`; a thrown error becomes MCP isError content,
 * while contract-level `{ok:false,error:{...}}` results stay ordinary tool results.
 */
import { TOOLS, getTool } from './tools.mjs';

/** Protocol revisions we speak, newest first (min-negotiation, see initialize). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'dbghub', version: '0.1.0' };

export const SERVER_CAPABILITIES = { tools: { listChanged: false } };

export { TOOLS };

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Negotiate the protocol revision: echo the client's revision when supported, otherwise pick
 * the newest revision we support that is not newer than the request (ISO dates compare as
 * strings). An absent/unknown request gets our newest revision.
 */
export function negotiateProtocolVersion(requested) {
  const want = typeof requested === 'string' ? requested.trim() : '';
  if (want && SUPPORTED_PROTOCOL_VERSIONS.includes(want)) return want;
  if (want) {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) if (v <= want) return v;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id === undefined ? null : id,
  error: data === undefined ? { code, message } : { code, message, data },
});

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function textResult(value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      text = String(value);
    }
  }
  return { content: [{ type: 'text', text }] };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Run the MCP server on the given streams.
 * @param {{stdin: import('node:stream').Readable, stdout: import('node:stream').Writable,
 *          client: {callTool(name:string,args:object):Promise<any>}, version?: string,
 *          onError?: (e:Error)=>void}} opts
 * @returns {{close: () => Promise<void>}}
 */
export function runMcpServer({ stdin, stdout, client, version = SERVER_INFO.version, onError } = {}) {
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('runMcpServer: client.callTool(name,args) is required');
  }
  let closed = false;
  let buffer = '';
  let initialized = false;
  const inflight = new Set();

  const serverInfo = { name: SERVER_INFO.name, version };

  function send(message) {
    if (closed) return;
    let line;
    try {
      line = JSON.stringify(message);
    } catch (e) {
      onError?.(e);
      return;
    }
    try {
      stdout.write(line + '\n');
    } catch (e) {
      onError?.(e);
    }
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        const requested = isObject(params) ? params.protocolVersion : undefined;
        const protocolVersion = negotiateProtocolVersion(requested);
        initialized = true;
        return rpcResult(id, {
          protocolVersion,
          capabilities: SERVER_CAPABILITIES,
          serverInfo,
          instructions:
            'dbghub: persistent debug daemon over MCP. Call discover before open; prefer state/details over re-running. ' +
            'All tools return {ok:true,...} or {ok:false,error:{code,message,hint}}.',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        if (!isObject(params) || typeof params.name !== 'string') {
          return rpcError(id, -32602, 'tools/call requires params.name');
        }
        const name = params.name;
        const args = isObject(params.arguments) ? params.arguments : {};
        if (!getTool(name)) return rpcError(id, -32602, `unknown tool: ${name}`);
        try {
          const value = await client.callTool(name, args);
          return rpcResult(id, textResult(value));
        } catch (e) {
          const payload = {
            ok: false,
            error: {
              code: e && e.code ? String(e.code) : 'E_INTERNAL',
              message: e && e.message ? String(e.message) : String(e),
              ...(e && e.hint ? { hint: String(e.hint) } : {}),
            },
          };
          return rpcResult(id, { ...textResult(payload), isError: true });
        }
      }
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send(rpcError(null, -32700, 'parse error: invalid JSON line'));
      return;
    }
    if (Array.isArray(msg)) {
      // Legacy JSON-RPC batch: answer with an array in one stdout line.
      const out = [];
      for (const item of msg) out.push(await handleOne(item));
      const filtered = out.filter(Boolean);
      if (filtered.length) send(filtered);
      return;
    }
    const response = await handleOne(msg);
    if (response !== null) send(response);
  }

  async function handleOne(msg) {
    if (!isObject(msg)) return rpcError(null, -32600, 'invalid request');
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    if (typeof msg.method !== 'string') {
      // A response from the peer is not expected here; ignore silently.
      return null;
    }
    // Notifications have no id: never reply (MCP notifications/initialized, cancelled, ...).
    if (!hasId) return null;
    return handleRequest(msg);
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      send(rpcError(null, -32700, 'request line exceeds maximum size'));
      return;
    }
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const work = handleLine(line).catch((e) => onError?.(e));
      inflight.add(work);
      work.finally(() => inflight.delete(work));
    }
  }

  function onEnd() {
    // stdin closed by the host: nothing more to answer. The shim exits itself.
  }

  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('error', (e) => onError?.(e));
  if (typeof stdin.on === 'function') stdin.on('close', onEnd);

  return {
    get initialized() {
      return initialized;
    },
    /** Wait (bounded) until every in-flight tools/call has written its response. */
    async awaitDrain(timeoutMs = 1500) {
      if (inflight.size === 0) return;
      let timer;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        stdin.off('data', onData);
      } catch { /* ignore */ }
    },
  };
}
