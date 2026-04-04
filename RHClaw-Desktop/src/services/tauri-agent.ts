export interface TauriAgentLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface TauriAgentStatusSnapshot {
  available: boolean;
  running: boolean;
  mode: string;
  detail: string;
  sessionId?: string;
  lastHeartbeatAt?: string;
  heartbeatCount: number;
  logFilePath?: string;
  logs: TauriAgentLogEntry[];
}

export interface RuntimePackageStatusSnapshot {
  available: boolean;
  installed: boolean;
  managed: boolean;
  cliAvailable?: boolean;
  offlineBundleVersion?: string;
  offlineBundleManifestVersion?: string;
  offlineBundlePackageVersion?: string;
  offlineBundleUpdateAvailable?: boolean;
  detail: string;
  installMode?: string;
  version?: string;
  packageSource?: string;
  downloadUrl?: string;
  packagePath?: string;
  expectedSha256?: string;
  resolvedSha256?: string;
  verified?: boolean;
  installDir?: string;
  manifestPath?: string;
  executablePath?: string;
  boundInstallPath?: string;
  detectedInstallPath?: string;
  detectedInstallPaths?: string[];
  managedEndpoint?: string;
  installedAt?: string;
  processRunning?: boolean;
  processId?: number;
  processMode?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  restartCount?: number;
  logFilePath?: string;
  statusLogs?: string[];
  workspacePath?: string;
}

export interface AutostartStatusSnapshot {
  available: boolean;
  enabled: boolean;
  launcher: string;
  detail: string;
}

export interface DesktopUpdaterStatusSnapshot {
  available: boolean;
  updateAvailable: boolean;
  installed: boolean;
  currentVersion: string;
  targetVersion?: string;
  assignedChannel: string;
  endpoint: string;
  downloadUrl?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  lastCheckedAt: string;
  detail: string;
}

export interface DesktopUpdaterProgressSnapshot {
  active: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  completed: boolean;
  error: string | null;
}

export interface RHClawPluginStatusSnapshot {
  available: boolean;
  installed: boolean;
  configured: boolean;
  detail: string;
  installMode?: string;
  packageSpec?: string;
  packageSource?: string;
  packageVersion?: string;
  localPackagePath?: string;
  installedPackagePath?: string;
  installReceiptPath?: string;
  packageValidated: boolean;
  pluginDir?: string;
  manifestPath?: string;
  generatedConfigPath?: string;
  pluginEnvPath?: string;
  gatewayRestartRequired: boolean;
  gatewayProbePassed: boolean;
  lastProbeAt?: string;
  lastProbeDetail?: string;
  gatewayTokenEnvName?: string;
  secretRefSource?: string;
  serverUrl?: string;
  deviceSocketUrl?: string;
  deviceId?: string;
  deviceName?: string;
  defaultAgentId?: string;
  channelStatus?: 'unknown' | 'connected' | 'error';
  channelLastHeartbeatAt?: string;
  channelDetail?: string;
}

export interface GatewayLlmConfigWriteResult {
  envPath: string;
  configPath: string;
  model: string;
  baseUrl: string;
  applyMode: 'config-set' | 'gateway-patch';
  restartRequired: boolean;
  detail: string;
}

export interface GatewayRestartResult {
  running: boolean;
  detail: string;
}

export interface OpenClawModelCatalogItem {
  key: string;
  name?: string;
  input?: string;
  contextWindow?: number;
  local?: boolean;
  available?: boolean;
  tags?: string[];
  missing?: boolean;
}

export interface OpenClawModelsListPayload {
  count?: number;
  models?: OpenClawModelCatalogItem[];
}

export interface OpenClawAuthProviderStatus {
  provider: string;
  effective?: {
    kind?: string;
    detail?: string;
  };
  profiles?: {
    count?: number;
    oauth?: number;
    token?: number;
    apiKey?: number;
    labels?: string[];
  };
  env?: {
    value?: string;
    source?: string;
  };
  modelsJson?: {
    value?: string;
    source?: string;
  };
}

