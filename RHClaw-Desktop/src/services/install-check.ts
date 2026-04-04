import { checkOpenClawRuntime, normalizeEndpoint, type OpenClawRuntimeHealth } from './openclaw-runtime';
import { deriveRuntimeStatusDiagnostic } from './runtime-status-diagnostics';
import {
  getRuntimePackageStatus,
  getTaskStatus,
  startTask,
  type RuntimePackageStatusSnapshot,
  type TaskType,
} from './tauri-agent';

export type InstallCheckStateCode =
  | 'missing_cli'
  | 'broken_install'
  | 'installed_not_running'
  | 'installed_needs_repair'
  | 'installed_reusable';

export type InstallCheckActionId = 'reinstall_latest' | 'repair' | 'reuse';

export type InstallWizardScene = 'launch' | 'checking' | 'installing' | 'decision' | 'binding' | 'failed';

export interface InstallCheckSnapshot {
  stateCode?: InstallCheckStateCode;
  step: 1 | 2 | 3 | 4;
  scene: InstallWizardScene;
  title: string;
  detail: string;
  progressPercent?: number;
  recommendedActions: InstallCheckActionId[];
  preferredAction?: InstallCheckActionId;
}

export interface InstallCheckExecutionFailure {
  action: InstallCheckActionId;
  detail: string;
  recoveryHint: string;
}

export interface ExecuteInstallCheckActionInput {
  action: InstallCheckActionId;
  runtimePackage: RuntimePackageStatusSnapshot;
  runtimeEndpoint?: string;
  runtimeTimeoutMs?: number;
  version?: string;
  downloadUrl?: string;
  expectedSha256?: string;
  serverApiBaseUrl?: string;
  selectedInstallPath?: string;
  onTaskStarted?: (taskId: string) => void;
  onProgress?: (progress: InstallCheckProgressUpdate) => void;
}

export interface InstallCheckProgressUpdate {
  progressPercent: number;
  note: string;
  log: string;
}

export interface ExecuteInstallCheckActionResult {
  ok: boolean;
  action: InstallCheckActionId;
  detail: string;
  recoveryHint?: string;
  runtimePackage: RuntimePackageStatusSnapshot;
  runtimeHealth?: OpenClawRuntimeHealth | { status: 'healthy' | 'error' | 'unknown'; detail?: string };
  nextSnapshot: InstallCheckSnapshot;
  failure?: InstallCheckExecutionFailure;
}

interface DeriveInstallCheckSnapshotInput {
  runtimePackage: RuntimePackageStatusSnapshot;
  runtimeHealth?: OpenClawRuntimeHealth | { status: 'healthy' | 'error' | 'unknown'; detail?: string };
  runtimeBusy?: 'refresh' | 'install' | 'bind' | 'repair' | 'reuse' | 'remove' | 'start' | 'stop' | null;
  bindPath?: string;
  bindSessionToken?: string;
  deviceStatus?: 'idle' | 'binding' | 'connected' | 'offline';
  qrCodeError?: string;
  lastMessage?: string;
  executionFailure?: InstallCheckExecutionFailure;
}

const installCheckRecoveryHint = '重新启动安装程序，选择全新安装';
const runtimeSkeletonFailureDetail = 'Desktop 当前仍在使用 OpenClaw 安装骨架，尚未接入官方 CLI 安装/复用链路。';

