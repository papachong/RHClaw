interface InstallProgressBarProps {
  progress: number;
  label: string;
  active?: boolean;
}

export function InstallProgressBar(props: InstallProgressBarProps) {
  const safeProgress = Number.isFinite(props.progress)
    ? Math.min(100, Math.max(0, Math.round(props.progress)))
    : 0;

  const fillClassName = [
    'install-wizard-progress-fill',
    props.active ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="install-wizard-progress-block">
      <div className="install-wizard-progress-bar" aria-label={props.label}>
        <span className={fillClassName} style={{ width: `${safeProgress}%` }} />
      </div>
      <div className="install-wizard-progress-copy">
        <span>{props.label}</span>
        <strong>{`${safeProgress}%`}</strong>
      </div>
    </div>
  );
}