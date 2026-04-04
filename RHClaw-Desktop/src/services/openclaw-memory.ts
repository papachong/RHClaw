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

export interface OpenClawMemoryDayItem {
  day: string;
  fileCount: number;
  chunkCount: number;
  latestAt?: string | null;
}

export interface OpenClawMemoryRecordItem {
  path: string;
  source: string;
  size?: number | null;
  fileMtime?: string | null;
  updatedAt?: string | null;
  chunkCount: number;
}

export interface OpenClawMemoryOverview {
  available: boolean;
  dbPath: string;
  dbSizeBytes: number;
  fileCount: number;
  chunkCount: number;
  selectedDay?: string | null;
  days: OpenClawMemoryDayItem[];
  records: OpenClawMemoryRecordItem[];
  detail: string;
}

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

function requireInvoke(): TauriInvoke {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法读取本地 OpenClaw memory 数据库。');
  }

  return invoke;
}

export async function getOpenClawMemoryOverview(selectedDay?: string): Promise<OpenClawMemoryOverview> {
  const invoke = requireInvoke();
  return invoke<OpenClawMemoryOverview>('get_openclaw_memory_overview', { selectedDay });
}