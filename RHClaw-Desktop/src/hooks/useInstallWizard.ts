import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelTask, type RuntimePackageStatusSnapshot } from '../services/tauri-agent';
import {
  deriveInstallCheckSnapshot,
  deriveInstallCheckStateCode,
  executeActionViaTaskCenter,
  getInstallCheckActionLabel,
  type InstallCheckActionId,
  type InstallCheckExecutionFailure,
} from '../services/install-check';
import { appendDesktopTraceLog } from '../services/desktop-trace-api';
import type { OpenClawRuntimeHealth } from '../services/openclaw-runtime';
import { normalizeEndpoint } from '../services/openclaw-runtime';
import type { InstallWizardViewModel, RuntimeSetupPromptMode } from '../types/desktop';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

type RuntimeHealthSnapshot = OpenClawRuntimeHealth | { status: 'healthy' | 'error' | 'unknown'; detail?: string };
type RuntimeBusyValue = 'refresh' | 'install' | 'bind' | 'repair' | 'reuse' | 'remove' | 'start' | 'stop' | null;
type DeviceStatusValue = 'idle' | 'binding' | 'connected' | 'offline';
type InstallTaskPhase = 'runtime-task' | 'skills-sync' | 'bind-prepare' | null;

export interface UseInstallWizardDeps {
  /** 当前工作区启动模式 */
  startupWorkspaceMode: 'checking' | 'bound' | 'unbound';

  /** 来自 useDesktopRuntime 的状态/操作 */
  runtimeBusy: RuntimeBusyValue;
  runtimePackage: RuntimePackageStatusSnapshot;
  setRuntimeBusy: (busy: RuntimeBusyValue) => void;
  setRuntimePackage: (pkg: RuntimePackageStatusSnapshot) => void;
  refreshRuntimePackagePanel: () => Promise<RuntimePackageStatusSnapshot>;

  /** 用于 useMemo / effect 内读取最新 state */
  getDeviceShellSnapshot: () => {
    runtimeHealth?: RuntimeHealthSnapshot;
    runtimeConfig?: { endpoint?: string; timeoutMs?: number };
    bindPath: string;
    bindSessionToken: string;
    status: DeviceStatusValue;
    deviceToken?: string;
  };

  /** 来自 App.tsx 的回调 */
  setMessage: (msg: string) => void;
  serverConfigApiBaseUrl: string;
  updateRuntimeConfig: (endpoint: string) => void;
  updateRuntimeHealth: (health: RuntimeHealthSnapshot) => void;
  installRecommendedSkillsAfterRuntimeReady: (handlers: {
    onLog: (line: string) => void;
    onProgressNote: (note: string) => void;
  }) => Promise<unknown>;
  prepareBindSessionAfterInstall: (action: InstallCheckActionId, actionDetail: string) => Promise<void>;

  /** 已绑定情况下最近一条日志（供 useMemo 使用） */
  message: string;
  bindQrCodeError: string;

  /** runtimeSetupPrompt 相关 */
  runtimeSetupPromptMode: RuntimeSetupPromptMode | null;
  setRuntimeSetupPromptMode: (mode: RuntimeSetupPromptMode | null) => void;
  runtimeSetupPromptDismissed: boolean;
  setRuntimeSetupPromptDismissed: (dismissed: boolean) => void;
  desktopTraceSessionId: string;

