export interface OpenClawRuntimeConfig {
  endpoint: string;
  timeoutMs?: number;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke;
    };
  }
}

interface NativeRuntimeProbePayload {
  healthy: boolean;
  detail: string;
  endpoint: string;
  checkedAt?: string;
  version?: string;
}

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

export interface OpenClawRuntimeHealth {
  status: 'healthy' | 'error';
  detail: string;
  checkedAt: string;
  version?: string;
}

interface RuntimeEnvelope<T> {
  success?: boolean;
  data?: T;
  message?: string;
}

export async function checkOpenClawRuntime(config: OpenClawRuntimeConfig): Promise<OpenClawRuntimeHealth> {
  const endpoint = normalizeEndpoint(config.endpoint);
  if (!endpoint) {
    throw new Error('请先配置 OpenClaw Runtime 地址');
  }

  const invoke = getInvoke();
  if (invoke) {
    try {
      const payload = await invoke<NativeRuntimeProbePayload>('probe_openclaw_runtime', {
        endpoint,
        timeoutMs: config.timeoutMs ?? 5000,
      });

      if (!payload.healthy) {
        throw new Error(payload.detail || 'Gateway 健康检查失败');
      }

      return {
        status: 'healthy',
        detail: payload.detail || '运行时连接正常',
        checkedAt: payload.checkedAt || new Date().toISOString(),
        version: payload.version,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Older desktop binaries may not include the native probe command yet.
      if (!message.toLowerCase().includes('probe_openclaw_runtime')) {
        throw error;
      }
    }
  }

  // In browser dev mode (no Tauri), route through Vite proxy to avoid CORS
  const healthUrl = resolveGatewayUrl(endpoint, '/health');

  const response = await fetchRuntimeHealthWithRetry(
    healthUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    config.timeoutMs ?? 5000,
  );

  const payload = await tryParseJson<Record<string, unknown>>(response);
  if (!response.ok) {
    throw new Error(extractMessage(payload) || `运行时健康检查失败（${response.status}）`);
  }

  if ((payload as RuntimeEnvelope<Record<string, unknown>> | undefined)?.success === false) {
    throw new Error(extractMessage(payload) || '运行时健康检查返回失败');
  }

  const envelope = payload as RuntimeEnvelope<Record<string, unknown>> | undefined;
  const data = envelope?.data;
  const status = readString(payload, 'status') || readString(data, 'status');
  const version = readString(payload, 'version') || readString(data, 'version');
  const detail = extractMessage(payload) || (status ? `运行时状态：${status}` : '运行时连接正常');

  return {
    status: 'healthy',
    detail,
    checkedAt: new Date().toISOString(),
    version,
  };
}

export function normalizeEndpoint(endpoint: string | undefined) {
  return endpoint?.trim().replace(/\/$/, '') || '';
}

/**
 * In dev mode (both pure browser and Tauri dev), rewrite local gateway
 * URLs through the Vite proxy at `/__local_gateway` to avoid CORS issues.
 * In Tauri dev the WebView loads from localhost:5174 so the Vite proxy
 * is still reachable; only production builds skip the proxy.
 */
function resolveGatewayUrl(endpoint: string, path: string): string {
  if (import.meta.env.DEV) {
    try {
      const url = new URL(endpoint);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return `${window.location.origin}/__local_gateway${path}`;
      }
    } catch { /* not a valid URL, fall through */ }
  }
  return `${endpoint}${path}`;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw normalizeRuntimeFetchError(error, input, timeoutMs);
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchRuntimeHealthWithRetry(input: string, init: RequestInit, timeoutMs: number) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fetchWithTimeout(input, init, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < 4) {
        await delay(700 * attempt);
        continue;
      }
    }
  }

  throw lastError || new Error('Gateway 健康检查失败');
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeRuntimeFetchError(error: unknown, input: string, timeoutMs: number) {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new Error(`Gateway 健康检查超时（${timeoutMs}ms）：${input}`);
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();

  if (normalized === 'load failed.' || normalized === 'load failed' || normalized === 'failed to fetch') {
    return new Error(`Gateway 健康检查连接失败：${input}。Gateway 可能仍在启动中，或本地代理/端口暂不可达`);
  }

  return new Error(message || `Gateway 健康检查失败：${input}`);
}

async function tryParseJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

function extractMessage(payload: Record<string, unknown> | undefined) {
  const envelope = payload as RuntimeEnvelope<Record<string, unknown>> | undefined;
  return readString(payload, 'message') || readString(envelope?.data, 'message');
}

function readString(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === 'string' ? value : undefined;
}
