#!/usr/bin/env node
import { createHash, createSign } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, basename, dirname } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(resolve(cwd, 'src-tauri/tauri.conf.json'), 'utf8'));
const compatibilityMatrixPath = resolve(cwd, 'release/compatibility-matrix.json');
const defaultCompatibilityMatrix = {
  channels: ['stable'],
  platforms: [
    { platform: 'darwin', architectures: [
      { arch: 'aarch64', bundleTargets: ['dmg', 'app.tar.gz'], installMethod: 'dmg', minDesktopVersion: packageJson.version, rollbackSupported: true },
      { arch: 'x86_64', bundleTargets: ['dmg', 'app.tar.gz'], installMethod: 'dmg', minDesktopVersion: packageJson.version, rollbackSupported: true },
    ] },
    { platform: 'windows', architectures: [
      { arch: 'x86_64', bundleTargets: ['msi', 'nsis'], installMethod: 'nsis', minDesktopVersion: packageJson.version, rollbackSupported: true },
    ] },
  ],
};
const compatibilityMatrix = existsSync(compatibilityMatrixPath)
  ? JSON.parse(readFileSync(compatibilityMatrixPath, 'utf8'))
  : defaultCompatibilityMatrix;

const artifactRoot = resolve(cwd, args['bundle-dir'] || args['artifact-root'] || 'src-tauri/target');
const outputPath = resolve(cwd, args.output || 'release/release-manifest.json');
const channel = args.channel || process.env.RHOPENCLAW_RELEASE_CHANNEL || 'stable';
const updaterOutputPath = resolve(cwd, args['updater-output'] || `release/updater/${channel}/latest.json`);
const releaseBaseUrl = (process.env.RHOPENCLAW_RELEASE_BASE_URL || '').trim().replace(/\/$/, '');
const releasedAt = process.env.RHOPENCLAW_RELEASED_AT || new Date().toISOString();
const releaseNotes = process.env.RHOPENCLAW_RELEASE_NOTES || 'RHClaw Desktop 发布清单（自动生成）';
const docsUrl = (process.env.RHOPENCLAW_RELEASE_DOCS_URL || '').trim() || null;
const manifestSigningKey = (process.env.RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY || '').trim();
const manifestSigningKeyPath = (process.env.RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH || '').trim();

function normalizePemContent(value) {
  if (!value) {
    return '';
  }

  return value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : value;
}

function readOptionalPemValue(rawValue, rawPath) {
  const inlineValue = normalizePemContent(rawValue);
  if (inlineValue) {
    return inlineValue;
  }

  if (rawPath && existsSync(resolve(cwd, rawPath))) {
    return readFileSync(resolve(cwd, rawPath), 'utf8');
  }

  return '';
}

function createCanonicalManifestPayload(input) {
  return JSON.stringify(input, null, 2);
}

