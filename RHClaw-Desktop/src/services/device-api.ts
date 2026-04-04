import packageJson from '../../package.json';
import { getApiBaseUrl } from './server-config';
const DEVICE_CODE_KEY = 'rhopenclaw_device_code';

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

interface RegisterDeviceResponse {
  success: boolean;
  data: {
    device: {
      id: string;
      deviceCode: string;
      deviceName?: string;
      deviceAlias?: string;
      ownerUserId?: string | null;
      status: string;
    };
    token: {
      deviceToken: string;
      expiresAt: string;
    };
  };
}

interface BindSessionResponse {
  success: boolean;
  data: {
    bindSession: {
      sessionId: string;
      sessionToken: string;
      expiresAt: string;
      miniProgramPath: string;
      bindUrlLink?: string;
      bindLaunchToken?: string;
      device: {
        id: string;
        deviceCode: string;
        deviceName?: string;
        deviceAlias?: string;
      };
    };
  };
}

export interface BindSessionHint {
  loginRequired?: boolean;
  canAutoConfirm?: boolean;
  conflictType?: 'none' | 'device_already_bound' | 'quota_exceeded' | 'replace_required';
}

export interface BindSessionStatusData {
  bindSession: {
    sessionToken: string;
    status: 'pending' | 'confirmed' | 'expired' | 'cancelled' | 'abandoned' | 'replaced';
    expiresAt: string;
    confirmedByUserId?: string | null;
    miniProgramPath?: string;
    bindLaunchToken?: string;
  };
  device: {
    id: string;
    ownerUserId?: string | null;
    bindAt?: string | null;
    status: string;
    deviceName?: string;
    deviceAlias?: string;
    deviceCode: string;
  };
  bindHint?: BindSessionHint;
  executionAllowed?: boolean;
  executionBlockReason?: string | null;
  subscriptionStatus?: string | null;
  nextAction?: string | null;
  message?: string;
}

interface BindSessionStatusResponse {
  success: boolean;
  data: BindSessionStatusData;
}

export interface CurrentDeviceProfileData {
  device: {
    id: string;
    deviceCode: string;
    deviceName?: string;
    deviceAlias?: string;
    ownerUserId?: string | null;
    status: string;
  };
  owner: {
    id: string;
    nickname?: string | null;
    wechatOpenid?: string | null;
    status: string;
  } | null;
  checkedAt: string;
}

interface CurrentDeviceProfileResponse {
  success: boolean;
  data: CurrentDeviceProfileData;
}

interface AbandonBindSessionResponse {
  success: boolean;
  data: {
    sessionToken: string;
    status: 'abandoned';
    reapAfter?: string;
    message?: string;
  };
}

export function getOrCreateDeviceCode() {
  const existing = localStorage.getItem(DEVICE_CODE_KEY);
  if (existing) {
    return existing;
  }

  const generated = crypto.randomUUID();
  localStorage.setItem(DEVICE_CODE_KEY, generated);
  return generated;
}

export async function registerDevice(deviceCode: string) {
  const native = await invokeNativeHttp<RegisterDeviceResponse['data']>('register_device_http', {
    apiBaseUrl: getApiBaseUrl(),
    deviceCode,
  });
  if (native) {
    return native;
  }

  const url = `${getApiBaseUrl()}/devices/register`;
  const identity = getDesktopClientIdentity();
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      deviceCode,
      platform: identity.platform,
      appVersion: identity.appVersion,
      protocolVersion: identity.protocolVersion,
    }),
  });

  return parseResponse<RegisterDeviceResponse>(response);
}

function getDesktopClientIdentity() {
  return {
    platform: detectBrowserPlatformLabel(),
    appVersion: packageJson.version || 'unknown',
    protocolVersion: '1',
  };
}

function detectBrowserPlatformLabel() {
  const value = typeof navigator !== 'undefined'
    ? ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '')
    : '';
  const normalized = value.toLowerCase();
  if (normalized.includes('mac')) {
    return 'macOS';
  }
  if (normalized.includes('win')) {
    return 'Windows';
  }
  if (normalized.includes('linux')) {
    return 'Linux';
  }
  return 'browser-shell';
}

export async function createBindSession(deviceToken: string) {
  const native = await invokeNativeHttp<BindSessionResponse['data']>('create_bind_session_http', {
    apiBaseUrl: getApiBaseUrl(),
    deviceToken,
  });
  if (native) {
    return native;
  }

  const url = `${getApiBaseUrl()}/devices/bind-session`;
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceToken}`,
    },
    body: JSON.stringify({ ttlMinutes: 10 }),
  });

  return parseResponse<BindSessionResponse>(response);
}

export async function getBindSessionStatus(deviceToken: string, sessionToken: string) {
  const native = await invokeNativeHttp<BindSessionStatusResponse['data']>('get_bind_session_status_http', {
    apiBaseUrl: getApiBaseUrl(),
    deviceToken,
    sessionToken,
  });
  if (native) {
    return native;
  }

  const url = `${getApiBaseUrl()}/devices/bind-session/${sessionToken}/status`;
  const response = await requestJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${deviceToken}`,
    },
  });

  return parseResponse<BindSessionStatusResponse>(response);
}

export async function getCurrentDeviceProfile(deviceToken: string) {
  const native = await invokeNativeHttp<CurrentDeviceProfileResponse['data']>('get_current_device_profile_http', {
    apiBaseUrl: getApiBaseUrl(),
    deviceToken,
  });
  if (native) {
    return native;
  }

  const response = await requestJson(`${getApiBaseUrl()}/devices/me/profile`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${deviceToken}`,
    },
  });

  return parseResponse<CurrentDeviceProfileResponse>(response);
}

export async function abandonBindSession(deviceToken: string, sessionToken: string) {
  const url = `${getApiBaseUrl()}/devices/bind-session/${sessionToken}/abandon`;
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceToken}`,
    },
    body: JSON.stringify({ reason: 'desktop_user_abandon' }),
  });

  return parseResponse<AbandonBindSessionResponse>(response);
}

async function parseResponse<T extends { success: boolean; data: unknown; message?: string }>(response: Response) {
  let payload: T;
  try {
    payload = (await response.json()) as T;
  } catch {
    throw new Error(`服务端响应不是有效 JSON（HTTP ${response.status}）`);
  }

  if (!response.ok || !payload.success) {
    throw new Error(payload.message || 'Request failed');
  }

  return payload.data as T['data'];
}

async function requestJson(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `请求失败：${reason}。请检查 API 地址与网络连通性（当前：${getApiBaseUrl()}）。`,
    );
  }
}

function getTauriInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

async function invokeNativeHttp<T>(command: string, args: Record<string, unknown>) {
  const invoke = getTauriInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<T>(command, { args });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason || 'Native HTTP request failed');
  }
}
