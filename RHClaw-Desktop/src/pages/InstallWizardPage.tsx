import appIcon from '../../src-tauri/icons/128x128@2x.png';
import { InstallProgressBar } from '../components/install-progress-bar';
import { TerminalLogSummary } from '../components/terminal-log-summary';
import type { InstallWizardViewModel } from '../types/desktop';

export interface InstallWizardPageProps {
  installWizard: InstallWizardViewModel;
  wizardProgressPercent: number;
  wizardProgressLabel: string;
  runtimeBusy: string | null;
  installTaskStageLabel: string;
  latestInstallLog: string;
  canContinueInstallInBackground: boolean;
  canCancelInstallTask: boolean;
  installCancelRequested: boolean;
  canReuseCurrentInstall: boolean;
  decisionPrimaryLabel: string;
  installLogSummary: string[];
  bindQrCodeDataUrl: string;
  bindQrCodeError: string;
  detectedInstallPaths: string[];
  selectedInstallPath: string | null;
  onSelectInstallPath: (path: string) => void;
  onLaunchInstallFlow: () => void;
  onInstallManagedRuntime: () => void;
  onBindExistingRuntime: () => void;
  onContinueInstallInBackground: () => void;
  onCancelInstallTask: () => void;
  onCreateBindSession: () => void;
}