function walk(directory) {
  if (!existsSync(directory)) {
    return [];
  }

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

function detectArtifactMeta(filePath) {
  const fileName = basename(filePath);
  const lower = filePath.toLowerCase();
  const arch = /arm64|aarch64/.test(lower)
    ? 'aarch64'
    : /x64|x86_64|amd64/.test(lower)
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'aarch64'
        : 'x86_64';

  if (lower.endsWith('.dmg')) return { platform: 'darwin', installerType: 'dmg', arch };
  if (lower.endsWith('.app.tar.gz')) return { platform: 'darwin', installerType: 'app.tar.gz', arch };
  if (lower.endsWith('.msi')) return { platform: 'windows', installerType: 'msi', arch };
  if (lower.endsWith('.exe')) return { platform: 'windows', installerType: 'nsis', arch };
  if (lower.endsWith('.appimage')) return { platform: 'linux', installerType: 'appimage', arch };
  if (lower.endsWith('.deb')) return { platform: 'linux', installerType: 'deb', arch };
  if (lower.endsWith('.rpm')) return { platform: 'linux', installerType: 'rpm', arch };
  return null;
}

function sha256File(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function readUpdaterSignature(filePath) {
  const signaturePath = `${filePath}.sig`;
  if (!existsSync(signaturePath)) {
    return null;
  }

  return readFileSync(signaturePath, 'utf8').trim() || null;
}

function resolveMatrixItem(platform, arch, installerType) {
  const platformEntry = compatibilityMatrix.platforms.find((item) => item.platform === platform);
  const architectureEntry = platformEntry?.architectures.find((item) => item.arch === arch && item.bundleTargets.includes(installerType));
  return architectureEntry || null;
}

function buildArtifactPreferenceScore(platform, arch, filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  const targetHints = {
    'darwin:aarch64': ['/aarch64-apple-darwin/release/bundle/'],
    'darwin:x86_64': ['/x86_64-apple-darwin/release/bundle/'],
    'windows:x86_64': ['/x86_64-pc-windows-msvc/release/bundle/', '/x86_64-pc-windows-gnu/release/bundle/'],
  };

  const hints = targetHints[`${platform}:${arch}`] || [];
  if (hints.some((hint) => normalized.includes(hint))) {
    return 200;
  }

  if (normalized.includes('/target/release/bundle/')) {
    return 100;
  }

  return 0;
}

function buildUpdaterArtifactPreferenceScore(item) {
  const installerPriority = {
    darwin: ['app.tar.gz', 'dmg'],
    windows: ['nsis', 'msi'],
    linux: ['appimage', 'deb', 'rpm'],
  };

  const priorities = installerPriority[item.platform] || [];
  const index = priorities.indexOf(item.installerType);
  if (index === -1) {
    return 0;
  }

  return priorities.length - index;
}

const compatibilityTargets = (compatibilityMatrix.platforms || []).flatMap((platform) =>
  (platform.architectures || []).flatMap((architecture) =>
    (architecture.bundleTargets || []).map((bundleTarget) => ({
      platform: platform.platform,
      arch: architecture.arch,
      installerType: bundleTarget,
      installMethod: architecture.installMethod,
      minDesktopVersion: architecture.minDesktopVersion,
      rollbackSupported: architecture.rollbackSupported,
      notes: architecture.notes || '',
    })),
  ),
);

const files = walk(artifactRoot).filter((filePath) => {
  const lower = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    lower.includes('/release/bundle/') &&
    (lower.endsWith('.dmg') || lower.endsWith('.app.tar.gz') || lower.endsWith('.msi') || lower.endsWith('.exe'))
  );
});
const warnings = [];

if (Array.isArray(compatibilityMatrix.channels) && compatibilityMatrix.channels.length > 0 && !compatibilityMatrix.channels.includes(channel)) {
  warnings.push(`当前 channel=${channel} 未在兼容矩阵 channels 中声明。`);
}
const itemCandidates = files
  .map((filePath) => {
    const meta = detectArtifactMeta(filePath);
    if (!meta) {
      return null;
    }

    const matrix = resolveMatrixItem(meta.platform, meta.arch, meta.installerType);
    if (!matrix) {
      warnings.push(`未在兼容矩阵中找到 ${meta.platform}/${meta.arch}/${meta.installerType} 的配置。`);
    }

    const stats = statSync(filePath);
    const fileName = basename(filePath);
    const downloadUrl = releaseBaseUrl ? `${releaseBaseUrl}/${encodeURIComponent(fileName)}` : '';

    return {
      version: tauriConfig.version || packageJson.version,
      platform: meta.platform,
      arch: meta.arch,
      installerType: meta.installerType,
      fileName,
      filePath: relative(cwd, filePath),
      fileSize: stats.size,
      sha256: sha256File(filePath),
      downloadUrl: downloadUrl || null,
      installMethod: matrix?.installMethod || 'package',
      minDesktopVersion: matrix?.minDesktopVersion || packageJson.version,
      rollbackSupported: matrix?.rollbackSupported ?? true,
      notes: matrix?.notes || '',
      rolloutChannel: channel,
      updaterSignature: readUpdaterSignature(filePath),
      _sourcePath: filePath,
      _sourceMtimeMs: stats.mtimeMs,
      _preferenceScore: buildArtifactPreferenceScore(meta.platform, meta.arch, filePath),
    };
  })
  .filter(Boolean)
  .sort((left, right) => {
    const leftKey = `${left.platform}:${left.arch}:${left.installerType}:${left.filePath}`;
    const rightKey = `${right.platform}:${right.arch}:${right.installerType}:${right.filePath}`;
    return leftKey.localeCompare(rightKey);
  });

const itemsByKey = new Map();
for (const item of itemCandidates) {
  const key = `${item.platform}:${item.arch}:${item.installerType}`;
  const existing = itemsByKey.get(key);
  if (!existing) {
    itemsByKey.set(key, item);
    continue;
  }

  const shouldReplace =
    item._preferenceScore > existing._preferenceScore ||
    (item._preferenceScore === existing._preferenceScore && item._sourceMtimeMs > existing._sourceMtimeMs);

  if (shouldReplace) {
    itemsByKey.set(key, item);
  }
}

const items = Array.from(itemsByKey.values())
  .map(({ _sourcePath: _unusedSourcePath, _sourceMtimeMs: _unusedSourceMtimeMs, _preferenceScore: _unusedPreferenceScore, ...item }) => item)
  .sort((left, right) => {
    const leftKey = `${left.platform}:${left.arch}:${left.installerType}:${left.filePath}`;
    const rightKey = `${right.platform}:${right.arch}:${right.installerType}:${right.filePath}`;
    return leftKey.localeCompare(rightKey);
  });

if (items.length === 0) {
  warnings.push('当前 target 目录下未检测到桌面安装包产物，已生成空清单基线。');
}

const coveredKeys = new Set(items.map((item) => `${item.platform}:${item.arch}:${item.installerType}`));
const requiredArtifacts = compatibilityTargets.map((target) => ({
  ...target,
  present: coveredKeys.has(`${target.platform}:${target.arch}:${target.installerType}`),
}));

const missingArtifacts = requiredArtifacts.filter((target) => !target.present);
if (missingArtifacts.length > 0) {
  warnings.push(`兼容矩阵要求的安装包仍缺少 ${missingArtifacts.length} 项。`);
}

const updaterCandidatesByTarget = new Map();
for (const item of itemsByKey.values()) {
  if (!item.downloadUrl) {
    warnings.push(`未提供 RHOPENCLAW_RELEASE_BASE_URL，无法为 ${item.fileName} 生成 updater 下载地址。`);
    continue;
  }

  if (!item.updaterSignature) {
    warnings.push(`未检测到 ${item.fileName}.sig，当前产物无法进入桌面自升级清单。`);
    continue;
  }

  const targetKey = `${item.platform}-${item.arch}`;
  const existing = updaterCandidatesByTarget.get(targetKey);
  if (!existing) {
    updaterCandidatesByTarget.set(targetKey, item);
    continue;
  }

  const currentScore = buildUpdaterArtifactPreferenceScore(item);
  const existingScore = buildUpdaterArtifactPreferenceScore(existing);
  if (currentScore > existingScore) {
    updaterCandidatesByTarget.set(targetKey, item);
  }
}

const updaterPlatforms = {};
for (const [targetKey, item] of updaterCandidatesByTarget.entries()) {
  updaterPlatforms[targetKey] = {
    signature: item.updaterSignature,
    url: item.downloadUrl,
  };
}

const updaterManifest = {
  version: tauriConfig.version || packageJson.version,
  notes: releaseNotes,
  pub_date: releasedAt,
  platforms: updaterPlatforms,
};

const manifestPrivateKey = readOptionalPemValue(manifestSigningKey, manifestSigningKeyPath);
let manifestSignature = null;
let signatureAlgorithm = null;

if (!manifestPrivateKey) {
  warnings.push('未提供 Release Manifest 私钥，当前仅输出哈希摘要，未附带签名。');
}

const manifestCore = {
  productName: tauriConfig.productName || packageJson.name,
  identifier: tauriConfig.identifier,
  desktopVersion: tauriConfig.version || packageJson.version,
  channel,
  releasedAt,
  generatedAt: new Date().toISOString(),
  releaseNotes,
  docsUrl,
  bundleDir: relative(cwd, artifactRoot),
  compatibilityMatrix: 'release/compatibility-matrix.json',
  rollbackValidation: 'release/rollback-validation.json',
  updaterManifestPath: relative(cwd, updaterOutputPath),
  itemCount: items.length,
  coverage: {
    requiredCount: requiredArtifacts.length,
    presentCount: requiredArtifacts.filter((item) => item.present).length,
    missingCount: missingArtifacts.length,
  },
  warnings: [...warnings],
  requiredArtifacts,
  items,
};

const manifestPayload = createCanonicalManifestPayload(manifestCore);
const manifestSha256 = createHash('sha256').update(manifestPayload).digest('hex');

if (manifestPrivateKey) {
  const signer = createSign('RSA-SHA256');
  signer.update(manifestPayload);
  signer.end();
  manifestSignature = signer.sign(manifestPrivateKey, 'base64');
  signatureAlgorithm = 'RSA-SHA256';
}

const manifest = {
  ...manifestCore,
  manifestSha256,
  manifestSignature,
  signatureAlgorithm,
};

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(updaterOutputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
writeFileSync(updaterOutputPath, JSON.stringify(updaterManifest, null, 2));
console.log(
  JSON.stringify(
    {
      ok: true,
      outputPath: relative(cwd, outputPath),
      updaterOutputPath: relative(cwd, updaterOutputPath),
      itemCount: items.length,
      coverage: manifest.coverage,
      warnings,
      signed: Boolean(manifestSignature),
    },
    null,
    2,
  ),
);
