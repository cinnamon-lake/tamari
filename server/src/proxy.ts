/**
 * System-wide HTTP/HTTPS/SOCKS proxy support.
 *
 * Reads proxy settings from the database (or environment variables as fallback)
 * and configures Node's global HTTP agents so that all outbound `fetch()`
 * requests go through the proxy automatically.
 *
 * Also supports a per-backend "reverse proxy" concept: users can override
 * the default API base URL and supply a separate proxy password.
 * We deliberately do NOT validate API key formats — that breaks legitimate
 * proxy and local-backend setups for no benefit.
 */

import http from 'node:http';
import https from 'node:https';
import { getLogger } from './lib/logger.js';

const log = getLogger('proxy');

let proxyAgent: import('proxy-agent').ProxyAgent | null = null;

export interface ProxySettings {
  enabled: boolean;
  url: string;
  bypass: string[];
}

export function getProxySettings(settings: Record<string, unknown>): ProxySettings {
  // Environment variables take precedence for system-wide proxy
  const envUrl =
    process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? '';
  const envBypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (envUrl) {
    return { enabled: true, url: envUrl, bypass: envBypass };
  }

  // Fall back to database settings
  const bypassRaw = settings['proxy.bypass'];
  return {
    enabled: settings['proxy.enabled'] === true,
    url: typeof settings['proxy.url'] === 'string' ? settings['proxy.url'] : '',
    bypass: Array.isArray(bypassRaw) ? bypassRaw.filter((x): x is string => typeof x === 'string') : [],
  };
}

export async function initProxy(settings: ProxySettings): Promise<void> {
  if (!settings.enabled || !settings.url) {
    return;
  }

  try {
    const { ProxyAgent } = await import('proxy-agent');
    proxyAgent = new ProxyAgent();

    // proxy-agent reads from env vars; set them explicitly from settings
    process.env.ALL_PROXY = settings.url;
    if (settings.bypass.length > 0) {
      process.env.NO_PROXY = settings.bypass.join(',');
    }

    http.globalAgent = proxyAgent;
    https.globalAgent = proxyAgent;

    // System proxy enabled
  } catch (err) {
    log.error({ err }, 'failed to initialize proxy-agent');
  }
}

export function getProxyAgent(): typeof proxyAgent {
  return proxyAgent;
}
