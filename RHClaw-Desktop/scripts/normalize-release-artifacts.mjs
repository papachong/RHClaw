#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const rootDir = resolve(cwd, process.env.RHOPENCLAW_ARTIFACT_ROOT || 'src-tauri/target');
const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(resolve(cwd, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = process.env.RHOPENCLAW_DESKTOP_VERSION || tauriConfig.version || packageJson.version;
const productPrefix = process.env.RHOPENCLAW_RELEASE_PREFIX || 'RHClaw-Desktop';

function walk(directory) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      results.push(...walk(entryPath));
    } else {
      results.push(entryPath);
    }
  }
  return results;
}

function detectArchToken(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('arm64') || lower.includes('aarch64')) return 'arm64';
  if (lower.includes('x64') || lower.includes('x86_64') || lower.includes('amd64')) return 'x64';
  if (lower.includes('aarch64-apple-darwin')) return 'arm64';
  if (lower.includes('x86_64-apple-darwin')) return 'x64';
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function getCanonicalArtifactName(filePath) {
  const lower = filePath.toLowerCase();
  const arch = detectArchToken(filePath);
  if (lower.endsWith('.dmg')) {
    return `${productPrefix}-${version}-macos-${arch}.dmg`;
  }
  if (lower.endsWith('.app.tar.gz')) {
    return `${productPrefix}-${version}-macos-${arch}.app.tar.gz`;
  }
  if (lower.endsWith('.msi')) {
    return `${productPrefix}-${version}-windows-${arch}.msi`;
  }
  if (lower.endsWith('.exe')) {
    return `${productPrefix}-${version}-windows-${arch}.exe`;
  }
  return null;
}

function getCanonicalName(filePath) {
  if (filePath.toLowerCase().endsWith('.sig')) {
    const artifactPath = filePath.slice(0, -4);
    const canonicalArtifactName = getCanonicalArtifactName(artifactPath);
    return canonicalArtifactName ? `${canonicalArtifactName}.sig` : null;
  }

  return getCanonicalArtifactName(filePath);
}

const files = walk(rootDir).filter((filePath) => {
  const lower = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    lower.includes('/release/bundle/') &&
    (
      lower.endsWith('.dmg') ||
      lower.endsWith('.app.tar.gz') ||
      lower.endsWith('.msi') ||
      lower.endsWith('.exe') ||
      lower.endsWith('.dmg.sig') ||
      lower.endsWith('.app.tar.gz.sig') ||
      lower.endsWith('.msi.sig') ||
      lower.endsWith('.exe.sig')
    )
  );
});

const renamed = [];
const skipped = [];

for (const filePath of files) {
  const canonicalName = getCanonicalName(filePath);
  if (!canonicalName) continue;
  const currentName = basename(filePath);
  if (currentName === canonicalName) {
    skipped.push(filePath);
    continue;
  }

  const targetPath = join(dirname(filePath), canonicalName);
  if (targetPath !== filePath && existsSync(targetPath)) {
    rmSync(targetPath);
  }
  renameSync(filePath, targetPath);
  renamed.push({ from: filePath, to: targetPath });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      rootDir,
      renamedCount: renamed.length,
      skippedCount: skipped.length,
      renamed,
    },
    null,
    2,
  ),
);