export function deriveInstallCheckSnapshot(input: DeriveInstallCheckSnapshotInput): InstallCheckSnapshot {
  const {
    runtimePackage,
    runtimeHealth,
    runtimeBusy,
    bindPath,
    bindSessionToken,
    deviceStatus,
    qrCodeError,
    lastMessage,
    executionFailure,
  } = input;

  if (executionFailure) {
    return {
      step: 4,
      scene: 'failed',
      title: '安装失败',
      detail: `${executionFailure.detail} ${executionFailure.recoveryHint}`.trim(),
      progressPercent: 100,
      recommendedActions: ['reinstall_latest'],
      preferredAction: 'reinstall_latest',
    };
  }

  if (!runtimePackage.available && !runtimeBusy) {
    return {
      step: 1,
      scene: 'launch',
      title: '一键搞定你的小龙虾',
      detail: '官方OpenClaw+内置技能+龙虾群+免费大模型+微信',
      recommendedActions: ['reinstall_latest'],
      preferredAction: 'reinstall_latest',
    };
  }

  if (deviceStatus === 'binding' && bindPath) {
    return {
      step: 4,
      scene: 'binding',
      title: '安装完成，请使用微信扫码继续。',
      detail: ' ',
      progressPercent: 100,
      recommendedActions: [],
    };
  }

  if (bindSessionToken && deviceStatus === 'offline' && (qrCodeError || includesBindFailureHint(lastMessage))) {
    return {
      step: 4,
      scene: 'binding',
      title: '绑定会话需重试',
      detail: qrCodeError || '当前二维码已失效或绑定流程被中断，请重新发起全新安装或生成新的绑定会话。',
      progressPercent: 100,
      recommendedActions: [],
    };
  }

  if (runtimeBusy === 'install' || runtimeBusy === 'bind' || runtimeBusy === 'repair' || runtimeBusy === 'reuse') {
    return {
      step: 3,
      scene: 'installing',
      title: '安装中，可能需要几分钟...',
      detail: '正在执行安装或复用动作，完成后会继续启动 Gateway、安装 RHClaw-Channel，并进入二维码绑定页。',
      progressPercent: 60,
      recommendedActions: ['reinstall_latest'],
      preferredAction: 'reinstall_latest',
    };
  }

  if (runtimeBusy === 'refresh' || !runtimePackage.available) {
    return {
      step: 2,
      scene: 'checking',
      title: '安装环境检查，可能需要几分钟...',
      detail: '正在扫描本机安装状态、运行态与可复用情况，随后会自动进入步骤三。',
      progressPercent: 30,
      recommendedActions: [],
    };
  }

  const stateCode = deriveInstallCheckStateCode(runtimePackage, runtimeHealth);
  const runtimeStatusDiagnostic = deriveRuntimeStatusDiagnostic(runtimePackage, runtimeHealth);

  if (stateCode === 'missing_cli') {
    return {
      stateCode,
      step: 3,
      scene: 'installing',
      title: '安装中，可能需要几分钟...',
      detail: '当前未检测到可复用的 OpenClaw 安装，下一步将执行官方命令完成全新安装。',
      progressPercent: 60,
      recommendedActions: ['reinstall_latest'],
      preferredAction: 'reinstall_latest',
    };
  }

  if (stateCode === 'broken_install') {
    return {
      stateCode,
      step: 3,
      scene: 'installing',
      title: '安装中，可能需要几分钟...',
      detail: runtimePackage.detail || '已检测到残缺安装或初始化不完整，建议直接执行全新安装。',
      progressPercent: 60,
      recommendedActions: ['reinstall_latest'],
      preferredAction: 'reinstall_latest',
    };
  }

  if (stateCode === 'installed_not_running') {
    return {
      stateCode,
      step: 3,
      scene: 'decision',
      title: '安装环境检查完毕',
      detail: runtimeStatusDiagnostic.note
        ? `检测到当前 OpenClaw 已在运行。${runtimeStatusDiagnostic.note} 请选择：`
        : '检测到你当前电脑你已经安装了小龙虾(OpenClaw)，请选择：',
      progressPercent: 100,
      recommendedActions: ['reuse', 'reinstall_latest'],
      preferredAction: 'reuse',
    };
  }

  if (stateCode === 'installed_needs_repair') {
    return {
      stateCode,
      step: 3,
      scene: 'decision',
      title: '安装环境检查完毕',
      detail: runtimeHealth?.detail || runtimePackage.detail || '检测到当前 OpenClaw 安装存在异常，建议先修复。',
      progressPercent: 100,
      recommendedActions: ['repair', 'reinstall_latest'],
      preferredAction: 'repair',
    };
  }

  return {
    stateCode,
    step: 3,
    scene: 'decision',
    title: '安装环境检查完毕',
    detail: runtimeStatusDiagnostic.note
      ? `检测到当前 OpenClaw 已在运行。${runtimeStatusDiagnostic.note} 请选择：`
      : '检测到你当前电脑你已经安装了小龙虾(OpenClaw)，请选择：',
    progressPercent: 100,
    recommendedActions: ['reuse', 'reinstall_latest'],
    preferredAction: 'reuse',
  };
}