export interface OpenClawModelsStatusPayload {
  configPath?: string;
  agentDir?: string;
  defaultModel?: string;
  resolvedDefault?: string;
  fallbacks?: string[];
  imageModel?: string | null;
  imageFallbacks?: string[];
  auth?: {
    storePath?: string;
    providers?: OpenClawAuthProviderStatus[];
    providersWithOAuth?: string[];
    missingProvidersInUse?: string[];
  };
}

export interface OpenClawPasteTokenArgs {
  provider: string;
  token: string;
  profileId?: string;
  expiresIn?: string;
}

export interface OpenClawModelsCapabilityPayload {
  cliAvailable: boolean;
  cliPath?: string;
  listCapability: boolean;
  statusCapability: boolean;
  setCapability: boolean;
  authCapability: boolean;
}

export interface OpenClawCliCommandResult<TParsed = unknown> {
  ok: boolean;
  stdout: string;
  stderr: string;
  parsed?: TParsed;
  errorCode?: string | null;
  detail?: string;
}

export interface OpenClawConfigBackupResult {
  ok: boolean;
  backupFilePath: string;
  backupFileName: string;
  backupSizeBytes: number;
  sourceSizeBytes: number;
  detail: string;
}

export interface OpenClawConfigRestoreResult {
  ok: boolean;
  restoredFrom: string;
  restoredCount: number;
  detail: string;
}

const OPENCLAW_NATIVE_PROVIDER_ALIASES: Record<string, string> = {
  anthropic: 'anthropic',
  gemini: 'google',
  google: 'google',
  minimax: 'minimax',
  openai: 'openai',
  openrouter: 'openrouter',
  xai: 'xai',
  zhipu: 'zai',
  zai: 'zai',
};

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

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

export function resolveOpenClawNativeProviderCode(providerCode?: string | null): string | null {
  if (!providerCode) {
    return null;
  }

  return OPENCLAW_NATIVE_PROVIDER_ALIASES[providerCode] ?? null;
}

export function buildOpenClawModelKey(providerCode: string, model: string): string | null {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    return null;
  }

  if (normalizedModel.includes('/')) {
    return normalizedModel;
  }

  const nativeProviderCode = resolveOpenClawNativeProviderCode(providerCode);
  if (!nativeProviderCode) {
    return null;
  }

  return `${nativeProviderCode}/${normalizedModel}`;
}

function createBrowserFallback(detail: string): TauriAgentStatusSnapshot {
  return {
    available: false,
    running: false,
    mode: 'browser-shell',
    detail,
    heartbeatCount: 0,
    logs: [],
  };
}

function createRuntimeBrowserFallback(detail: string): RuntimePackageStatusSnapshot {
  return {
    available: false,
    installed: false,
    managed: false,
    detail,
  };
}

function createAutostartBrowserFallback(detail: string): AutostartStatusSnapshot {
  return {
    available: false,
    enabled: false,
    launcher: 'browser-shell',
    detail,
  };
}

function createDesktopUpdaterBrowserFallback(detail: string): DesktopUpdaterStatusSnapshot {
  return {
    available: false,
    updateAvailable: false,
    installed: false,
    currentVersion: 'browser-shell',
    assignedChannel: 'stable',
    endpoint: '',
    lastCheckedAt: new Date().toISOString(),
    detail,
  };
}

function createRHClawPluginBrowserFallback(detail: string): RHClawPluginStatusSnapshot {
  return {
    available: false,
    installed: false,
    configured: false,
    detail,
    packageSpec: '@rhopenclaw/rhclaw-channel',
    packageValidated: false,
    gatewayRestartRequired: false,
    gatewayProbePassed: false,
    channelStatus: 'unknown',
  };
}

export function resolveRHClawChannelStatus(
  snapshot: Pick<RHClawPluginStatusSnapshot, 'channelStatus' | 'gatewayProbePassed' | 'installed'>,
): 'unknown' | 'connected' | 'error' {
  if (
    snapshot.channelStatus === 'unknown' ||
    snapshot.channelStatus === 'connected' ||
    snapshot.channelStatus === 'error'
  ) {
    return snapshot.channelStatus;
  }

  return snapshot.gatewayProbePassed ? 'connected' : snapshot.installed ? 'error' : 'unknown';
}

