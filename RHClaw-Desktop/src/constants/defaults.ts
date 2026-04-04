import type { AutostartStatusSnapshot, RHClawPluginStatusSnapshot, RuntimePackageStatusSnapshot, TauriAgentStatusSnapshot } from '../services/tauri-agent';
import type { DesktopStorageStatus } from '../services/local-persistence';

export const defaultTauriAgentStatus: TauriAgentStatusSnapshot = {
  available: false,
  running: false,
  mode: 'browser-shell',
  detail: '等待初始化 Tauri Agent 骨架。',
  heartbeatCount: 0,
  logs: [],
};

export const defaultDesktopStorageStatus: DesktopStorageStatus = {
  available: false,
  mode: 'browser-fallback',
  detail: '等待初始化本地存储骨架。',
};

export const defaultRuntimePackageStatus: RuntimePackageStatusSnapshot = {
  available: false,
  installed: false,
  managed: false,
  detail: '等待初始化官方运行时托管状态。',
  installMode: undefined,
  verified: false,
};

export const defaultAutostartStatus: AutostartStatusSnapshot = {
  available: false,
  enabled: false,
  launcher: 'browser-shell',
  detail: '等待初始化开机自启状态。',
};

export const defaultRHClawPluginStatus: RHClawPluginStatusSnapshot = {
  available: false,
  installed: false,
  configured: false,
  detail: '等待初始化 RHClaw Channel 插件托管状态。',
  packageSpec: '@rhopenclaw/rhclaw-channel',
  packageValidated: false,
  gatewayRestartRequired: false,
  gatewayProbePassed: false,
  channelStatus: 'unknown',
};

export const defaultPendingMonitorThresholds = {
  queueSize: 3,
  pausedCount: 1,
};

export const pendingResultBaseRetryMs = 5_000;
export const pendingResultMaxRetryMs = 5 * 60 * 1000;
export const pendingResultMaxAttempts = 8;
export const desktopStateSnapshotDebounceMs = 400;
export const websocketHeartbeatIntervalMs = 30_000;
export const websocketHeartbeatAckTimeoutMs = 65_000;
export const websocketReconnectFailureThreshold = 2;
export const websocketReconnectCooldownBaseMs = 60_000;
export const websocketReconnectCooldownMaxMs = 10 * 60 * 1000;
