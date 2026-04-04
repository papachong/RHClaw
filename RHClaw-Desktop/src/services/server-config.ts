const API_BASE_URL_KEY = 'rhopenclaw_api_base_url';
const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1';

/**
 * In browser dev mode (no Tauri), route API requests through Vite proxy
 * to avoid CORS preflight failures and keep the public repo local-first.
 */
function isDevBrowserMode(): boolean {
  if (!import.meta.env.DEV) return false;
  const w = window as unknown as Record<string, unknown>;
  return !w.__TAURI__ && !w.__TAURI_INTERNALS__;
}

export interface DesktopServerConfig {
  apiBaseUrl: string;
}

export function getApiBaseUrl() {
  if (isDevBrowserMode()) {
    return `${window.location.origin}/api/v1`;
  }
  const stored = localStorage.getItem(API_BASE_URL_KEY);
  return normalizeApiBaseUrl(stored || DEFAULT_API_BASE_URL);
}

export function getDesktopServerConfig(): DesktopServerConfig {
  return {
    apiBaseUrl: getApiBaseUrl(),
  };
}

export function saveDesktopServerConfig(input: { apiBaseUrl: string }) {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  localStorage.setItem(API_BASE_URL_KEY, apiBaseUrl);

  return getDesktopServerConfig();
}

export function resetDesktopServerConfig() {
  localStorage.removeItem(API_BASE_URL_KEY);
  return getDesktopServerConfig();
}

function normalizeApiBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('API 地址必须以 http:// 或 https:// 开头');
  }

  if (/\/api\/v\d+$/i.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/api/v1`;
}