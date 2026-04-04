export interface TerminalLogSummaryProps {
  title: string;
  ariaLabel: string;
  lines: string[];
}

function summarizeLatestLine(line: string) {
  const normalized = line.trim();
  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 64)}...`;
}

export function TerminalLogSummary({ title, ariaLabel, lines }: TerminalLogSummaryProps) {
  const latestLine = lines.length > 0 ? lines[lines.length - 1] : '';
  const summaryText = latestLine ? `${summarizeLatestLine(latestLine)}` : `${title}（暂无日志）`;

  return (
    <details className="terminal-log-summary-panel" aria-label={ariaLabel}>
      <summary className="terminal-log-summary-toggle">
        <div className="terminal-log-summary-copy">
          <span>{summaryText}</span>
        </div>
      </summary>

      <div className="terminal-log-shell">
        <div className="terminal-log-chrome" aria-hidden="true">
          <span className="terminal-log-chrome-dot terminal-log-chrome-dot-close" />
          <span className="terminal-log-chrome-dot terminal-log-chrome-dot-minimize" />
          <span className="terminal-log-chrome-dot terminal-log-chrome-dot-expand" />
          <span className="terminal-log-chrome-title">tail -f rhopenclaw.log</span>
        </div>
        <div className="terminal-log-body" role="log" aria-live="polite">
          {lines.map((line, index) => (
            <p className="terminal-log-body-line" key={`${index}-${line}`}>
              <span className="terminal-log-body-prompt" aria-hidden="true">$</span>
              <span>{line}</span>
            </p>
          ))}
        </div>
      </div>
    </details>
  );
}