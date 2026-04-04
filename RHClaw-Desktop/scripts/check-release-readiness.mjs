#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const reportPath = resolve(cwd, args.report || 'release/release-validation-report.json');
const manifestPath = resolve(cwd, args.manifest || 'release/release-manifest.json');
const requireSignature = `${args['require-signature'] || 'false'}` === 'true';

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const failures = [];

if (report.ok !== true) {
  failures.push('release-validation-report.json 存在 errors。');
}

if (!report.coverage || typeof report.coverage.missingCount !== 'number') {
  failures.push('release-validation-report.json 缺少 coverage.missingCount。');
} else if (report.coverage.missingCount > 0) {
  failures.push(`兼容矩阵仍缺少 ${report.coverage.missingCount} 个安装包产物。`);
}

if (requireSignature && !manifest.manifestSignature) {
  failures.push('要求签名校验时，release-manifest.json 仍未附带 manifestSignature。');
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      coverage: report.coverage,
      requireSignature,
      manifestSigned: Boolean(manifest.manifestSignature),
    },
    null,
    2,
  ),
);