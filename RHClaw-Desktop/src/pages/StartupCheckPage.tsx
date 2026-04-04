import appIcon from '../../src-tauri/icons/128x128@2x.png';
import { InstallProgressBar } from '../components/install-progress-bar';
import { TerminalLogSummary } from '../components/terminal-log-summary';
import type { StartupCheckViewModel } from '../types/desktop';

export interface StartupCheckPageProps {
  startupCheck: StartupCheckViewModel;
}

export function StartupCheckPage({ startupCheck }: StartupCheckPageProps) {
  return (
    <section className="install-wizard-shell">
      <h2 className="install-wizard-brand-title">小爪龙虾 - RHClaw</h2>
      <InstallProgressBar progress={startupCheck.progressPercent} label={startupCheck.progressLabel} active />
      {startupCheck.logs.length > 0 ? (
        <TerminalLogSummary title="启动检查日志" ariaLabel="启动检查日志摘要" lines={startupCheck.logs} />
      ) : null}
      <div className="install-wizard-hero">
        <img src={appIcon} alt="RHOpenClaw 图标" className="install-wizard-mascot" />
        <h2>{startupCheck.title}</h2>
        <p className="install-wizard-subtitle">{startupCheck.detail}</p>
      </div>
    </section>
  );
}
