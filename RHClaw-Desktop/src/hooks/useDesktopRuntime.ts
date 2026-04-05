import { useState, useEffect, useRef } from 'react';
import {
  getAutostartStatus,
  getRHClawPluginStatus,
  getRuntimePackageStatus,
  getTauriAgentStatus,
  installRHClawPlugin,
  probeRHClawPlugin,
  removeRHClawPlugin,
  readManagedRuntimeLogs,
  removeRuntimePackage,
  readTauriAgentLogs,
  restartGateway,
  setAutostartEnabled,
  resolveRHClawChannelStatus,
  startManagedRuntimeProcess,
  startTauriAgentSidecar,
  stopManagedRuntimeProcess,
  stopTauriAgentSidecar,
  type AutostartStatusSnapshot,
  type RHClawPluginStatusSnapshot,
  type RuntimePackageStatusSnapshot,
  type TauriAgentStatusSnapshot,
} from '../services/tauri-agent';
import { appendDesktopTraceLog } from '../services/desktop-trace-api';
import { normalizeEndpoint } from '../services/openclaw-runtime';
import type { DesktopLogEntry, RuntimeSetupPromptMode } from '../types/desktop';
import {
  defaultAutostartStatus,
  defaultRHClawPluginStatus,
  defaultRuntimePackageStatus,
  defaultTauriAgentStatus,
} from '../constants/defaults';

export interface UseDesktopRuntimeDeps {
  startupWorkspaceMode: 'checking' | 'bound' | 'unbound';
  getDeviceIdentity: () => {
    deviceId: string;
    deviceCode: string;
    deviceName: string;
    deviceToken: string;
  };
  getOrCreateDeviceCode: () => string;
  getRuntimeConfig: () => { endpoint?: string; timeoutMs?: number } | undefined;
  serverConfigApiBaseUrl: string;
  setMessage: (msg: string) => void;
  pushDesktopLog: (source: DesktopLogEntry['source'], msg: string, level: DesktopLogEntry['level']) => void;
  updateRuntimeConfig: (endpoint: string) => void;
  setRuntimeSetupPromptMode: (mode: RuntimeSetupPromptMode | null) => void;
  setRuntimeSetupPromptDismissed: (dismissed: boolean) => void;
  desktopTraceSessionId: string;
  onSubscriptionSocketMessage?: (event: Record<string, unknown>) => void;
}

function toRHClawPluginSocketUrl(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  return normalized.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}

function deriveDeviceSocketUrl(apiBaseUrl: string) {
  const origin = apiBaseUrl.trim().replace(/\/api\/v\d+$/i, '').replace(/\/+$/, '');
  return origin ? `${origin}/device` : '';
}