export async function getTauriAgentStatus(): Promise<TauriAgentStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createBrowserFallback('当前为浏览器联调壳层，Tauri Commands 尚未接入运行时。');
  }

  return invoke<TauriAgentStatusSnapshot>('agent_status');
}

export async function readTauriAgentLogs(): Promise<TauriAgentLogEntry[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }

  return invoke<TauriAgentLogEntry[]>('read_agent_logs');
}

export async function startTauriAgentSidecar(): Promise<TauriAgentStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createBrowserFallback('当前为浏览器联调壳层，无法启动 Tauri sidecar。');
  }

  return invoke<TauriAgentStatusSnapshot>('start_agent_sidecar');
}

export async function stopTauriAgentSidecar(): Promise<TauriAgentStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createBrowserFallback('当前为浏览器联调壳层，无法停止 Tauri sidecar。');
  }

  return invoke<TauriAgentStatusSnapshot>('stop_agent_sidecar');
}

export async function getRuntimePackageStatus(): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法查询官方运行时托管状态。');
  }

  const result = await invoke<RuntimePackageStatusSnapshot>('runtime_package_status');
  console.info('[runtimePackage] snapshot', {
    version: result.version,
    installed: result.installed,
    cliAvailable: result.cliAvailable,
    processRunning: result.processRunning,
    workspacePath: result.workspacePath,
    statusLogs: result.statusLogs,
  });
  return result;
}

export async function installRuntimePackage(version?: string, serverApiBaseUrl?: string): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法安装官方运行时。');
  }

  return invoke<RuntimePackageStatusSnapshot>('install_runtime_package', { version, serverApiBaseUrl });
}

export async function probeOpenClawModelsCapability(): Promise<OpenClawCliCommandResult<OpenClawModelsCapabilityPayload>> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前为浏览器联调壳层，无法探测 OpenClaw models CLI 能力。',
      errorCode: 'TAURI_UNAVAILABLE',
      detail: '当前为浏览器联调壳层，无法探测 OpenClaw models CLI 能力。',
    };
  }

  return invoke<OpenClawCliCommandResult<OpenClawModelsCapabilityPayload>>('models_capability_probe');
}

export async function getOpenClawModelsList(provider?: string): Promise<OpenClawCliCommandResult<OpenClawModelsListPayload>> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前为浏览器联调壳层，无法读取 OpenClaw 模型目录。',
      errorCode: 'TAURI_UNAVAILABLE',
      detail: '当前为浏览器联调壳层，无法读取 OpenClaw 模型目录。',
    };
  }

  return invoke<OpenClawCliCommandResult<OpenClawModelsListPayload>>('models_list_all', { provider });
}

export async function getOpenClawModelsStatus(): Promise<OpenClawCliCommandResult<OpenClawModelsStatusPayload>> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前为浏览器联调壳层，无法读取 OpenClaw 模型状态。',
      errorCode: 'TAURI_UNAVAILABLE',
      detail: '当前为浏览器联调壳层，无法读取 OpenClaw 模型状态。',
    };
  }

  return invoke<OpenClawCliCommandResult<OpenClawModelsStatusPayload>>('models_status');
}

export async function setOpenClawDefaultModel(modelKey: string): Promise<OpenClawCliCommandResult<Record<string, never>>> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前为浏览器联调壳层，无法设置 OpenClaw 默认模型。',
      errorCode: 'TAURI_UNAVAILABLE',
      detail: '当前为浏览器联调壳层，无法设置 OpenClaw 默认模型。',
    };
  }

  return invoke<OpenClawCliCommandResult<Record<string, never>>>('models_set', { modelKey });
}

export async function pasteOpenClawAuthToken(args: OpenClawPasteTokenArgs): Promise<OpenClawCliCommandResult<Record<string, never>>> {
  const invoke = getInvoke();
  if (!invoke) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前为浏览器联调壳层，无法写入 OpenClaw auth token。',
      errorCode: 'TAURI_UNAVAILABLE',
      detail: '当前为浏览器联调壳层，无法写入 OpenClaw auth token。',
    };
  }

  return invoke<OpenClawCliCommandResult<Record<string, never>>>('models_auth_paste_token', { args });
}

