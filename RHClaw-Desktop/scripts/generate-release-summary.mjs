#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const reportPath = resolve(cwd, args.report || 'release/release-validation-report.json');
const outputPath = resolve(cwd, args.output || 'release/release-summary.md');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const lines = [];
lines.push('# RHClaw Desktop Release Summary');
lines.push('');
lines.push(`- Report: ${relative(cwd, reportPath)}`);

if (report.coverage) {
  lines.push(
    `- Coverage: ${report.coverage.presentCount}/${report.coverage.requiredCount} (missing ${report.coverage.missingCount})`,
  );
}

lines.push(`- Verified artifacts: ${report.verifiedArtifacts ?? 0}`);
lines.push(`- Rollback scenarios: ${report.rollbackScenarios ?? 0}`);
lines.push(`- Status: ${report.ok ? 'PASS' : 'FAIL'}`);
lines.push('');

const missingArtifacts = (report.artifactMatrix || []).filter((item) => !item.present);
if (missingArtifacts.length > 0) {
  lines.push('## Missing Artifacts');
  lines.push('');
  for (const item of missingArtifacts) {
    lines.push(`- ${item.platform}/${item.arch}/${item.installerType}`);
  }
  lines.push('');
}

if (Array.isArray(report.warnings) && report.warnings.length > 0) {
  lines.push('## Warnings');
  lines.push('');
  for (const warning of report.warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push('');
}

if (Array.isArray(report.errors) && report.errors.length > 0) {
  lines.push('## Errors');
  lines.push('');
  for (const error of report.errors) {
    lines.push(`- ${error}`);
  }
  lines.push('');
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(outputPath);