  lastLoggedMessage: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInstallWizard(deps: UseInstallWizardDeps) {
  const {
    startupWorkspaceMode,
    runtimeBusy,
    runtimePackage,
    setRuntimeBusy,
    setRuntimePackage,
    refreshRuntimePackagePanel,
    getDeviceShellSnapshot,
    setMessage,
    serverConfigApiBaseUrl,
    updateRuntimeConfig,
    updateRuntimeHealth,
    installRecommendedSkillsAfterRuntimeReady,
    prepareBindSessionAfterInstall,
    message,
    bindQrCodeError,
    runtimeSetupPromptMode,
    setRuntimeSetupPromptMode,
    runtimeSetupPromptDismissed,
    setRuntimeSetupPromptDismissed,
    desktopTraceSessionId,
    lastLoggedMessage,
  } = deps;

  // ---- state ----
  const [runtimeInstallVersion, setRuntimeInstallVersion] = useState('');
  const [runtimeInstallUrl, setRuntimeInstallUrl] = useState('');
  const [runtimeInstallSha256, setRuntimeInstallSha256] = useState('');
  const [installExecutionFailure, setInstallExecutionFailure] = useState<InstallCheckExecutionFailure | null>(null);
  const [installProgressNote, setInstallProgressNote] = useState('');
  const [installProgressPercent, setInstallProgressPercent] = useState<number | null>(null);
  const [installLogSummary, setInstallLogSummary] = useState<string[]>([]);
  const [wizardStarted, setWizardStarted] = useState(false);
  const [selectedInstallPath, setSelectedInstallPath] = useState<string | null>(null);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [installTaskAction, setInstallTaskAction] = useState<InstallCheckActionId | null>(null);
  const [installTaskPhase, setInstallTaskPhase] = useState<InstallTaskPhase>(null);
  const [installShellMode, setInstallShellMode] = useState<'wizard' | 'background'>('wizard');
  const [installCancelRequested, setInstallCancelRequested] = useState(false);

  // ---- refs ----
  const installProgressTimelineRef = useRef<number[]>([]);
  const installProgressSequenceRef = useRef<string | null>(null);
  const installTraceIdRef = useRef<string | null>(null);
  const installExecutionIdRef = useRef<string | null>(null);

  // ---- helpers ----

  function nextTraceId(prefix: 'install' | 'execution') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  function ensureInstallTraceId() {
    if (!installTraceIdRef.current) {
      installTraceIdRef.current = nextTraceId('install');
    }
    return installTraceIdRef.current;
  }

  function beginInstallExecution() {
    installExecutionIdRef.current = nextTraceId('execution');
    return installExecutionIdRef.current;
  }

  function clearInstallExecution() {
    installExecutionIdRef.current = null;
  }

  function getInstallActionEventPrefix(action: InstallCheckActionId) {
    switch (action) {
      case 'reinstall_latest':
        return 'runtime.install.full';
      case 'repair':
        return 'runtime.install.repair';
      case 'reuse':
        return 'runtime.install.reuse';
      default:
        return 'runtime.install.action';
    }
  }

  async function emitInstallTraceEvent(options: {
    event: string;
    message: string;
    level?: 'info' | 'warning' | 'error';
    status?: 'started' | 'running' | 'success' | 'failure';
    detail?: Record<string, unknown>;
    durationMs?: number;
  }) {
    await appendDesktopTraceLog({
      level: options.level ?? 'info',
      source: 'desktop',
      module: 'useInstallWizard',
      event: options.event,
      message: options.message,
      status: options.status,
      traceId: ensureInstallTraceId(),
      executionId: installExecutionIdRef.current ?? undefined,
      sessionId: desktopTraceSessionId,
      durationMs: options.durationMs,
      detail: options.detail ?? null,
    });
  }

  function appendInstallLog(messageText: string) {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${messageText}`;
    setInstallLogSummary((current) => [...current, line].slice(-8));
  }

  function appendInstallStatusLogs(lines?: string[]) {
    if (!lines || lines.length === 0) {
      return;
    }

    setInstallLogSummary((current) => {
      const next = [...current];
      lines.forEach((line) => {
        const normalized = line.trim();
        if (!normalized) {
          return;
        }
        next.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${normalized}`);
      });
      return next.slice(-8);
    });
  }

  function clearInstallProgressTimeline() {
    installProgressTimelineRef.current.forEach((timer) => window.clearTimeout(timer));
    installProgressTimelineRef.current = [];
    installProgressSequenceRef.current = null;
  }

  function scheduleInstallProgressTimeline(
    sequence: 'checking' | 'reuse' | 'repair' | 'reinstall',
    phases: Array<{ delayMs: number; progress: number; note: string; log: string }>,
  ) {
    clearInstallProgressTimeline();
    installProgressSequenceRef.current = sequence;
    installProgressTimelineRef.current = phases.map((phase) =>
      window.setTimeout(() => {
        if (installProgressSequenceRef.current !== sequence) {
          return;
        }

        setInstallProgressPercent((current) => Math.max(current ?? 0, phase.progress));
        setInstallProgressNote(phase.note);
        appendInstallLog(phase.log);
      }, phase.delayMs),
    );
  }

  function describeUnknownError(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return '未知错误';
  }

  function describeInstallTaskStage(action: InstallCheckActionId | null, phase: InstallTaskPhase) {
    if (!action) {
      return '';
    }

    if (phase === 'runtime-task') {
      return `${getInstallCheckActionLabel(action)}: 正在执行后台任务`;
    }

    if (phase === 'skills-sync') {
      return `${getInstallCheckActionLabel(action)}: 正在同步推荐 skills`;
    }

    if (phase === 'bind-prepare') {
      return `${getInstallCheckActionLabel(action)}: 正在准备绑定二维码`;
    }

    return getInstallCheckActionLabel(action);
  }

  function handleContinueInstallInBackground() {
    if (!installTaskAction && runtimeBusy === null) {
      return;
    }

    setInstallShellMode('background');
    setMessage('安装任务已转入后台，可先查看任务状态，完成后再返回安装页。');
  }

  function handleReturnToInstallWizard() {
    setInstallShellMode('wizard');
  }

  async function handleCancelInstallTask() {
    if (!installTaskId || installTaskPhase !== 'runtime-task') {
      return;
    }

    setInstallCancelRequested(true);
    setInstallProgressNote('已请求取消，等待后台任务进入下一安全检查点...');
    appendInstallLog('已请求取消后台安装任务，等待任务中心确认。');
    setMessage('已请求取消安装任务，取消将在下一安全检查点生效。');

    try {
      await cancelTask(installTaskId);
    } catch (error) {
      const detail = describeUnknownError(error);
      setInstallCancelRequested(false);
      appendInstallLog(`取消任务失败：${detail}`);
      setMessage(`取消安装任务失败：${detail}`);
    }
  }

  // ---- handlers ----

  async function handleLaunchInstallFlow() {
    console.info('[reinstall:handleLaunchInstallFlow] START');
    installTraceIdRef.current = nextTraceId('install');
    clearInstallExecution();
    setInstallShellMode('wizard');
    setInstallTaskId(null);
    setInstallTaskAction(null);
    setInstallTaskPhase(null);
    setInstallCancelRequested(false);
    await emitInstallTraceEvent({
      event: 'runtime.install.check.started',
      message: '开始执行安装环境检查',
      status: 'started',
    });
    scheduleInstallProgressTimeline('checking', [
      {
        delayMs: 900,
        progress: 10,
        note: '正在查找本机 OpenClaw CLI 与安装路径...',
        log: '正在查找本机 OpenClaw CLI 与安装路径。',
      },
      {
        delayMs: 1900,
        progress: 20,
        note: '正在读取本地运行时 manifest 与安装痕迹...',
        log: '正在读取本地运行时 manifest 与安装痕迹。',
      },
      {
        delayMs: 2900,
        progress: 30,
        note: '正在检查 Gateway 当前运行状态...',
        log: '正在检查 Gateway 当前运行状态。',
      },
    ]);
    setWizardStarted(true);
    setRuntimeSetupPromptDismissed(false);
    setRuntimeBusy('refresh');
    setInstallExecutionFailure(null);
    setMessage('正在检查安装环境，请稍候。');
    setInstallProgressNote('正在扫描本机 OpenClaw CLI、安装痕迹与 Gateway 状态...');
    setInstallProgressPercent(10);
    setInstallLogSummary([]);
    appendInstallLog('用户已点击开始安装。');
    appendInstallLog('开始执行安装环境检查。');

    let autoAction: InstallCheckActionId | null = null;

    try {
      const status = await refreshRuntimePackagePanel();
      appendInstallStatusLogs(status.statusLogs);

      const stateCode = deriveInstallCheckStateCode(status, getDeviceShellSnapshot().runtimeHealth);
      console.info('[reinstall:handleLaunchInstallFlow] check result', {
        stateCode,
        cliAvailable: status.cliAvailable,
        installed: status.installed,
        available: status.available,
        detectedPath: status.detectedInstallPath,
      });

      if (stateCode === 'missing_cli' || stateCode === 'broken_install') {
        autoAction = 'reinstall_latest';
        setMessage('安装环境检查完成，正在执行 OpenClaw 官方安装。');
        setInstallProgressNote('环境检查完成，正在执行官方安装与启动准备...');
        setInstallProgressPercent(60);
        appendInstallLog('环境检查完成，命中自动安装路径。');
        await emitInstallTraceEvent({
          event: 'runtime.install.check.completed',
          message: '安装环境检查完成，命中自动安装路径',
          status: 'success',
          detail: {
            stateCode,
            cliAvailable: status.cliAvailable,
            installed: status.installed,
            detectedInstallPath: status.detectedInstallPath,
            nextAction: autoAction,
          },
        });
      } else {
        const snapshot = deriveInstallCheckSnapshot({
          runtimePackage: status,
          runtimeHealth: getDeviceShellSnapshot().runtimeHealth,
        });
        setMessage('安装环境检查完成。');
        setInstallProgressNote(snapshot.detail);
        setInstallProgressPercent(snapshot.progressPercent ?? 30);
        appendInstallLog(`环境检查完成：${snapshot.detail}`);
        await emitInstallTraceEvent({
          event: 'runtime.install.check.completed',
          message: '安装环境检查完成',
          status: 'success',
          detail: {
            stateCode,
            cliAvailable: status.cliAvailable,
            installed: status.installed,
            detectedInstallPath: status.detectedInstallPath,
            recommendedActions: snapshot.recommendedActions,
            preferredAction: snapshot.preferredAction,
          },
        });
      }
    } catch (error) {
      const detail = describeUnknownError(error);
      await emitInstallTraceEvent({
        event: 'runtime.install.check.failed',
        message: `安装环境检查失败：${detail}`,
        level: 'error',
        status: 'failure',
        detail: { error: detail },
      });
      throw error;
    } finally {
      clearInstallProgressTimeline();
      if (!autoAction) {
        setRuntimeBusy(null);
      }
    }

    if (autoAction) {
      await handleExecuteInstallAction(autoAction);
    }
  }

  async function handleExecuteInstallAction(action: InstallCheckActionId) {
    console.info('[reinstall:handleExecuteInstallAction] START', { action });
    ensureInstallTraceId();
    const executionId = beginInstallExecution();
    const actionEventPrefix = getInstallActionEventPrefix(action);
    const actionStartedAt = Date.now();
    await emitInstallTraceEvent({
      event: `${actionEventPrefix}.started`,
      message: `开始执行${getInstallCheckActionLabel(action)}`,
      status: 'started',
      detail: { action, executionId },
    });
    const actionKey = action === 'reinstall_latest' ? 'reinstall' : action;
    if (action === 'reinstall_latest') {
      scheduleInstallProgressTimeline(actionKey, [
        {
          delayMs: 1200,
          progress: 70,
          note: '正在下载或校验 OpenClaw CLI 安装脚本...',
          log: '正在下载或校验 OpenClaw CLI 安装脚本。',
        },
      ]);
    } else {
      clearInstallProgressTimeline();
    }
    setRuntimeBusy(action === 'reinstall_latest' ? 'install' : action);
    setInstallShellMode('wizard');
    setInstallTaskAction(action);
    setInstallTaskPhase('runtime-task');
    setInstallTaskId(null);
    setInstallCancelRequested(false);
    setInstallExecutionFailure(null);
    setInstallProgressPercent(60);
    setInstallProgressNote(
      action === 'reinstall_latest'
        ? '正在安装官方 OpenClaw，并准备启动 Gateway...'
        : action === 'repair'
          ? '正在修复当前 OpenClaw 安装，并重新诊断运行状态...'
          : '正在复用当前 OpenClaw 安装，并执行启动检查...'
    );
    appendInstallLog(`开始执行：${getInstallCheckActionLabel(action)}`);

    try {
      const snapshot = getDeviceShellSnapshot();
      const result = await executeActionViaTaskCenter({
        action,
        runtimePackage,
        runtimeEndpoint: snapshot.runtimeConfig?.endpoint,
        runtimeTimeoutMs: snapshot.runtimeConfig?.timeoutMs,
        version: runtimeInstallVersion,
        downloadUrl: runtimeInstallUrl,
        expectedSha256: runtimeInstallSha256,
        serverApiBaseUrl: serverConfigApiBaseUrl,
        selectedInstallPath: selectedInstallPath ?? undefined,
        onTaskStarted: (taskId) => {
          setInstallTaskId(taskId);
          appendInstallLog(`后台任务已创建，任务 ID：${taskId}`);
        },
        onProgress: (progress) => {
          setInstallProgressPercent(progress.progressPercent);
          setInstallProgressNote(progress.note);
          appendInstallLog(progress.log);
          void emitInstallTraceEvent({
            event: `${actionEventPrefix}.progress`,
            message: progress.note,
            status: 'running',
            detail: {
              progressPercent: progress.progressPercent,
              note: progress.note,
              log: progress.log,
            },
          });
        },
      });

      console.info('[reinstall:handleExecuteInstallAction] task result', {
        ok: result.ok,
        action: result.action,
        detail: result.detail,
        runtimeAvailable: result.runtimePackage.available,
        runtimeInstalled: result.runtimePackage.installed,
        cliAvailable: result.runtimePackage.cliAvailable,
        managedEndpoint: result.runtimePackage.managedEndpoint,
      });

      setRuntimePackage(result.runtimePackage);
      appendInstallStatusLogs(result.runtimePackage.statusLogs);
      setRuntimeSetupPromptMode(null);
      setRuntimeSetupPromptDismissed(false);

      if (result.runtimeHealth) {
        updateRuntimeHealth(result.runtimeHealth);
      }

      if (result.runtimePackage.managedEndpoint) {
        updateRuntimeConfig(normalizeEndpoint(result.runtimePackage.managedEndpoint));
      }

      if (!result.ok) {
        console.warn('[reinstall:handleExecuteInstallAction] task FAILED', {
          detail: result.detail,
          recoveryHint: result.recoveryHint,
        });
        setInstallExecutionFailure(result.failure ?? null);
        setMessage(result.recoveryHint || result.detail);
        setInstallShellMode('wizard');
        setInstallProgressNote(result.detail);
        setInstallProgressPercent(100);
        appendInstallLog(`执行失败：${result.detail}`);
        await emitInstallTraceEvent({
          event: `${actionEventPrefix}.failed`,
          message: result.detail,
          level: 'error',
          status: 'failure',
          durationMs: Date.now() - actionStartedAt,
          detail: {
            action,
            recoveryHint: result.recoveryHint,
            runtimeAvailable: result.runtimePackage.available,
            runtimeInstalled: result.runtimePackage.installed,
          },
        });
        return;
      }

      await emitInstallTraceEvent({
        event: `${actionEventPrefix}.completed`,
        message: result.detail,
        status: 'success',
        durationMs: Date.now() - actionStartedAt,
        detail: {
          action,
          runtimeAvailable: result.runtimePackage.available,
          runtimeInstalled: result.runtimePackage.installed,
          cliAvailable: result.runtimePackage.cliAvailable,
          managedEndpoint: result.runtimePackage.managedEndpoint,
        },
      });

      setInstallTaskId(null);
      setInstallTaskPhase('skills-sync');
      setInstallCancelRequested(false);

      try {
        clearInstallProgressTimeline();
        setInstallProgressPercent(72);
        setInstallProgressNote('OpenClaw 已准备完成，正在同步服务端推荐 skills...');
        appendInstallLog('OpenClaw 已就绪，开始同步服务端推荐 skills。');
        await emitInstallTraceEvent({
          event: 'runtime.install.skills-sync.started',
          message: '开始同步服务端推荐 skills',
          status: 'started',
          detail: { action },
        });
        try {
          await installRecommendedSkillsAfterRuntimeReady({
            onLog: appendInstallLog,
            onProgressNote: setInstallProgressNote,
          });
          await emitInstallTraceEvent({
            event: 'runtime.install.skills-sync.completed',
            message: '推荐 skills 同步完成',
            status: 'success',
            detail: { action },
          });
        } catch (skillsError) {
          const skillsErrorDetail = describeUnknownError(skillsError);
          appendInstallLog(`推荐 skills 同步失败：${skillsErrorDetail}`);
          await emitInstallTraceEvent({
            event: 'runtime.install.skills-sync.failed',
            message: `推荐 skills 同步失败：${skillsErrorDetail}`,
            level: 'warning',
            status: 'failure',
            detail: { action, error: skillsErrorDetail },
          });
        }
        setInstallTaskPhase('bind-prepare');
        setInstallProgressPercent(80);
        setInstallProgressNote('推荐 skills 处理完成，正在安装 RHClaw Channel、注册设备并生成二维码...');
        appendInstallLog('推荐 skills 处理完成，开始执行安装后绑定准备。');
        console.info('[reinstall:handleExecuteInstallAction] calling prepareBindSessionAfterInstall...');
        await emitInstallTraceEvent({
          event: 'runtime.install.bind-prepare.started',
          message: '开始执行安装后绑定准备',
          status: 'started',
          detail: { action },
        });
        await prepareBindSessionAfterInstall(action, result.detail);
        appendInstallLog('绑定准备完成，二维码已生成。');
        setInstallShellMode('wizard');
        await emitInstallTraceEvent({
          event: 'runtime.install.bind-prepare.completed',
          message: '绑定准备完成，二维码已生成',
          status: 'success',
          detail: { action },
        });
        console.info('[reinstall:handleExecuteInstallAction] prepareBindSession DONE');
      } catch (error) {
        const detail = describeUnknownError(error);
        setInstallExecutionFailure({
          action,
          detail,
          recoveryHint: '重新启动安装程序，选择全新安装',
        });
        clearInstallProgressTimeline();
        setInstallShellMode('wizard');
        setInstallProgressNote(detail);
        setInstallProgressPercent(100);
        appendInstallLog(`绑定准备失败：${detail}`);
        setMessage('绑定准备失败，请重新启动安装程序并选择全新安装。');
        await emitInstallTraceEvent({
          event: 'runtime.install.bind-prepare.failed',
          message: `绑定准备失败：${detail}`,
          level: 'error',
          status: 'failure',
          detail: { action, error: detail },
        });
        return;
      }
    } finally {
      clearInstallProgressTimeline();
      console.info('[reinstall:handleExecuteInstallAction] FINALLY, setting runtimeBusy=null');
      setRuntimeBusy(null);
      setInstallTaskId(null);
      setInstallTaskAction(null);
      setInstallTaskPhase(null);
      setInstallCancelRequested(false);
      clearInstallExecution();
    }
  }

  async function handleInstallManagedRuntime() {
    await handleExecuteInstallAction('reinstall_latest');
  }

  async function handleBindExistingRuntime() {
    await handleExecuteInstallAction(installWizard.preferredAction === 'repair' ? 'repair' : 'reuse');
  }

  // ---- effect: runtime setup prompt auto-trigger ----

  useEffect(() => {
    if (startupWorkspaceMode === 'checking' || (!wizardStarted && startupWorkspaceMode !== 'bound')) {
      return;
    }

    if (runtimeBusy !== null || runtimeSetupPromptDismissed) {
      return;
    }

    const snapshot = getDeviceShellSnapshot();
    const derived = deriveInstallCheckSnapshot({
      runtimePackage,
      runtimeHealth: snapshot.runtimeHealth,
      runtimeBusy,
      bindPath: snapshot.bindPath,
      bindSessionToken: snapshot.bindSessionToken,
      deviceStatus: snapshot.status,
      lastMessage: lastLoggedMessage,
      executionFailure: installExecutionFailure ?? undefined,
    });

    if (derived.scene === 'decision') {
      setRuntimeSetupPromptMode('detected-existing');
      return;
    }

    if (derived.stateCode === 'missing_cli' || derived.stateCode === 'broken_install') {
      setRuntimeSetupPromptMode('fresh-install');
    }
  }, [installExecutionFailure, runtimeBusy, runtimePackage, runtimeSetupPromptDismissed]);

  // ---- computed ----

  const installWizard = useMemo<InstallWizardViewModel>(() => {
    const snapshot = getDeviceShellSnapshot();
    // 用户未点击"开始安装"前，始终停留在 launch 页
    if (!wizardStarted && !runtimeBusy) {
      return {
        step: 1,
        scene: 'launch' as const,
        title: '一键搞定你的小龙虾',
        detail: '官方OpenClaw+内置技能+龙虾群+免费大模型+微信',
        recommendedActions: ['reinstall_latest' as const],
        preferredAction: 'reinstall_latest' as const,
      };
    }

    const derived = deriveInstallCheckSnapshot({
      runtimePackage,
      runtimeHealth: snapshot.runtimeHealth,
      runtimeBusy,
      bindPath: snapshot.bindPath,
      bindSessionToken: snapshot.bindSessionToken,
      deviceStatus: snapshot.status,
      qrCodeError: bindQrCodeError,
      lastMessage: message,
      executionFailure: installExecutionFailure ?? undefined,
    });

    console.info('[reinstall:installWizard:useMemo]', {
      wizardStarted,
      runtimeBusy,
      'runtimePackage.available': runtimePackage.available,
      'snapshot.status': snapshot.status,
      'snapshot.bindPath': snapshot.bindPath ? snapshot.bindPath.slice(0, 30) : '<empty>',
      'snapshot.bindSessionToken': snapshot.bindSessionToken ? 'present' : '<empty>',
      'derived.scene': derived.scene,
      'derived.stateCode': derived.stateCode,
    });

    // 用户已点击"开始安装"后，不应退回首页；
    // 若 derive 仍返回 launch（如 runtimePackage.available 仍为 false），
    // 保持 checking 状态，等待后续自动安装补齐。
    if (wizardStarted && derived.scene === 'launch') {
      console.warn('[reinstall:installWizard:useMemo] derived launch but wizardStarted=true, forcing checking');
      return {
        ...derived,
        step: 2 as const,
        scene: 'checking' as const,
        title: '安装环境检查，可能需要几分钟...',
        detail: derived.detail || '正在扫描本机安装状态，随后会自动进入步骤三。',
      };
    }

    return derived;
  }, [wizardStarted, bindQrCodeError, installExecutionFailure, message, runtimeBusy, runtimePackage, getDeviceShellSnapshot]);

  const decisionPrimaryLabel = getInstallCheckActionLabel(installWizard.preferredAction === 'repair' ? 'repair' : 'reuse');

  const canReuseCurrentInstall = Boolean(
    runtimePackage.cliAvailable !== false && (runtimePackage.detectedInstallPath || runtimePackage.boundInstallPath || runtimePackage.installed),
  );

  const wizardProgressPercent = installProgressPercent ?? installWizard.progressPercent ?? 0;

  const wizardProgressLabel =
    installWizard.scene === 'checking'
      ? installProgressNote || '安装环境检查，可能需要几分钟...'
      : installWizard.scene === 'installing'
        ? installProgressNote || '安装中，可能需要几分钟...'
        : installWizard.scene === 'decision'
          ? '安装环境检查完毕'
          : installWizard.scene === 'binding'
            ? '环境已就绪，等待绑定'
            : installWizard.scene === 'failed'
              ? '安装失败'
              : '';

  const installTaskStageLabel = describeInstallTaskStage(installTaskAction, installTaskPhase);
  const canContinueInstallInBackground = Boolean((installTaskAction || runtimeBusy) && installShellMode !== 'background');
  const canCancelInstallTask = Boolean(installTaskId && installTaskPhase === 'runtime-task');
  const latestInstallLog = installLogSummary[installLogSummary.length - 1] || installProgressNote;

  // ---- reset helper (called by App.tsx when entering bound workspace) ----

  function resetInstallWizard() {
    setInstallExecutionFailure(null);
    setInstallProgressPercent(null);
    setInstallProgressNote('');
    setInstallLogSummary([]);
    setRuntimeSetupPromptMode(null);
    setWizardStarted(false);
    setSelectedInstallPath(null);
    setInstallTaskId(null);
    setInstallTaskAction(null);
    setInstallTaskPhase(null);
    setInstallShellMode('wizard');
    setInstallCancelRequested(false);
    installTraceIdRef.current = null;
    clearInstallExecution();
  }

  return {
    // state
    runtimeInstallVersion,
    setRuntimeInstallVersion,
    runtimeInstallUrl,
    setRuntimeInstallUrl,
    runtimeInstallSha256,
    setRuntimeInstallSha256,
    installExecutionFailure,
    setInstallExecutionFailure,
    installProgressNote,
    installProgressPercent,
    setInstallProgressPercent,
    setInstallProgressNote,
    installLogSummary,
    wizardStarted,
    selectedInstallPath,
    installTaskId,
    installTaskAction,
    installTaskPhase,
    installShellMode,
    installCancelRequested,
    setSelectedInstallPath,

    // computed
    installWizard,
    decisionPrimaryLabel,
    canReuseCurrentInstall,
    wizardProgressPercent,
    wizardProgressLabel,
    installTaskStageLabel,
    canContinueInstallInBackground,
    canCancelInstallTask,
    latestInstallLog,

    // handlers
    handleLaunchInstallFlow,
    handleExecuteInstallAction,
    handleInstallManagedRuntime,
    handleBindExistingRuntime,
    handleContinueInstallInBackground,
    handleReturnToInstallWizard,
    handleCancelInstallTask,

    // utilities
    appendInstallLog,
    appendInstallStatusLogs,
    clearInstallProgressTimeline,
    scheduleInstallProgressTimeline,
    resetInstallWizard,
  };
}