export function deriveInstallCheckStateCode(
  runtimePackage: RuntimePackageStatusSnapshot,
  runtimeHealth?: OpenClawRuntimeHealth | { status: 'healthy' | 'error' | 'unknown'; detail?: string },
): InstallCheckStateCode {
  const runtimeStatusDiagnostic = deriveRuntimeStatusDiagnostic(runtimePackage, runtimeHealth);

  if (runtimePackage.cliAvailable === false) {
    return 'missing_cli';
  }

  if (!runtimePackage.detectedInstallPath && !runtimePackage.installed) {
    return 'missing_cli';
  }

  if (runtimePackage.detectedInstallPath && !runtimePackage.installed) {
    return 'broken_install';
  }

  if (runtimeStatusDiagnostic.preferRunningSignal) {
    return 'installed_reusable';
  }

  if (runtimeHealth?.status === 'error') {
    if (runtimePackage.processRunning) {
      return 'installed_needs_repair';
    }

    return 'installed_not_running';
  }

  if (!runtimePackage.processRunning && !runtimePackage.managed && runtimeHealth?.status !== 'healthy') {
    return 'installed_not_running';
  }

  if (runtimePackage.installed && runtimePackage.cliAvailable && (runtimePackage.managed || runtimePackage.processRunning || runtimeHealth?.status === 'healthy')) {
    return 'installed_reusable';
  }

  return 'installed_needs_repair';
}

function includesBindFailureHint(message?: string) {
  if (!message) {
    return false;
  }

  return (
    message.includes('过期') ||
    message.includes('取消') ||
    message.includes('放弃') ||
    message.includes('替换') ||
    message.includes('失败')
  );
}


export function getInstallCheckActionLabel(action: InstallCheckActionId) {
  switch (action) {
    case 'repair':
      return '修复当前安装';
    case 'reuse':
      return '复用当前安装';
    case 'reinstall_latest':
      return '重新安装';
    default:
      return '安装动作';
  }
}

function buildSuccessDetail(
  action: InstallCheckActionId,
  runtimePackage: RuntimePackageStatusSnapshot,
  runtimeHealth?: OpenClawRuntimeHealth | { status: 'healthy' | 'error' | 'unknown'; detail?: string },
) {
  const runtimeStatusDiagnostic = deriveRuntimeStatusDiagnostic(runtimePackage, runtimeHealth);
  const baseDetail = runtimePackage.detail || runtimeHealth?.detail || 'OpenClaw 运行环境已就绪。';
  const resolvedDetail = runtimeStatusDiagnostic.note
    ? `${baseDetail} ${runtimeStatusDiagnostic.note}`
    : baseDetail;

  switch (action) {
    case 'repair':
      return `${resolvedDetail} 当前安装已完成修复诊断，正在进入绑定准备。`;
    case 'reuse':
      return `${resolvedDetail} 当前安装已完成复用诊断，正在进入绑定准备。`;
    case 'reinstall_latest':
      return `${resolvedDetail} 已完成全新安装与运行时准备，正在进入绑定准备。`;
    default:
      return resolvedDetail;
  }
}

async function probeRuntimeHealth(
  runtimePackage: RuntimePackageStatusSnapshot,
  input: ExecuteInstallCheckActionInput,
) {
  const endpoint = normalizeEndpoint(runtimePackage.managedEndpoint || input.runtimeEndpoint || '');
  if (!endpoint) {
    return undefined;
  }

  try {
    return await checkOpenClawRuntime({
      endpoint,
      timeoutMs: input.runtimeTimeoutMs,
    });
  } catch {
    // fetch 失败（连接拒绝、超时等）不应导致整个安装动作失败，
    // 返回 unknown 让后续流程继续推进。
    return {
      status: 'unknown' as const,
      detail: 'Gateway 健康探测未响应，将跳过探活继续后续流程。',
      checkedAt: new Date().toISOString(),
    };
  }
}

function shouldProbeRuntimeHealth(
  runtimePackage: RuntimePackageStatusSnapshot,
  input: ExecuteInstallCheckActionInput,
) {
  const endpoint = normalizeEndpoint(runtimePackage.managedEndpoint || input.runtimeEndpoint || '');
  if (!endpoint) {
    return false;
  }

  // 当前 Desktop 的安装/复用流仍以托管骨架为主，骨架进程本身不暴露 HTTP health。
  // 在这些场景下先进入绑定闭环，后续再由真实运行时探测补齐。
  if (runtimePackage.processMode === 'managed-runtime-process') {
    return false;
  }

  // Gateway 未运行时跳过健康探测，避免 fetch 连接拒绝导致安装/复用/修复失败。
  if (!runtimePackage.processRunning) {
    return false;
  }

  return true;
}

function isRuntimeInstallSkeleton(runtimePackage: RuntimePackageStatusSnapshot) {
  const packageSource = (runtimePackage.packageSource || '').trim();
  const version = (runtimePackage.version || '').trim();

  return (
    packageSource === 'official-runtime-stub' ||
    packageSource === 'existing-openclaw-binding' ||
    version === '0.1.0-official-stub'
  );
}

