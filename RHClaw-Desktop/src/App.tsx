import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArchiveRestore, Brain, CalendarDays, Check, ChevronDown, ChevronLeft, Copy, Download, FileText, FolderOpen, Heart, IdCard, Info, LoaderCircle, Power, Puzzle, QrCode, RefreshCw, Rocket, Save, Settings, Settings2, SlidersHorizontal, Sparkles, Trash2, User, Wrench } from 'lucide-react';
import QRCode from 'qrcode';
import packageJson from '../package.json';
import appIcon from '../src-tauri/icons/128x128.png';
import { InstallProgressBar } from './components/install-progress-bar';
import { TerminalLogSummary } from './components/terminal-log-summary';
import { InstallWizardPage } from './pages/InstallWizardPage';
import { StartupCheckPage } from './pages/StartupCheckPage';
import { UpdateModal } from './components/UpdateModal';
import {
  defaultDeviceShellState,
  loadPersistedDeviceShellState,
  parsePersistedDeviceShellSnapshot,
  persistDeviceShellState,
  type DeviceShellState,
} from './features/device-shell';
import {
  createBindSession,
  getCurrentDeviceProfile,
  getBindSessionStatus,
  getOrCreateDeviceCode,
  registerDevice,
} from './services/device-api';
import { fetchInstallLlmConfig } from './services/desktop-settings-api';
import {
  createPendingBindSessionView,
  deriveDesktopBindSessionView,
  type DesktopBindSessionView,
} from './services/bind-session';
import { checkOpenClawRuntime, normalizeEndpoint } from './services/openclaw-runtime';
import { deriveRuntimeStatusDiagnostic } from './services/runtime-status-diagnostics';
import {
  clearDeviceTokenSecurely,
  loadDeviceTokenSecurely,
  saveDeviceTokenSecurely,
  type SecureTokenState,
} from './services/secure-storage';
import {
  clearDesktopInstallMarker,
  loadDesktopInstallMarker,
  loadDesktopRecommendedSkillsInstallReport,
  loadDesktopStateSnapshot,
  saveDesktopInstallMarker,
  saveDesktopRecommendedSkillsInstallReport,
  saveDesktopStateSnapshot,
} from './services/local-persistence';
import {
  getDesktopServerConfig,
} from './services/server-config';
import { useDesktopSettings } from './hooks/useDesktopSettings';
import { useDesktopRuntime } from './hooks/useDesktopRuntime';
import { useInstallWizard } from './hooks/useInstallWizard';
import {
  desktopWorkspaceTabs,
  type DesktopInstallMarker,
  type DesktopLogEntry,
  type DesktopRecommendedSkillsInstallReport,
  type DesktopWorkspaceTab,
  type RuntimeSetupPromptMode,
  type StartupCheckViewModel,
} from './types/desktop';
import {
  getDesktopSkillsCatalog,
  getLocalSkills,
  installSkill,
  mergeRecommendedAndLocalSkills,
  uninstallSkill,
  type SkillCompareItem,
} from './services/skills-api';

import {
  buildOpenClawModelKey,
  backupOpenClawConfig,
  getTaskStatus,
  getRuntimePackageStatus,
  getOpenClawModelsList,
  getOpenClawModelsStatus,
  pickOpenClawBackupFile,
  probeOpenClawModelsCapability,
  relaunchDesktopApp,
  removeRuntimePackage,
  restoreOpenClawConfig,
  resolveRHClawChannelStatus,
  restartGateway,
  startTask,
  type OpenClawModelCatalogItem,
  type RuntimePackageStatusSnapshot,
  startManagedRuntimeProcess,
  writeGatewayLlmConfig,
} from './services/tauri-agent';
import {
  listWorkspaceMarkdownFiles,
  readWorkspaceMarkdownFile,
  saveWorkspaceMarkdownFile,
  type WorkspaceMarkdownFileItem,
} from './services/openclaw-workspace';
import {
  getOpenClawMemoryOverview,
  type OpenClawMemoryOverview,
} from './services/openclaw-memory';
import {
  appendDesktopTraceLog,
  collectDesktopDebugBundle,
  findRecentDesktopTraceFailures,
  getDesktopTraceTimeline,
  getTraceMinLevel,
  queryDesktopTraces,
  recordDesktopUiLog,
  setTraceMinLevel,
  TRACE_LEVEL_OPTIONS,
  type DesktopTraceBundleResult,
  type DesktopStructuredTraceEntry,
  type TraceLevelOption,
} from './services/desktop-trace-api';


function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return '未知错误';
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const digits = current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function toTimestampMs(value?: string | null) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function wasRuntimeManuallyStopped(status: RuntimePackageStatusSnapshot) {
  const stoppedAt = toTimestampMs(status.lastStoppedAt);
  if (stoppedAt === null) {
    return false;
  }

  const startedAt = toTimestampMs(status.lastStartedAt);
  return startedAt === null || stoppedAt >= startedAt;
}

function normalizeSkillSlug(value: string) {
  return value.trim();
}

function formatDisplayTime(value?: string | null) {
  if (!value) {
    return '-';
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toLocaleString('zh-CN', { hour12: false });
}

function formatSkillDownloads(value?: number) {
  if (!value || value <= 0) {
    return '0';
  }

  if (value >= 10_000) {
    const formatted = (value / 10_000).toFixed(1).replace(/\.0$/, '');
    return `${formatted}万`;
  }

  return value.toLocaleString('zh-CN');
}

function summarizeRecommendedSkillsInstallReport(report: DesktopRecommendedSkillsInstallReport) {
  const failedItems = report.items.filter((item) => item.status === 'failed');
  return {
    summary: `上次自动安装：新增 ${report.installedCount} 个，已存在 ${report.alreadyInstalledCount} 个，失败 ${report.failedCount} 个。`,
    failedDetail: failedItems.length > 0
      ? `失败项：${failedItems.map((item) => `${item.name}（${item.detail}）`).join('；')}`
      : '',
  };
}

function pickDisplayText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }

    if (['unknown', '<none>', '-', '待检测'].includes(normalized.toLowerCase())) {
      continue;
    }

    return normalized;
  }

  return '';
}

const STARTUP_RUNTIME_SYNC_POLL_INTERVAL_MS = 1000;

function createInitialStartupCheckState(): StartupCheckViewModel {
  return {
    title: '正在检查 Desktop 安装状态',
    detail: '正在读取本地安装标记、设备令牌与 Gateway 运行状态。',
    progressPercent: 10,
    progressLabel: '正在准备启动检查...',
    logs: [],
  };
}

const APP_DISPLAY_NAME = '小爪龙虾（RHClaw）';
const APP_COPYRIGHT_YEAR = new Date().getFullYear();

interface SkillsPanelState {
  loading: boolean;
  items: SkillCompareItem[];
  detail: string;
  totalCount: number;
  installedCount: number;
  pendingCount: number;
  checkedAt?: string;
  skillhubSiteUrl?: string;
}

interface CliModelCatalogState {
  loading: boolean;
  sourceMode: 'cli' | 'fallback';
  detail: string;
  providerPrefix?: string;
  providerCode?: string;
  models: OpenClawModelCatalogItem[];
  defaultModel?: string;
  resolvedDefault?: string;
}

interface GroupedCliModels {
  id: string;
  label: string;
  items: OpenClawModelCatalogItem[];
}

interface AdvancedConfigPanelState {
  viewMode: 'root' | 'memory' | 'editor';
  loading: boolean;
  openingFileName: string | null;
  saving: boolean;
  detail: string;
  workspacePath: string;
  files: WorkspaceMarkdownFileItem[];
  activeFile: WorkspaceMarkdownFileItem | null;
  initialContent: string;
  editorContent: string;
  dirty: boolean;
  lastCheckedAt?: string;
}

interface MemoryOverviewPanelState {
  loading: boolean;
  overview: OpenClawMemoryOverview | null;
  selectedDay: string | null;
  detail: string;
}

interface TraceDiagnosticsPanelState {
  loading: boolean;
  detail: string;
  entries: DesktopStructuredTraceEntry[];
  eventPrefix: string;
  level: 'all' | 'info' | 'warning' | 'error';
  recentFailures: DesktopStructuredTraceEntry[];
  recentFailuresDetail: string;
  selectedTraceId: string | null;
  timelineLoading: boolean;
  timelineDetail: string;
  timelineEntries: DesktopStructuredTraceEntry[];
  exportingBundle: boolean;
  lastBundle: DesktopTraceBundleResult | null;
}
const TRACE_DIAGNOSTICS_ENABLED = import.meta.env.DEV;
const TRACE_QUERY_LOOKBACK_MS = 6 * 60 * 60 * 1000;

type AdvancedLeaveAction =
  | { kind: 'tab'; tab: DesktopWorkspaceTab }
  | { kind: 'refresh-root' }
  | { kind: 'open-memory' }
  | { kind: 'close-memory' }
  | { kind: 'open-file'; file: WorkspaceMarkdownFileItem }
  | { kind: 'close-editor' }
  | { kind: 'reload-file' };

interface AdvancedLeaveDialogState {
  open: boolean;
  saving: boolean;
  action: AdvancedLeaveAction | null;
}

function createInitialAdvancedConfigPanelState(): AdvancedConfigPanelState {
  return {
    viewMode: 'root',
    loading: false,
    openingFileName: null,
    saving: false,
    detail: '等待加载当前 OpenClaw workspace 配置文件。',
    workspacePath: '',
    files: [],
    activeFile: null,
    initialContent: '',
    editorContent: '',
    dirty: false,
  };
}

function resolveWorkspaceTabIcon(tab: DesktopWorkspaceTab) {
  switch (tab) {
    case 'home':
      return Sparkles;
    case 'skills':
      return Puzzle;
    case 'models':
      return SlidersHorizontal;
    case 'advanced':
      return Settings2;
    case 'trace':
      return Activity;
    case 'about':
      return Info;
    default:
      return Sparkles;
  }
}

function resolveWorkspaceFileIcon(icon?: string) {
  switch (icon) {
    case 'heart':
      return Heart;
    case 'user':
      return User;
    case 'id-card':
      return IdCard;
    case 'tool':
      return Wrench;
    case 'brain':
      return Brain;
    case 'activity':
      return Activity;
    case 'rocket':
      return Rocket;
    case 'power':
      return Power;
    case 'file-text':
    default:
      return FileText;
  }
}

function formatLlmSourceLabel(source?: string | null, hasDetectedLocalModel = false) {
  switch (source) {
    case 'custom':
      return '自定义配置生效';
    case 'pool':
      return '套餐模型生效';
    case 'none':
    default:
      return hasDetectedLocalModel ? '已检测到本地模型' : '模型来源待确认';
  }
}

function formatPoolTypeLabel(poolType?: string | null) {
  switch (poolType) {
    case 'trial':
      return '试用池';
    case 'subscription':
      return '订阅池';
    default:
      return '未分配';
  }
}

function formatVerificationStatusLabel(status?: string | null) {
  switch (status) {
    case 'passed':
      return '已校验';
    case 'failed':
      return '校验失败';
    case 'pending':
    default:
      return '待校验';
  }
}

function formatProviderConfigStatus(status?: string | null) {
  switch (status) {
    case 'active':
      return '当前激活';
    case 'invalid':
      return '配置异常';
    case 'disabled':
    default:
      return '未激活';
  }
}

function buildUniqueOptions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean))) as string[];
}

function extractModelValueFromCliKey(key: string, providerPrefix?: string) {
  const trimmedKey = key.trim();
  const trimmedPrefix = providerPrefix?.trim();
  if (!trimmedKey) {
    return '';
  }

  if (trimmedPrefix && trimmedKey.startsWith(`${trimmedPrefix}/`)) {
    return trimmedKey.slice(trimmedPrefix.length + 1);
  }

  return trimmedKey;
}

function groupCliModels(models: OpenClawModelCatalogItem[]) {
  const local = models.filter((item) => item.local);
  const ready = models.filter((item) => !item.local && item.available);
  const catalog = models.filter((item) => !item.local && !item.available);

  return [
    { id: 'local', label: '本地模型', items: local },
    { id: 'ready', label: '可直接使用', items: ready },
    { id: 'catalog', label: '目录模型', items: catalog },
  ].filter((group) => group.items.length > 0) as GroupedCliModels[];
}

function getBindingStatusLabel(status: DeviceShellState['status']) {
  switch (status) {
    case 'connected':
      return '已绑定';
    case 'binding':
      return '绑定中';
    case 'offline':
      return '离线';
    case 'idle':
    default:
      return '待绑定';
  }
}

function resolveLobsterRuntimeStatus(input: {
  startupWorkspaceMode: 'checking' | 'bound' | 'unbound';
  deviceStatus: DeviceShellState['status'];
  runtimeBusy: string | null;
  runtimePackage: { installed: boolean; processRunning?: boolean; available: boolean; detail: string };
  gatewayHealthy: boolean;
  runtimeHealthStatus?: 'healthy' | 'error' | 'unknown';
  preferRunningSignal?: boolean;
}) {
  if (input.runtimeBusy) {
    return { label: '处理中', tone: 'is-warning' };
  }

  if (input.startupWorkspaceMode === 'checking') {
    return { label: '检查中', tone: 'is-neutral' };
  }

  if (input.startupWorkspaceMode === 'unbound') {
    return { label: '待安装', tone: 'is-warning' };
  }

  if (input.deviceStatus === 'binding') {
    return { label: '绑定中', tone: 'is-warning' };
  }

  // bound mode — check runtime package state
  if (!input.runtimePackage.installed) {
    return { label: '未安装', tone: 'is-danger' };
  }

  if (input.runtimePackage.processRunning === true && (input.gatewayHealthy || input.preferRunningSignal)) {
    return { label: '运行中', tone: input.gatewayHealthy ? 'is-success' : 'is-warning' };
  }

  if (input.runtimePackage.processRunning === true) {
    // process running but gateway not yet confirmed healthy
    return input.runtimeHealthStatus === 'error'
      ? { label: '异常', tone: 'is-danger' }
      : { label: '启动中', tone: 'is-warning' };
  }

  if (input.runtimePackage.processRunning === false) {
    return { label: '已停止', tone: 'is-danger' };
  }

  // processRunning undefined — status not yet fetched
  return { label: '待检测', tone: 'is-neutral' };
}