export function InstallWizardPage({
  installWizard,
  wizardProgressPercent,
  wizardProgressLabel,
  runtimeBusy,
  installTaskStageLabel,
  latestInstallLog,
  canContinueInstallInBackground,
  canCancelInstallTask,
  installCancelRequested,
  canReuseCurrentInstall,
  decisionPrimaryLabel,
  installLogSummary,
  bindQrCodeDataUrl,
  bindQrCodeError,
  detectedInstallPaths,
  selectedInstallPath,
  onSelectInstallPath,
  onLaunchInstallFlow,
  onInstallManagedRuntime,
  onBindExistingRuntime,
  onContinueInstallInBackground,
  onCancelInstallTask,
  onCreateBindSession,
}: InstallWizardPageProps) {
  return (
    <section className="install-wizard-shell">
      <h2 className="install-wizard-brand-title">小爪龙虾 - RHClaw</h2>

      {installWizard.scene !== 'launch' ? (
        <>
          <InstallProgressBar
            progress={wizardProgressPercent}
            label={wizardProgressLabel}
            active={runtimeBusy !== null && wizardProgressPercent < 100}
          />
          {installLogSummary.length > 0 ? (
            <TerminalLogSummary title="日志摘要" ariaLabel="安装日志摘要" lines={installLogSummary} />
          ) : null}
          {installTaskStageLabel ? (
            <div className="install-wizard-task-meta" aria-live="polite">
              <div>
                <strong>{installTaskStageLabel}</strong>
                <p>{latestInstallLog || wizardProgressLabel}</p>
              </div>
              {installCancelRequested ? <span className="install-wizard-task-tag">已请求取消</span> : null}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="install-wizard-hero">
        {installWizard.scene === 'decision' ? (
          <>
            <h2 className="install-wizard-hero-decision">{installWizard.detail}</h2>
            {detectedInstallPaths.length > 1 ? (
              <div className="install-wizard-path-selector" aria-label="选择安装路径">
                <p className="install-wizard-path-selector-hint">检测到多个 OpenClaw 安装，请选择要复用的版本：</p>
                <ul className="install-wizard-path-list">
                  {detectedInstallPaths.map((path) => (
                    <li key={path}>
                      <label className={`install-wizard-path-item${selectedInstallPath === path ? ' install-wizard-path-item-selected' : ''}`}>
                        <input
                          type="radio"
                          name="install-path"
                          value={path}
                          checked={selectedInstallPath === path}
                          onChange={() => onSelectInstallPath(path)}
                          disabled={runtimeBusy !== null}
                        />
                        <span className="install-wizard-path-label">{path}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="install-wizard-decision-cards">
              <button
                className="install-wizard-decision-card"
                onClick={onBindExistingRuntime}
                disabled={runtimeBusy !== null || !canReuseCurrentInstall}
              >
                <img src={appIcon} alt="复用修复" className="install-wizard-decision-card-img install-wizard-decision-card-img-muted" />
                <span>{runtimeBusy === 'reuse' || runtimeBusy === 'repair' ? '处理中...' : decisionPrimaryLabel}</span>
              </button>
              <button
                className="install-wizard-decision-card install-wizard-decision-card-primary"
                onClick={onInstallManagedRuntime}
                disabled={runtimeBusy !== null}
              >
                <img src={appIcon} alt="重新安装" className="install-wizard-decision-card-img" />
                <span>{runtimeBusy === 'install' ? '安装中...' : '重新安装'}</span>
              </button>
            </div>
          </>
        ) : installWizard.scene === 'binding' ? (
          <>
            <h2 className="install-wizard-hero-binding">{installWizard.title}</h2>
            <p className="install-wizard-subtitle">{installWizard.detail}</p>
            {bindQrCodeError ? (
              <div className="install-wizard-qr-center install-wizard-qr-placeholder">{bindQrCodeError}</div>
            ) : bindQrCodeDataUrl ? (
              <img src={bindQrCodeDataUrl} alt="绑定二维码" className="install-wizard-qr-center" />
            ) : (
              <div className="install-wizard-qr-center install-wizard-qr-placeholder">二维码生成中...</div>
            )}
          </>
        ) : installWizard.scene === 'failed' ? (
          <>
            <h3 className="install-wizard-hero-failed">不好，环境太复杂，小龙虾安装失败(OpenClaw)了！</h3>
            <img src={appIcon} alt="RHOpenClaw 图标" className="install-wizard-mascot" />
          </>
        ) : (
          <>
            <img src={appIcon} alt="RHOpenClaw 图标" className="install-wizard-mascot" />
            <h2>一键搞定你的小龙虾</h2>
            <p className="install-wizard-subtitle">(官方OpenClaw+内置技能+龙虾群+免费大模型+微信)</p>
          </>
        )}
      </div>

      <div className="install-wizard-actions">
        {installWizard.scene === 'launch' ? (
          <button
            className="install-wizard-primary-button install-wizard-primary-button-wide"
            onClick={onLaunchInstallFlow}
            disabled={runtimeBusy !== null}
          >
            开始安装
          </button>
        ) : null}

        {installWizard.scene === 'checking' ? (
          <button className="install-wizard-primary-button install-wizard-primary-button-wide install-wizard-primary-button-disabled" disabled>开始安装</button>
        ) : null}

        {installWizard.scene === 'installing' ? (
          <div className="install-wizard-inline-actions">
            <button className="install-wizard-primary-button install-wizard-primary-button-wide install-wizard-primary-button-disabled" disabled>
              {runtimeBusy === 'install' ? '安装中...' : runtimeBusy === 'reuse' || runtimeBusy === 'repair' ? '处理中...' : '开始安装'}
            </button>
          </div>
        ) : null}

        {installWizard.scene === 'failed' ? (
          <button className="install-wizard-primary-button" onClick={onInstallManagedRuntime} disabled={runtimeBusy !== null}>
            {runtimeBusy === 'install' ? '安装中...' : '全新安装'}
          </button>
        ) : null}

        {installWizard.scene === 'binding' && bindQrCodeError ? (
          <button className="install-wizard-primary-button" onClick={onCreateBindSession} disabled={runtimeBusy !== null}>
            重新生成二维码
          </button>
        ) : null}
      </div>

      {installWizard.scene !== 'launch' && installWizard.scene !== 'checking' && installWizard.scene !== 'installing' ? (
        <div className="install-wizard-footer-tagline">
          <h3>一键搞定你的小龙虾</h3>
          <p>(官方OpenClaw+内置技能+龙虾群+免费大模型+微信)</p>
        </div>
      ) : null}
    </section>
  );
}
