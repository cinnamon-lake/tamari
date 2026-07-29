/**
 * Shared Lua request-script transformer.
 *
 * Any backend adapter can call `applyRequestScript()` before `fetch()` to let
 * the user mutate the outgoing HTTP request via a Lua script hook. The script
 * receives a `request` table with `url`, `method`, `headers`, and `body` fields.
 */

import { LuaFactory } from 'wasmoon';
import { URL } from 'node:url';
import ipaddr from 'ipaddr.js';
import dns from 'node:dns';

const luaFactory = new LuaFactory();

export class RequestScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestScriptError';
  }
}

function isBlockedIp(ipStr: string): boolean {
  try {
    const parsed = ipaddr.parse(ipStr);
    if (parsed.kind() === 'ipv6' && 'isIPv4MappedAddress' in parsed && parsed.isIPv4MappedAddress()) {
      const ipv4 = parsed.toIPv4Address();
      const range = ipv4.range();
      return range === 'loopback' || range === 'private' || range === 'unspecified' || range === 'linkLocal';
    }
    const range = parsed.range();
    return (
      range === 'loopback' ||
      range === 'private' ||
      range === 'unspecified' ||
      range === 'linkLocal' ||
      range === 'uniqueLocal'
    );
  } catch {
    return false;
  }
}

function isLoopbackIp(ipStr: string): boolean {
  try {
    const parsed = ipaddr.parse(ipStr);
    if (parsed.kind() === 'ipv6' && 'isIPv4MappedAddress' in parsed && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().range() === 'loopback';
    }
    return parsed.range() === 'loopback';
  } catch {
    return false;
  }
}

/** Loopback by name (`localhost`) or literal IP (127.x, ::1) — the mark of a deliberately configured local backend. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || (ipaddr.isValid(h) && isLoopbackIp(h));
}

export async function assertSafeUrl(url: string, allowLocalhost = false): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RequestScriptError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RequestScriptError(`SSRF blocked: unsupported protocol ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject localhost by name immediately
  if (!allowLocalhost && hostname === 'localhost') {
    throw new RequestScriptError('SSRF blocked: cannot request localhost');
  }

  // If the hostname is a literal IP, validate it directly. Loopback literals
  // (127.x, ::1) are allowed when allowLocalhost is set — same exemption as the
  // `localhost` name; other private ranges stay blocked.
  if (ipaddr.isValid(hostname)) {
    if (isBlockedIp(hostname) && !(allowLocalhost && isLoopbackIp(hostname))) {
      throw new RequestScriptError(`SSRF blocked: cannot request private address ${hostname}`);
    }
    return;
  }

  // Skip DNS rebinding check for localhost when explicitly allowed
  if (allowLocalhost && hostname === 'localhost') {
    return;
  }

  // Resolve the hostname and validate every returned IP (defence against DNS rebinding)
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    // If DNS fails we treat it as unsafe
    throw new RequestScriptError(`SSRF blocked: cannot resolve ${hostname}`);
  }

  for (const addr of addresses) {
    if (isBlockedIp(addr.address)) {
      throw new RequestScriptError(
        `SSRF blocked: ${hostname} resolves to private address ${addr.address}`,
      );
    }
  }
}

export async function applyRequestScript(
  url: string,
  init: RequestInit,
  script: string | undefined,
  extras?: Record<string, unknown>,
  allowLocalhost = false,
): Promise<{ url: string; init: RequestInit }> {
  if (!script?.trim()) {
    await assertSafeUrl(url, allowLocalhost);
    return { url, init };
  }

  // If the adapter's configured endpoint is itself loopback, the user runs a
  // local backend (llama.cpp, a local proxy, …) — the script is allowed to keep
  // talking to loopback. For cloud-configured backends allowLocalhost stays
  // false, so a script still cannot redirect the request to loopback.
  let initialIsLoopback = false;
  try {
    initialIsLoopback = isLoopbackHost(new URL(url).hostname);
  } catch {
    // Invalid URL — assertSafeUrl on the final URL reports it properly.
  }
  const allowLoopback = allowLocalhost || initialIsLoopback;

  const lua = await luaFactory.createEngine({ enableProxy: false, injectObjects: true });
  try {
    // Enforce execution timeout at the Lua VM level (same as LuaRuntime) so a
    // runaway script (e.g. `while true do end`) rejects instead of hanging.
    lua.global.setTimeout(5000);

    // Strip dangerous libraries and functions (same sandbox as QuickReply Lua)
    lua.global.set('io', undefined);
    lua.global.set('os', undefined);
    lua.global.set('debug', undefined);
    lua.global.set('package', undefined);
    lua.global.set('require', undefined);
    lua.global.set('loadfile', undefined);
    lua.global.set('dofile', undefined);
    lua.global.set('load', undefined);
    lua.global.set('loadstring', undefined);

    const requestTable = {
      url,
      method: init.method,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };

    lua.global.set('request', requestTable);

    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        lua.global.set(key, value);
      }
    }

    await lua.doString(script);

    // Lua may return a request table missing any field (or nothing at all), so
    // type the result as Partial — every field access below is guarded with ??.
    const mutated = (lua.global.get('request') as Partial<typeof requestTable> | undefined) ?? requestTable;
    const finalUrl = mutated.url ?? url;
    await assertSafeUrl(finalUrl, allowLoopback);
    return {
      url: finalUrl,
      init: {
        ...init,
        method: (mutated.method) ?? init.method,
        headers: (mutated.headers) ?? init.headers,
        body: mutated.body !== undefined ? JSON.stringify(mutated.body) : init.body,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RequestScriptError(message);
  } finally {
    lua.global.close();
  }
}
