#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const bundleDir = resolve(cwd, process.env.RHOPENCLAW_BUNDLE_DIR || 'src-tauri/target/release/bundle');
const macosBundleDir = resolve(bundleDir, 'macos');
const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(resolve(cwd, 'src-tauri/tauri.conf.json'), 'utf8'));
const productName = process.env.RHOPENCLAW_PRODUCT_NAME || tauriConfig.productName || packageJson.name;
const releasePrefix = process.env.RHOPENCLAW_RELEASE_PREFIX || 'RHClaw-Desktop';
const version = process.env.RHOPENCLAW_DESKTOP_VERSION || tauriConfig.version || packageJson.version;
const appName = `${productName}.app`;
const appPath = resolve(macosBundleDir, appName);

function detectArchiveSuffix() {
  const lowerBundleDir = bundleDir.toLowerCase();

  if (lowerBundleDir.includes('aarch64-apple-darwin') || lowerBundleDir.includes('arm64')) {
    return 'arm64';
  }

  if (lowerBundleDir.includes('x86_64-apple-darwin') || lowerBundleDir.includes('x64') || lowerBundleDir.includes('amd64')) {
    return 'x64';
  }

  if (process.arch === 'arm64') {
    return 'arm64';
  }

  if (process.arch === 'x64') {
    return 'x64';
  }

  return process.arch;
}

if (!existsSync(appPath)) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: true,
        reason: 'macOS app bundle not found',
        appPath,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

mkdirSync(macosBundleDir, { recursive: true });

const archiveName = `${releasePrefix}-${version}-macos-${detectArchiveSuffix()}.app.tar.gz`;
const archivePath = resolve(macosBundleDir, archiveName);

if (existsSync(archivePath)) {
  rmSync(archivePath);
}

execFileSync('tar', ['-czf', archivePath, '-C', dirname(appPath), basename(appPath)], {
  cwd,
  stdio: 'inherit',
});

console.log(
  JSON.stringify(
    {
      ok: true,
      generated: true,
      archivePath,
    },
    null,
    2,
  ),
);