export async function installManagedRuntimePackage(options: {
  version?: string;
  downloadUrl?: string;
  expectedSha256?: string;
  serverApiBaseUrl?: string;
}): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法安装官方运行时。');
  }

  return invoke<RuntimePackageStatusSnapshot>('install_runtime_package', options);
}

export async function writeGatewayLlmConfig(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  openaiCompatPrefix?: string;
}): Promise<GatewayLlmConfigWriteResult> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法写入 Gateway 模型配置。');
  }

  return invoke<GatewayLlmConfigWriteResult>('write_gateway_llm_config', { args: input });
}

export async function restartGateway(): Promise<GatewayRestartResult> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法重启 Gateway。');
  }

  return invoke<GatewayRestartResult>('restart_gateway');
}

export async function bindExistingRuntimePackage(path?: string): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法绑定已安装的 OpenClaw。');
  }

  return invoke<RuntimePackageStatusSnapshot>('bind_existing_runtime_package', path ? { path } : undefined);
}

export async function doctorRuntimePackage(): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法执行 OpenClaw 官方诊断。');
  }

  return invoke<RuntimePackageStatusSnapshot>('doctor_runtime_package');
}

export async function removeRuntimePackage(): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法移除官方运行时。');
  }

  return invoke<RuntimePackageStatusSnapshot>('remove_runtime_package');
}

export async function startManagedRuntimeProcess(): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法启动托管运行时进程。');
  }

  return invoke<RuntimePackageStatusSnapshot>('start_runtime_process');
}

export async function stopManagedRuntimeProcess(): Promise<RuntimePackageStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRuntimeBrowserFallback('当前为浏览器联调壳层，无法停止托管运行时进程。');
  }

  return invoke<RuntimePackageStatusSnapshot>('stop_runtime_process');
}

export async function readManagedRuntimeLogs(maxLines = 120): Promise<string[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }

  return invoke<string[]>('read_runtime_logs', { maxLines });
}

export async function getAutostartStatus(): Promise<AutostartStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createAutostartBrowserFallback('当前为浏览器联调壳层，无法读取开机自启状态。');
  }

  return invoke<AutostartStatusSnapshot>('autostart_status');
}

export async function setAutostartEnabled(enabled: boolean): Promise<AutostartStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createAutostartBrowserFallback('当前为浏览器联调壳层，无法切换开机自启状态。');
  }

  return invoke<AutostartStatusSnapshot>('set_autostart_enabled', { enabled });
}

export async function checkAndInstallDesktopUpdate(): Promise<DesktopUpdaterStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createDesktopUpdaterBrowserFallback('当前为浏览器联调壳层，无法执行桌面端自升级。');
  }

  return invoke<DesktopUpdaterStatusSnapshot>('check_and_install_desktop_update');
}

export async function getDesktopUpdateProgress(): Promise<DesktopUpdaterProgressSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return { active: false, downloadedBytes: 0, totalBytes: null, completed: false, error: null };
  }
  return invoke<DesktopUpdaterProgressSnapshot>('get_desktop_update_progress');
}

export async function relaunchDesktopApp(): Promise<void> {
  // Try Tauri 2 process.relaunch API first
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return;
  } catch {
    // plugin-process not available, fall back to IPC command
  }

  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法重启桌面应用。');
  }

  await invoke('relaunch_desktop_app');
}

export async function getRHClawPluginStatus(): Promise<RHClawPluginStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRHClawPluginBrowserFallback('当前为浏览器联调壳层，无法读取 RHClaw Channel 插件托管状态。');
  }

  return invoke<RHClawPluginStatusSnapshot>('rhclaw_plugin_status');
}

export async function installRHClawPlugin(options: {
  packageSpec?: string;
  localPackagePath?: string;
  serverUrl: string;
  deviceSocketUrl: string;
  deviceId: string;
  deviceCode?: string;
  deviceName?: string;
  defaultAgentId?: string;
  deviceToken?: string;
}): Promise<RHClawPluginStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRHClawPluginBrowserFallback('当前为浏览器联调壳层，无法安装 RHClaw Channel 插件。');
  }

  return invoke<RHClawPluginStatusSnapshot>('install_rhclaw_plugin', options);
}

