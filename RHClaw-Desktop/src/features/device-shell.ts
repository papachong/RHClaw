export type DeviceConnectionStatus = 'idle' | 'binding' | 'connected' | 'offline';

export interface DeviceShellState {
  deviceCode?: string;
  deviceName: string;
  alias?: string;
  ownerNickname?: string;
  status: DeviceConnectionStatus;
  deviceToken?: string;
  deviceTokenExpiresAt?: string;
  credentialStorage?: {
    mode: 'native_secure_store' | 'encrypted_indexeddb' | 'session_memory' | 'memory';
    detail?: string;
    loadedAt?: string;
  };
  deviceId?: string;
  bindSessionToken?: string;
  bindPath?: string;
  bindUrlLink?: string;
  bindLaunchToken?: string;
  bindExpiresAt?: string;
  runtimeConfig?: {
    endpoint?: string;
    timeoutMs?: number;
  };
  runtimeHealth?: {
    status: 'healthy' | 'error' | 'unknown';
    detail?: string;
    checkedAt?: string;
    version?: string;
  };
  gatewayHealthy: boolean;
  channelStatus: 'unknown' | 'connected' | 'error';
  channelLastHeartbeatAt?: string;
}

export const defaultDeviceShellState: DeviceShellState = {
  deviceName: '未命名设备',
  status: 'idle',
  runtimeConfig: {
    endpoint: 'http://127.0.0.1:18789',
    timeoutMs: 5000,
  },
  runtimeHealth: {
    status: 'unknown',
  },
  credentialStorage: {
    mode: 'memory',
    detail: '等待初始化安全存储',
  },
  gatewayHealthy: false,
  channelStatus: 'unknown',
};

const DEVICE_SHELL_STORAGE_KEY = 'rhopenclaw_desktop_shell_state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePersistedDeviceShellSnapshot(snapshot: Record<string, unknown> | null): Partial<DeviceShellState> {
  if (!snapshot) {
    return {};
  }

  return {
    status:
      snapshot.status === 'idle' ||
      snapshot.status === 'binding' ||
      snapshot.status === 'connected' ||
      snapshot.status === 'offline'
        ? snapshot.status
        : undefined,
    deviceId: typeof snapshot.deviceId === 'string' ? snapshot.deviceId : undefined,
    deviceCode: typeof snapshot.deviceCode === 'string' ? snapshot.deviceCode : undefined,
    deviceName: typeof snapshot.deviceName === 'string' ? snapshot.deviceName : undefined,
    alias: typeof snapshot.alias === 'string' ? snapshot.alias : undefined,
    ownerNickname: typeof snapshot.ownerNickname === 'string' ? snapshot.ownerNickname : undefined,
    bindSessionToken: typeof snapshot.bindSessionToken === 'string' ? snapshot.bindSessionToken : undefined,
    bindPath: typeof snapshot.bindPath === 'string' ? snapshot.bindPath : undefined,
    bindUrlLink: typeof snapshot.bindUrlLink === 'string' ? snapshot.bindUrlLink : undefined,
    bindLaunchToken: typeof snapshot.bindLaunchToken === 'string' ? snapshot.bindLaunchToken : undefined,
    bindExpiresAt: typeof snapshot.bindExpiresAt === 'string' ? snapshot.bindExpiresAt : undefined,
    deviceTokenExpiresAt: typeof snapshot.deviceTokenExpiresAt === 'string' ? snapshot.deviceTokenExpiresAt : undefined,
    runtimeConfig: isRecord(snapshot.runtimeConfig)
      ? {
          endpoint: typeof snapshot.runtimeConfig.endpoint === 'string' ? snapshot.runtimeConfig.endpoint : undefined,
          timeoutMs: typeof snapshot.runtimeConfig.timeoutMs === 'number' ? snapshot.runtimeConfig.timeoutMs : undefined,
        }
      : undefined,
    runtimeHealth:
      isRecord(snapshot.runtimeHealth) &&
      (snapshot.runtimeHealth.status === 'healthy' ||
        snapshot.runtimeHealth.status === 'error' ||
        snapshot.runtimeHealth.status === 'unknown')
        ? {
            status: snapshot.runtimeHealth.status,
            detail: typeof snapshot.runtimeHealth.detail === 'string' ? snapshot.runtimeHealth.detail : undefined,
            checkedAt: typeof snapshot.runtimeHealth.checkedAt === 'string' ? snapshot.runtimeHealth.checkedAt : undefined,
            version: typeof snapshot.runtimeHealth.version === 'string' ? snapshot.runtimeHealth.version : undefined,
          }
        : undefined,
    credentialStorage: isRecord(snapshot.credentialStorage)
      ? {
          mode:
            snapshot.credentialStorage.mode === 'native_secure_store' ||
            snapshot.credentialStorage.mode === 'encrypted_indexeddb' ||
            snapshot.credentialStorage.mode === 'session_memory' ||
            snapshot.credentialStorage.mode === 'memory'
              ? snapshot.credentialStorage.mode
              : 'memory',
          detail: typeof snapshot.credentialStorage.detail === 'string' ? snapshot.credentialStorage.detail : undefined,
          loadedAt: typeof snapshot.credentialStorage.loadedAt === 'string' ? snapshot.credentialStorage.loadedAt : undefined,
        }
      : undefined,
    gatewayHealthy: snapshot.gatewayHealthy === true,
    channelStatus:
      snapshot.channelStatus === 'connected' || snapshot.channelStatus === 'error' || snapshot.channelStatus === 'unknown'
        ? snapshot.channelStatus
        : undefined,
    channelLastHeartbeatAt:
      typeof snapshot.channelLastHeartbeatAt === 'string' ? snapshot.channelLastHeartbeatAt : undefined,
  };
}

export function loadPersistedDeviceShellState(): Partial<DeviceShellState> {
  try {
    const raw = localStorage.getItem(DEVICE_SHELL_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    return parsePersistedDeviceShellSnapshot(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function persistDeviceShellState(state: DeviceShellState) {
  const snapshot: Partial<DeviceShellState> = {
    deviceCode: state.deviceCode,
    deviceName: state.deviceName,
    alias: state.alias,
    ownerNickname: state.ownerNickname,
    status: state.status,
    deviceId: state.deviceId,
    deviceTokenExpiresAt: state.deviceTokenExpiresAt,
    bindSessionToken: state.bindSessionToken,
    bindPath: state.bindPath,
    bindUrlLink: state.bindUrlLink,
    bindLaunchToken: state.bindLaunchToken,
    bindExpiresAt: state.bindExpiresAt,
    runtimeConfig: state.runtimeConfig,
    runtimeHealth: state.runtimeHealth,
    credentialStorage: state.credentialStorage,
    gatewayHealthy: state.gatewayHealthy,
    channelStatus: state.channelStatus,
    channelLastHeartbeatAt: state.channelLastHeartbeatAt,
  };
  localStorage.setItem(DEVICE_SHELL_STORAGE_KEY, JSON.stringify(snapshot));
}