export function App() {
  const persistedState = useMemo(() => loadPersistedDeviceShellState(), []);
  const initialServerConfig = useMemo(() => getDesktopServerConfig(), []);
  const initialState = useMemo<DeviceShellState>(
    () => ({
      ...defaultDeviceShellState,
      ...persistedState,
      deviceCode: getOrCreateDeviceCode(),
      deviceName: persistedState.deviceName || 'RHClaw Desktop',
    }),
    [persistedState],
  );

  const [state, setState] = useState<DeviceShellState>(initialState);
  const [busy, setBusy] = useState<'register' | 'bind' | null>(null);
  const [message, setMessage] = useState('正在初始化 Desktop 工作台');
  const [bindQrCodeDataUrl, setBindQrCodeDataUrl] = useState('');
  const [bindQrCodeError, setBindQrCodeError] = useState('');
  const [subscriptionQrCodeDataUrl, setSubscriptionQrCodeDataUrl] = useState('');
  const [subscriptionQrCodeError, setSubscriptionQrCodeError] = useState('');
  const keepaliveCheckInFlightRef = useRef(false);
  const [currentWechatUserName, setCurrentWechatUserName] = useState('');
  const [bindSessionView, setBindSessionView] = useState<DesktopBindSessionView | null>(null);
  const [runtimeSetupPromptMode, setRuntimeSetupPromptMode] = useState<RuntimeSetupPromptMode | null>(null);
  const [runtimeSetupPromptDismissed, setRuntimeSetupPromptDismissed] = useState(false);
  const [startupWorkspaceMode, setStartupWorkspaceMode] = useState<'checking' | 'bound' | 'unbound'>('checking');
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [serverConfigApiBaseUrl] = useState(initialServerConfig.apiBaseUrl);
  const [desktopLogEntries, setDesktopLogEntries] = useState<DesktopLogEntry[]>([]);
  const [startupCheck, setStartupCheck] = useState<StartupCheckViewModel>(() => createInitialStartupCheckState());
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<DesktopWorkspaceTab>('home');
  const [homeActionBusy, setHomeActionBusy] = useState<'refresh' | 'restart' | 'reinstall' | 'uninstall' | null>(null);
  const [lobsterStatusOpen, setLobsterStatusOpen] = useState(true);
  const [subscriptionInfoOpen, setSubscriptionInfoOpen] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const [skillsPanel, setSkillsPanel] = useState<SkillsPanelState>({
    loading: false,
    items: [],
    detail: '等待加载推荐 skills。',
    totalCount: 0,
    installedCount: 0,
    pendingCount: 0,
  });
  const [recommendedSkillsInstallReport, setRecommendedSkillsInstallReport] =
    useState<DesktopRecommendedSkillsInstallReport | null>(null);
  const [skillActionState, setSkillActionState] = useState<{ slug: string; mode: 'install' | 'uninstall' } | null>(null);
  const [cliModelCatalog, setCliModelCatalog] = useState<CliModelCatalogState>({
    loading: false,
    sourceMode: 'fallback',
    detail: '等待读取 OpenClaw CLI 模型目录。',
    models: [],
  });
  const [llmModelSearchQuery, setLlmModelSearchQuery] = useState('');
  const [advancedConfigPanel, setAdvancedConfigPanel] = useState<AdvancedConfigPanelState>(() => createInitialAdvancedConfigPanelState());
  const [memoryOverviewPanel, setMemoryOverviewPanel] = useState<MemoryOverviewPanelState>({
    loading: false,
    overview: null,
    selectedDay: null,
    detail: '等待加载 OpenClaw memory 数据。',
  });
  const [traceDiagnosticsPanel, setTraceDiagnosticsPanel] = useState<TraceDiagnosticsPanelState>({
    loading: false,
    detail: TRACE_DIAGNOSTICS_ENABLED ? '等待查询最近 6 小时链路日志。' : '当前构建已关闭 Desktop Trace 查询视图。',
    entries: [],
    eventPrefix: '',
    level: 'all',
    recentFailures: [],
    recentFailuresDetail: TRACE_DIAGNOSTICS_ENABLED ? '等待查询最近失败摘要。' : '当前构建已关闭失败摘要能力。',
    selectedTraceId: null,
    timelineLoading: false,
    timelineDetail: TRACE_DIAGNOSTICS_ENABLED ? '选择 trace 后可查看完整时间线。' : '当前构建已关闭时间线能力。',
    timelineEntries: [],
    exportingBundle: false,
    lastBundle: null,
  });
  // 日志写入级别控制（同步自 localStorage，决定 trace 文件写入颗粒度）
  const [traceMinLevel, setTraceMinLevelState] = useState<TraceLevelOption>(() => getTraceMinLevel());
  const [advancedLeaveDialog, setAdvancedLeaveDialog] = useState<AdvancedLeaveDialogState>({
    open: false,
    saving: false,
    action: null,
  });
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [openClawBackupBusy, setOpenClawBackupBusy] = useState(false);
  const [lobsterQrModal, setLobsterQrModal] = useState<{
    open: boolean;
    loading: boolean;
    qrDataUrl: string;
    sessionToken: string;
    error: string;
    copied: boolean;
  }>({
    open: false,
    loading: false,
    qrDataUrl: '',
    sessionToken: '',
    error: '',
    copied: false,
  });

  const stateRef = useRef<DeviceShellState>(initialState);
  const desktopLogSequenceRef = useRef(0);
  const appliedInstallModelSignatureRef = useRef<string | null>(null);
  const modelConfigFetchedAtRef = useRef<string | null>(null);
  const desktopTraceSessionIdRef = useRef(`desktop-session-${crypto.randomUUID()}`);
  const bindTraceIdRef = useRef<string | null>(null);
  const bindExecutionIdRef = useRef<string | null>(null);

  function nextDesktopTraceId(prefix: 'bind' | 'execution' | 'desktop') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  function formatTraceDetail(value?: Record<string, unknown> | null) {
    if (!value || Object.keys(value).length === 0) {
      return '';
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }

  function describeTraceEntry(entry: DesktopStructuredTraceEntry) {
    const status = entry.status?.trim();
    return status ? `${entry.event} · ${status}` : entry.event;
  }

  async function refreshTraceTimeline(traceId: string | null) {
    if (!TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }

    if (!traceId) {
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        selectedTraceId: null,
        timelineLoading: false,
        timelineDetail: '当前结果中没有可展开的 trace。',
        timelineEntries: [],
      }));
      return;
    }

    setTraceDiagnosticsPanel((current) => ({
      ...current,
      selectedTraceId: traceId,
      timelineLoading: true,
      timelineDetail: `正在读取 ${traceId} 的时间线...`,
    }));

    try {
      const timelineEntries = await getDesktopTraceTimeline(traceId, 120);
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        selectedTraceId: traceId,
        timelineLoading: false,
        timelineDetail: timelineEntries.length > 0
          ? `已读取 ${timelineEntries.length} 条时间线事件。`
          : '该 trace 当前没有更多时间线事件。',
        timelineEntries: [...timelineEntries].sort((left, right) => left.timestampMs - right.timestampMs),
      }));
    } catch (error) {
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        selectedTraceId: traceId,
        timelineLoading: false,
        timelineDetail: `时间线读取失败：${describeError(error)}`,
        timelineEntries: [],
      }));
    }
  }

  async function refreshRecentTraceFailures() {
    if (!TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }

    setTraceDiagnosticsPanel((current) => ({
      ...current,
      recentFailuresDetail: '正在读取最近失败摘要...',
    }));

    try {
      const recentFailures = await findRecentDesktopTraceFailures({
        sessionId: desktopTraceSessionIdRef.current,
        sinceMs: Date.now() - TRACE_QUERY_LOOKBACK_MS,
        limit: 8,
      });
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        recentFailures,
        recentFailuresDetail: recentFailures.length > 0
          ? `最近 6 小时发现 ${recentFailures.length} 条失败事件。`
          : '最近 6 小时未发现 error / failure 事件。',
      }));
    } catch (error) {
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        recentFailures: [],
        recentFailuresDetail: `失败摘要读取失败：${describeError(error)}`,
      }));
    }
  }

  async function refreshTraceDiagnosticsPanel(options?: {
    eventPrefix?: string;
    level?: TraceDiagnosticsPanelState['level'];
    traceId?: string | null;
  }) {
    if (!TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }

    const nextEventPrefix = options?.eventPrefix ?? traceDiagnosticsPanel.eventPrefix;
    const nextLevel = options?.level ?? traceDiagnosticsPanel.level;
    const requestedTraceId = options?.traceId === undefined ? traceDiagnosticsPanel.selectedTraceId : options.traceId;

    setTraceDiagnosticsPanel((current) => ({
      ...current,
      loading: true,
      detail: '正在查询最近 Desktop trace 日志...',
      eventPrefix: nextEventPrefix,
      level: nextLevel,
    }));

    try {
      const entries = await queryDesktopTraces({
        sessionId: desktopTraceSessionIdRef.current,
        eventPrefix: nextEventPrefix.trim() || undefined,
        level: nextLevel === 'all' ? undefined : nextLevel,
        sinceMs: Date.now() - TRACE_QUERY_LOOKBACK_MS,
        limit: 80,
      });

      const resolvedTraceId = requestedTraceId ?? entries.find((entry) => Boolean(entry.traceId))?.traceId ?? null;

      setTraceDiagnosticsPanel((current) => ({
        ...current,
        loading: false,
        detail: entries.length > 0
          ? `已读取最近 6 小时 ${entries.length} 条事件，当前 session=${desktopTraceSessionIdRef.current.slice(0, 18)}...`
          : '最近 6 小时内没有匹配当前筛选条件的结构化事件。',
        entries,
        eventPrefix: nextEventPrefix,
        level: nextLevel,
        selectedTraceId: resolvedTraceId,
        timelineEntries: resolvedTraceId ? current.timelineEntries : [],
        timelineDetail: resolvedTraceId ? current.timelineDetail : '选择带 traceId 的事件后可查看完整时间线。',
      }));

      await refreshRecentTraceFailures();
      await refreshTraceTimeline(resolvedTraceId);
    } catch (error) {
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        loading: false,
        detail: `结构化日志查询失败：${describeError(error)}`,
        entries: [],
        recentFailures: [],
        recentFailuresDetail: '日志查询失败，失败摘要未更新。',
        selectedTraceId: null,
        timelineLoading: false,
        timelineDetail: '日志查询失败，无法构建时间线。',
        timelineEntries: [],
      }));
    }
  }

  async function handleExportTraceBundle() {
    if (!TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }

    setTraceDiagnosticsPanel((current) => ({
      ...current,
      exportingBundle: true,
      detail: '正在导出调试包...',
    }));

    try {
      const result = await collectDesktopDebugBundle({
        traceId: traceDiagnosticsPanel.selectedTraceId ?? undefined,
        sessionId: desktopTraceSessionIdRef.current,
        limit: 200,
      });

      if (!result) {
        throw new Error('当前环境不支持调试包导出。');
      }

      setTraceDiagnosticsPanel((current) => ({
        ...current,
        exportingBundle: false,
        detail: `调试包已导出，共 ${result.entryCount} 条事件，路径：${result.bundlePath}`,
        lastBundle: result,
      }));
    } catch (error) {
      setTraceDiagnosticsPanel((current) => ({
        ...current,
        exportingBundle: false,
        detail: `调试包导出失败：${describeError(error)}`,
      }));
    }
  }

  function handleSetTraceMinLevel(level: TraceLevelOption) {
    setTraceMinLevel(level);
    setTraceMinLevelState(level);
  }

  async function emitDesktopTraceEvent(options: {
    event: string;
    message: string;
    level?: 'info' | 'warning' | 'error';
    status?: 'started' | 'running' | 'success' | 'failure';
    traceId?: string;
    executionId?: string;
    detail?: Record<string, unknown>;
  }) {
    await appendDesktopTraceLog({
      level: options.level ?? 'info',
      source: 'desktop',
      module: 'App',
      event: options.event,
      message: options.message,
      status: options.status,
      traceId: options.traceId,
      executionId: options.executionId,
      sessionId: desktopTraceSessionIdRef.current,
      detail: options.detail ?? null,
    });
  }

  function pushDesktopLog(source: DesktopLogEntry['source'], entryMessage: string, level: DesktopLogEntry['level']) {
    const timestamp = new Date().toISOString();
    desktopLogSequenceRef.current += 1;
    setDesktopLogEntries((current) => [
      {
        id: `${timestamp}-${desktopLogSequenceRef.current}`,
        timestamp,
        level,
        source,
        message: entryMessage,
      },
      ...current,
    ].slice(0, 200));

    void recordDesktopUiLog({
      source,
      message: entryMessage,
      level,
      sessionId: desktopTraceSessionIdRef.current,
    }).catch(() => undefined);
  }

  function updateRuntimeConfig(endpoint: string) {
    setState((current) => ({
      ...current,
      runtimeConfig: {
        ...current.runtimeConfig,
        endpoint: normalizeEndpoint(endpoint),
      },
    }));
  }

  function buildDesktopInstallMarker(current: DeviceShellState): DesktopInstallMarker {
    return {
      completedAt: new Date().toISOString(),
      deviceId: current.deviceId,
      deviceCode: current.deviceCode,
      deviceName: current.deviceName,
      serverApiBaseUrl: serverConfigApiBaseUrl,
      runtimeEndpoint: current.runtimeConfig?.endpoint,
    };
  }

  const settings = useDesktopSettings({
    getDeviceToken: () => stateRef.current.deviceToken,
    deviceToken: state.deviceToken,
    deviceStatus: state.status,
    setMessage,
    formatDisplayTime,
  });

  const runtime = useDesktopRuntime({
    startupWorkspaceMode,
    getDeviceIdentity: () => ({
      deviceId: stateRef.current.deviceId ?? '',
      deviceCode: stateRef.current.deviceCode ?? '',
      deviceName: stateRef.current.deviceName ?? '',
      deviceToken: stateRef.current.deviceToken ?? '',
    }),
    getOrCreateDeviceCode,
    getRuntimeConfig: () => stateRef.current.runtimeConfig,
    serverConfigApiBaseUrl,
    setMessage,
    pushDesktopLog,
    updateRuntimeConfig,
    setRuntimeSetupPromptMode,
    setRuntimeSetupPromptDismissed,
    desktopTraceSessionId: desktopTraceSessionIdRef.current,
  });

  const {
    runtimeBusy,
    runtimePackage,
    runtimeLogLines,
    autostartBusy,
    autostartStatus,
    pluginBusy,
    rhclawPlugin,
    workspaceRuntimeLoading,
    setRuntimeBusy,
    setRuntimePackage,
    refreshRuntimePackagePanel,
    ensureRHClawPluginReady,
    handleRefreshRuntimePanel,
    handleRemoveManagedRuntime,
    handleStartManagedRuntimeProcess,
    handleStopManagedRuntimeProcess,
    handleToggleAutostart,
    handleRefreshAutostartPanel,
    handleRefreshRHClawPluginPanel,
    handleInstallRHClawPlugin,
    handleProbeRHClawPlugin,
    handleRestartAndProbeRHClawPlugin,
    handleRemoveRHClawPlugin,
    resetRuntimePanels,
  } = runtime;

  function appendStartupCheckLog(messageText: string) {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${messageText}`;
    setStartupCheck((current) => ({
      ...current,
      logs: [...current.logs, line].slice(-8),
    }));
  }

  function updateStartupCheck(patch: Partial<StartupCheckViewModel>, logMessage?: string) {
    setStartupCheck((current) => ({
      ...current,
      ...patch,
    }));

    if (logMessage) {
      appendStartupCheckLog(logMessage);
    }
  }

  async function beginBindSession(deviceToken: string) {
    console.info('[reinstall:beginBindSession] START', { deviceToken: deviceToken?.slice(0, 20) + '...' });
    bindTraceIdRef.current = nextDesktopTraceId('bind');
    bindExecutionIdRef.current = nextDesktopTraceId('execution');
    await emitDesktopTraceEvent({
      event: 'bind.session.create.started',
      message: '开始创建绑定会话',
      status: 'started',
      traceId: bindTraceIdRef.current,
      executionId: bindExecutionIdRef.current,
    });
    // Clear old session immediately so the polling effect stops before we
    // create a new session.  Without this, the old 3-second poll may fire
    // after the new session is created (but before React re-renders),
    // setting bindQrCodeError back to the expired-session message and
    // hiding the fresh QR code.
    setState((current) => ({
      ...current,
      bindSessionToken: undefined,
      bindPath: undefined,
    }));
    setBindQrCodeDataUrl('');
    setBindQrCodeError('');

    const payload = await createBindSession(deviceToken);
    console.info('[reinstall:beginBindSession] createBindSession OK', {
      sessionToken: payload.bindSession.sessionToken?.slice(0, 20) + '...',
      miniProgramPath: payload.bindSession.miniProgramPath,
      bindUrlLink: payload.bindSession.bindUrlLink || '(empty)',
      bindLaunchToken: payload.bindSession.bindLaunchToken ? 'present' : '(empty)',
      deviceId: payload.bindSession.device.id,
    });
    const bindView = createPendingBindSessionView();
    setBindSessionView(bindView);
    setState((current) => {
      const next = {
        ...current,
        status: 'binding' as const,
        deviceId: payload.bindSession.device.id,
        deviceCode: payload.bindSession.device.deviceCode,
        deviceName: payload.bindSession.device.deviceName || current.deviceName,
        alias: payload.bindSession.device.deviceAlias || current.alias,
        bindSessionToken: payload.bindSession.sessionToken,
        bindPath: payload.bindSession.miniProgramPath,
        bindUrlLink: payload.bindSession.bindUrlLink,
        bindLaunchToken: payload.bindSession.bindLaunchToken,
        bindExpiresAt: payload.bindSession.expiresAt,
      };
      // 同步更新 stateRef，防止 useMemo 在同一渲染周期内读到 stale 值
      stateRef.current = next;
      return next;
    });
    setMessage(bindView.detail);
    setStartupWorkspaceMode('unbound');
    pushDesktopLog('desktop', 'bind-session:created', 'info');
    await emitDesktopTraceEvent({
      event: 'bind.session.create.completed',
      message: '绑定会话创建完成',
      status: 'success',
      traceId: bindTraceIdRef.current,
      executionId: bindExecutionIdRef.current,
      detail: {
        deviceId: payload.bindSession.device.id,
        deviceCode: payload.bindSession.device.deviceCode,
        sessionTokenPresent: Boolean(payload.bindSession.sessionToken),
      },
    });
    console.info('[reinstall:beginBindSession] DONE, state set to binding, bindPath set');
  }

  async function freshRegisterDevice(action: string) {
    console.info('[reinstall:freshRegisterDevice] START', { action });
    const traceId = nextDesktopTraceId('desktop');
    const executionId = nextDesktopTraceId('execution');
    await emitDesktopTraceEvent({
      event: 'device.register.started',
      message: '开始注册设备',
      status: 'started',
      traceId,
      executionId,
      detail: { action },
    });
    const payload = await registerDevice(getOrCreateDeviceCode());
    const secureToken = await saveDeviceTokenSecurely(payload.token.deviceToken);
    console.info('[reinstall:freshRegisterDevice] registered', {
      deviceId: payload.device.id,
      deviceCode: payload.device.deviceCode,
      tokenSlice: payload.token.deviceToken?.slice(0, 20) + '...',
      credMode: secureToken.mode,
    });

    setState((current) => {
      const next = {
        ...current,
        deviceId: payload.device.id,
        deviceCode: payload.device.deviceCode,
        deviceName: payload.device.deviceName || current.deviceName,
        alias: payload.device.deviceAlias || current.alias,
        deviceToken: payload.token.deviceToken,
        deviceTokenExpiresAt: payload.token.expiresAt,
        credentialStorage: {
          mode: secureToken.mode,
          detail: secureToken.detail,
          loadedAt: new Date().toISOString(),
        },
      };
      stateRef.current = next;
      return next;
    });
    pushDesktopLog('desktop', `install:${action}:registered`, 'info');
    await emitDesktopTraceEvent({
      event: 'device.register.completed',
      message: '设备注册完成',
      status: 'success',
      traceId,
      executionId,
      detail: {
        action,
        deviceId: payload.device.id,
        deviceCode: payload.device.deviceCode,
      },
    });

    return {
      deviceToken: payload.token.deviceToken,
      deviceId: payload.device.id,
      deviceName: payload.device.deviceName,
    };
  }

  function isTokenRevokedError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /revoked|unauthorized|token.*invalid|401/i.test(msg);
  }

  async function applyInstallAssignedModel(deviceToken: string, options?: { skipRestart?: boolean }): Promise<{ needsRestart: boolean }> {
    console.info('[reinstall:applyInstallAssignedModel] START', {
      tokenSlice: deviceToken?.slice(0, 20) + '...',
      currentSignature: appliedInstallModelSignatureRef.current,
      skipRestart: options?.skipRestart,
    });

    // TTL guard: if we already have a persisted signature and fetched config
    // within the last 24 hours, skip the network call entirely.
    const MODEL_CONFIG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    if (
      appliedInstallModelSignatureRef.current &&
      modelConfigFetchedAtRef.current &&
      Date.now() - new Date(modelConfigFetchedAtRef.current).getTime() < MODEL_CONFIG_TTL_MS
    ) {
      console.info('[reinstall:applyInstallAssignedModel] SKIP — within TTL, signature present');
      pushDesktopLog('runtime', 'install:model-assigned:skip:ttl', 'info');
      return { needsRestart: false };
    }

    try {
      const payload = await fetchInstallLlmConfig(deviceToken);
      const fetchedAt = new Date().toISOString();
      console.info('[reinstall:applyInstallAssignedModel] fetched', {
        providerCode: payload.assignment.providerCode,
        defaultModel: payload.assignment.defaultModel,
        openaiCompatPrefix: payload.assignment.openaiCompatPrefix,
        baseUrl: payload.assignment.baseUrl,
      });
      const assignmentSignature = JSON.stringify({
        providerCode: payload.assignment.providerCode,
        baseUrl: payload.assignment.baseUrl,
        model: payload.assignment.defaultModel,
        openaiCompatPrefix: payload.assignment.openaiCompatPrefix,
      });

      modelConfigFetchedAtRef.current = fetchedAt;

      if (appliedInstallModelSignatureRef.current === assignmentSignature) {
        console.info('[reinstall:applyInstallAssignedModel] SKIP — signature unchanged');
        pushDesktopLog('runtime', `install:model-assigned:skip:${payload.assignment.providerCode}`, 'info');
        return { needsRestart: false };
      }

      console.info('[reinstall:applyInstallAssignedModel] writing gateway config...');
      await writeGatewayLlmConfig({
        apiKey: payload.assignment.bootstrapApiKey,
        baseUrl: payload.assignment.baseUrl,
        model: payload.assignment.defaultModel,
        openaiCompatPrefix: payload.assignment.openaiCompatPrefix,
      });

      if (options?.skipRestart) {
        // Caller will handle the restart — just record the new signature optimistically
        appliedInstallModelSignatureRef.current = assignmentSignature;
        console.info('[reinstall:applyInstallAssignedModel] DONE (skipRestart, caller will restart)', {
          provider: payload.assignment.providerCode,
          model: payload.assignment.defaultModel,
        });
        pushDesktopLog('runtime', `install:model-assigned:${payload.assignment.providerCode}`, 'info');
        return { needsRestart: true };
      }

      console.info('[reinstall:applyInstallAssignedModel] restarting gateway...');
      const restart = await restartGateway();
      if (restart.running) {
        appliedInstallModelSignatureRef.current = assignmentSignature;
      }
      console.info('[reinstall:applyInstallAssignedModel] DONE', {
        gatewayRunning: restart.running,
        provider: payload.assignment.providerCode,
        model: payload.assignment.defaultModel,
      });
      pushDesktopLog('runtime', `install:model-assigned:${payload.assignment.providerCode}`, restart.running ? 'info' : 'warning');
      return { needsRestart: false };
    } catch (error) {
      const detail = describeError(error);
      console.error('[reinstall:applyInstallAssignedModel] FAILED', detail);
      pushDesktopLog('runtime', `install:model-assignment-failed:${detail}`, 'warning');
      return { needsRestart: false };
    }
  }

  async function prepareBindSessionAfterInstall(action: string, actionDetail: string) {
    console.info('[reinstall:prepareBindSession] START', {
      action,
      actionDetail,
      currentStatus: stateRef.current.status,
      hasDeviceToken: !!stateRef.current.deviceToken,
      hasDeviceId: !!stateRef.current.deviceId,
    });
    setMessage(`${actionDetail}，正在准备设备绑定...`);

    let nextDeviceToken = stateRef.current.deviceToken;
    let nextDeviceId = stateRef.current.deviceId;
    let nextDeviceName = stateRef.current.deviceName;

    if (!nextDeviceToken || !nextDeviceId) {
      console.info('[reinstall:prepareBindSession] no token/id, registering device...');
      const reg = await freshRegisterDevice(action);
      nextDeviceToken = reg.deviceToken;
      nextDeviceId = reg.deviceId;
      nextDeviceName = reg.deviceName || nextDeviceName;
    }

    // 重新安装会执行 `openclaw reset --scope full`，本地模型配置已被清空，
    // 但 appliedInstallModelSignatureRef 仍持有上次安装的签名；若 pool 分配未变，
    // applyInstallAssignedModel 会因签名匹配而跳过写入，导致模型配置丢失或残留旧值。
    // 此处强制置空，确保重装后必须重新写入。
    if (action === 'reinstall_latest') {
      console.info('[reinstall:prepareBindSession] clearing model signature ref for reinstall');
      appliedInstallModelSignatureRef.current = null;
      modelConfigFetchedAtRef.current = null;
    }

    console.info('[reinstall:prepareBindSession] step: applyInstallAssignedModel');
    await applyInstallAssignedModel(nextDeviceToken!);

    try {
      console.info('[reinstall:prepareBindSession] step: ensureRHClawPluginReady');
      const pluginStatus = await ensureRHClawPluginReady({
        deviceId: nextDeviceId,
        deviceCode: stateRef.current.deviceCode,
        deviceName: nextDeviceName,
        deviceToken: nextDeviceToken,
      });
      const nextChannelStatus = resolveRHClawChannelStatus(pluginStatus);
      console.info('[reinstall:prepareBindSession] plugin ready', {
        channelStatus: nextChannelStatus,
        installed: pluginStatus.installed,
        configured: pluginStatus.configured,
      });

      setState((current) => {
        const next = {
          ...current,
          channelStatus: nextChannelStatus,
          channelLastHeartbeatAt:
            pluginStatus.channelLastHeartbeatAt || pluginStatus.lastProbeAt || current.channelLastHeartbeatAt,
        };
        stateRef.current = next;
        return next;
      });

      console.info('[reinstall:prepareBindSession] step: beginBindSession');
      await beginBindSession(nextDeviceToken!);
      console.info('[reinstall:prepareBindSession] DONE — state should be binding', {
        stateRefStatus: stateRef.current.status,
        stateRefBindPath: stateRef.current.bindPath,
      });
    } catch (error) {
      if (!isTokenRevokedError(error)) {
        console.error('[reinstall:prepareBindSession] FAILED (non-revoke)', error);
        throw error;
      }

      console.warn('[reinstall:prepareBindSession] token revoked, re-registering...');
      pushDesktopLog('desktop', `install:${action}:token-revoked, re-registering`, 'warning');
      const reg = await freshRegisterDevice(action);
      nextDeviceToken = reg.deviceToken;
      nextDeviceId = reg.deviceId;
      nextDeviceName = reg.deviceName || nextDeviceName;
      await applyInstallAssignedModel(nextDeviceToken!);

      const pluginStatus = await ensureRHClawPluginReady({
        deviceId: nextDeviceId,
        deviceCode: stateRef.current.deviceCode,
        deviceName: nextDeviceName,
        deviceToken: nextDeviceToken,
      });
      const nextChannelStatus = resolveRHClawChannelStatus(pluginStatus);

      setState((current) => {
        const next = {
          ...current,
          channelStatus: nextChannelStatus,
          channelLastHeartbeatAt:
            pluginStatus.channelLastHeartbeatAt || pluginStatus.lastProbeAt || current.channelLastHeartbeatAt,
        };
        stateRef.current = next;
        return next;
      });

      await beginBindSession(nextDeviceToken!);
      console.info('[reinstall:prepareBindSession] DONE (after re-register)', {
        stateRefStatus: stateRef.current.status,
        stateRefBindPath: stateRef.current.bindPath,
      });
    }
  }

  const wizard = useInstallWizard({
    startupWorkspaceMode,
    runtimeBusy,
    runtimePackage,
    setRuntimeBusy,
    setRuntimePackage,
    refreshRuntimePackagePanel,
    getDeviceShellSnapshot: () => ({
      runtimeHealth: stateRef.current.runtimeHealth,
      runtimeConfig: stateRef.current.runtimeConfig,
      bindPath: stateRef.current.bindPath ?? '',
      bindSessionToken: stateRef.current.bindSessionToken ?? '',
      status: stateRef.current.status,
      deviceToken: stateRef.current.deviceToken,
    }),
    setMessage,
    serverConfigApiBaseUrl,
    updateRuntimeConfig,
    updateRuntimeHealth: (health) => {
      setState((current) => ({
        ...current,
        runtimeHealth: health,
        gatewayHealthy: health.status === 'healthy',
      }));
    },
    installRecommendedSkillsAfterRuntimeReady,
    prepareBindSessionAfterInstall,
    message,
    bindQrCodeError,
    runtimeSetupPromptMode,
    setRuntimeSetupPromptMode,
    runtimeSetupPromptDismissed,
    setRuntimeSetupPromptDismissed,
    desktopTraceSessionId: desktopTraceSessionIdRef.current,
    lastLoggedMessage: desktopLogEntries[0]?.message || message,
  });

  const {
    runtimeInstallVersion,
    setRuntimeInstallVersion,
    runtimeInstallUrl,
    setRuntimeInstallUrl,
    runtimeInstallSha256,
    setRuntimeInstallSha256,
    installLogSummary,
    selectedInstallPath,
    installShellMode,
    installCancelRequested,
    setSelectedInstallPath,
    installWizard,
    decisionPrimaryLabel,
    canReuseCurrentInstall,
    wizardProgressPercent,
    wizardProgressLabel,
    installTaskStageLabel,
    canContinueInstallInBackground,
    canCancelInstallTask,
    latestInstallLog,
    handleLaunchInstallFlow,
    handleInstallManagedRuntime,
    handleBindExistingRuntime,
    handleContinueInstallInBackground,
    handleReturnToInstallWizard,
    handleCancelInstallTask,
    clearInstallProgressTimeline,
    resetInstallWizard,
  } = wizard;

  useEffect(() => {
    stateRef.current = state;
    persistDeviceShellState(state);
  }, [state]);

  useEffect(() => {
    void bootstrapStartupWorkspace();

    return () => {
      clearInstallProgressTimeline();
    };
  }, []);

  useEffect(() => {
    void generateBindQrCode();
  }, [state.bindPath, state.bindUrlLink]);

  useEffect(() => {
    void generateSubscriptionQrCode();
  }, [settings.desktopSubscription.miniProgramPath, settings.desktopSubscription.urlLink]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound' || activeWorkspaceTab !== 'skills') {
      return;
    }

    void refreshSkillsPanel();
  }, [activeWorkspaceTab, startupWorkspaceMode]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound' || activeWorkspaceTab !== 'models') {
      return;
    }

    void refreshCliModelCatalog(settings.selectedLlmProvider?.providerCode, settings.selectedLlmProvider?.openclawPrefix);
  }, [
    activeWorkspaceTab,
    startupWorkspaceMode,
    settings.selectedLlmProvider?.providerCode,
    settings.selectedLlmProvider?.openclawPrefix,
  ]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound' || activeWorkspaceTab !== 'advanced') {
      return;
    }

    void refreshAdvancedConfigPanel();
    void refreshMemoryOverview();
  }, [activeWorkspaceTab, startupWorkspaceMode]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound' || activeWorkspaceTab !== 'trace' || !TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }

    void refreshTraceDiagnosticsPanel();
  }, [activeWorkspaceTab, startupWorkspaceMode]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound') return;
    void loadCurrentDeviceProfile('startup');
  }, [startupWorkspaceMode, state.deviceToken]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound') {
      return;
    }

    console.info('[runtimeVersion] resolved', {
      runtimePackageVersion: runtimePackage.version,
      healthVersion: state.runtimeHealth?.version,
      renderedVersion: pickDisplayText(runtimePackage.version, state.runtimeHealth?.version) || '待检测',
      runtimeStatusLogs: runtimePackage.statusLogs,
    });
  }, [startupWorkspaceMode, runtimePackage.version, runtimePackage.statusLogs, state.runtimeHealth?.version]);

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound') {
      return;
    }

    let active = true;

    const runKeepaliveCheck = async () => {
      if (keepaliveCheckInFlightRef.current) {
        return;
      }

      keepaliveCheckInFlightRef.current = true;
      try {
        const latestRuntimeStatus = await getRuntimePackageStatus();
        if (!active) {
          return;
        }

        setRuntimePackage(latestRuntimeStatus);
        if (latestRuntimeStatus.managedEndpoint) {
          updateRuntimeConfig(normalizeEndpoint(latestRuntimeStatus.managedEndpoint));
        }

        if (latestRuntimeStatus.processRunning) {
          // Process is running — but if gatewayHealthy is stale-false (e.g.
          // after an external gateway restart or token rotation), re-probe
          // /health so the UI recovers from "启动中" to "运行中".
          if (!stateRef.current.gatewayHealthy) {
            try {
              const runtimeHealth = await checkOpenClawRuntime({
                endpoint:
                  stateRef.current.runtimeConfig?.endpoint ||
                  latestRuntimeStatus.managedEndpoint ||
                  '',
                timeoutMs: stateRef.current.runtimeConfig?.timeoutMs,
              });
              setState((current) => ({
                ...current,
                runtimeHealth,
                gatewayHealthy: runtimeHealth.status === 'healthy',
              }));
            } catch {
              // probe failed — leave state unchanged, next keepalive will retry.
            }
          }
          return;
        }

        setState((current) => ({
          ...current,
          gatewayHealthy: false,
        }));

        if (wasRuntimeManuallyStopped(latestRuntimeStatus)) {
          console.info('[keepalive] Gateway 处于手动停止状态，跳过自动恢复。');
          return;
        }

        console.warn('[keepalive] Gateway 已停止，正在自动恢复...');
        pushDesktopLog('runtime', 'keepalive:gateway-stopped:auto-restart', 'warning');

        const recoveredRuntimeStatus = await startManagedRuntimeProcess();
        if (!active) {
          return;
        }

        setRuntimePackage(recoveredRuntimeStatus);
        if (recoveredRuntimeStatus.managedEndpoint) {
          updateRuntimeConfig(normalizeEndpoint(recoveredRuntimeStatus.managedEndpoint));
        }
        if (recoveredRuntimeStatus.processRunning) {
          setState((current) => ({
            ...current,
            gatewayHealthy: true,
          }));
          pushDesktopLog(
            'runtime',
            `keepalive:gateway-restarted:${recoveredRuntimeStatus.detail || 'ok'}`,
            'info',
          );
        }
      } catch (error) {
        if (!active) {
          return;
        }

        const detail = describeError(error);
        console.error('[keepalive] 巡检异常:', detail);
        pushDesktopLog('runtime', `keepalive:error:${detail}`, 'warning');
      } finally {
        keepaliveCheckInFlightRef.current = false;
      }
    };

    const timer = window.setInterval(() => {
      void runKeepaliveCheck();
    }, 60_000);

    return () => {
      active = false;
      window.clearInterval(timer);
      keepaliveCheckInFlightRef.current = false;
    };
  }, [startupWorkspaceMode]);

  useEffect(() => {
    const nextChannelStatus = resolveRHClawChannelStatus(rhclawPlugin);

    setState((current) => {
      const nextHeartbeat = rhclawPlugin.channelLastHeartbeatAt || rhclawPlugin.lastProbeAt || current.channelLastHeartbeatAt;
      if (current.channelStatus === nextChannelStatus && current.channelLastHeartbeatAt === nextHeartbeat) {
        return current;
      }

      return {
        ...current,
        channelStatus: nextChannelStatus,
        channelLastHeartbeatAt: nextHeartbeat,
      };
    });
  }, [
    rhclawPlugin.channelLastHeartbeatAt,
    rhclawPlugin.channelStatus,
    rhclawPlugin.gatewayProbePassed,
    rhclawPlugin.installed,
    rhclawPlugin.lastProbeAt,
  ]);

  useEffect(() => {
    const targetVersion = settings.desktopVersion.updaterStatus?.targetVersion || null;
    if (!targetVersion) {
      setDismissedUpdateVersion(null);
    }
  }, [settings.desktopVersion.updaterStatus?.targetVersion]);

  useEffect(() => {
    if (state.status !== 'binding' || !state.deviceToken || !state.bindSessionToken) {
      return;
    }

    let active = true;
    const traceId = bindTraceIdRef.current ?? nextDesktopTraceId('bind');
    bindTraceIdRef.current = traceId;
    const executionId = nextDesktopTraceId('execution');
    bindExecutionIdRef.current = executionId;

    void emitDesktopTraceEvent({
      event: 'bind.session.poll.started',
      message: '开始轮询绑定会话状态',
      status: 'started',
      traceId,
      executionId,
      detail: {
        sessionTokenPresent: Boolean(state.bindSessionToken),
      },
    });

    const poll = async () => {
      try {
        const payload = await getBindSessionStatus(stateRef.current.deviceToken!, stateRef.current.bindSessionToken!);
        if (!active) {
          return;
        }

        const nextView = deriveDesktopBindSessionView(payload);
        setBindSessionView(nextView);
        setMessage(nextView.detail);

        setState((current) => ({
          ...current,
          deviceId: payload.device.id,
          deviceCode: payload.device.deviceCode,
          deviceName: payload.device.deviceName || current.deviceName,
          alias: payload.device.deviceAlias || current.alias,
          bindExpiresAt: payload.bindSession.expiresAt,
        }));

        if (nextView.state === 'bound' || nextView.state === 'limited') {
          await emitDesktopTraceEvent({
            event: 'bind.session.confirmed',
            message: nextView.detail,
            status: 'success',
            traceId,
            executionId,
            detail: {
              limited: nextView.state === 'limited',
              deviceId: payload.device.id,
              deviceCode: payload.device.deviceCode,
            },
          });
          enterBoundWorkspace({
            detail: nextView.detail,
            limited: nextView.state === 'limited',
            deviceId: payload.device.id,
            deviceCode: payload.device.deviceCode,
            deviceName: payload.device.deviceName,
            alias: payload.device.deviceAlias,
          });
          return;
        }

        if (nextView.canRetry) {
          setBindQrCodeError(nextView.detail);
          await emitDesktopTraceEvent({
            event: 'bind.session.retry-required',
            message: nextView.detail,
            level: 'warning',
            status: 'running',
            traceId,
            executionId,
          });
        }
      } catch (error) {
        if (!active) {
          return;
        }

        const detail = describeError(error);
        setBindQrCodeError(detail);
        setMessage(detail);
        pushDesktopLog('desktop', `bind-session:poll:error:${detail}`, 'warning');
        await emitDesktopTraceEvent({
          event: 'bind.session.poll.failed',
          message: detail,
          level: 'warning',
          status: 'failure',
          traceId,
          executionId,
        });
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [state.status, state.deviceToken, state.bindSessionToken]);

  async function bootstrapStartupWorkspace() {
    // 1. Version update check — runs before anything else
    try {
      await settings.refreshDesktopVersionPanel();
    } catch (_) {
      // update check failure should not block startup
    }

    setStartupCheck(createInitialStartupCheckState());
    appendStartupCheckLog('开始读取本地安装标记、设备令牌与状态快照。');

    try {
      const [secureTokenState, snapshot, installMarker, skillsInstallReport] = await Promise.all([
        loadDeviceTokenSecurely(),
        loadDesktopStateSnapshot(),
        loadDesktopInstallMarker(),
        loadDesktopRecommendedSkillsInstallReport(),
      ]);

      applySecureTokenState(secureTokenState);
      setRecommendedSkillsInstallReport(skillsInstallReport);
      const restored = parsePersistedDeviceShellSnapshot(snapshot);

      let restoredState: DeviceShellState = {
        ...stateRef.current,
        ...restored,
        deviceCode: restored.deviceCode || stateRef.current.deviceCode || getOrCreateDeviceCode(),
        deviceName: restored.deviceName || stateRef.current.deviceName,
        deviceToken: secureTokenState.token,
        credentialStorage: {
          mode: secureTokenState.mode,
          detail: secureTokenState.detail,
          loadedAt: new Date().toISOString(),
        },
      };

      stateRef.current = restoredState;
      setState(restoredState);

      // Restore persisted model config signature to avoid unnecessary Gateway restarts
      if (typeof snapshot?.appliedModelSignature === 'string') {
        appliedInstallModelSignatureRef.current = snapshot.appliedModelSignature;
      }
      if (typeof snapshot?.modelConfigFetchedAt === 'string') {
        modelConfigFetchedAtRef.current = snapshot.modelConfigFetchedAt;
      }

      // --- Auto-renew expired / invalid device token ---
      let activeToken = secureTokenState.token;
      if (activeToken && (restored.status === 'connected' || restored.status === 'offline')) {
        const locallyExpired =
          restoredState.deviceTokenExpiresAt &&
          new Date(restoredState.deviceTokenExpiresAt).getTime() < Date.now();

        let needsRenewal = !!locallyExpired;

        // If not locally expired, probe server to catch JWT-secret changes
        if (!needsRenewal) {
          try {
            await getCurrentDeviceProfile(activeToken);
          } catch {
            needsRenewal = true;
          }
        }

        if (needsRenewal) {
          appendStartupCheckLog('设备令牌已失效，正在自动续期...');
          try {
            const reg = await freshRegisterDevice('token-refresh');
            activeToken = reg.deviceToken;
            restoredState = {
              ...restoredState,
              deviceToken: activeToken,
              deviceId: reg.deviceId || restoredState.deviceId,
            };
            stateRef.current = restoredState;
            appendStartupCheckLog('设备令牌已自动续期成功。');
          } catch (renewErr) {
            appendStartupCheckLog(`设备令牌续期失败：${describeError(renewErr)}`);
          }
        }
      }

      if (!installMarker) {
        if (restored.status === 'connected') {
          const synthesizedInstallMarker = buildDesktopInstallMarker(restoredState);
          appendStartupCheckLog('检测到已绑定状态但安装标记缺失，正在自动补写安装标记并恢复工作台。');
          await saveDesktopInstallMarker(synthesizedInstallMarker);

          if (activeToken) {
            await validateBoundWorkspace(restoredState, synthesizedInstallMarker, activeToken);
          } else {
            await enterBoundWorkspaceWithWarning(
              restoredState,
              synthesizedInstallMarker,
              '',
              '检测到已绑定工作台，但当前未恢复设备令牌。已保留工作台状态，请在工作台中继续修复。',
            );
          }
          return;
        }

        updateStartupCheck(
          {
            title: '未发现安装成功标记',
            detail: '当前设备尚未完成“安装成功 + Gateway 启动 + 设备注册 + IM 绑定”闭环，将进入安装流程。',
            progressPercent: 100,
            progressLabel: '未发现安装标记',
          },
          '未发现安装成功标记。',
        );

        if (activeToken && restored.status === 'binding') {
          setStartupWorkspaceMode('unbound');
          setMessage('已恢复绑定流程，请继续扫码确认。');
          return;
        }

        setStartupWorkspaceMode('unbound');
        setMessage('尚未发现安装成功标记，请继续安装与绑定。');
        return;
      }

      if (!activeToken) {
        await enterBoundWorkspaceWithWarning(
          restoredState,
          installMarker,
          '',
          '检测到旧的安装标记，但设备令牌暂未恢复。已保留工作台状态，请在工作台中继续修复。',
        );
        return;
      }

      await validateBoundWorkspace(restoredState, installMarker, activeToken);
    } catch (error) {
      setStartupWorkspaceMode('unbound');
      const detail = `启动初始化失败：${describeError(error)}`;
      updateStartupCheck(
        {
          title: '启动检查失败',
          detail,
          progressPercent: 100,
          progressLabel: '启动检查失败',
        },
        detail,
      );
      setMessage(detail);
    }
  }

  async function validateBoundWorkspace(restoredState: DeviceShellState, installMarker: DesktopInstallMarker, token: string) {
    updateStartupCheck(
      {
        title: '正在校验 OpenClaw 与 Gateway',
        detail: '已发现安装成功标记，正在确认 OpenClaw CLI、Gateway 服务和 RHClaw Channel 是否可自恢复。',
        progressPercent: 30,
        progressLabel: '正在校验 OpenClaw 安装状态...',
      },
      '已发现安装成功标记，开始检查 OpenClaw 与 Gateway 服务。',
    );

    const runtimeStatus = await refreshRuntimePackagePanel();
    appendStartupCheckLog(runtimeStatus.detail || '已读取 OpenClaw 运行时状态。');

    if (!runtimeStatus.installed || runtimeStatus.cliAvailable === false) {
      await fallbackToFreshInstall('安装标记存在，但本机未检测到可用的 OpenClaw 安装，已回退到全新安装。');
      return;
    }

    let activeRuntimeStatus = runtimeStatus;
    if (runtimeStatus.offlineBundleUpdateAvailable) {
      try {
        activeRuntimeStatus = await syncRuntimeToOfflineBundleVersion();
      } catch (error) {
        await enterBoundWorkspaceWithWarning(
          restoredState,
          installMarker,
          token,
          `检测到离线包包含更高版本 OpenClaw，但自动同步失败：${describeError(error)}。已保留绑定状态，请在工作台中继续修复。`,
        );
        return;
      }
    }

    if (!activeRuntimeStatus.processRunning) {
      updateStartupCheck(
        {
          title: '正在自动启动 Gateway',
          detail: '安装标记有效，但 Gateway 当前未运行，正在自动启动并修复 LaunchAgent。',
          progressPercent: 55,
          progressLabel: '正在自动启动 Gateway 服务...',
        },
        'Gateway 未运行，开始自动启动服务。',
      );

      activeRuntimeStatus = await startManagedRuntimeProcess();
      setRuntimePackage(activeRuntimeStatus);
      appendStartupCheckLog(activeRuntimeStatus.detail || 'Gateway 启动完成。');
    } else {
      appendStartupCheckLog('Gateway 已处于运行状态。');
    }

    updateStartupCheck(
      {
        title: '正在校验运行时健康状态',
        detail: 'Gateway 已启动，正在确认健康检查与 RHClaw Channel 连接状态。',
        progressPercent: 72,
        progressLabel: '正在校验 Gateway 与 Channel 状态...',
      },
      '正在执行 Gateway 健康检查。',
    );

    // If the Gateway process is already confirmed running from the runtime
    // status probe (which internally hits /health), skip the redundant
    // frontend health-check + retry cycle to save 1-8 seconds.
    if (activeRuntimeStatus.processRunning) {
      const syntheticHealth = {
        status: 'healthy' as const,
        detail: activeRuntimeStatus.detail || 'Gateway 运行中（由 runtime_package_status 确认）。',
        checkedAt: new Date().toISOString(),
        version: activeRuntimeStatus.version,
      };
      setState((current) => ({
        ...current,
        runtimeHealth: syntheticHealth,
        gatewayHealthy: true,
      }));
      appendStartupCheckLog(syntheticHealth.detail);
    } else {
      try {
        const runtimeHealth = await checkOpenClawRuntime({
          endpoint:
            restoredState.runtimeConfig?.endpoint ||
            activeRuntimeStatus.managedEndpoint ||
            installMarker.runtimeEndpoint ||
            '',
          timeoutMs: restoredState.runtimeConfig?.timeoutMs,
        });

        setState((current) => ({
          ...current,
          runtimeHealth,
          gatewayHealthy: true,
        }));
        appendStartupCheckLog(runtimeHealth.detail || 'Gateway 健康检查通过。');
      } catch (error) {
        await enterBoundWorkspaceWithWarning(
          restoredState,
          installMarker,
          token,
          `Gateway 启动后健康检查失败：${describeError(error)}。已保留绑定状态，请在工作台中继续修复。`,
        );
        return;
      }
    }

    const pluginStatus = await ensureRHClawPluginReady({
      deviceId: restoredState.deviceId || installMarker.deviceId || restoredState.deviceCode || installMarker.deviceCode || getOrCreateDeviceCode(),
      deviceCode: restoredState.deviceCode || installMarker.deviceCode || getOrCreateDeviceCode(),
      deviceName: restoredState.deviceName || installMarker.deviceName,
      deviceToken: token,
      skipRestart: true,
    });
    appendStartupCheckLog(pluginStatus.detail || 'RHClaw Channel 状态已刷新。');

    // Track whether plugin install wrote new config requiring a Gateway restart
    const pluginNeedsRestart = pluginStatus.gatewayRestartRequired;

    const nextChannelStatus = resolveRHClawChannelStatus(pluginStatus);
    const pluginHealthy =
      nextChannelStatus === 'connected' ||
      (pluginStatus.installed && pluginStatus.configured && nextChannelStatus === 'unknown');

    if (!pluginHealthy) {
      await enterBoundWorkspaceWithWarning(
        restoredState,
        installMarker,
        token,
        'RHClaw Channel 未能完成自动修复。已保留绑定状态，请在工作台中继续修复。',
      );
      return;
    }

    // Ensure model config is present (self-heal if initial install missed it).
    // Use skipRestart so we can consolidate into a single restart below.
    const modelResult = await applyInstallAssignedModel(token, { skipRestart: true });

    // Consolidated Gateway restart: only restart once if either plugin or model
    // config changed, instead of restarting 2-3 times in series.
    if (pluginNeedsRestart || modelResult.needsRestart) {
      appendStartupCheckLog('插件或模型配置有变更，正在统一重启 Gateway...');
      await restartGateway();
      appendStartupCheckLog('Gateway 已重启完成。');
    }

    const nextState: DeviceShellState = {
      ...restoredState,
      status: 'connected',
      deviceId: restoredState.deviceId || installMarker.deviceId,
      deviceCode: restoredState.deviceCode || installMarker.deviceCode || getOrCreateDeviceCode(),
      deviceName: restoredState.deviceName || installMarker.deviceName || restoredState.deviceName,
      deviceToken: token,
      bindSessionToken: undefined,
      bindPath: undefined,
      bindUrlLink: undefined,
      bindLaunchToken: undefined,
      bindExpiresAt: undefined,
      channelStatus: nextChannelStatus,
      channelLastHeartbeatAt: pluginStatus.channelLastHeartbeatAt || pluginStatus.lastProbeAt || restoredState.channelLastHeartbeatAt,
      gatewayHealthy: true,
      runtimeConfig: {
        ...restoredState.runtimeConfig,
        endpoint: normalizeEndpoint(
          restoredState.runtimeConfig?.endpoint || activeRuntimeStatus.managedEndpoint || installMarker.runtimeEndpoint || ''
        ),
      },
    };

    stateRef.current = nextState;
    setState(nextState);
    setStartupWorkspaceMode('bound');
    setBindQrCodeDataUrl('');
    setBindQrCodeError('');
    setBindSessionView(null);
    updateStartupCheck(
      {
        title: '工作台已就绪',
        detail: '安装标记与服务状态检查通过，工作台数据会在后台继续加载，不阻塞当前操作。',
        progressPercent: 100,
        progressLabel: '启动检查完成',
      },
      '启动检查通过，进入工作台。',
    );
    setMessage('安装标记检查通过，正在进入工作台。');
    void persistBoundWorkspaceSnapshot(nextState);
  }

  async function syncRuntimeToOfflineBundleVersion() {
    updateStartupCheck(
      {
        title: '正在同步 OpenClaw 版本',
        detail: '检测到离线包包含更高版本，正在自动同步本机 OpenClaw 安装并刷新运行时清单。',
        progressPercent: 42,
        progressLabel: '正在同步 OpenClaw 版本...',
      },
      '检测到离线包版本更高，开始自动同步 OpenClaw。',
    );

    setRuntimeBusy('repair');
    try {
      let taskEntry = await startTask('repair_runtime');
      if (taskEntry.status === 'failed') {
        throw new Error(taskEntry.error || '启动版本同步任务失败。');
      }

      let seenLogCount = 0;
      const flushTaskLogs = () => {
        for (let index = seenLogCount; index < taskEntry.logs.length; index += 1) {
          appendStartupCheckLog(taskEntry.logs[index]);
        }
        seenLogCount = taskEntry.logs.length;
      };

      flushTaskLogs();

      while (taskEntry.status === 'queued' || taskEntry.status === 'running') {
        updateStartupCheck({
          title: '正在同步 OpenClaw 版本',
          detail: taskEntry.progressNote || '正在执行后台版本同步任务。',
          progressPercent: Math.max(42, Math.min(68, taskEntry.progressPercent || 42)),
          progressLabel: '正在同步 OpenClaw 版本...',
        });

        await new Promise((resolve) => window.setTimeout(resolve, STARTUP_RUNTIME_SYNC_POLL_INTERVAL_MS));

        const entries = await getTaskStatus(taskEntry.taskId);
        const nextEntry = entries.find((entry) => entry.taskId === taskEntry.taskId);
        if (!nextEntry) {
          throw new Error('未找到版本同步任务状态。');
        }
        taskEntry = nextEntry;
        flushTaskLogs();
      }

      if (taskEntry.status !== 'completed') {
        throw new Error(taskEntry.error || taskEntry.progressNote || '版本同步任务未成功完成。');
      }

      const refreshedStatus = await refreshRuntimePackagePanel();
      appendStartupCheckLog(refreshedStatus.detail || 'OpenClaw 版本同步完成。');
      return refreshedStatus;
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function enterBoundWorkspaceWithWarning(
    restoredState: DeviceShellState,
    installMarker: DesktopInstallMarker,
    token: string,
    detail: string,
  ) {
    const nextState: DeviceShellState = {
      ...restoredState,
      status: 'connected',
      deviceId: restoredState.deviceId || installMarker.deviceId,
      deviceCode: restoredState.deviceCode || installMarker.deviceCode || getOrCreateDeviceCode(),
      deviceName: restoredState.deviceName || installMarker.deviceName || restoredState.deviceName,
      deviceToken: token,
      bindSessionToken: undefined,
      bindPath: undefined,
      bindUrlLink: undefined,
      bindLaunchToken: undefined,
      bindExpiresAt: undefined,
      gatewayHealthy: false,
      runtimeHealth: {
        status: 'error',
        detail,
        checkedAt: new Date().toISOString(),
      },
      channelStatus: restoredState.channelStatus || 'unknown',
    };

    stateRef.current = nextState;
    setState(nextState);
    setStartupWorkspaceMode('bound');
    setBindQrCodeDataUrl('');
    setBindQrCodeError('');
    setBindSessionView(null);
    updateStartupCheck(
      {
        title: '工作台已进入降级恢复模式',
        detail,
        progressPercent: 100,
        progressLabel: '已进入工作台',
      },
      detail,
    );
    setMessage(detail);
    await persistBoundWorkspaceSnapshot(nextState);
  }

  async function fallbackToFreshInstall(detail: string) {
    updateStartupCheck(
      {
        title: '启动修复失败',
        detail,
        progressPercent: 100,
        progressLabel: '已回退到全新安装',
      },
      detail,
    );

    try {
      await clearDeviceTokenSecurely();
    } catch {
      // ignore cleanup failure
    }

    try {
      await clearDesktopInstallMarker();
    } catch {
      // ignore cleanup failure
    }

    settings.resetSettingsPanels();
    resetRuntimePanels();
    setState({
      ...defaultDeviceShellState,
      deviceCode: stateRef.current.deviceCode || getOrCreateDeviceCode(),
      deviceName: stateRef.current.deviceName || 'RHClaw Desktop',
    });
    setBindQrCodeDataUrl('');
    setBindQrCodeError('');
    setBindSessionView(null);
    setStartupWorkspaceMode('unbound');
    setMessage(detail);
  }

  function applySecureTokenState(result: SecureTokenState) {
    setState((current) => ({
      ...current,
      deviceToken: result.token,
      credentialStorage: {
        mode: result.mode,
        detail: result.detail,
        loadedAt: new Date().toISOString(),
      },
    }));
  }

  function buildDesktopStateSnapshot(current: DeviceShellState) {
    return {
      status: current.status,
      deviceId: current.deviceId,
      deviceCode: current.deviceCode,
      deviceName: current.deviceName,
      alias: current.alias,
      ownerNickname: current.ownerNickname,
      bindSessionToken: current.bindSessionToken,
      bindPath: current.bindPath,
      bindUrlLink: current.bindUrlLink,
      bindLaunchToken: current.bindLaunchToken,
      bindExpiresAt: current.bindExpiresAt,
      deviceTokenExpiresAt: current.deviceTokenExpiresAt,
      runtimeConfig: current.runtimeConfig,
      runtimeHealth: current.runtimeHealth,
      gatewayHealthy: current.gatewayHealthy,
      channelStatus: current.channelStatus,
      channelLastHeartbeatAt: current.channelLastHeartbeatAt,
      appliedModelSignature: appliedInstallModelSignatureRef.current ?? undefined,
      modelConfigFetchedAt: modelConfigFetchedAtRef.current ?? undefined,
      savedAt: new Date().toISOString(),
    };
  }

  async function persistBoundWorkspaceSnapshot(nextState: DeviceShellState) {
    try {
      const installMarker = buildDesktopInstallMarker(nextState);
      await saveDesktopInstallMarker(installMarker);

      // Merge state snapshot and install marker into a single atomic write
      // to avoid the race condition where a concurrent saveDesktopStateSnapshot
      // overwrites the installMarker written by saveDesktopInstallMarker.
      const statePayload = buildDesktopStateSnapshot(nextState);
      await saveDesktopStateSnapshot({
        ...statePayload,
        installMarker,
      });
    } catch (error) {
      pushDesktopLog('desktop', `snapshot:save:error:${describeError(error)}`, 'warning');
    }
  }

  async function generateBindQrCode() {
    const qrContent = state.bindUrlLink || state.bindPath;
    console.info('[bind-qr] generateBindQrCode', {
      bindUrlLink: state.bindUrlLink ? state.bindUrlLink.slice(0, 60) + '...' : '(empty)',
      bindPath: state.bindPath ? 'present' : '(empty)',
      usingUrlLink: Boolean(state.bindUrlLink),
    });
    if (!qrContent) {
      setBindQrCodeDataUrl('');
      setBindQrCodeError('');
      return;
    }

    try {
      setBindQrCodeDataUrl(await QRCode.toDataURL(qrContent, { width: 240, margin: 1 }));
      setBindQrCodeError('');
    } catch (error) {
      setBindQrCodeDataUrl('');
      setBindQrCodeError(`二维码生成失败：${describeError(error)}`);
    }
  }

  async function generateSubscriptionQrCode() {
    const qrContent = settings.desktopSubscription.urlLink || settings.desktopSubscription.miniProgramPath;
    if (!qrContent) {
      setSubscriptionQrCodeDataUrl('');
      setSubscriptionQrCodeError('');
      return;
    }

    try {
      setSubscriptionQrCodeDataUrl(await QRCode.toDataURL(qrContent, { width: 220, margin: 1 }));
      setSubscriptionQrCodeError('');
    } catch (error) {
      setSubscriptionQrCodeDataUrl('');
      setSubscriptionQrCodeError(`二维码生成失败：${describeError(error)}`);
    }
  }

  function handleRestartLobsterRuntime() {
    if (homeActionBusy === 'restart') return;
    setHomeActionBusy('restart');
    setMessage('正在重启龙虾服务，请稍候…');
    console.info('[restart] 触发龙虾服务重启');

    // 后台执行，不阻塞 UI
    restartGateway()
      .then(async (result) => {
        console.info('[restart] restartGateway 完成:', result);
        await refreshRuntimePackagePanel();
        await loadCurrentDeviceProfile('restart');
        setMessage(result.running ? '龙虾服务已重新启动。' : `龙虾服务重启状态异常：${result.detail}`);
        pushDesktopLog('runtime', `workspace:restart:${result.detail}`, result.running ? 'info' : 'warning');
      })
      .catch((error) => {
        const detail = describeError(error);
        console.error('[restart] restartGateway 失败:', detail);
        setMessage(`龙虾服务重启失败：${detail}`);
        pushDesktopLog('runtime', `workspace:restart:error:${detail}`, 'danger');
      })
      .finally(() => {
        setHomeActionBusy(null);
      });
  }

  async function loadCurrentDeviceProfile(reason: 'startup' | 'restart' | 'manual-refresh') {
    const deviceToken = stateRef.current.deviceToken;
    if (!deviceToken) {
      return null;
    }

    try {
      const profile = await getCurrentDeviceProfile(deviceToken);
      console.info(`[deviceProfile] resolved during ${reason}`, {
        deviceId: profile.device.id,
        deviceCode: profile.device.deviceCode,
        deviceName: profile.device.deviceName,
        deviceAlias: profile.device.deviceAlias,
        ownerNickname: profile.owner?.nickname,
        ownerWechatOpenid: profile.owner?.wechatOpenid,
        status: profile.device.status,
      });
      setCurrentWechatUserName(profile.owner?.nickname?.trim() || '');
      setState((current) => ({
        ...current,
        deviceId: profile.device.id || current.deviceId,
        deviceCode: profile.device.deviceCode || current.deviceCode,
        deviceName: profile.device.deviceName || current.deviceName,
        alias: profile.device.deviceAlias || current.alias,
        ownerNickname: profile.owner?.nickname?.trim() || current.ownerNickname,
      }));
      return profile;
    } catch (error) {
      console.error(`[deviceProfile] load failed during ${reason}`, error);
      return null;
    }
  }

  async function handleManualRefreshRuntime() {
    if (homeActionBusy !== null || runtimeBusy !== null) {
      return;
    }

    setHomeActionBusy('refresh');
    setMessage('正在手动刷新 OpenClaw 状态...');

    try {
      const runtimeStatus = await refreshRuntimePackagePanel();
      const deviceProfile = await loadCurrentDeviceProfile('manual-refresh');
      console.info('[workspace-refresh] snapshot', {
        runtimeVersion: runtimeStatus.version,
        runtimeStatusLogs: runtimeStatus.statusLogs,
        deviceAlias: deviceProfile?.device.deviceAlias,
        deviceName: deviceProfile?.device.deviceName,
        ownerNickname: deviceProfile?.owner?.nickname,
      });
      setMessage('OpenClaw 状态已刷新。');
    } catch (error) {
      const detail = describeError(error);
      console.error('[workspace-refresh] failed', detail);
      setMessage(`刷新 OpenClaw 状态失败：${detail}`);
    } finally {
      setHomeActionBusy(null);
    }
  }

  function handleReinstallLobsterRuntime() {
    if (homeActionBusy !== null || runtimeBusy !== null) {
      return;
    }

    setConfirmDialog({
      title: '重新安装龙虾',
      message: '确认重新安装龙虾（OpenClaw）吗？将进入重新安装流程，并重新完成安装向导。',
      onConfirm: () => {
        setConfirmDialog(null);
        setHomeActionBusy('reinstall');
        setActiveWorkspaceTab('home');
        setStartupWorkspaceMode('unbound');
        setMessage('正在进入重新安装流程。');

        window.setTimeout(() => {
          void handleInstallManagedRuntime().finally(() => {
            setHomeActionBusy(null);
          });
        }, 0);
      },
    });
  }

  function handleUninstallLobsterRuntime() {
    if (homeActionBusy !== null || runtimeBusy !== null) {
      return;
    }

    setConfirmDialog({
      title: '卸载龙虾',
      message: '确认彻底卸载龙虾（OpenClaw）吗？此操作将删除本机OpenClaw和你的OpenClaw工作区，后续需用小爪龙虾客户端(RHClaw Desktop)重新安装后才能使用。',
      onConfirm: () => {
        setConfirmDialog(null);
        void performUninstallLobster();
      },
    });
  }

  async function performUninstallLobster() {
    setHomeActionBusy('uninstall');
    setMessage('正在彻底卸载龙虾，请稍候...');
    const traceId = nextDesktopTraceId('desktop');
    const executionId = nextDesktopTraceId('execution');

    try {
      await emitDesktopTraceEvent({
        event: 'runtime.workspace.uninstall.started',
        message: '开始彻底卸载 OpenClaw 运行时',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await removeRuntimePackage();
      await refreshRuntimePackagePanel();

      // --- 彻底清理：与 fallbackToFreshInstall 对齐 ---
      try {
        await clearDeviceTokenSecurely();
      } catch {
        // ignore cleanup failure
      }
      try {
        await clearDesktopInstallMarker();
      } catch {
        // ignore cleanup failure
      }

      settings.resetSettingsPanels();
      resetRuntimePanels();
      setState({
        ...defaultDeviceShellState,
        deviceCode: stateRef.current.deviceCode || getOrCreateDeviceCode(),
        deviceName: stateRef.current.deviceName || 'RHClaw Desktop',
      });
      setBindQrCodeDataUrl('');
      setBindQrCodeError('');
      setBindSessionView(null);
      setStartupWorkspaceMode('unbound');

      const doneMsg = status.detail || '龙虾已彻底卸载。';
      setMessage(doneMsg);
      pushDesktopLog('runtime', `workspace:uninstall:${doneMsg}`, 'info');
      await emitDesktopTraceEvent({
        event: 'runtime.workspace.uninstall.completed',
        message: doneMsg,
        status: 'success',
        traceId,
        executionId,
      });
    } catch (error) {
      const detail = describeError(error);
      setMessage(`彻底卸载龙虾失败：${detail}`);
      pushDesktopLog('runtime', `workspace:uninstall:error:${detail}`, 'danger');
      await emitDesktopTraceEvent({
        event: 'runtime.workspace.uninstall.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setHomeActionBusy(null);
    }
  }

  async function handleRegister() {
    setBusy('register');
    const traceId = nextDesktopTraceId('desktop');
    const executionId = nextDesktopTraceId('execution');
    try {
      await emitDesktopTraceEvent({
        event: 'device.register.started',
        message: '开始手动注册设备',
        status: 'started',
        traceId,
        executionId,
      });
      const payload = await registerDevice(getOrCreateDeviceCode());
      const secureToken = await saveDeviceTokenSecurely(payload.token.deviceToken);
      setState((current) => ({
        ...current,
        status: 'idle',
        deviceId: payload.device.id,
        deviceCode: payload.device.deviceCode,
        deviceName: payload.device.deviceName || current.deviceName,
        alias: payload.device.deviceAlias || current.alias,
        deviceToken: payload.token.deviceToken,
        deviceTokenExpiresAt: payload.token.expiresAt,
        credentialStorage: {
          mode: secureToken.mode,
          detail: secureToken.detail,
          loadedAt: new Date().toISOString(),
        },
      }));
      setMessage('设备注册成功，可以继续生成绑定二维码。');
      pushDesktopLog('desktop', 'device:registered', 'info');
      await emitDesktopTraceEvent({
        event: 'device.register.completed',
        message: '手动注册设备完成',
        status: 'success',
        traceId,
        executionId,
        detail: {
          deviceId: payload.device.id,
          deviceCode: payload.device.deviceCode,
        },
      });
    } catch (error) {
      const detail = describeError(error);
      setMessage(detail);
      pushDesktopLog('desktop', `device:register:error:${detail}`, 'danger');
      await emitDesktopTraceEvent({
        event: 'device.register.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleOpenLobsterQrCode() {
    setSettingsMenuOpen(false);
    setLobsterQrModal({
      open: true,
      loading: true,
      qrDataUrl: '',
      sessionToken: '',
      error: '',
      copied: false,
    });

    const deviceToken = stateRef.current.deviceToken;
    if (!deviceToken) {
      setLobsterQrModal((prev) => ({ ...prev, loading: false, error: '请先注册设备，再生成绑定二维码。' }));
      return;
    }

    try {
      const payload = await createBindSession(deviceToken);
      const qrContent = payload.bindSession.bindUrlLink || payload.bindSession.miniProgramPath;
      const sessionToken = payload.bindSession.sessionToken;

      if (!qrContent) {
        setLobsterQrModal((prev) => ({ ...prev, loading: false, sessionToken, error: '无法生成二维码链接' }));
        return;
      }

      const qrDataUrl = await QRCode.toDataURL(qrContent, { width: 240, margin: 1 });
      setLobsterQrModal((prev) => ({
        ...prev,
        loading: false,
        qrDataUrl,
        sessionToken,
      }));
    } catch (error) {
      setLobsterQrModal((prev) => ({ ...prev, loading: false, error: describeError(error) }));
    }
  }

  function handleBackupOpenClawConfig() {
    if (openClawBackupBusy) {
      return;
    }

    setOpenClawBackupBusy(true);
    setSettingsMenuOpen(false);
    setMessage('已开始后台备份 OpenClaw 配置（除 logs 外），可继续使用工作台。');
    pushDesktopLog('desktop', 'workspace:backup:started', 'info');

    void backupOpenClawConfig()
      .then((result) => {
        setMessage(
          [
            '龙虾配置备份成功。',
            `备份文件：${result.backupFileName}`,
            `压缩后大小：${formatBytes(result.backupSizeBytes)}`,
            `原始大小：${formatBytes(result.sourceSizeBytes)}`,
            `保存路径：${result.backupFilePath}`,
          ].join('\n'),
        );
        pushDesktopLog('desktop', `workspace:backup:ok:${result.backupFileName}`, 'info');
      })
      .catch((error) => {
        const detail = describeError(error);
        setMessage(`备份龙虾失败：${detail}`);
        pushDesktopLog('desktop', `workspace:backup:error:${detail}`, 'danger');
      })
      .finally(() => {
        setOpenClawBackupBusy(false);
      });
  }

  function handleRestoreOpenClawConfigMenu() {
    setSettingsMenuOpen(false);
    setConfirmDialog({
      title: '恢复龙虾配置',
      message: '将覆盖当前 ~/.openclaw（日志目录保留）。建议先执行一次“备份龙虾”。是否继续？',
      confirmLabel: '选择备份文件',
      onConfirm: () => {
        setConfirmDialog(null);
        void handleRestoreOpenClawConfig();
      },
    });
  }

  async function handleRestoreOpenClawConfig() {
    const selectedPath = await pickOpenClawBackupFile();
    const input = selectedPath ?? window.prompt(
      '请输入备份 ZIP 路径（支持 Windows 路径如 C:\\Users\\xx\\...\\backup.zip，或仅文件名；留空则恢复最近一次）',
      '',
    ) ?? '';
    const backupFilePath = input.trim();

    setMessage('正在恢复 OpenClaw 配置...');
    try {
      const result = await restoreOpenClawConfig(backupFilePath || undefined);
      setMessage(`${result.detail}\n来源：${result.restoredFrom}\n恢复条目：${result.restoredCount}`);
      pushDesktopLog('desktop', `workspace:restore:ok:${result.restoredFrom}`, 'info');
    } catch (error) {
      const detail = describeError(error);
      setMessage(`恢复龙虾失败：${detail}`);
      pushDesktopLog('desktop', `workspace:restore:error:${detail}`, 'danger');
    }
  }

  function handleOpenTraceDiagnosticsPage() {
    setSettingsMenuOpen(false);
    void requestAdvancedLeave({ kind: 'tab', tab: 'trace' });
  }

  async function handleCreateBindSession() {
    const deviceToken = stateRef.current.deviceToken;
    if (!deviceToken) {
      setMessage('请先注册设备，再生成绑定二维码。');
      return;
    }

    setBusy('bind');
    try {
      await beginBindSession(deviceToken);
    } catch (error) {
      const detail = describeError(error);
      setMessage(detail);
      pushDesktopLog('desktop', `bind-session:create:error:${detail}`, 'danger');
      await emitDesktopTraceEvent({
        event: 'bind.session.create.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId: bindTraceIdRef.current ?? undefined,
        executionId: bindExecutionIdRef.current ?? undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  function enterBoundWorkspace(input: {
    detail: string;
    limited?: boolean;
    deviceId?: string;
    deviceCode?: string;
    deviceName?: string;
    alias?: string;
  }) {
    const nextState: DeviceShellState = {
      ...stateRef.current,
      status: 'connected',
      deviceId: input.deviceId ?? stateRef.current.deviceId,
      deviceCode: input.deviceCode ?? stateRef.current.deviceCode,
      deviceName: input.deviceName || stateRef.current.deviceName,
      alias: input.alias ?? stateRef.current.alias,
      bindSessionToken: undefined,
      bindPath: undefined,
      bindUrlLink: undefined,
      bindLaunchToken: undefined,
      bindExpiresAt: undefined,
    };

    stateRef.current = nextState;
    setState(nextState);
    setStartupWorkspaceMode('bound');
    setBindQrCodeDataUrl('');
    setBindQrCodeError('');
    setBindSessionView(null);
    resetInstallWizard();
    setMessage(input.detail);
    void persistBoundWorkspaceSnapshot(nextState);
  }

  const updaterStatus = settings.desktopVersion.updaterStatus;
  const shouldShowBackgroundInstallWorkspace = startupWorkspaceMode === 'unbound' && installShellMode === 'background';
  const shouldShowWorkspace = startupWorkspaceMode === 'bound' || shouldShowBackgroundInstallWorkspace;
  const shouldShowStartupCheck = startupWorkspaceMode === 'checking';
  const shouldShowInstallWizard = startupWorkspaceMode === 'unbound' && !shouldShowBackgroundInstallWorkspace;
  const shouldShowUpdateModal = Boolean(
    updaterStatus
      && updaterStatus.updateAvailable,
  );
  const currentAppVersion = packageJson.version || '0.0.0';
  const workspaceTitle = APP_DISPLAY_NAME;
  const runtimeEndpoint = state.runtimeConfig?.endpoint || runtimePackage.managedEndpoint || '-';
  const runtimeVersion = pickDisplayText(runtimePackage.version, state.runtimeHealth?.version) || '待检测';
  const openclawWorkspacePath = pickDisplayText(runtimePackage.workspacePath) || '-';
  const currentInstallPath =
    runtimePackage.boundInstallPath || runtimePackage.installDir || runtimePackage.detectedInstallPath || '-';
  const currentDeviceAlias = pickDisplayText(state.alias);
  const currentDeviceDisplay = `${state.deviceId || state.deviceCode || '-'}${currentDeviceAlias ? `（${currentDeviceAlias}）` : ''}`;
  const currentWechatUser = pickDisplayText(currentWechatUserName, state.ownerNickname) || '-';
  const currentSubscription = settings.desktopSubscription.subscription;
  const customLlmLocked = !settings.desktopLlm.allowCustomLlm;
  const currentPlanCode = currentSubscription?.account?.currentPlanCode || '';
  const currentPlanName = currentSubscription?.summary.planName || currentPlanCode || '未识别套餐';
  const customLlmLockedReason = '请到基本信息页扫码购买自定义模型套餐才能配置';
  const runtimeStatusDiagnostic = useMemo(
    () => deriveRuntimeStatusDiagnostic(runtimePackage, state.runtimeHealth),
    [runtimePackage, state.runtimeHealth],
  );
  const lobsterRuntimeStatus = resolveLobsterRuntimeStatus({
    startupWorkspaceMode,
    deviceStatus: state.status,
    runtimeBusy,
    runtimePackage,
    gatewayHealthy: state.gatewayHealthy,
    runtimeHealthStatus: state.runtimeHealth?.status,
    preferRunningSignal: runtimeStatusDiagnostic.preferRunningSignal,
  });
    useEffect(() => {
      if (startupWorkspaceMode !== 'bound' || !runtimeStatusDiagnostic.preferRunningSignal) {
        return;
      }

      setState((current) => {
        const nextDetail = runtimeStatusDiagnostic.note || runtimePackage.detail || current.runtimeHealth?.detail;
        const nextVersion = current.runtimeHealth?.version || runtimePackage.version;

        if (
          current.gatewayHealthy === true &&
          current.runtimeHealth?.status === 'healthy' &&
          current.runtimeHealth.detail === nextDetail &&
          current.runtimeHealth.version === nextVersion
        ) {
          return current;
        }

        return {
          ...current,
          gatewayHealthy: true,
          runtimeHealth: {
            status: 'healthy',
            detail: nextDetail,
            checkedAt: current.runtimeHealth?.checkedAt || new Date().toISOString(),
            version: nextVersion,
          },
        };
      });
    }, [runtimePackage.detail, runtimePackage.version, runtimeStatusDiagnostic.note, runtimeStatusDiagnostic.preferRunningSignal, startupWorkspaceMode]);
  const aboutHighlights = [
    `Desktop ${currentAppVersion}`,
    `OpenClaw ${runtimeVersion}`,
    `绑定状态 ${getBindingStatusLabel(state.status)}`,
  ];

  function renderWorkspacePlaceholder(
    title: string,
    detail: string,
    tone: 'empty' | 'panel' = 'panel',
  ) {
    return (
      <section className={`workspace-stage ${tone === 'empty' ? 'workspace-stage-empty' : ''}`}>
        <div className="workspace-stage-glow" aria-hidden="true" />
        <div className="workspace-stage-copy">
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
      </section>
    );
  }

  function summarizeSkills(items: SkillCompareItem[], localSkills: Array<{ slug: string }>) {
    const recommendedSlugs = new Set(items.map((item) => item.slug));
    const localInstalledSlugs = new Set(localSkills.map((item) => item.slug?.trim()).filter(Boolean));
    const installedCount = localInstalledSlugs.size;
    const totalCount = new Set([...recommendedSlugs, ...localInstalledSlugs]).size;
    const pendingCount = Math.max(totalCount - installedCount, 0);

    return {
      totalCount,
      installedCount,
      pendingCount,
    };
  }

  async function installRecommendedSkillsAfterRuntimeReady(handlers: {
    onLog: (line: string) => void;
    onProgressNote: (note: string) => void;
  }) {
    const startedAt = new Date().toISOString();
    const { onLog, onProgressNote } = handlers;

    const catalog = await getDesktopSkillsCatalog();
    const localSkills = await getLocalSkills().catch(() => []);
    const installedSlugs = new Set(
      localSkills
        .map((item) => normalizeSkillSlug(item.slug || ''))
        .filter(Boolean),
    );
    const reportItems: DesktopRecommendedSkillsInstallReport['items'] = [];
    let missingCount = 0;

    onLog(`已获取 ${catalog.items.length} 个服务端推荐 skills。`);
    onProgressNote('正在同步推荐技能本地状态...');

    for (const item of catalog.items) {
      const slug = normalizeSkillSlug(item.slug);
      if (!slug) {
        continue;
      }

      const name = item.name?.trim() || slug;
      if (installedSlugs.has(slug)) {
        reportItems.push({
          slug,
          name,
          status: 'already-installed',
          detail: '安装完成后检测到本地已可用。',
          finishedAt: new Date().toISOString(),
        });
        onLog(`技能 ${slug} 已可用，无需再次安装。`);
      } else {
        missingCount += 1;
        onLog(`技能 ${slug} 当前未安装，保留为手工安装候选。`);
      }
    }

    if (missingCount > 0) {
      onLog(`仍有 ${missingCount} 个推荐技能未自动就绪，可在技能管理中手工安装。`);
    }

    const report: DesktopRecommendedSkillsInstallReport = {
      source: 'install-wizard',
      startedAt,
      finishedAt: new Date().toISOString(),
      totalCount: catalog.items.length,
      installedCount: 0,
      alreadyInstalledCount: reportItems.filter((item) => item.status === 'already-installed').length,
      failedCount: 0,
      skillhubSiteUrl: catalog.skillhub?.siteUrl,
      installerUrl: catalog.skillhub?.installerUrl,
      items: reportItems,
    };

    await saveDesktopRecommendedSkillsInstallReport(report);
    setRecommendedSkillsInstallReport(report);
    setMessage(
      missingCount > 0
        ? `推荐 skills 状态已同步，本地已就绪 ${report.alreadyInstalledCount} 个，仍有 ${missingCount} 个可在技能管理中手工安装。`
        : `推荐 skills 状态已同步，本地已就绪 ${report.alreadyInstalledCount} 个。`,
    );

    return report;
  }

  async function refreshSkillsPanel() {
    setSkillsPanel((current) => ({
      ...current,
      loading: true,
      detail: current.items.length > 0 ? '正在同步推荐 skills 与本地安装状态...' : '正在加载技能列表...',
    }));

    const [catalogResult, localSkillsResult] = await Promise.allSettled([
      getDesktopSkillsCatalog(),
      getLocalSkills(),
    ] as const);

    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : {
      mode: 'recommended',
      notes: undefined,
      updatedAt: undefined,
      skillhub: undefined,
      items: [],
    };
    const localSkills = localSkillsResult.status === 'fulfilled' ? localSkillsResult.value : [];
    const items = mergeRecommendedAndLocalSkills(catalog.items, localSkills);
    const { totalCount, installedCount, pendingCount } = summarizeSkills(items, localSkills);
    const issues: string[] = [];

    if (catalogResult.status === 'rejected') {
      issues.push(`推荐列表读取失败：${describeError(catalogResult.reason)}`);
    }
    if (localSkillsResult.status === 'rejected') {
      issues.push(`本地列表读取失败：${describeError(localSkillsResult.reason)}`);
    }

    setSkillsPanel({
      loading: false,
      items,
      detail: items.length > 0
        ? issues.length > 0
          ? `${issues.join('；')}。当前展示 ${items.length} 个推荐技能，总计 ${totalCount} 个技能，其中本地已安装 ${installedCount} 个。`
          : `已同步 ${items.length} 个推荐技能，总计 ${totalCount} 个技能，其中本地已安装 ${installedCount} 个。`
        : issues.length > 0
          ? issues.join('；')
          : '当前没有可展示的技能。',
      totalCount,
      installedCount,
      pendingCount,
      checkedAt: new Date().toISOString(),
      skillhubSiteUrl: catalog.skillhub?.siteUrl,
    });

    if (issues.length > 0 && items.length === 0) {
      setMessage(issues.join('；'));
    }
  }

  async function handleInstallSkill(slug: string) {
    setSkillActionState({ slug, mode: 'install' });
    try {
      const catalog = await getDesktopSkillsCatalog();
      const localSkills = await installSkill(slug, {
        installerUrl: catalog.skillhub?.installerUrl,
      });
      const items = mergeRecommendedAndLocalSkills(catalog.items, localSkills);
      const { totalCount, installedCount, pendingCount } = summarizeSkills(items, localSkills);

      setSkillsPanel({
        loading: false,
        items,
        detail: `技能 ${slug} 安装完成，当前已安装 ${installedCount} 个技能。`,
        totalCount,
        installedCount,
        pendingCount,
        checkedAt: new Date().toISOString(),
        skillhubSiteUrl: catalog.skillhub?.siteUrl,
      });
      setMessage(`技能 ${slug} 安装完成。`);
    } catch (error) {
      const detail = describeError(error);
      setSkillsPanel((current) => ({
        ...current,
        detail: `技能 ${slug} 安装失败：${detail}`,
        checkedAt: new Date().toISOString(),
      }));
      setMessage(detail);
    } finally {
      setSkillActionState(null);
    }
  }

  async function handleUninstallSkill(slug: string) {
    setSkillActionState({ slug, mode: 'uninstall' });
    try {
      const [catalog, localSkills] = await Promise.all([
        getDesktopSkillsCatalog(),
        uninstallSkill(slug),
      ]);
      const items = mergeRecommendedAndLocalSkills(catalog.items, localSkills);
      const { totalCount, installedCount, pendingCount } = summarizeSkills(items, localSkills);

      setSkillsPanel({
        loading: false,
        items,
        detail: `技能 ${slug} 已卸载，当前已安装 ${installedCount} 个技能。`,
        totalCount,
        installedCount,
        pendingCount,
        checkedAt: new Date().toISOString(),
        skillhubSiteUrl: catalog.skillhub?.siteUrl,
      });
      setMessage(`技能 ${slug} 已卸载。`);
    } catch (error) {
      const detail = describeError(error);
      setSkillsPanel((current) => ({
        ...current,
        detail: `技能 ${slug} 卸载失败：${detail}`,
        checkedAt: new Date().toISOString(),
      }));
      setMessage(detail);
    } finally {
      setSkillActionState(null);
    }
  }

  async function refreshCliModelCatalog(providerCode?: string, providerPrefix?: string) {
    setCliModelCatalog((current) => ({
      ...current,
      loading: true,
      providerCode,
      providerPrefix,
      detail: '正在读取 OpenClaw CLI 实时模型目录...',
    }));

    try {
      // 1. 总是优先尝试读取 CLI status（不依赖能力探测结果）
      let statusResult: Awaited<ReturnType<typeof getOpenClawModelsStatus>> | null = null;
      try {
        statusResult = await getOpenClawModelsStatus();
      } catch {
        // status 读取失败不阻塞后续流程
      }

      // 2. 探测 CLI 能力（用于决定 list 命令是否可用）
      const capability = await probeOpenClawModelsCapability();
      const canReadList = capability.ok && capability.parsed?.listCapability;
      const cliPreferred = canReadList && providerPrefix && (providerPrefix !== 'openai' || providerCode === 'openai' || providerCode === 'openrouter');

      const listResult = cliPreferred ? await getOpenClawModelsList(providerPrefix) : null;

      const models = listResult?.ok ? (listResult.parsed?.models ?? []) : [];
      const sortedModels = [...models].sort((left, right) => {
        const availableDelta = Number(Boolean(right.available)) - Number(Boolean(left.available));
        if (availableDelta !== 0) {
          return availableDelta;
        }
        return (left.name || left.key).localeCompare(right.name || right.key, 'zh-CN');
      });

      const statusDefault = statusResult?.ok ? statusResult.parsed?.defaultModel : undefined;
      const statusResolved = statusResult?.ok ? statusResult.parsed?.resolvedDefault : undefined;

      if (cliPreferred && listResult?.ok) {
        setCliModelCatalog({
          loading: false,
          sourceMode: 'cli',
          detail: `CLI 实时目录已加载 ${sortedModels.length} 个模型，按当前 Provider 前缀 ${providerPrefix} 过滤。`,
          providerCode,
          providerPrefix,
          models: sortedModels,
          defaultModel: statusDefault,
          resolvedDefault: statusResolved,
        });
        return;
      }

      // status 读取成功但 list 不可用时仍展示 status 信息
      const statusOk = statusResult?.ok === true;
      const fallbackReason = statusOk && !cliPreferred
        ? providerPrefix === 'openai' && providerCode !== 'openai' && providerCode !== 'openrouter'
          ? '当前 Provider 走 OpenAI 兼容接口，CLI 无法直接识别远端私有模型目录，已回退到平台推荐模型。'
          : 'CLI 模型状态已获取，模型目录已回退到平台推荐模型。'
        : !capability.ok
          ? statusOk
            ? 'CLI 能力探测异常，但模型状态已通过直接读取获得。'
            : capability.detail || capability.stderr || 'OpenClaw CLI 当前不可用，无法读取本地模型状态。'
          : listResult?.detail || listResult?.stderr || 'OpenClaw CLI 未返回可用模型目录，已回退到平台推荐模型。';

      setCliModelCatalog({
        loading: false,
        sourceMode: statusOk ? 'cli' : 'fallback',
        detail: fallbackReason,
        providerCode,
        providerPrefix,
        models: [],
        defaultModel: statusDefault,
        resolvedDefault: statusResolved,
      });
    } catch (error) {
      setCliModelCatalog((current) => ({
        ...current,
        loading: false,
        sourceMode: 'fallback',
        detail: `读取 CLI 模型目录失败：${describeError(error)}`,
        providerCode,
        providerPrefix,
        models: [],
      }));
    }
  }

  function hasUnsavedAdvancedChanges() {
    return activeWorkspaceTab === 'advanced' && advancedConfigPanel.dirty;
  }

  function closeAdvancedLeaveDialog() {
    setAdvancedLeaveDialog({ open: false, saving: false, action: null });
  }

  async function performAdvancedLeaveAction(action: AdvancedLeaveAction) {
    switch (action.kind) {
      case 'tab':
        setActiveWorkspaceTab(action.tab);
        return;
      case 'refresh-root':
        await refreshAdvancedConfigPanel();
        return;
      case 'open-memory':
        await openTodayMemoryDirectory();
        return;
      case 'close-memory':
        await refreshAdvancedConfigPanel();
        return;
      case 'open-file':
        await openAdvancedConfigFile(action.file);
        return;
      case 'close-editor':
        setAdvancedConfigPanel((current) => ({
          ...current,
          activeFile: null,
          initialContent: '',
          editorContent: '',
          dirty: false,
          openingFileName: null,
          viewMode: 'root',
          detail: current.files.length > 0 ? `已读取 ${current.files.length} 个 Markdown 文件。` : current.detail,
        }));
        return;
      case 'reload-file':
        if (advancedConfigPanel.activeFile) {
          await openAdvancedConfigFile(advancedConfigPanel.activeFile);
        }
        return;
      default:
        return;
    }
  }

  async function requestAdvancedLeave(action: AdvancedLeaveAction) {
    if (!hasUnsavedAdvancedChanges()) {
      await performAdvancedLeaveAction(action);
      return;
    }

    setAdvancedLeaveDialog({ open: true, saving: false, action });
  }

  async function handleConfirmSaveAndLeave() {
    if (!advancedLeaveDialog.action) {
      closeAdvancedLeaveDialog();
      return;
    }

    setAdvancedLeaveDialog((current) => ({ ...current, saving: true }));
    const saved = await saveAdvancedConfigFile();
    if (!saved) {
      setAdvancedLeaveDialog((current) => ({ ...current, saving: false }));
      return;
    }

    const nextAction = advancedLeaveDialog.action;
    closeAdvancedLeaveDialog();
    await performAdvancedLeaveAction(nextAction);
  }

  async function handleConfirmDiscardAndLeave() {
    const nextAction = advancedLeaveDialog.action;
    closeAdvancedLeaveDialog();
    if (!nextAction) {
      return;
    }

    setAdvancedConfigPanel((current) => ({
      ...current,
      dirty: false,
      editorContent: current.initialContent,
    }));
    await performAdvancedLeaveAction(nextAction);
  }

  function handleWorkspaceTabChange(tab: DesktopWorkspaceTab) {
    void requestAdvancedLeave({ kind: 'tab', tab });
  }

  async function refreshAdvancedConfigPanel() {
    setAdvancedConfigPanel((current) => ({
      ...current,
      viewMode: 'root',
      loading: true,
      detail: current.files.length > 0 ? '正在刷新当前 OpenClaw workspace Markdown 列表...' : '正在读取当前 OpenClaw workspace Markdown 列表...',
    }));

    try {
      const payload = await listWorkspaceMarkdownFiles();
      setAdvancedConfigPanel((current) => ({
        ...current,
        viewMode: 'root',
        loading: false,
        workspacePath: payload.workspacePath,
        files: payload.files,
        detail: payload.files.length > 0 ? `已读取 ${payload.files.length} 个 Markdown 文件。` : '当前 workspace 目录下没有 Markdown 文件。',
        lastCheckedAt: new Date().toISOString(),
        activeFile: current.activeFile
          ? payload.files.find((item) => item.name === current.activeFile?.name) ?? current.activeFile
          : null,
      }));
    } catch (error) {
      const detail = describeError(error);
      setAdvancedConfigPanel((current) => ({
        ...current,
        loading: false,
        detail,
      }));
      setMessage(detail);
    }
  }

  async function refreshMemoryOverview(selectedDay?: string | null) {
    setMemoryOverviewPanel((current) => ({
      ...current,
      loading: true,
      detail: selectedDay ? `正在读取 ${selectedDay} 的 memory 记录...` : '正在读取 OpenClaw memory 数据...',
    }));

    try {
      const overview = await getOpenClawMemoryOverview(selectedDay || undefined);
      setMemoryOverviewPanel({
        loading: false,
        overview,
        selectedDay: overview.selectedDay || null,
        detail: overview.detail,
      });
    } catch (error) {
      const detail = describeError(error);
      setMemoryOverviewPanel((current) => ({
        ...current,
        loading: false,
        detail,
      }));
      setMessage(detail);
    }
  }

  async function openTodayMemoryDirectory() {
    setAdvancedConfigPanel((current) => ({
      ...current,
      viewMode: 'memory',
      activeFile: null,
      initialContent: '',
      editorContent: '',
      dirty: false,
      openingFileName: null,
    }));
    await refreshMemoryOverview(memoryOverviewPanel.selectedDay);
  }

  async function openAdvancedConfigFile(file: WorkspaceMarkdownFileItem) {
    setAdvancedConfigPanel((current) => ({
      ...current,
      openingFileName: file.name,
      detail: `正在打开 ${file.name}...`,
    }));

    try {
      const content = await readWorkspaceMarkdownFile(file.relativePath);
      setAdvancedConfigPanel((current) => ({
        ...current,
        viewMode: 'editor',
        openingFileName: null,
        activeFile: file,
        initialContent: content,
        editorContent: content,
        dirty: false,
        detail: `${file.name} 已加载，可直接编辑并保存。`,
      }));
    } catch (error) {
      const detail = describeError(error);
      setAdvancedConfigPanel((current) => ({
        ...current,
        openingFileName: null,
        detail,
      }));
      setMessage(detail);
    }
  }

  function closeAdvancedConfigEditor() {
    setAdvancedConfigPanel((current) => ({
      ...current,
      activeFile: null,
      initialContent: '',
      editorContent: '',
      dirty: false,
      openingFileName: null,
      viewMode: 'root',
      detail: current.files.length > 0 ? `已读取 ${current.files.length} 个 Markdown 文件。` : current.detail,
    }));
  }

  function closeTodayMemoryDirectory() {
    void refreshAdvancedConfigPanel();
  }

  async function reloadAdvancedConfigFile() {
    if (!advancedConfigPanel.activeFile) {
      return;
    }

    await openAdvancedConfigFile(advancedConfigPanel.activeFile);
  }

  async function saveAdvancedConfigFile() {
    if (!advancedConfigPanel.activeFile) {
      return false;
    }

    setAdvancedConfigPanel((current) => ({
      ...current,
      saving: true,
      detail: `正在保存 ${current.activeFile?.name || ''}...`,
    }));

    try {
      const savedPath = await saveWorkspaceMarkdownFile(advancedConfigPanel.activeFile.relativePath, advancedConfigPanel.editorContent);
      const savedAt = new Date().toLocaleString('zh-CN', { hour12: false });

      setAdvancedConfigPanel((current) => ({
        ...current,
        saving: false,
        initialContent: current.editorContent,
        dirty: false,
        detail: `${current.activeFile?.name || '文件'} 已保存。`,
        files: current.files.map((item) => item.name === current.activeFile?.name
          ? { ...item, path: savedPath, modifiedAt: savedAt }
          : item),
        activeFile: current.activeFile ? { ...current.activeFile, path: savedPath, modifiedAt: savedAt } : null,
      }));
      setMessage(`${advancedConfigPanel.activeFile.name} 已保存到本地 OpenClaw workspace。`);
      return true;
    } catch (error) {
      const detail = describeError(error);
      setAdvancedConfigPanel((current) => ({
        ...current,
        saving: false,
        detail,
      }));
      setMessage(detail);
      return false;
    }
  }

  function renderHomePanel() {
    const currentPlan = currentSubscription?.summary.planName || '未获取';
    const currentPlanStatus = currentSubscription?.summary.statusLabel || (settings.subscriptionPanelBusy === 'refresh' ? '同步中' : '待同步');
    const currentExpireAt = currentSubscription?.account?.expireAt
      || currentSubscription?.trial?.trialEndAt
      || currentSubscription?.entitlement?.effectiveTo
      || '';
    const deviceUsageLabel = currentSubscription
      ? `${currentSubscription.usage.activeDeviceCount}/${currentSubscription.usage.totalDeviceLimit}`
      : '-';
    const remainingDaysLabel = currentSubscription?.trial?.inTrial
      ? `${currentSubscription.trial.daysLeft} 天`
      : currentSubscription?.trial?.available
        ? '可开启试用'
        : '按套餐周期';
    const featureHighlights = currentSubscription?.summary.featureHighlights?.filter(Boolean).slice(0, 3) ?? [];

    return (
      <section className="workspace-stage workspace-basic-stage">
        <div className="workspace-basic-panel">
          <div className={`lobster-status-section workspace-basic-section${lobsterStatusOpen ? ' is-open' : ''}`}>
            <div className="lobster-status-summary">
              <button
                type="button"
                className="lobster-collapse-toggle"
                onClick={() => setLobsterStatusOpen((v) => !v)}
                aria-label={lobsterStatusOpen ? '折叠龙虾状态' : '展开龙虾状态'}
              >
                <ChevronDown size={18} className="lobster-summary-chevron" />
              </button>
              <span className="lobster-summary-title">龙虾状态</span>
              <span className={`workspace-status-badge ${lobsterRuntimeStatus.tone}`}>{lobsterRuntimeStatus.label}</span>
              <span className="lobster-summary-actions">
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => void handleManualRefreshRuntime()}
                  disabled={homeActionBusy !== null || runtimeBusy !== null}
                >
                  {homeActionBusy === 'refresh' ? '刷新中...' : '手动刷新'}
                </button>
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => handleRestartLobsterRuntime()}
                  disabled={homeActionBusy !== null || runtimeBusy !== null}
                >
                  {homeActionBusy === 'restart' ? '重启中…' : '重新启动'}
                </button>
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => handleReinstallLobsterRuntime()}
                  disabled={homeActionBusy !== null || runtimeBusy !== null}
                >
                  {homeActionBusy === 'reinstall' ? '重新安装中...' : '重新安装'}
                </button>
                <button
                  type="button"
                  className="workspace-primary-action workspace-danger-action"
                  onClick={() => void handleUninstallLobsterRuntime()}
                  disabled={homeActionBusy !== null || runtimeBusy !== null}
                >
                  {homeActionBusy === 'uninstall' ? '卸载中...' : '卸载龙虾'}
                </button>
              </span>
            </div>

            {lobsterStatusOpen && <div className="lobster-status-body workspace-basic-section-body">

              <div className="workspace-basic-info-grid">
                <div className="workspace-basic-info-item">
                  <span>绑定设备：<b>{currentDeviceDisplay}</b></span>
                </div>

                <div className="workspace-basic-info-item">
                  <span>微信用户：<b>{currentWechatUser}</b></span>
                </div>

                <div className="workspace-basic-info-item">
                  <span>OpenClaw版本: <b>{runtimeVersion}</b></span>
                </div>

                <div className="workspace-basic-info-item is-wide">
                  <span>工作区：<b>{openclawWorkspacePath}</b></span>
                </div>

                <div className="workspace-basic-info-item is-wide">
                  <span>安装路径：<b>{currentInstallPath}</b></span>
                </div>
              </div>
              {runtimeStatusDiagnostic.note ? (
                <div className="workspace-basic-inline-note">
                  <strong>运行时提示</strong>
                  <span>{runtimeStatusDiagnostic.note}</span>
                </div>
              ) : null}
            </div>}
          </div>

          <div className={`lobster-status-section workspace-basic-section${subscriptionInfoOpen ? ' is-open' : ''}`}>
            <div className="lobster-status-summary">
              <button
                type="button"
                className="lobster-collapse-toggle"
                onClick={() => setSubscriptionInfoOpen((v) => !v)}
                aria-label={subscriptionInfoOpen ? '折叠订阅信息' : '展开订阅信息'}
              >
                <ChevronDown size={18} className="lobster-summary-chevron" />
              </button>
              <span className="lobster-summary-title">订阅信息</span>
              <span className="workspace-status-badge is-neutral">{currentPlanStatus}</span>
              <span className="lobster-summary-actions">
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => void settings.refreshDesktopSubscriptionPanel()}
                  disabled={settings.subscriptionPanelBusy === 'refresh'}
                >
                  {settings.subscriptionPanelBusy === 'refresh' ? '同步中...' : '刷新订阅'}
                </button>
              </span>
            </div>

            {subscriptionInfoOpen && <div className="lobster-status-body workspace-basic-section-body">
              <div className="workspace-basic-subscription-grid">
                <div className="workspace-basic-subscription-main">
                  <div className="workspace-basic-subscription-card is-highlight">
                    <span className="workspace-basic-card-label">当前套餐</span>
                    <strong>{currentPlan}</strong>
                    <p>
                      {currentSubscription
                        ? `剩余天数：${remainingDaysLabel} ｜ ${currentExpireAt ? `到期时间：${formatDisplayTime(currentExpireAt)}` : '到期时间待同步'} ｜ 设备已绑定：${deviceUsageLabel}`
                        : settings.subscriptionPanelBusy === 'refresh'
                          ? '正在从服务端同步订阅信息...'
                          : '当前尚未从服务端获取到订阅信息。'}
                    </p>
                  </div>

                  {featureHighlights.length > 0 ? (
                    <div className="workspace-basic-highlights">
                      {featureHighlights.map((item) => (
                        <span key={item} className="workspace-basic-highlight-chip">{item}</span>
                      ))}
                    </div>
                  ) : null}

                  {settings.latestSubscriptionNotification ? (
                    <div className="workspace-basic-subscription-card">
                      <span className="workspace-basic-card-label">最近同步</span>
                      <strong>{settings.latestSubscriptionNotification.title}</strong>
                      <p>{settings.latestSubscriptionNotification.detail}</p>
                    </div>
                  ) : null}
                </div>

                <div className="workspace-basic-subscription-side">
                  <div className="workspace-basic-subscription-card workspace-basic-qr-card">
                    <strong>请扫码到小程序中订阅</strong>
                    {subscriptionQrCodeError ? (
                      <div className="workspace-basic-qr-placeholder">{subscriptionQrCodeError}</div>
                    ) : subscriptionQrCodeDataUrl ? (
                      <img src={subscriptionQrCodeDataUrl} alt="订阅小程序二维码" className="workspace-basic-qr-image" />
                    ) : (
                      <div className="workspace-basic-qr-placeholder">二维码生成中...</div>
                    )}
                  </div>
                </div>
              </div>
            </div>}
          </div>
        </div>
      </section>
    );
  }

  function renderSkillsPanel() {
    const { totalCount, installedCount, pendingCount } = skillsPanel;
    const autoInstallSummary = recommendedSkillsInstallReport
      ? summarizeRecommendedSkillsInstallReport(recommendedSkillsInstallReport)
      : null;

    return (
      <section className="workspace-stage workspace-skills-stage">
        <div className="workspace-skills-panel">
          <div className="workspace-skills-toolbar">
            <div className="workspace-skills-summary-inline">
              <span>{`总计 ${totalCount} 个技能，已安装 ${installedCount} 个，未安装 ${pendingCount} 个`}</span>
            </div>

            <button
              type="button"
              className="workspace-skills-refresh"
              onClick={() => void refreshSkillsPanel()}
              disabled={skillsPanel.loading || skillActionState !== null}
            >
              <RefreshCw className={skillsPanel.loading ? 'is-spinning' : ''} strokeWidth={1.9} />
              <span>{skillsPanel.loading ? '同步中...' : '刷新列表'}</span>
            </button>
          </div>

          <div className="workspace-skill-list" role="list" aria-label="推荐技能列表">
            {skillsPanel.items.length === 0 ? (
              <div className="workspace-skill-empty">
                <p>{skillsPanel.loading ? '正在加载推荐技能...' : '当前没有推荐技能。'}</p>
              </div>
            ) : (
              skillsPanel.items.map((item, index) => {
                const installed = item.installStatus === 'installed';
                const isInstalling = skillActionState?.slug === item.slug && skillActionState.mode === 'install';
                const isUninstalling = skillActionState?.slug === item.slug && skillActionState.mode === 'uninstall';

                return (
                  <article key={item.slug} className="workspace-skill-item" role="listitem">
                    <div className={`workspace-skill-rank ${installed ? 'is-installed' : ''}`}>
                      <span>{index + 1}</span>
                    </div>

                    <div className="workspace-skill-main">
                      <div className="workspace-skill-title-row">
                        <h3>{item.name}</h3>
                        {item.tags?.slice(0, 2).map((tag) => (
                          <span key={`${item.slug}-${tag}`} className="workspace-skill-tag">{tag}</span>
                        ))}
                      </div>

                      <p>{item.description || '该技能暂无补充说明。'}</p>

                      <div className="workspace-skill-meta">
                        <span>{item.recommended ? 'RHClaw推荐' : '本地已装'}</span>
                        <span>{item.owner ? `作者: ${item.owner}` : '作者: 未知'}</span>
                        <span>{item.source ? `来源: ${item.source}` : ''}</span>
                        <span>{item.version ? `版本: ${item.version}` : '未标注版本'}</span>
                        {item.localVersion ? <span>{`本地 ${item.localVersion}`}</span> : null}
                      </div>
                    </div>

                    <div className="workspace-skill-side">
                      <div className="workspace-skill-downloads" title="下载次数">
                        <span className="workspace-skill-downloads-label">{`下载次数 ${formatSkillDownloads(item.downloads)}`}</span>
                      </div>

                      <span className={`workspace-skill-status ${installed ? 'is-installed' : 'is-pending'}`}>
                        {installed ? (
                          <>
                            <Check strokeWidth={2.2} />
                            <span>已安装</span>
                          </>
                        ) : (
                          <>
                            <Download strokeWidth={2.2} />
                            <span>未安装</span>
                          </>
                        )}
                      </span>

                      <button
                        type="button"
                        className={`workspace-skill-action ${installed ? 'is-danger' : ''}`}
                        onClick={() => void (installed ? handleUninstallSkill(item.slug) : handleInstallSkill(item.slug))}
                        disabled={skillActionState !== null || skillsPanel.loading}
                      >
                        {isInstalling ? (
                          <>
                            <LoaderCircle className="is-spinning" strokeWidth={2} />
                            <span>安装中...</span>
                          </>
                        ) : isUninstalling ? (
                          <>
                            <LoaderCircle className="is-spinning" strokeWidth={2} />
                            <span>卸载中...</span>
                          </>
                        ) : (
                          <>
                            {installed ? <Trash2 strokeWidth={2} /> : <Download strokeWidth={2} />}
                            <span>{installed ? '卸载' : '安装'}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="workspace-skills-footer">
            <span>{skillsPanel.checkedAt ? `最近同步：${formatDisplayTime(skillsPanel.checkedAt)}` : '尚未同步'}</span>
            {skillsPanel.skillhubSiteUrl ? <span>{`来源：${skillsPanel.skillhubSiteUrl}`}</span> : null}
            {autoInstallSummary ? <span>{autoInstallSummary.summary}</span> : null}
            {recommendedSkillsInstallReport?.finishedAt ? <span>{`自动安装时间：${formatDisplayTime(recommendedSkillsInstallReport.finishedAt)}`}</span> : null}
            {autoInstallSummary?.failedDetail ? <span>{autoInstallSummary.failedDetail}</span> : null}
          </div>
        </div>
      </section>
    );
  }

  function handleSelectLlmProvider(providerCode: string) {
    const provider = settings.desktopLlm.providers.find((item) => item.providerCode === providerCode);
    settings.setLlmProviderCode(providerCode);
    settings.setLlmBaseUrl(provider?.defaultBaseUrl || '');
    settings.setLlmDefaultModel(provider?.defaultModel || '');
    setLlmModelSearchQuery('');
  }

  function resetLlmDraftFromProvider() {
    const provider = settings.selectedLlmProvider;
    settings.setLlmBaseUrl(provider?.defaultBaseUrl || '');
    settings.setLlmDefaultModel(provider?.defaultModel || '');
  }

  function renderModelsPanel() {
    const assignment = settings.desktopLlm.assignment;
    const selectedProvider = settings.selectedLlmProvider;
    const assignedPoolEntry = assignment?.assignedPoolEntry ?? null;
    const activeConfig = settings.desktopLlm.activeConfig;
    const providerOptions = settings.desktopLlm.providers;
    const providerConfigs = settings.desktopLlm.configs.filter((item) => item.providerCode === settings.llmProviderCode);
    const normalizedModelSearchQuery = llmModelSearchQuery.trim().toLowerCase();
    const filteredCliModels = cliModelCatalog.sourceMode === 'cli'
      ? cliModelCatalog.models.filter((item) => {
          if (!normalizedModelSearchQuery) {
            return true;
          }

          const haystacks = [
            item.key,
            item.name,
            item.input,
            extractModelValueFromCliKey(item.key, selectedProvider?.openclawPrefix),
          ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());

          return haystacks.some((value) => value.includes(normalizedModelSearchQuery));
        })
      : [];
    const groupedCliModels = groupCliModels(filteredCliModels);
    const cliModelOptions = cliModelCatalog.sourceMode === 'cli'
      ? filteredCliModels
          .map((item) => extractModelValueFromCliKey(item.key, selectedProvider?.openclawPrefix))
          .filter(Boolean)
      : [];
    const baseUrlOptions = buildUniqueOptions([
      selectedProvider?.defaultBaseUrl,
      assignedPoolEntry?.providerCode === settings.llmProviderCode ? assignedPoolEntry.baseUrl : null,
      ...providerConfigs.map((item) => item.baseUrl),
      settings.llmBaseUrl,
    ]);
    const modelOptions = buildUniqueOptions([
      selectedProvider?.defaultModel,
      ...(selectedProvider?.recommendedModels ?? []),
      ...cliModelOptions,
      assignedPoolEntry?.providerCode === settings.llmProviderCode ? assignedPoolEntry.defaultModel : null,
      ...providerConfigs.map((item) => item.defaultModel),
      settings.llmDefaultModel,
    ]);
    const busy = settings.llmPanelBusy !== null;
    const restoreDisabled = !assignedPoolEntry || busy;
    const effectiveOpenClawModel = cliModelCatalog.resolvedDefault || cliModelCatalog.defaultModel || '待检测';
    const hasDetectedLocalModel = Boolean(cliModelCatalog.resolvedDefault || cliModelCatalog.defaultModel);
    const configurationSourceLabel = assignment?.source === 'custom'
      ? '来自已激活的自定义模型配置'
      : assignment?.source === 'pool'
        ? `来自${formatPoolTypeLabel(assignment.recommendedPoolType)}套餐模型`
        : hasDetectedLocalModel
          ? '检测到本地模型，但暂未匹配到来源记录'
          : currentPlanCode
            ? '当前未识别为自定义模型，先按套餐信息显示'
            : '当前模型来源待确认';
    const configurationSourceDetail = assignment?.source === 'custom'
      ? activeConfig
        ? `${activeConfig.providerName} / ${activeConfig.defaultModel || '-'} ｜ 最近校验 ${formatDisplayTime(activeConfig.lastVerifiedAt || activeConfig.updatedAt)}`
        : '自定义配置已生效，但本地尚未同步到详情。'
      : assignment?.source === 'pool'
        ? assignedPoolEntry
          ? `${assignedPoolEntry.providerName} / ${assignedPoolEntry.defaultModel} ｜ ${assignedPoolEntry.baseUrl}`
          : '套餐模型来源已生效，但服务端未返回池分配详情。'
        : hasDetectedLocalModel
          ? `本地 OpenClaw 当前使用 ${effectiveOpenClawModel}，但服务端暂未将它识别为“自定义模型”或“套餐模型”。如刚完成配置，可点击“刷新状态”重新识别。`
          : `${currentPlanName ? `当前套餐 ${currentPlanName}` : '当前套餐信息可用'}${currentPlanCode ? `（${currentPlanCode}）` : ''} ｜ 如刚完成模型配置，可点击“刷新状态”重新识别`;

    return (
      <section className="workspace-stage workspace-model-stage">
        <div className="workspace-model-panel">
          <section className="workspace-model-section">
            <div className="workspace-model-section-head">
              <div>
                <h2>当前模型</h2>
              </div>

              <div className="workspace-model-actions">
                <button
                  type="button"
                  className="workspace-secondary-action"
                  onClick={() => void Promise.all([
                    settings.refreshDesktopLlmPanel(),
                    refreshCliModelCatalog(settings.selectedLlmProvider?.providerCode, settings.selectedLlmProvider?.openclawPrefix),
                  ])}
                  disabled={busy}
                >
                  {settings.llmPanelBusy === 'refresh' ? '同步中...' : '刷新状态'}
                </button>
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => void settings.handleReassignDesktopLlm()}
                  disabled={restoreDisabled}
                  title={assignedPoolEntry ? '恢复到套餐池当前分配模型' : '当前未检测到套餐池分配模型'}
                >
                  {settings.llmPanelBusy === 'reassign' ? '恢复中...' : '恢复套餐模型配置'}
                </button>
              </div>
            </div>

            <div className="workspace-model-summary-band">
              <div className="workspace-model-current-grid is-summary">
                <article className="workspace-model-card is-hero">
                  <span className="workspace-basic-card-label">当前 OpenClaw 实际使用模型</span>
                  <strong>{effectiveOpenClawModel}</strong>
                  <p>
                    {cliModelCatalog.sourceMode === 'cli'
                      ? `CLI 当前默认模型：${cliModelCatalog.defaultModel || '未设置'} ｜ 实际解析：${cliModelCatalog.resolvedDefault || '未解析'}`
                      : cliModelCatalog.detail}
                  </p>
                  <div className="workspace-model-chip-row">
                    <span className={`workspace-status-badge ${cliModelCatalog.sourceMode === 'cli' ? 'is-success' : 'is-neutral'}`}>
                      {cliModelCatalog.sourceMode === 'cli' ? 'CLI 实时状态' : '兼容回退'}
                    </span>
                    <span className={`workspace-status-badge ${assignment?.source === 'custom' ? 'is-warning' : assignment?.source === 'pool' ? 'is-success' : 'is-neutral'}`}>
                      {formatLlmSourceLabel(assignment?.source, hasDetectedLocalModel)}
                    </span>
                    {assignment?.hasPendingReassign ? <span className="workspace-model-inline-tip is-danger">检测到套餐模型待重新同步</span> : null}
                    {cliModelCatalog.loading ? <span className="workspace-model-inline-tip">CLI 目录刷新中...</span> : null}
                  </div>
                </article>

                <article className="workspace-model-card">
                  <span className="workspace-basic-card-label">配置来源</span>
                  <strong>{configurationSourceLabel}</strong>
                  <p>
                    {configurationSourceDetail}
                  </p>
                </article>
              </div>
            </div>
          </section>

          <section className="workspace-model-section">
            <div className="workspace-model-section-head">
              <div>
                <h2>配置自定义模型</h2>
                <p>通过 OpenClaw CLI 命令行配置官方模型向导或兼容自定义模型，请在终端中执行以下步骤。点击代码块右侧即可复制命令。</p>
              </div>
            </div>

            <div className="workspace-model-section-eyebrow">
              <h3>方式一：官方配置命令指导</h3>
              <p>按官方向导选择模型，填写 API Key（适用于绝大多数标准 Provider，如 anthropic, openai 等）</p>
            </div>

            <div className="workspace-model-current-grid">
              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">步骤一：查看当前模型状态</span>
                <strong>确认当前使用的模型与解析结果</strong>
                <p>执行以下命令查看当前默认模型：</p>
                <div className="workspace-model-cli-container">
                  <pre className="workspace-model-cli-block"><code>openclaw models status</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models status')} title="复制"><Copy size={14} /></button>
                </div>
              </article>

              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">步骤二：查看可用模型目录</span>
                <strong>列出全部或指定 Provider 的模型</strong>
                <p>查看全部模型：</p>
                <div className="workspace-model-cli-container workspace-model-cli-container-spaced">
                  <pre className="workspace-model-cli-block"><code>openclaw models list --all</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models list --all')} title="复制"><Copy size={14} /></button>
                </div>
                <p>按 Provider 过滤（以 anthropic 为例）：</p>
                <div className="workspace-model-cli-container">
                  <pre className="workspace-model-cli-block"><code>openclaw models list --provider anthropic --all</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models list --provider anthropic --all')} title="复制"><Copy size={14} /></button>
                </div>
              </article>

              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">步骤三：运行鉴权向导</span>
                <strong>交互完成鉴权与模型选择</strong>
                <p>推荐初次使用交互向导：</p>
                <div className="workspace-model-cli-container workspace-model-cli-container-spaced">
                  <pre className="workspace-model-cli-block"><code>openclaw models auth login</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models auth login')} title="复制"><Copy size={14} /></button>
                </div>
                <p>直接粘贴已有 API Key：</p>
                <div className="workspace-model-cli-container">
                  <pre className="workspace-model-cli-block"><code>openclaw models auth paste-token --provider anthropic</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models auth paste-token --provider anthropic')} title="复制"><Copy size={14} /></button>
                </div>
              </article>
            </div>

            <div className="workspace-model-section-eyebrow workspace-model-section-eyebrow-spaced">
              <h3>方式二：兼容模型配置方法指导（进阶）</h3>
              <p>如果您使用由于特殊原因不在目录中的第三方 API（如自建转发平台），请手动配置兼容环境。</p>
            </div>

            <div className="workspace-model-current-grid">
              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">进阶 1：编写环境变量</span>
                <strong>配置 OPENAI 兼容网关信息</strong>
                <p>编辑 <code>~/.openclaw/.env</code> 文件，写入以下环境变量：</p>
                <div className="workspace-model-cli-container">
                  <pre className="workspace-model-cli-block"><code>{`OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://your-api-endpoint/v1`}</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('OPENAI_API_KEY=sk-your-api-key\nOPENAI_BASE_URL=https://your-api-endpoint/v1')} title="复制"><Copy size={14} /></button>
                </div>
              </article>

              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">进阶 2：修改网关配置</span>
                <strong>设置全局默认模型为 openai 协议</strong>
                <p>编辑 <code>~/.openclaw/openclaw.json</code>，确保包含如下结构：</p>
                <div className="workspace-model-cli-container">
                  <pre className="workspace-model-cli-block"><code>{`{
  "agents": {
    "defaults": {
      "model": "openai/your-model-name"
    }
  }
}`}</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('{\n  "agents": {\n    "defaults": {\n      "model": "openai/your-model-name"\n    }\n  }\n}')} title="复制"><Copy size={14} /></button>
                </div>
              </article>

              <article className="workspace-model-card">
                <span className="workspace-basic-card-label">完成配置后验证</span>
                <strong>验证修改与同步 Desktop 面板</strong>
                <p>重新检测本地 Gateway 使用模型的状况：</p>
                <div className="workspace-model-cli-container workspace-model-cli-container-spaced">
                  <pre className="workspace-model-cli-block"><code>openclaw models status</code></pre>
                  <button type="button" className="workspace-model-cli-copy" onClick={() => navigator.clipboard.writeText('openclaw models status')} title="复制"><Copy size={14} /></button>
                </div>
                <p>确认无误后，返回顶部点击「刷新状态」同步显示。</p>
              </article>
            </div>
          </section>
        </div>
      </section>
    );
  }

  function renderAdvancedPanel() {
    const lineCount = Math.max(advancedConfigPanel.editorContent.split('\n').length, 1);
    const showingMemoryList = advancedConfigPanel.viewMode === 'memory' && !advancedConfigPanel.activeFile;
    const memoryOverview = memoryOverviewPanel.overview;

    return (
      <section className="workspace-stage workspace-advanced-stage">
        <div className="workspace-advanced-panel">
          {advancedConfigPanel.activeFile ? (
            <section className="workspace-advanced-section workspace-advanced-editor-section">
              <div className="workspace-advanced-editor-header">
                <button type="button" className="workspace-advanced-back-button" onClick={() => void requestAdvancedLeave({ kind: 'close-editor' })}>
                  <ChevronLeft strokeWidth={2.2} />
                  <span>返回</span>
                </button>

                <div className="workspace-advanced-editor-meta">
                  <h3>编辑 {advancedConfigPanel.activeFile.name}</h3>
                  <p>{advancedConfigPanel.activeFile.path}</p>
                </div>

                <div className="workspace-advanced-actions">
                  <button
                    type="button"
                    className="workspace-secondary-action"
                    onClick={() => void requestAdvancedLeave({ kind: 'reload-file' })}
                    disabled={advancedConfigPanel.saving || advancedConfigPanel.openingFileName !== null}
                  >
                    重新读取
                  </button>
                  <button
                    type="button"
                    className="workspace-primary-action"
                    onClick={() => void saveAdvancedConfigFile()}
                    disabled={advancedConfigPanel.saving || advancedConfigPanel.openingFileName !== null || !advancedConfigPanel.dirty}
                  >
                    {advancedConfigPanel.saving ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>

              <div className="workspace-advanced-editor-statusbar">
                <span>工作区：{advancedConfigPanel.workspacePath || '待检测'}</span>
                <span>{advancedConfigPanel.dirty ? '当前有未保存修改' : '内容已同步到本地文件'}</span>
                <span>{advancedConfigPanel.activeFile.modifiedAt ? `最近修改：${advancedConfigPanel.activeFile.modifiedAt}` : '最近修改时间未知'}</span>
              </div>

              <div className="workspace-advanced-editor-shell">
                <div className="workspace-advanced-editor-gutter" aria-hidden="true">
                  {Array.from({ length: lineCount }, (_, index) => (
                    <span key={`${advancedConfigPanel.activeFile?.name}-${index + 1}`}>{index + 1}</span>
                  ))}
                </div>

                <textarea
                  className="workspace-advanced-editor"
                  aria-label={`编辑 ${advancedConfigPanel.activeFile.name}`}
                  value={advancedConfigPanel.editorContent}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setAdvancedConfigPanel((current) => ({
                      ...current,
                      editorContent: nextValue,
                      dirty: nextValue !== current.initialContent,
                    }));
                  }}
                  spellCheck={false}
                  disabled={advancedConfigPanel.saving || advancedConfigPanel.openingFileName !== null}
                />
              </div>
            </section>
          ) : showingMemoryList ? (
            <section className="workspace-advanced-section">
              <div className="workspace-advanced-editor-header">
                <button type="button" className="workspace-advanced-back-button" onClick={() => void requestAdvancedLeave({ kind: 'close-memory' })}>
                  <ChevronLeft strokeWidth={2.2} />
                  <span>返回</span>
                </button>

                <div className="workspace-advanced-editor-meta">
                  <h3>每日记忆</h3>
                  <p>{memoryOverview?.dbPath || '正在读取 OpenClaw memory 数据库路径...'}</p>
                </div>

                <div className="workspace-advanced-actions">
                  <button
                    type="button"
                    className="workspace-secondary-action"
                    onClick={() => void refreshMemoryOverview(memoryOverviewPanel.selectedDay)}
                    disabled={advancedConfigPanel.loading || advancedConfigPanel.saving || advancedConfigPanel.openingFileName !== null}
                  >
                    {memoryOverviewPanel.loading ? '刷新中...' : '刷新记忆'}
                  </button>
                </div>
              </div>

              <div className="workspace-advanced-meta-row">
                <span>{memoryOverviewPanel.detail}</span>
                <span>{memoryOverview?.selectedDay ? `当前日期：${memoryOverview.selectedDay}` : '当前无日期筛选'}</span>
              </div>

              <div className="workspace-advanced-memory-summary-grid">
                <article className="workspace-advanced-memory-summary-card">
                  <span>数据库</span>
                  <strong>{memoryOverview?.available ? '已连接' : '未发现'}</strong>
                  <p>{memoryOverview?.dbPath || '未检测到 ~/.openclaw/memory/main.sqlite'}</p>
                </article>
                <article className="workspace-advanced-memory-summary-card">
                  <span>文件记录</span>
                  <strong>{memoryOverview?.fileCount ?? 0}</strong>
                  <p>{memoryOverview ? `库大小 ${(memoryOverview.dbSizeBytes / 1024).toFixed(1)} KB` : '等待读取'}</p>
                </article>
                <article className="workspace-advanced-memory-summary-card">
                  <span>Chunk 数</span>
                  <strong>{memoryOverview?.chunkCount ?? 0}</strong>
                  <p>{memoryOverview?.days.length ? `共 ${memoryOverview.days.length} 个日期分组` : '当前无日期分组'}</p>
                </article>
              </div>

              <div className="workspace-advanced-memory-days" role="list" aria-label="memory 日期列表">
                {(memoryOverview?.days ?? []).length === 0 ? (
                  <div className="workspace-model-empty">{memoryOverviewPanel.loading ? '正在加载 memory 日期...' : '当前 memory 数据库中还没有可展示的日期记录。'}</div>
                ) : (
                  memoryOverview?.days.map((dayItem) => (
                    <button
                      key={dayItem.day}
                      type="button"
                      className={`workspace-advanced-memory-day-chip ${memoryOverviewPanel.selectedDay === dayItem.day ? 'is-active' : ''}`}
                      onClick={() => void refreshMemoryOverview(dayItem.day)}
                      disabled={memoryOverviewPanel.loading}
                      role="listitem"
                    >
                      <strong>{dayItem.day}</strong>
                      <span>{dayItem.fileCount} 条记录</span>
                    </button>
                  ))
                )}
              </div>

              <div className="workspace-advanced-memory-records" role="list" aria-label="memory 记录列表">
                {(memoryOverview?.records ?? []).length === 0 ? (
                  <div className="workspace-model-empty">{memoryOverviewPanel.loading ? '正在加载 memory 记录...' : '当前日期下还没有可展示的 memory 记录。'}</div>
                ) : (
                  memoryOverview?.records.map((record) => {
                    return (
                      <article key={`${record.path}-${record.updatedAt || record.fileMtime || 'na'}`} className="workspace-advanced-memory-record-card" role="listitem">
                        <div className="workspace-advanced-memory-record-main">
                          <div className="workspace-advanced-file-title-row">
                            <strong>{record.path}</strong>
                            <span className="workspace-advanced-file-badge is-ready">{record.source}</span>
                          </div>
                          <p>{record.updatedAt ? `最近更新：${record.updatedAt}` : record.fileMtime ? `文件时间：${record.fileMtime}` : '时间未知'}</p>
                          <span>{record.size ? `大小 ${(record.size / 1024).toFixed(1)} KB` : '大小未知'} ｜ Chunks {record.chunkCount}</span>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          ) : (
            <section className="workspace-advanced-section">
              <div className="workspace-advanced-path-card">
                <div className="workspace-advanced-path-icon">
                  <FolderOpen strokeWidth={1.9} />
                </div>
                <div className="workspace-advanced-path-copy">
                  <span>龙虾工作区</span>
                  <strong>{advancedConfigPanel.workspacePath || '正在检测当前 OpenClaw workspace...'}</strong>
                </div>
                <div className="workspace-advanced-path-actions">
                  <button
                    type="button"
                    className="workspace-secondary-action"
                    onClick={() => void requestAdvancedLeave({ kind: 'refresh-root' })}
                    disabled={advancedConfigPanel.loading || advancedConfigPanel.openingFileName !== null || advancedConfigPanel.saving}
                  >
                    {advancedConfigPanel.loading ? '刷新中...' : '刷新列表'}
                  </button>
                </div>
              </div>

              <div className="workspace-advanced-meta-row">
                <span>{advancedConfigPanel.detail}</span>
                <span>{advancedConfigPanel.lastCheckedAt ? `最近刷新：${formatDisplayTime(advancedConfigPanel.lastCheckedAt)}` : '尚未刷新'}</span>
              </div>

              <div className="workspace-advanced-file-grid" role="list" aria-label="OpenClaw workspace markdown 文件列表">
                {advancedConfigPanel.files.length === 0 ? (
                  <div className="workspace-model-empty">{advancedConfigPanel.loading ? '正在加载 Markdown 文件...' : '当前没有可编辑的 Markdown 文件。'}</div>
                ) : null}

                {advancedConfigPanel.files.map((file) => {
                  const Icon = resolveWorkspaceFileIcon(file.icon);
                  const opening = advancedConfigPanel.openingFileName === file.name;

                  return (
                    <button
                      key={file.relativePath}
                      type="button"
                      className="workspace-advanced-file-card"
                      onClick={() => void requestAdvancedLeave({ kind: 'open-file', file })}
                      disabled={advancedConfigPanel.loading || advancedConfigPanel.saving}
                      role="listitem"
                    >
                      <div className="workspace-advanced-file-icon">
                        <Icon strokeWidth={1.9} />
                      </div>

                      <div className="workspace-advanced-file-copy">
                        <div className="workspace-advanced-file-title-row">
                          <strong>{file.name}</strong>
                          <span className={`workspace-advanced-file-badge ${file.exists ? 'is-ready' : ''}`}>
                            {file.exists ? '√' : '未创建'}
                          </span>
                        </div>
                        <p>{file.description}</p>
                        <span>{file.modifiedAt ? `最近修改：${file.modifiedAt}` : '最近修改时间未知'}</span>
                      </div>

                      <div className="workspace-advanced-file-arrow">
                        {opening ? '打开中...' : '打开'}
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  className="workspace-advanced-directory-card"
                  onClick={() => void requestAdvancedLeave({ kind: 'open-memory' })}
                  role="listitem"
                >
                  <div className="workspace-advanced-directory-icon">
                    <CalendarDays strokeWidth={1.9} />
                  </div>
                  <div className="workspace-advanced-directory-copy">
                    <h3>每日记忆</h3>
                    <p>直接读取 OpenClaw 自带 memory 数据库，按日期浏览已写入的记忆记录。</p>
                  </div>
                  <div className="workspace-advanced-file-arrow">进入</div>
                </button>
              </div>
            </section>
          )}
        </div>
      </section>
    );
  }

  function renderTracePanel() {
    const recentFailureEntries = traceDiagnosticsPanel.recentFailures.slice(0, 4);
    const latestFailureMessage = recentFailureEntries[0]?.message || traceDiagnosticsPanel.recentFailuresDetail;

    return (
      <section className="workspace-stage workspace-advanced-stage workspace-trace-stage">
        <div className="workspace-advanced-panel workspace-trace-panel-shell">
          <section className="workspace-advanced-section workspace-trace-hero" aria-label="日志诊断概览">
            <div className="workspace-trace-hero-backdrop" aria-hidden="true" />

            <div className="workspace-trace-hero-head">
              <button type="button" className="workspace-advanced-back-button workspace-trace-back-button" onClick={() => handleWorkspaceTabChange('home')}>
                <ChevronLeft strokeWidth={2.2} />
                <span>返回工作台</span>
              </button>

              <div className="workspace-trace-hero-badges" aria-label="诊断标签">
                <span className="workspace-trace-hero-badge is-dev">Dev Only</span>
                <span className="workspace-trace-hero-badge">AI 排障页</span>
                <span className="workspace-trace-hero-badge">Session Trace</span>
              </div>
            </div>

            <div className="workspace-trace-hero-main">
              <div className="workspace-trace-hero-copy">
                <p className="workspace-trace-eyebrow">Desktop Diagnostics Console</p>
                <h2>结构化日志诊断中心</h2>
                <p>
                  这个页面专门给安装、启动、绑定三条主链路做排障。
                  这里保留结构化事件、失败摘要、时间线和调试包导出，减少生产环境噪声，同时给 AI 足够的上下文定位问题。
                </p>
              </div>

              <div className="workspace-trace-hero-actions">
                <button
                  type="button"
                  className="workspace-secondary-action"
                  onClick={() => void handleExportTraceBundle()}
                  disabled={traceDiagnosticsPanel.loading || traceDiagnosticsPanel.timelineLoading || traceDiagnosticsPanel.exportingBundle}
                >
                  {traceDiagnosticsPanel.exportingBundle ? '导出中...' : '导出调试包'}
                </button>
                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => void refreshTraceDiagnosticsPanel()}
                  disabled={traceDiagnosticsPanel.loading || traceDiagnosticsPanel.timelineLoading || traceDiagnosticsPanel.exportingBundle}
                >
                  {traceDiagnosticsPanel.loading ? '查询中...' : '刷新日志'}
                </button>
              </div>
            </div>

            <div className="workspace-trace-hero-grid">
              <article className="workspace-trace-status-card">
                <span>当前 Session</span>
                <strong>{desktopTraceSessionIdRef.current}</strong>
                <p>AI 排障时优先带上这个 session，可直接缩小查询范围。</p>
              </article>
              <article className="workspace-trace-status-card">
                <span>写入级别</span>
                <strong>{traceMinLevel}</strong>
                <p>{import.meta.env.DEV ? '开发构建默认 info，适合联调观察。' : '正式构建默认 warning，避免过多调试噪声。'}</p>
              </article>
              <article className="workspace-trace-status-card is-highlight">
                <span>最近失败摘要</span>
                <strong>{recentFailureEntries.length} 条</strong>
                <p>{latestFailureMessage}</p>
              </article>
            </div>
          </section>

          <section className="workspace-advanced-section workspace-trace-controls" aria-label="日志页控制区">
            <section className="workspace-advanced-trace-level-control" aria-label="日志写入级别控制">
              <div className="workspace-advanced-editor-header">
                <div className="workspace-advanced-editor-meta">
                  <h3>日志详细程度</h3>
                  <p>控制本地结构化日志（trace.ndjson）的写入颗粒度。业务链路事件始终写入，不受此影响。</p>
                </div>
                <div className="workspace-advanced-actions">
                  {TRACE_LEVEL_OPTIONS.map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      className={`workspace-secondary-action${traceMinLevel === lvl ? ' is-active' : ''}`}
                      onClick={() => handleSetTraceMinLevel(lvl)}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>
              <div className="workspace-advanced-meta-row">
                <span>当前写入级别：<strong>{traceMinLevel}</strong>{import.meta.env.DEV ? '（开发构建，默认 info）' : '（正式构建，默认 warning）'}</span>
                <span>当前页仅在 Dev 模式可见</span>
              </div>
            </section>

            <section className="workspace-advanced-trace-panel workspace-trace-console" aria-label="Desktop 结构化日志查询面板">
              <div className="workspace-advanced-meta-row">
                <span>{traceDiagnosticsPanel.detail}</span>
                <span>session：{desktopTraceSessionIdRef.current}</span>
              </div>

              <div className="workspace-advanced-trace-filters">
                <label className="workspace-advanced-trace-field">
                  <span>事件前缀</span>
                  <input
                    type="text"
                    value={traceDiagnosticsPanel.eventPrefix}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setTraceDiagnosticsPanel((current) => ({
                        ...current,
                        eventPrefix: nextValue,
                      }));
                    }}
                    placeholder="例如 runtime.install 或 bind.session"
                  />
                </label>

                <label className="workspace-advanced-trace-field">
                  <span>级别</span>
                  <select
                    value={traceDiagnosticsPanel.level}
                    onChange={(event) => {
                      const nextLevel = event.target.value as TraceDiagnosticsPanelState['level'];
                      setTraceDiagnosticsPanel((current) => ({
                        ...current,
                        level: nextLevel,
                      }));
                    }}
                  >
                    <option value="all">全部</option>
                    <option value="info">info</option>
                    <option value="warning">warning</option>
                    <option value="error">error</option>
                  </select>
                </label>

                <button
                  type="button"
                  className="workspace-primary-action"
                  onClick={() => void refreshTraceDiagnosticsPanel({ traceId: null })}
                  disabled={traceDiagnosticsPanel.loading || traceDiagnosticsPanel.timelineLoading}
                >
                  应用筛选
                </button>
              </div>

              <div className="workspace-advanced-memory-summary-grid workspace-advanced-trace-summary-grid">
                <article className="workspace-advanced-memory-summary-card">
                  <span>最近事件</span>
                  <strong>{traceDiagnosticsPanel.entries.length}</strong>
                  <p>仅展示最近 6 小时，最多 80 条当前 session 事件。</p>
                </article>
                <article className="workspace-advanced-memory-summary-card">
                  <span>失败事件</span>
                  <strong>{recentFailureEntries.length}</strong>
                  <p>{recentFailureEntries[0]?.message || traceDiagnosticsPanel.recentFailuresDetail}</p>
                </article>
                <article className="workspace-advanced-memory-summary-card">
                  <span>当前时间线</span>
                  <strong>{traceDiagnosticsPanel.timelineEntries.length}</strong>
                  <p>{traceDiagnosticsPanel.lastBundle?.bundlePath || traceDiagnosticsPanel.selectedTraceId || '尚未选择 traceId'}</p>
                </article>
              </div>

              {traceDiagnosticsPanel.lastBundle ? (
                <div className="workspace-advanced-trace-bundle-card">
                  <div className="workspace-advanced-editor-meta">
                    <h3>最近一次调试包</h3>
                    <p>{traceDiagnosticsPanel.lastBundle.bundlePath}</p>
                  </div>
                  <div className="workspace-advanced-actions">
                    <button
                      type="button"
                      className="workspace-secondary-action"
                      onClick={() => void navigator.clipboard.writeText(traceDiagnosticsPanel.lastBundle?.bundlePath || '')}
                    >
                      复制路径
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="workspace-advanced-trace-columns">
                <div className="workspace-advanced-trace-list" role="list" aria-label="结构化日志列表">
                  {traceDiagnosticsPanel.entries.length === 0 ? (
                    <div className="workspace-model-empty">
                      {traceDiagnosticsPanel.loading ? '正在查询结构化日志...' : '当前没有可展示的结构化 trace 结果。'}
                    </div>
                  ) : (
                    traceDiagnosticsPanel.entries.map((entry) => {
                      const detailText = formatTraceDetail(entry.detail);
                      const hasTrace = Boolean(entry.traceId);
                      const selected = traceDiagnosticsPanel.selectedTraceId !== null && entry.traceId === traceDiagnosticsPanel.selectedTraceId;

                      return (
                        <article
                          key={entry.id}
                          className={`workspace-advanced-trace-entry ${selected ? 'is-active' : ''}`}
                          role="listitem"
                        >
                          <div className="workspace-advanced-trace-entry-head">
                            <div>
                              <strong>{entry.message}</strong>
                              <p>{describeTraceEntry(entry)}</p>
                            </div>
                            <div className="workspace-advanced-trace-entry-actions">
                              <span className={`workspace-advanced-trace-level is-${entry.level}`}>{entry.level}</span>
                              <button
                                type="button"
                                className="workspace-secondary-action workspace-advanced-trace-open"
                                onClick={() => void refreshTraceTimeline(entry.traceId ?? null)}
                                disabled={!hasTrace || traceDiagnosticsPanel.timelineLoading}
                              >
                                {selected && traceDiagnosticsPanel.timelineLoading ? '加载中...' : '时间线'}
                              </button>
                            </div>
                          </div>
                          <div className="workspace-advanced-meta-row">
                            <span>{formatDisplayTime(entry.timestamp)}</span>
                            <span>{entry.module} · {entry.source}</span>
                          </div>
                          {entry.traceId ? <span className="workspace-advanced-trace-id">trace: {entry.traceId}</span> : null}
                          {detailText ? <pre className="workspace-advanced-trace-detail">{detailText}</pre> : null}
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="workspace-advanced-trace-timeline">
                  <div className="workspace-advanced-editor-meta">
                    <h3>Trace 时间线</h3>
                    <p>{traceDiagnosticsPanel.timelineDetail}</p>
                  </div>

                  {traceDiagnosticsPanel.timelineEntries.length === 0 ? (
                    <div className="workspace-model-empty">
                      {traceDiagnosticsPanel.timelineLoading ? '正在加载时间线...' : '请选择左侧带 traceId 的事件查看时间线。'}
                    </div>
                  ) : (
                    <div className="workspace-advanced-trace-timeline-list" role="list" aria-label="Trace 时间线列表">
                      {traceDiagnosticsPanel.timelineEntries.map((entry) => {
                        const detailText = formatTraceDetail(entry.detail);
                        return (
                          <article key={entry.id} className="workspace-advanced-trace-timeline-item" role="listitem">
                            <span className={`workspace-advanced-trace-level is-${entry.level}`}>{entry.level}</span>
                            <div className="workspace-advanced-trace-timeline-copy">
                              <strong>{entry.message}</strong>
                              <p>{formatDisplayTime(entry.timestamp)} · {describeTraceEntry(entry)}</p>
                              {detailText ? <pre className="workspace-advanced-trace-detail">{detailText}</pre> : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </section>
        </div>
      </section>
    );
  }

  function renderAboutPanel() {
    return (
      <section className="workspace-stage workspace-about-stage">
        <div className="workspace-about-panel">
          <div className="workspace-about-hero">
            <div className="workspace-about-copy">
              <div className="workspace-about-title-row">
                <div className="workspace-about-logo-wrap">
                  <img className="workspace-about-logo" src={appIcon} alt="RHClaw Logo" />
                </div>

                <div className="workspace-about-title-copy">
                  <h3 className="workspace-about-title">小爪龙虾（RHClaw）</h3>
                  <span className="workspace-about-logo-badge">open-source build</span>
                </div>
              </div>

              <div className="workspace-about-badges" aria-label="运行摘要">
                {aboutHighlights.map((item) => (
                  <span key={item} className="workspace-about-badge">{item}</span>
                ))}
              </div>

              <p>
                小爪龙虾(RHClaw) 是一套围绕官方 OpenClaw 的一键本地安装配置系统，
                提供本地安装、运行状态查看与桌面侧工作流承接能力。
              </p>
              <p>
                当前公开仓默认面向本地开发与自托管部署，线上服务端、更新源与发行链路需要显式配置。
              </p>

              <div className="workspace-about-meta">
                <p>作者：GallenMa</p>
                <p>微信：Gallen2011</p>
                <p>邮箱：papachong@139.com</p>
                <p>仓库：https://github.com/papachong/RHClaw</p>
              </div>
            </div>
          </div>

          <footer className="workspace-about-footer">
            <p>Copyright © {APP_COPYRIGHT_YEAR} RHClaw contributors.</p>
            <p>Desktop public repository build.</p>
          </footer>
        </div>
      </section>
    );
  }

  function renderWorkspacePanel() {
    switch (activeWorkspaceTab) {
      case 'about':
        return renderAboutPanel();
      case 'skills':
        return renderSkillsPanel();
      case 'models':
        return renderModelsPanel();
      case 'advanced':
        return renderAdvancedPanel();
      case 'trace':
        return TRACE_DIAGNOSTICS_ENABLED ? renderTracePanel() : renderHomePanel();
      case 'home':
      default:
        return renderHomePanel();
    }
  }

  function renderBackgroundInstallWorkspace() {
    return (
      <section className="workspace-stage workspace-background-install-stage">
        <div className="workspace-stage-copy workspace-background-install-copy">
          <span className="workspace-background-install-eyebrow">后台安装</span>
          <h2>安装任务正在后台继续</h2>
          <p>当前先展示任务面板，避免安装页长期占住整个壳层。运行时准备完成后，会自动回到安装页展示二维码或失败信息。</p>
        </div>

        <div className="workspace-background-install-card">
          <InstallProgressBar
            progress={wizardProgressPercent}
            label={wizardProgressLabel}
            active={runtimeBusy !== null && wizardProgressPercent < 100}
          />

          <div className="workspace-background-install-status" aria-live="polite">
            <div>
              <strong>{installTaskStageLabel || '后台任务执行中'}</strong>
              <p>{latestInstallLog || wizardProgressLabel || '正在等待后台任务新进度...'}</p>
            </div>
            {installCancelRequested ? <span className="workspace-background-install-pill">已请求取消</span> : null}
          </div>

          <div className="workspace-background-install-actions">
            <button type="button" className="workspace-secondary-action" onClick={handleReturnToInstallWizard}>
              返回安装页
            </button>
            <button
              type="button"
              className="workspace-primary-action workspace-danger-action"
              onClick={() => void handleCancelInstallTask()}
              disabled={!canCancelInstallTask}
            >
              {installCancelRequested ? '等待取消...' : '取消任务'}
            </button>
          </div>

          {installLogSummary.length > 0 ? (
            <TerminalLogSummary title="后台任务日志" ariaLabel="后台安装日志" lines={installLogSummary} />
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <main className={`app-shell ${shouldShowInstallWizard || shouldShowStartupCheck ? 'app-shell-install' : ''}`}>
      {shouldShowWorkspace ? (
        <>
          <section className="workspace-window-shell">
            <header className="workspace-window-header">
              <h1 className="workspace-window-title">
                <img className="workspace-window-title-logo" src={appIcon} alt="RHClaw Logo" />
                <span>{workspaceTitle}</span>
                <span className="workspace-window-title-version">v{currentAppVersion}</span>
              </h1>

              {shouldShowBackgroundInstallWorkspace ? (
                <div className="workspace-window-actions workspace-window-actions-background">
                  <button type="button" className="workspace-secondary-action" onClick={handleReturnToInstallWizard}>
                    返回安装页
                  </button>
                </div>
              ) : (
                <div className="workspace-window-actions">
                  <nav className="workspace-nav" aria-label="工作台导航">
                    {desktopWorkspaceTabs.map((tab) => {
                      const Icon = resolveWorkspaceTabIcon(tab.id);
                      const active = activeWorkspaceTab === tab.id;

                      return (
                        <button
                          key={tab.id}
                          type="button"
                          className={`workspace-nav-tab ${active ? 'is-active' : ''}`}
                          onClick={() => handleWorkspaceTabChange(tab.id)}
                        >
                          <Icon className="workspace-nav-tab-icon" strokeWidth={1.9} />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </nav>

                  <div className="workspace-settings-wrapper">
                    <button type="button" className="workspace-settings-button" aria-label="设置入口" onClick={() => setSettingsMenuOpen((o) => !o)}>
                      <Settings strokeWidth={2} />
                    </button>
                    {settingsMenuOpen ? (
                      <>
                        <div className="workspace-settings-backdrop" onClick={() => setSettingsMenuOpen(false)} />
                        <div className="workspace-settings-dropdown">
                          {TRACE_DIAGNOSTICS_ENABLED ? (
                            <button type="button" className="workspace-settings-dropdown-item" onClick={handleOpenTraceDiagnosticsPage}>
                              <Activity size={16} strokeWidth={1.8} />
                              日志跟踪
                            </button>
                          ) : null}
                          <button type="button" className="workspace-settings-dropdown-item" onClick={() => void handleOpenLobsterQrCode()}>
                            <QrCode size={16} strokeWidth={1.8} />
                            龙虾二维码
                          </button>
                          <div className="workspace-settings-dropdown-divider" />
                          <button
                            type="button"
                            className="workspace-settings-dropdown-item"
                            onClick={handleBackupOpenClawConfig}
                            disabled={openClawBackupBusy}
                          >
                            {openClawBackupBusy ? <LoaderCircle size={16} strokeWidth={1.8} className="animate-spin" /> : <Save size={16} strokeWidth={1.8} />}
                            {openClawBackupBusy ? '备份中...' : '备份龙虾'}
                          </button>
                          <button type="button" className="workspace-settings-dropdown-item" onClick={handleRestoreOpenClawConfigMenu}>
                            <ArchiveRestore size={16} strokeWidth={1.8} />
                            恢复龙虾
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </header>

            {shouldShowBackgroundInstallWorkspace ? renderBackgroundInstallWorkspace() : renderWorkspacePanel()}
          </section>

          {confirmDialog ? (
            <div className="update-modal-overlay" role="presentation" onClick={() => setConfirmDialog(null)}>
              <div className="update-modal-card confirm-dialog-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <h3 className="confirm-dialog-title">{confirmDialog.title}</h3>
                <p className="confirm-dialog-message">{confirmDialog.message}</p>
                <div className="confirm-dialog-actions">
                  <button type="button" className="workspace-secondary-action" onClick={() => setConfirmDialog(null)}>
                    取消
                  </button>
                  <button type="button" className="workspace-primary-action workspace-danger-action" onClick={confirmDialog.onConfirm}>
                    {confirmDialog.confirmLabel ?? '确认'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {lobsterQrModal.open ? (
            <div className="update-modal-overlay" role="presentation" onClick={() => setLobsterQrModal((prev) => ({ ...prev, open: false }))}>
              <div className="update-modal-card lobster-qr-modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <h3 className="confirm-dialog-title">龙虾二维码</h3>
                {lobsterQrModal.loading ? (
                  <div className="lobster-qr-loading">
                    <LoaderCircle className="lobster-qr-spinner" size={28} />
                    <p>正在生成绑定二维码…</p>
                  </div>
                ) : lobsterQrModal.error ? (
                  <div className="lobster-qr-loading">
                    <p className="lobster-qr-error">{lobsterQrModal.error}</p>
                  </div>
                ) : (
                  <>
                    <div className="lobster-qr-image-wrap">
                      <img src={lobsterQrModal.qrDataUrl} alt="绑定二维码" className="lobster-qr-image" />
                    </div>
                    <p className="lobster-qr-hint">使用微信扫码，在小程序端完成绑定</p>
                    {lobsterQrModal.sessionToken ? (
                      <div className="lobster-qr-copy-panel">
                        <div className="lobster-qr-copy-row">
                          <code className="lobster-qr-token">{lobsterQrModal.sessionToken}</code>
                        </div>
                        <button
                          type="button"
                          className="lobster-qr-copy-btn lobster-qr-copy-btn-block"
                          onClick={() => {
                            void navigator.clipboard.writeText(lobsterQrModal.sessionToken);
                            setLobsterQrModal((prev) => ({ ...prev, copied: true }));
                          }}
                        >
                          {lobsterQrModal.copied ? <Check size={14} /> : <Copy size={14} />}
                          <span>{lobsterQrModal.copied ? '已复制' : '复制绑定码'}</span>
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}

          {advancedLeaveDialog.open ? (
            <div className="update-modal-overlay" role="presentation">
              <div className="update-modal-card workspace-leave-dialog-card" role="dialog" aria-modal="true" aria-labelledby="workspace-leave-dialog-title">
                <span className="workspace-model-section-eyebrow">未保存内容</span>
                <h3 id="workspace-leave-dialog-title" className="workspace-leave-dialog-title">当前 Markdown 文件已编辑但未保存</h3>
                <div className="workspace-leave-dialog-actions">
                  <button type="button" className="workspace-secondary-action" onClick={closeAdvancedLeaveDialog} disabled={advancedLeaveDialog.saving}>
                    取消
                  </button>
                  <button type="button" className="workspace-secondary-action workspace-leave-dialog-discard" onClick={() => void handleConfirmDiscardAndLeave()} disabled={advancedLeaveDialog.saving}>
                    不保存
                  </button>
                  <button type="button" className="workspace-primary-action" onClick={() => void handleConfirmSaveAndLeave()} disabled={advancedLeaveDialog.saving}>
                    {advancedLeaveDialog.saving ? '保存中...' : '保存并离开'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {shouldShowStartupCheck ? <StartupCheckPage startupCheck={startupCheck} /> : null}

      {shouldShowInstallWizard ? (
        <InstallWizardPage
          installWizard={installWizard}
          wizardProgressPercent={wizardProgressPercent}
          wizardProgressLabel={wizardProgressLabel}
          runtimeBusy={runtimeBusy}
          installTaskStageLabel={installTaskStageLabel}
          latestInstallLog={latestInstallLog}
          canContinueInstallInBackground={canContinueInstallInBackground}
          canCancelInstallTask={canCancelInstallTask}
          installCancelRequested={installCancelRequested}
          canReuseCurrentInstall={canReuseCurrentInstall}
          decisionPrimaryLabel={decisionPrimaryLabel}
          installLogSummary={installLogSummary}
          bindQrCodeDataUrl={bindQrCodeDataUrl}
          bindQrCodeError={bindQrCodeError}
          detectedInstallPaths={runtimePackage.detectedInstallPaths ?? []}
          selectedInstallPath={selectedInstallPath}
          onSelectInstallPath={setSelectedInstallPath}
          onLaunchInstallFlow={() => void handleLaunchInstallFlow()}
          onInstallManagedRuntime={() => void handleInstallManagedRuntime()}
          onBindExistingRuntime={() => void handleBindExistingRuntime()}
          onContinueInstallInBackground={handleContinueInstallInBackground}
          onCancelInstallTask={() => void handleCancelInstallTask()}
          onCreateBindSession={() => void handleCreateBindSession()}
        />
      ) : null}

      {shouldShowUpdateModal && updaterStatus ? (
        <UpdateModal
          updaterStatus={updaterStatus}
          onRestartApp={() => void relaunchDesktopApp()}
        />
      ) : null}
    </main>
  );
}