export async function probeRHClawPlugin(): Promise<RHClawPluginStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRHClawPluginBrowserFallback('当前为浏览器联调壳层，无法探测 RHClaw Channel 插件状态。');
  }

  return invoke<RHClawPluginStatusSnapshot>('probe_rhclaw_plugin');
}

export async function removeRHClawPlugin(): Promise<RHClawPluginStatusSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    return createRHClawPluginBrowserFallback('当前为浏览器联调壳层，无法移除 RHClaw Channel 插件。');
  }

  return invoke<RHClawPluginStatusSnapshot>('remove_rhclaw_plugin');
}

// ---------------------------------------------------------------------------
// Task Center
// ---------------------------------------------------------------------------

export type TaskType = 'install_runtime' | 'bind_existing_runtime' | 'repair_runtime';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskEntry {
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  progressPercent: number;
  progressNote: string;
  startedAtMs: number;
  completedAtMs?: number;
  error?: string;
  logs: string[];
}

export interface TaskProgressEvent {
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  progressPercent: number;
  note: string;
  log: string;
  error?: string;
  timestampMs: number;
}

function createTaskBrowserFallback(): TaskEntry {
  return {
    taskId: 'browser-noop',
    taskType: 'install_runtime',
    status: 'failed',
    progressPercent: 0,
    progressNote: '当前为浏览器联调壳层，无法启动后台任务。',
    startedAtMs: Date.now(),
    error: '当前为浏览器联调壳层',
    logs: [],
  };
}

export async function startTask(
  taskType: TaskType,
  params: Record<string, unknown> = {},
): Promise<TaskEntry> {
  const invoke = getInvoke();
  if (!invoke) {
    return createTaskBrowserFallback();
  }

  return invoke<TaskEntry>('task_start', { taskType, params });
}

export async function getTaskStatus(taskId?: string): Promise<TaskEntry[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }

  return invoke<TaskEntry[]>('task_status', { taskId: taskId ?? null });
}

export async function cancelTask(taskId: string): Promise<TaskEntry> {
  const invoke = getInvoke();
  if (!invoke) {
    return createTaskBrowserFallback();
  }

  return invoke<TaskEntry>('task_cancel', { taskId });
}

export async function backupOpenClawConfig(): Promise<OpenClawConfigBackupResult> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法备份 OpenClaw 配置。');
  }

  return invoke<OpenClawConfigBackupResult>('backup_openclaw_config');
}

export async function pickOpenClawBackupFile(): Promise<string | null> {
  const invoke = getInvoke();
  if (!invoke) {
    return null;
  }

  return invoke<string | null>('pick_openclaw_backup_file');
}

export async function restoreOpenClawConfig(backupFilePath?: string): Promise<OpenClawConfigRestoreResult> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法恢复 OpenClaw 配置。');
  }

  return invoke<OpenClawConfigRestoreResult>(
    'restore_openclaw_config',
    backupFilePath ? { backupFilePath } : undefined,
  );
}

// ---------------------------------------------------------------------------
// OpenClaw Workspace Info
// ---------------------------------------------------------------------------

export interface OpenClawWorkspaceInfoResult {
  version: string;
  gatewayPort?: number | null;
  gatewayBind?: string | null;
  agentCount: number;
  skillCount: number;
  pluginCount: number;
  configPath?: string | null;
  dataDir?: string | null;
  workspacePath?: string | null;
  debugLogs?: string[];
  raw?: Record<string, unknown> | null;
}

export async function getOpenClawWorkspaceInfo(): Promise<OpenClawWorkspaceInfoResult | null> {
  const invoke = getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    const result = await invoke<OpenClawWorkspaceInfoResult>('get_openclaw_workspace_info');
    console.info('[openclawWorkspaceInfo] snapshot', result);
    return result;
  } catch (error) {
    console.error('[openclawWorkspaceInfo] failed', error);
    return null;
  }
}