export function useDesktopRuntime(deps: UseDesktopRuntimeDeps) {
  const {
    startupWorkspaceMode,
    getDeviceIdentity,
    getOrCreateDeviceCode,
    getRuntimeConfig,
    serverConfigApiBaseUrl,
    setMessage,
    pushDesktopLog,
    updateRuntimeConfig,
    setRuntimeSetupPromptMode,
    setRuntimeSetupPromptDismissed,
    desktopTraceSessionId,
    onSubscriptionSocketMessage,
  } = deps;

  const [runtimeBusy, setRuntimeBusy] = useState<
    'refresh' | 'install' | 'bind' | 'repair' | 'reuse' | 'remove' | 'start' | 'stop' | null
  >(null);
  const [runtimePackage, setRuntimePackage] = useState<RuntimePackageStatusSnapshot>(defaultRuntimePackageStatus);
  const [runtimeLogLines, setRuntimeLogLines] = useState<string[]>([]);
  const [autostartBusy, setAutostartBusy] = useState<'refresh' | 'enable' | 'disable' | null>(null);
  const [autostartStatus, setAutostartStatus] = useState<AutostartStatusSnapshot>(defaultAutostartStatus);
  const [pluginBusy, setPluginBusy] = useState<'refresh' | 'install' | 'probe' | 'restart' | 'remove' | null>(null);
  const [rhclawPlugin, setRHClawPlugin] = useState<RHClawPluginStatusSnapshot>(defaultRHClawPluginStatus);
  const [agentBusy, setAgentBusy] = useState<'start' | 'stop' | 'refresh' | null>(null);
  const [tauriAgent, setTauriAgent] = useState<TauriAgentStatusSnapshot>(defaultTauriAgentStatus);
  const [workspaceRuntimeLoading, setWorkspaceRuntimeLoading] = useState(false);
  const subscriptionSocketRef = useRef<WebSocket | null>(null);
  const subscriptionSocketReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionSocketBackoffMsRef = useRef(2000);
  const onSubscriptionSocketMessageRef = useRef(onSubscriptionSocketMessage);

  function nextTraceId(prefix: 'runtime' | 'execution') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  async function emitRuntimeTraceEvent(options: {
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
      source: 'runtime',
      module: 'useDesktopRuntime',
      event: options.event,
      message: options.message,
      status: options.status,
      traceId: options.traceId,
      executionId: options.executionId,
      sessionId: desktopTraceSessionId,
      detail: options.detail ?? null,
    });
  }

  // --- auto-refresh when bound ---
  useEffect(() => {
    if (startupWorkspaceMode !== 'bound') {
      setWorkspaceRuntimeLoading(false);
      return;
    }

    let active = true;

    const runRefreshBatch = async (showLoading: boolean) => {
      if (showLoading && active) {
        setWorkspaceRuntimeLoading(true);
      }

      await Promise.allSettled([
        refreshRuntimePackagePanel(),
        refreshRuntimeLogs(),
        refreshAutostartPanel(),
        refreshRHClawPluginPanel(),
      ]);

      if (showLoading && active) {
        setWorkspaceRuntimeLoading(false);
      }
    };

    void runRefreshBatch(true);

    return () => {
      active = false;
      setWorkspaceRuntimeLoading(false);
    };
  }, [startupWorkspaceMode]);

  // --- internal refresh helpers ---

  async function refreshTauriAgentStatus() {
    try {
      const [status, logs] = await Promise.all([getTauriAgentStatus(), readTauriAgentLogs()]);
      setTauriAgent({
        ...status,
        logs: logs.length > 0 ? logs : status.logs,
      });
    } catch (error) {
      pushDesktopLog('desktop', `startup:refresh-failed:${describeError(error)}`, 'danger');
      setTauriAgent({
        ...defaultTauriAgentStatus,
        detail: error instanceof Error ? error.message : '读取 Tauri Agent 状态失败',
      });
    }
  }

  async function refreshRuntimePackagePanel() {
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');
    try {
      await emitRuntimeTraceEvent({
        event: 'runtime.panel.refresh.started',
        message: '开始刷新官方运行时托管状态',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await getRuntimePackageStatus();
      setRuntimePackage(status);

      if (status.installed) {
        setRuntimeSetupPromptMode(null);
        setRuntimeSetupPromptDismissed(false);
      }

      if (status.managed && status.managedEndpoint && !getRuntimeConfig()?.endpoint) {
        updateRuntimeConfig(normalizeEndpoint(status.managedEndpoint));
      }

      await emitRuntimeTraceEvent({
        event: 'runtime.panel.refresh.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
        detail: {
          installed: status.installed,
          managed: status.managed,
          processRunning: status.processRunning,
          managedEndpoint: status.managedEndpoint,
        },
      });

      return status;
    } catch (error) {
      const fallbackStatus = {
        ...defaultRuntimePackageStatus,
        detail: error instanceof Error ? error.message : '读取官方运行时托管状态失败',
      };
      setRuntimePackage(fallbackStatus);
      await emitRuntimeTraceEvent({
        event: 'runtime.panel.refresh.failed',
        message: fallbackStatus.detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
      return fallbackStatus;
    }
  }

  async function refreshRuntimeLogs() {
    try {
      const logs = await readManagedRuntimeLogs();
      setRuntimeLogLines(logs);
    } catch (error) {
      setRuntimeLogLines([`runtime-log-read-failed: ${error instanceof Error ? error.message : 'unknown error'}`]);
    }
  }

  async function refreshAutostartPanel() {
    try {
      const status = await getAutostartStatus();
      setAutostartStatus(status);
    } catch (error) {
      setAutostartStatus({
        ...defaultAutostartStatus,
        detail: error instanceof Error ? error.message : '读取开机自启状态失败',
      });
    }
  }

  async function refreshRHClawPluginPanel() {
    try {
      const status = await getRHClawPluginStatus();
      setRHClawPlugin(status);
    } catch (error) {
      setRHClawPlugin({
        ...defaultRHClawPluginStatus,
        detail: error instanceof Error ? error.message : '读取 RHClaw 插件托管状态失败',
      });
    }
  }

  // --- panel handlers ---

  async function handleToggleAutostart(enabled: boolean) {
    setAutostartBusy(enabled ? 'enable' : 'disable');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');
    try {
      await emitRuntimeTraceEvent({
        event: 'desktop.autostart.toggle.started',
        message: `开始切换开机自启为${enabled ? '开启' : '关闭'}`,
        status: 'started',
        traceId,
        executionId,
        detail: { enabled },
      });
      const status = await setAutostartEnabled(enabled);
      setAutostartStatus(status);
      setMessage(status.detail);
      pushDesktopLog('desktop', `autostart:${enabled ? 'enabled' : 'disabled'}`, 'info');
      await emitRuntimeTraceEvent({
        event: 'desktop.autostart.toggle.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
        detail: { enabled: status.enabled },
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '切换开机自启失败';
      setMessage(nextMessage);
      pushDesktopLog('desktop', `autostart:error:${nextMessage}`, 'danger');
      await emitRuntimeTraceEvent({
        event: 'desktop.autostart.toggle.failed',
        message: nextMessage,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
        detail: { enabled },
      });
    } finally {
      setAutostartBusy(null);
    }
  }

  async function handleRefreshAutostartPanel() {
    setAutostartBusy('refresh');
    try {
      await refreshAutostartPanel();
    } finally {
      setAutostartBusy(null);
    }
  }

  async function handleRefreshRHClawPluginPanel() {
    setPluginBusy('refresh');
    try {
      await refreshRHClawPluginPanel();
      setMessage('已刷新 RHClaw Channel 插件托管状态。');
    } finally {
      setPluginBusy(null);
    }
  }

  async function handleInstallRHClawPlugin() {
    setPluginBusy('install');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.install.started',
        message: '开始安装 RHClaw Channel 插件',
        status: 'started',
        traceId,
        executionId,
      });
      const identity = getDeviceIdentity();
      const status = await ensureRHClawPluginReady({
        deviceId: identity.deviceId || identity.deviceCode || getOrCreateDeviceCode(),
        deviceCode: identity.deviceCode || getOrCreateDeviceCode(),
        deviceName: identity.deviceName,
        deviceToken: identity.deviceToken,
      });
      setRHClawPlugin(status);
      setMessage(status.detail);
      pushDesktopLog('desktop', 'rhclaw-plugin:install', 'info');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.install.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
        detail: {
          installed: status.installed,
          configured: status.configured,
          channelStatus: status.channelStatus,
        },
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '安装 RHClaw Channel 插件失败';
      setMessage(nextMessage);
      pushDesktopLog('desktop', `rhclaw-plugin:install:error:${nextMessage}`, 'danger');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.install.failed',
        message: nextMessage,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setPluginBusy(null);
    }
  }

  async function handleProbeRHClawPlugin() {
    setPluginBusy('probe');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.probe.started',
        message: '开始探测 RHClaw Channel 插件状态',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await probeRHClawPlugin();
      const channelStatus = resolveRHClawChannelStatus(status);
      setRHClawPlugin(status);
      setMessage(status.detail);
      pushDesktopLog('desktop', 'rhclaw-plugin:probe', channelStatus === 'connected' ? 'info' : 'warning');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.probe.completed',
        message: status.detail,
        status: channelStatus === 'connected' ? 'success' : 'running',
        traceId,
        executionId,
        detail: {
          installed: status.installed,
          configured: status.configured,
          channelStatus,
        },
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '探测 RHClaw Channel 插件状态失败';
      setMessage(nextMessage);
      pushDesktopLog('desktop', `rhclaw-plugin:probe:error:${nextMessage}`, 'danger');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.probe.failed',
        message: nextMessage,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setPluginBusy(null);
    }
  }

  async function handleRestartAndProbeRHClawPlugin() {
    setPluginBusy('restart');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.restart-probe.started',
        message: '开始重启 Gateway 并探测 RHClaw Channel 插件',
        status: 'started',
        traceId,
        executionId,
      });
      let latestRuntimeStatus = runtimePackage;
      if (runtimePackage.processRunning) {
        latestRuntimeStatus = await stopManagedRuntimeProcess();
      }

      if (latestRuntimeStatus.installed) {
        latestRuntimeStatus = await startManagedRuntimeProcess();
        setRuntimePackage(latestRuntimeStatus);

        if (latestRuntimeStatus.managedEndpoint) {
          updateRuntimeConfig(normalizeEndpoint(latestRuntimeStatus.managedEndpoint));
        }
      }

      const pluginStatus = await probeRHClawPlugin();
      const channelStatus = resolveRHClawChannelStatus(pluginStatus);
      setRHClawPlugin(pluginStatus);
      setMessage(pluginStatus.detail);
      pushDesktopLog('desktop', 'rhclaw-plugin:restart-and-probe', channelStatus === 'connected' ? 'info' : 'warning');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.restart-probe.completed',
        message: pluginStatus.detail,
        status: channelStatus === 'connected' ? 'success' : 'running',
        traceId,
        executionId,
        detail: {
          runtimeRunning: latestRuntimeStatus.processRunning,
          channelStatus,
        },
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '重启 Gateway 并探活 RHClaw 插件失败';
      setMessage(nextMessage);
      pushDesktopLog('desktop', `rhclaw-plugin:restart:error:${nextMessage}`, 'danger');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.restart-probe.failed',
        message: nextMessage,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setPluginBusy(null);
    }
  }

  async function handleRemoveRHClawPlugin() {
    setPluginBusy('remove');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.remove.started',
        message: '开始移除 RHClaw Channel 插件',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await removeRHClawPlugin();
      setRHClawPlugin(status);
      setMessage(status.detail);
      pushDesktopLog('desktop', 'rhclaw-plugin:remove', 'warning');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.remove.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '移除 RHClaw Channel 插件失败';
      setMessage(nextMessage);
      pushDesktopLog('desktop', `rhclaw-plugin:remove:error:${nextMessage}`, 'danger');
      await emitRuntimeTraceEvent({
        event: 'plugin.rhclaw.remove.failed',
        message: nextMessage,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setPluginBusy(null);
    }
  }

  async function handleStartAgentSidecar() {
    setAgentBusy('start');

    try {
      const status = await startTauriAgentSidecar();
      setTauriAgent(status);
      setMessage(status.detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '启动 Tauri Agent sidecar 失败');
    } finally {
      setAgentBusy(null);
    }
  }

  async function handleStopAgentSidecar() {
    setAgentBusy('stop');

    try {
      const status = await stopTauriAgentSidecar();
      setTauriAgent(status);
      setMessage(status.detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '停止 Tauri Agent sidecar 失败');
    } finally {
      setAgentBusy(null);
    }
  }

  async function handleRefreshAgentPanel() {
    setAgentBusy('refresh');

    try {
      await refreshTauriAgentStatus();
      setMessage('已刷新 Tauri Agent 骨架状态。');
    } finally {
      setAgentBusy(null);
    }
  }

  async function handleRefreshRuntimePanel() {
    setRuntimeBusy('refresh');

    try {
      await refreshRuntimePackagePanel();
      setMessage('已刷新官方运行时托管状态。');
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function handleRemoveManagedRuntime() {
    setRuntimeBusy('remove');
    const previousManagedEndpoint = runtimePackage.managedEndpoint;
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'runtime.package.remove.started',
        message: '开始移除官方运行时',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await removeRuntimePackage();
      setRuntimePackage(status);

      if (
        previousManagedEndpoint &&
        normalizeEndpoint(previousManagedEndpoint) === normalizeEndpoint(getRuntimeConfig()?.endpoint || '')
      ) {
        updateRuntimeConfig('');
      }

      setMessage(status.detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.package.remove.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '移除官方运行时失败';
      setMessage(detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.package.remove.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function handleStartManagedRuntimeProcess() {
    setRuntimeBusy('start');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'runtime.process.start.started',
        message: '开始启动托管运行时',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await startManagedRuntimeProcess();
      setRuntimePackage(status);

      if (status.managedEndpoint) {
        updateRuntimeConfig(normalizeEndpoint(status.managedEndpoint));
      }

      setMessage(status.detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.process.start.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
        detail: {
          processRunning: status.processRunning,
          managedEndpoint: status.managedEndpoint,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '启动托管运行时失败';
      setMessage(detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.process.start.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function handleStopManagedRuntimeProcess() {
    setRuntimeBusy('stop');
    const traceId = nextTraceId('runtime');
    const executionId = nextTraceId('execution');

    try {
      await emitRuntimeTraceEvent({
        event: 'runtime.process.stop.started',
        message: '开始停止托管运行时',
        status: 'started',
        traceId,
        executionId,
      });
      const status = await stopManagedRuntimeProcess();
      setRuntimePackage(status);
      setMessage(status.detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.process.stop.completed',
        message: status.detail,
        status: 'success',
        traceId,
        executionId,
        detail: {
          processRunning: status.processRunning,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '停止托管运行时失败';
      setMessage(detail);
      await emitRuntimeTraceEvent({
        event: 'runtime.process.stop.failed',
        message: detail,
        level: 'error',
        status: 'failure',
        traceId,
        executionId,
      });
    } finally {
      setRuntimeBusy(null);
    }
  }

  // --- plugin ensemble (used by install wizard) ---

  async function ensureRHClawPluginReady(input: {
    deviceId: string;
    deviceCode?: string;
    deviceName?: string;
    deviceToken?: string;
    skipRestart?: boolean;
  }) {
    const desiredServerUrl = serverConfigApiBaseUrl.trim();
    const desiredDeviceSocketUrl = toRHClawPluginSocketUrl(deriveDeviceSocketUrl(serverConfigApiBaseUrl)).trim();

    try {
      const currentStatus = await probeRHClawPlugin();
      const currentChannelStatus = resolveRHClawChannelStatus(currentStatus);
      const matchesDesiredConfig =
        currentStatus.serverUrl?.trim() === desiredServerUrl &&
        currentStatus.deviceSocketUrl?.trim() === desiredDeviceSocketUrl &&
        currentStatus.deviceId?.trim() === input.deviceId.trim();
      setRHClawPlugin(currentStatus);
      if (currentStatus.installed && currentStatus.configured && matchesDesiredConfig && currentChannelStatus === 'connected') {
        return currentStatus;
      }
      // Plugin is installed+configured but channel not yet connected — this is
      // normal when Gateway was just (re)started and the WebSocket hasn't
      // connected yet.  Skip the expensive reinstall+restart cycle.
      if (currentStatus.installed && currentStatus.configured && matchesDesiredConfig) {
        return currentStatus;
      }
    } catch {
      // Probe failure falls through to a clean reinstall path.
    }

    const installStatus = await installRHClawPlugin({
      packageSpec: '@ruhooai/rhclaw-channel',
      serverUrl: serverConfigApiBaseUrl,
      deviceSocketUrl: toRHClawPluginSocketUrl(deriveDeviceSocketUrl(serverConfigApiBaseUrl)),
      deviceId: input.deviceId,
      deviceCode: input.deviceCode,
      deviceName: input.deviceName,
      defaultAgentId: 'desktop-default-agent',
      deviceToken: input.deviceToken,
    });
    setRHClawPlugin(installStatus);

    // Restart Gateway so it reloads the newly written channels.rhclaw config
    if (!input.skipRestart) {
      await restartGateway();
    }

    try {
      const finalStatus = await probeRHClawPlugin();
      const finalChannelStatus = resolveRHClawChannelStatus(finalStatus);
      setRHClawPlugin(finalStatus);
      if (finalChannelStatus !== 'connected') {
        setMessage(`RHClaw Channel 插件已安装，但当前状态为 ${finalChannelStatus}，绑定流程将继续。`);
      }
      return finalStatus;
    } catch {
      setMessage('RHClaw Channel 插件已安装，Gateway 探活暂未通过，绑定流程将继续。');
      return installStatus;
    }
  }

  function resetRuntimePanels() {
    setRuntimeBusy(null);
    setRuntimePackage(defaultRuntimePackageStatus);
    setRuntimeLogLines([]);
    setAutostartBusy(null);
    setAutostartStatus(defaultAutostartStatus);
    setPluginBusy(null);
    setRHClawPlugin(defaultRHClawPluginStatus);
    setAgentBusy(null);
    closeSubscriptionSocket();
    setTauriAgent(defaultTauriAgentStatus);
  }

  useEffect(() => {
    onSubscriptionSocketMessageRef.current = onSubscriptionSocketMessage;
  }, [onSubscriptionSocketMessage]);

  function deriveSubscriptionSocketUrl(apiBaseUrl: string): string {
    const origin = apiBaseUrl.trim().replace(/\/api\/v\d+$/i, '').replace(/\/+$/, '');
    if (!origin) {
      return '';
    }
    const wsOrigin = /localhost|127\.0\.0\.1/i.test(origin)
      ? origin.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
      : origin.replace(/^http:\/\//i, 'wss://').replace(/^https:\/\//i, 'wss://');
    return `${wsOrigin}/ws/session`;
  }

  function closeSubscriptionSocket() {
    if (subscriptionSocketReconnectTimerRef.current !== null) {
      clearTimeout(subscriptionSocketReconnectTimerRef.current);
      subscriptionSocketReconnectTimerRef.current = null;
    }
    if (subscriptionSocketRef.current) {
      subscriptionSocketRef.current.onclose = null;
      subscriptionSocketRef.current.onerror = null;
      subscriptionSocketRef.current.onmessage = null;
      subscriptionSocketRef.current.close();
      subscriptionSocketRef.current = null;
    }
    subscriptionSocketBackoffMsRef.current = 2000;
  }

  function openSubscriptionSocket(wsUrl: string, deviceToken: string) {
    if (subscriptionSocketRef.current) {
      return;
    }

    try {
      const url = `${wsUrl}?token=${encodeURIComponent(deviceToken)}`;
      const socket = new WebSocket(url);
      subscriptionSocketRef.current = socket;

      socket.onopen = () => {
        subscriptionSocketBackoffMsRef.current = 2000;
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as { type?: string; data?: unknown };
          if (data?.type === 'device.subscription.update' && typeof data.data === 'object' && data.data !== null) {
            onSubscriptionSocketMessageRef.current?.(data.data as Record<string, unknown>);
          }
        } catch {
          // Ignore malformed messages from server.
        }
      };

      socket.onclose = () => {
        subscriptionSocketRef.current = null;
        const delay = subscriptionSocketBackoffMsRef.current;
        subscriptionSocketBackoffMsRef.current = Math.min(delay * 2, 30_000);
        subscriptionSocketReconnectTimerRef.current = setTimeout(() => {
          subscriptionSocketReconnectTimerRef.current = null;
          openSubscriptionSocket(wsUrl, deviceToken);
        }, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    } catch {
      const delay = subscriptionSocketBackoffMsRef.current;
      subscriptionSocketBackoffMsRef.current = Math.min(delay * 2, 30_000);
      subscriptionSocketReconnectTimerRef.current = setTimeout(() => {
        subscriptionSocketReconnectTimerRef.current = null;
        openSubscriptionSocket(wsUrl, deviceToken);
      }, delay);
    }
  }

  useEffect(() => {
    if (startupWorkspaceMode !== 'bound') {
      return;
    }

    const identity = getDeviceIdentity();
    const deviceToken = identity.deviceToken;
    if (!deviceToken) {
      return;
    }

    const wsUrl = deriveSubscriptionSocketUrl(serverConfigApiBaseUrl);
    if (!wsUrl) {
      return;
    }

    openSubscriptionSocket(wsUrl, deviceToken);

    return () => {
      closeSubscriptionSocket();
    };
  }, [startupWorkspaceMode, serverConfigApiBaseUrl]);

  return {
    // state
    runtimeBusy,
    runtimePackage,
    runtimeLogLines,
    autostartBusy,
    autostartStatus,
    pluginBusy,
    rhclawPlugin,
    agentBusy,
    tauriAgent,
    workspaceRuntimeLoading,

    // state setters (for install wizard)
    setRuntimeBusy,
    setRuntimePackage,
    setRHClawPlugin,

    // refresh helpers (exposed for install wizard / startup)
    refreshTauriAgentStatus,
    refreshRuntimePackagePanel,
    refreshRuntimeLogs,
    refreshAutostartPanel,
    refreshRHClawPluginPanel,

    // panel handlers
    handleToggleAutostart,
    handleRefreshAutostartPanel,
    handleRefreshRHClawPluginPanel,
    handleInstallRHClawPlugin,
    handleProbeRHClawPlugin,
    handleRestartAndProbeRHClawPlugin,
    handleRemoveRHClawPlugin,
    handleStartAgentSidecar,
    handleStopAgentSidecar,
    handleRefreshAgentPanel,
    handleRefreshRuntimePanel,
    handleRemoveManagedRuntime,
    handleStartManagedRuntimeProcess,
    handleStopManagedRuntimeProcess,

    // plugin ensemble
    ensureRHClawPluginReady,

    // reset
    resetRuntimePanels,
  };
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '未知错误';
}
