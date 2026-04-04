import type { OpenClawRuntimeHealth } from './openclaw-runtime';
import type { RuntimePackageStatusSnapshot } from './tauri-agent';

type RuntimeHealthSnapshot =
  | OpenClawRuntimeHealth
  | { status: 'healthy' | 'error' | 'unknown'; detail?: string };

export interface RuntimeStatusDiagnostic {
  preferRunningSignal: boolean;
  note?: string;
}

function hasGatewayRunningSignal(runtimePackage: RuntimePackageStatusSnapshot) {
  if (runtimePackage.processRunning !== true) {
    return false;
  }

  if (runtimePackage.processMode === 'managed-runtime-process') {
    return false;
  }

  const statusLogs = runtimePackage.statusLogs ?? [];
  return (
    statusLogs.includes('gateway.running=true') ||
    statusLogs.some(
      (line) =>
        line.startsWith('gateway.detail=Gateway 运行中') ||
        line.startsWith('gateway.detail=Gateway 进程存活'),
    ) ||
    runtimePackage.detail.includes('OpenClaw Gateway 已运行')
  );
}

export function deriveRuntimeStatusDiagnostic(
  runtimePackage: RuntimePackageStatusSnapshot,
  runtimeHealth?: RuntimeHealthSnapshot,
): RuntimeStatusDiagnostic {
  if (!hasGatewayRunningSignal(runtimePackage)) {
    return { preferRunningSignal: false };
  }

  if (runtimeHealth?.status === 'healthy') {
    return { preferRunningSignal: false };
  }

  return {
    preferRunningSignal: true,
    note:
      'Windows 原生受管模式下，Gateway运行中，但 OpenClaw 状态可能短时显示未健康，请稍后重试。',
  };
}