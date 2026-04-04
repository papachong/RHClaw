import { useEffect, useRef, useState } from 'react';
import packageJson from '../../package.json';
import type { DesktopUpdaterStatusSnapshot } from '../services/tauri-agent';
import { getDesktopUpdateProgress } from '../services/tauri-agent';
import appIcon from '../../src-tauri/icons/128x128.png';

export interface UpdateModalProps {
  updaterStatus: DesktopUpdaterStatusSnapshot;
  onRestartApp?: () => void;
  onDismiss?: () => void;
}

export function UpdateModal({ updaterStatus, onRestartApp }: UpdateModalProps) {
  // Self-managed progress polling — bypasses parent re-render chain entirely
  const [downloadedBytes, setDownloadedBytes] = useState(updaterStatus.downloadedBytes ?? 0);
  const [totalBytes, setTotalBytes] = useState(updaterStatus.totalBytes ?? null);
  const [installCompleted, setInstallCompleted] = useState(updaterStatus.installed);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (installCompleted) return;

    pollingRef.current = setInterval(async () => {
      try {
        const p = await getDesktopUpdateProgress();
        if (!p.active) return;
        setDownloadedBytes(p.downloadedBytes);
        if (p.totalBytes != null) setTotalBytes(p.totalBytes);
        if (p.completed) {
          setInstallCompleted(true);
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        }
      } catch {
        // ignore
      }
    }, 400);

    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    };
  }, [installCompleted]);

  const progressRatio = totalBytes && downloadedBytes
    ? Math.min(1, downloadedBytes / totalBytes)
    : installCompleted ? 1 : 0;

  const currentVersion = updaterStatus.currentVersion || packageJson.version || '0.0.0';
  const targetVersion = updaterStatus.targetVersion ? `v${updaterStatus.targetVersion}` : '';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
      backdropFilter: 'blur(6px)',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: 20,
        width: 480,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '40px 40px 36px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        position: 'relative',
        overflow: 'hidden',
      }}>

        {/* Title */}
        <h2 style={{
          fontSize: 26,
          fontWeight: 900,
          color: '#374151',
          letterSpacing: '0.08em',
          marginBottom: 32,
          fontFamily: '"ZCOOL KuaiLe", "Comic Sans MS", cursive, system-ui, sans-serif',
        }}>
          小爪龙虾 - RHClaw-v{currentVersion}
        </h2>

        {/* Icon */}
        <div style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 24,
          overflow: 'hidden',
          boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
          background: '#f8fafc',
          width: 128,
          height: 128,
          marginBottom: 32,
        }}>
          <img style={{ width: '100%', height: '100%', objectFit: 'cover' }} src={appIcon} alt="RHClaw Logo" />
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            background: 'linear-gradient(to top, rgba(229,231,235,0.9), rgba(243,244,246,0.6), transparent)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 4,
            paddingTop: 16,
          }}>
            <span style={{ fontSize: 12, color: '#374151', fontWeight: 500, letterSpacing: '0.05em' }}>
              open-source build
            </span>
          </div>
        </div>

        {/* Status Text */}
        <div style={{ color: '#1f2937', fontSize: 18, fontWeight: 600, marginBottom: 24 }}>
          {installCompleted
            ? <span>已下载完毕，请重启以切换到新版本 {targetVersion}</span>
            : <span>发现新版本{targetVersion}，正在下载...请稍候</span>}
        </div>

        {/* Progress Bar */}
        <div style={{
          width: '100%',
          maxWidth: 380,
          background: '#f1f5f9',
          borderRadius: 9999,
          height: 10,
          marginBottom: 32,
          overflow: 'hidden',
          position: 'relative',
        }}>
          <div style={{
            background: '#165DFF',
            height: '100%',
            borderRadius: 9999,
            transition: 'width 0.3s ease-out',
            width: `${Math.round(progressRatio * 100)}%`,
          }} />
        </div>

        {/* Update Notes */}
        <div style={{
          width: '100%',
          maxWidth: 420,
          background: '#F4F5F7',
          borderRadius: 12,
          padding: 24,
          marginBottom: 8,
          fontSize: 15,
          color: '#374151',
          lineHeight: 1.8,
          textAlign: 'left',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 12, color: '#1f2937' }}>更新内容：</div>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, opacity: 0.9 }}>
            <li style={{ marginBottom: 8 }}>1. 修复windows版安装bug</li>
            <li style={{ marginBottom: 8 }}>2. 更新小程序龙虾群管理功能</li>
            <li style={{ marginBottom: 8 }}>3. 增强服务端负载能力</li>
            <li>4. 增强龙虾记忆管理能力</li>
          </ol>
        </div>

        {/* Action Button - Only Restart Now */}
        {installCompleted && onRestartApp && (
          <div style={{ width: '100%', display: 'flex', justifyContent: 'center', marginTop: 24 }}>
            <button
              type="button"
              style={{
                width: 144,
                padding: '10px 0',
                borderRadius: 6,
                fontSize: 16,
                color: '#fff',
                fontWeight: 500,
                background: '#165DFF',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(22,93,255,0.2)',
              }}
              onClick={onRestartApp}
            >
              重新启动
            </button>
          </div>
        )}
      </div>
    </div>
  );
}