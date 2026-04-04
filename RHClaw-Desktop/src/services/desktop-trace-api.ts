type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// ---------------------------------------------------------------------------
// 日志级别写入控制
// ---------------------------------------------------------------------------
// 级别数值：debug=0, info=1, warning=2, error=3, fatal=4
// 生产构建默认 warning(2)，开发构建默认 info(1)
// 可通过 localStorage.DESKTOP_TRACE_MIN_LEVEL 运行时覆盖（供生产环境排障用）
// 有 traceId / executionId 的业务链路事件始终写入，不受此过滤影响
// ---------------------------------------------------------------------------

const TRACE_BUILD_DEFAULT_LEVEL = import.meta.env.DEV ? 'info' : 'warning';

export const TRACE_LEVEL_OPTIONS = ['debug', 'info', 'warning', 'error'] as const;
export type TraceLevelOption = (typeof TRACE_LEVEL_OPTIONS)[number];

function levelRank(level: string): number {
  switch (level) {
    case 'debug':   return 0;
    case 'info':    return 1;
    case 'warning': return 2;
    case 'error':   return 3;
    case 'fatal':   return 4;
    default:        return 1;
  }
}

export function getTraceMinLevel(): TraceLevelOption {
  try {
    const stored = localStorage.getItem('DESKTOP_TRACE_MIN_LEVEL');
    if (stored && (TRACE_LEVEL_OPTIONS as readonly string[]).includes(stored)) {
      return stored as TraceLevelOption;
    }
  } catch {
    // localStorage 不可用时静默降级
  }
  return TRACE_BUILD_DEFAULT_LEVEL as TraceLevelOption;
}

export function setTraceMinLevel(level: TraceLevelOption | null): void {
  try {
    if (level === null) {
      localStorage.removeItem('DESKTOP_TRACE_MIN_LEVEL');
    } else {
      localStorage.setItem('DESKTOP_TRACE_MIN_LEVEL', level);
    }
  } catch {
    // ignore
  }
}

function shouldWriteTrace(input: DesktopStructuredTraceWriteInput): boolean {
  // 业务链路事件（有 traceId 或 executionId）始终写入
  if (input.traceId || input.executionId) return true;
  // error / fatal 始终写入
  const rank = levelRank(input.level ?? 'info');
  if (rank >= 3) return true;
  // 按配置的最低级别过滤
  return rank >= levelRank(getTraceMinLevel());
}

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

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

export interface DesktopStructuredTraceEntry {
  id: string;
  timestamp: string;
  timestampMs: number;
  level: string;
  source: string;
  module: string;
  event: string;
  message: string;
  status?: string;
  traceId?: string;
  executionId?: string;
  sessionId?: string;
  durationMs?: number;
  detail?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

export interface DesktopStructuredTraceWriteInput {
  level: string;
  source: string;
  module: string;
  event: string;
  message: string;
  status?: string;
  traceId?: string;
  executionId?: string;
  sessionId?: string;
  durationMs?: number;
  detail?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

export interface DesktopStructuredTraceQuery {
  traceId?: string;
  executionId?: string;
  sessionId?: string;
  eventPrefix?: string;
  level?: string;
  sinceMs?: number;
  limit?: number;
}

export interface DesktopTraceFailureQuery {
  source?: string;
  sessionId?: string;
  eventPrefix?: string;
  sinceMs?: number;
  limit?: number;
}

export interface DesktopTraceBundleRequest {
  traceId?: string;
  sessionId?: string;
  limit?: number;
}

export interface DesktopTraceBundleResult {
  bundlePath: string;
  createdAt: string;
  traceId?: string;
  sessionId?: string;
  entryCount: number;
  failureCount: number;
}

function normalizeUiLogEvent(source: string, message: string) {
  const normalizedMessage = message
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return normalizedMessage ? `ui.${source}.${normalizedMessage}` : `ui.${source}.log`;
}

export async function appendDesktopTraceLog(
  input: DesktopStructuredTraceWriteInput,
): Promise<DesktopStructuredTraceEntry | null> {
  if (!shouldWriteTrace(input)) return null;
  const invoke = getInvoke();
  if (!invoke) {
    return null;
  }
  return invoke<DesktopStructuredTraceEntry>('append_desktop_trace', { input });
}

export async function recordDesktopUiLog(input: {
  level: 'info' | 'warning' | 'danger';
  source: 'desktop' | 'agent' | 'runtime';
  message: string;
  sessionId?: string;
}): Promise<DesktopStructuredTraceEntry | null> {
  const level = input.level === 'danger' ? 'error' : input.level;
  return appendDesktopTraceLog({
    level,
    source: input.source,
    module: 'App.pushDesktopLog',
    event: normalizeUiLogEvent(input.source, input.message),
    message: input.message,
    sessionId: input.sessionId,
  });
}

export async function queryDesktopTraces(
  query: DesktopStructuredTraceQuery = {},
): Promise<DesktopStructuredTraceEntry[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }
  return invoke<DesktopStructuredTraceEntry[]>('query_desktop_traces', { query });
}

export async function getDesktopTraceTimeline(traceId: string, limit?: number): Promise<DesktopStructuredTraceEntry[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }
  return invoke<DesktopStructuredTraceEntry[]>('get_trace_timeline', { traceId, limit });
}

export async function findRecentDesktopTraceFailures(
  query: DesktopTraceFailureQuery = {},
): Promise<DesktopStructuredTraceEntry[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }
  return invoke<DesktopStructuredTraceEntry[]>('find_recent_failures', { query });
}

export async function collectDesktopDebugBundle(
  request: DesktopTraceBundleRequest = {},
): Promise<DesktopTraceBundleResult | null> {
  const invoke = getInvoke();
  if (!invoke) {
    return null;
  }
  return invoke<DesktopTraceBundleResult>('collect_debug_bundle', { request });
}