// ---------------------------------------------------------------------------
// Task Center bridge — delegates install/reuse/repair to Rust backend
// ---------------------------------------------------------------------------

const ACTION_TO_TASK_TYPE: Record<InstallCheckActionId, TaskType> = {
  reinstall_latest: 'install_runtime',
  reuse: 'bind_existing_runtime',
  repair: 'repair_runtime',
};

const TASK_POLL_INTERVAL_MS = 800;

export async function executeActionViaTaskCenter(
  input: ExecuteInstallCheckActionInput,
): Promise<ExecuteInstallCheckActionResult> {
  const taskType = ACTION_TO_TASK_TYPE[input.action];
  const params: Record<string, unknown> = {};

  if (input.action === 'reinstall_latest') {
    params.version = input.version?.trim() || 'latest';
    if (input.downloadUrl?.trim()) params.downloadUrl = input.downloadUrl.trim();
    if (input.expectedSha256?.trim()) params.expectedSha256 = input.expectedSha256.trim();
    if (input.serverApiBaseUrl?.trim()) params.serverApiBaseUrl = input.serverApiBaseUrl.trim();
  } else if (input.action === 'reuse') {
    const bindPath = input.selectedInstallPath || input.runtimePackage.detectedInstallPath || input.runtimePackage.boundInstallPath;
    if (bindPath) params.path = bindPath;
  }

  try {
    const entry = await startTask(taskType, params);

    if (entry.status === 'failed') {
      throw new Error(entry.error || `后台任务启动失败`);
    }

    input.onTaskStarted?.(entry.taskId);

    // Poll until terminal state
    let currentEntry = entry;
    while (currentEntry.status === 'queued' || currentEntry.status === 'running') {
      input.onProgress?.({
        progressPercent: Math.max(60, Math.min(95, currentEntry.progressPercent)),
        note: currentEntry.progressNote || '后台任务执行中...',
        log: currentEntry.logs[currentEntry.logs.length - 1] || '后台任务执行中',
      });

      await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));

      const entries = await getTaskStatus(currentEntry.taskId);
      const updated = entries.find((e) => e.taskId === currentEntry.taskId);
      if (updated) {
        // Forward new log lines
        const prevLogCount = currentEntry.logs.length;
        for (let i = prevLogCount; i < updated.logs.length; i++) {
          input.onProgress?.({
            progressPercent: Math.max(60, Math.min(95, updated.progressPercent)),
            note: updated.progressNote || '后台任务执行中...',
            log: updated.logs[i],
          });
        }
        currentEntry = updated;
      }
    }

    if (currentEntry.status === 'cancelled') {
      throw new Error('任务已被取消');
    }

    if (currentEntry.status === 'failed') {
      throw new Error(currentEntry.error || `${getInstallCheckActionLabel(input.action)}失败`);
    }

    // Task completed — fetch latest runtime package status from backend
    const nextRuntimePackage = await getRuntimePackageStatus();

    const runtimeHealth = shouldProbeRuntimeHealth(nextRuntimePackage, input)
      ? await probeRuntimeHealth(nextRuntimePackage, input)
      : undefined;
    const runtimeStatusDiagnostic = deriveRuntimeStatusDiagnostic(nextRuntimePackage, runtimeHealth);
    if (runtimeHealth?.status === 'error' && !runtimeStatusDiagnostic.preferRunningSignal) {
      throw new Error(runtimeHealth.detail || `${getInstallCheckActionLabel(input.action)}后运行时仍不可用。`);
    }

    const detail = buildSuccessDetail(input.action, nextRuntimePackage, runtimeHealth);
    return {
      ok: true,
      action: input.action,
      detail,
      runtimePackage: nextRuntimePackage,
      runtimeHealth,
      nextSnapshot: deriveInstallCheckSnapshot({
        runtimePackage: nextRuntimePackage,
        runtimeHealth,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : `${getInstallCheckActionLabel(input.action)}失败`;
    const failure: InstallCheckExecutionFailure = {
      action: input.action,
      detail,
      recoveryHint: installCheckRecoveryHint,
    };

    return {
      ok: false,
      action: input.action,
      detail,
      recoveryHint: installCheckRecoveryHint,
      runtimePackage: input.runtimePackage,
      runtimeHealth: {
        status: 'error',
        detail,
        checkedAt: new Date().toISOString(),
      },
      failure,
      nextSnapshot: deriveInstallCheckSnapshot({
        runtimePackage: input.runtimePackage,
        runtimeHealth: {
          status: 'error',
          detail,
          checkedAt: new Date().toISOString(),
        },
        executionFailure: failure,
      }),
    };
  }
}