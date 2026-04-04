import type { DesktopInstallMarker, DesktopRecommendedSkillsInstallReport } from '../types/desktop';

export interface DesktopStorageStatus {
  available: boolean;
  mode: string;
  detail: string;
  jsonStatePath?: string;
  sqlitePath?: string;
  sqliteReady?: boolean;
  lastSavedAt?: string;
  credentialProvider?: string;
  credentialPath?: string;
  credentialSecure?: boolean;
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

const BROWSER_STATE_KEY = 'rhopenclaw_desktop_storage_stub_state';
const BROWSER_SECRET_KEY = 'rhopenclaw_desktop_storage_stub_secret';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

function browserStatus(detail: string): DesktopStorageStatus {
  return {
    available: false,
    mode: 'browser-fallback',
    detail,
    jsonStatePath: 'localStorage:rhopenclaw_desktop_storage_stub_state',
    sqlitePath: 'placeholder:desktop-state.sqlite3',
    sqliteReady: false,
    credentialProvider: 'sessionStorage-stub',
    credentialPath: 'sessionStorage:rhopenclaw_desktop_storage_stub_secret',
    credentialSecure: false,
  };
}

export async function getDesktopStorageStatus(): Promise<DesktopStorageStatus> {
  const invoke = getInvoke();
  if (!invoke) {
    return browserStatus('当前为浏览器联调壳层，使用 localStorage / sessionStorage 模拟本地存储骨架。');
  }

  return invoke<DesktopStorageStatus>('local_storage_status');
}

export async function saveDesktopStateSnapshot(payload: Record<string, unknown>): Promise<DesktopStorageStatus> {
  const invoke = getInvoke();
  const serialized = JSON.stringify(payload, null, 2);

  if (!invoke) {
    localStorage.setItem(BROWSER_STATE_KEY, serialized);
    return browserStatus('已在浏览器联调环境写入本地状态快照。');
  }

  return invoke<DesktopStorageStatus>('save_local_state_snapshot', { payload: serialized });
}

export async function loadDesktopStateSnapshot(): Promise<Record<string, unknown> | null> {
  const invoke = getInvoke();

  if (!invoke) {
    const raw = localStorage.getItem(BROWSER_STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  const raw = await invoke<string | null>('load_local_state_snapshot');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function parseDesktopInstallMarker(value: unknown): DesktopInstallMarker | null {
  if (!isRecord(value) || typeof value.completedAt !== 'string') {
    return null;
  }

  return {
    completedAt: value.completedAt,
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : undefined,
    deviceCode: typeof value.deviceCode === 'string' ? value.deviceCode : undefined,
    deviceName: typeof value.deviceName === 'string' ? value.deviceName : undefined,
    serverApiBaseUrl: typeof value.serverApiBaseUrl === 'string' ? value.serverApiBaseUrl : undefined,
    runtimeEndpoint: typeof value.runtimeEndpoint === 'string' ? value.runtimeEndpoint : undefined,
  };
}

function parseDesktopRecommendedSkillsInstallReport(value: unknown): DesktopRecommendedSkillsInstallReport | null {
  if (!isRecord(value) || typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') {
    return null;
  }

  const items = Array.isArray(value.items)
    ? value.items
        .map((item) => {
          if (!isRecord(item)) {
            return null;
          }
          if (
            typeof item.slug !== 'string'
            || typeof item.name !== 'string'
            || typeof item.status !== 'string'
            || typeof item.detail !== 'string'
            || typeof item.finishedAt !== 'string'
          ) {
            return null;
          }
          if (!['installed', 'already-installed', 'failed'].includes(item.status)) {
            return null;
          }

          return {
            slug: item.slug,
            name: item.name,
            status: item.status as DesktopRecommendedSkillsInstallReport['items'][number]['status'],
            detail: item.detail,
            finishedAt: item.finishedAt,
          };
        })
        .filter((item): item is DesktopRecommendedSkillsInstallReport['items'][number] => item !== null)
    : [];

  return {
    source: value.source === 'install-wizard' ? 'install-wizard' : 'install-wizard',
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    totalCount: typeof value.totalCount === 'number' ? value.totalCount : items.length,
    installedCount: typeof value.installedCount === 'number' ? value.installedCount : 0,
    alreadyInstalledCount: typeof value.alreadyInstalledCount === 'number' ? value.alreadyInstalledCount : 0,
    failedCount: typeof value.failedCount === 'number' ? value.failedCount : 0,
    skillhubSiteUrl: typeof value.skillhubSiteUrl === 'string' ? value.skillhubSiteUrl : undefined,
    installerUrl: typeof value.installerUrl === 'string' ? value.installerUrl : undefined,
    items,
  };
}

export async function loadDesktopInstallMarker(): Promise<DesktopInstallMarker | null> {
  const snapshot = await loadDesktopStateSnapshot();
  return parseDesktopInstallMarker(snapshot?.installMarker);
}

export async function saveDesktopInstallMarker(marker: DesktopInstallMarker): Promise<DesktopStorageStatus> {
  const snapshot = (await loadDesktopStateSnapshot()) ?? {};
  return saveDesktopStateSnapshot({
    ...snapshot,
    installMarker: marker,
  });
}

export async function clearDesktopInstallMarker(): Promise<DesktopStorageStatus> {
  const snapshot = (await loadDesktopStateSnapshot()) ?? {};
  if ('installMarker' in snapshot) {
    delete snapshot.installMarker;
  }
  return saveDesktopStateSnapshot(snapshot);
}

export async function loadDesktopRecommendedSkillsInstallReport(): Promise<DesktopRecommendedSkillsInstallReport | null> {
  const snapshot = await loadDesktopStateSnapshot();
  return parseDesktopRecommendedSkillsInstallReport(snapshot?.recommendedSkillsInstallReport);
}

export async function saveDesktopRecommendedSkillsInstallReport(
  report: DesktopRecommendedSkillsInstallReport,
): Promise<DesktopStorageStatus> {
  const snapshot = (await loadDesktopStateSnapshot()) ?? {};
  return saveDesktopStateSnapshot({
    ...snapshot,
    recommendedSkillsInstallReport: report,
  });
}

export async function saveDesktopCredentialStub(secret: string): Promise<DesktopStorageStatus> {
  const invoke = getInvoke();

  if (!invoke) {
    sessionStorage.setItem(BROWSER_SECRET_KEY, secret);
    return browserStatus('已在浏览器联调环境写入凭据占位。');
  }

  return invoke<DesktopStorageStatus>('save_device_secret_stub', { secret });
}

export async function loadDesktopCredentialStub(): Promise<string> {
  const invoke = getInvoke();

  if (!invoke) {
    return sessionStorage.getItem(BROWSER_SECRET_KEY) || '';
  }

  return invoke<string>('load_device_secret_stub');
 }
