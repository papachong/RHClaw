#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const outputRoot = resolve(projectRoot, args.output || 'release/openclaw-bootstrap');
const fullOfflineRoot = join(outputRoot, 'full-offline-materials');
const mirrorRoot = join(outputRoot, 'mirror-assets');
const installCnPath = resolve(__dirname, 'install-cn.sh');
const openclawVersionInput = args['openclaw-version'] || 'latest';
const nodeVersionInput = args['node-version'] || 'latest';
const nodeMinVersion = args['node-min-version'] || '22.16.0';
const nodePlatformInput = args['node-platform'] || '';
const nodeArchInput = args['node-arch'] || '';
const gumVersion = args['gum-version'] || '0.17.0';
const mirrorBaseUrl = (args['mirror-base-url'] || process.env.RHOPENCLAW_MIRROR_BASE_URL || '').replace(/\/$/, '');
if (!mirrorBaseUrl) {
  throw new Error('Missing mirror base URL. Pass --mirror-base-url or set RHOPENCLAW_MIRROR_BASE_URL.');
}
const installCnMirrorUrl = `${mirrorBaseUrl}/mirrors/openclaw/install-cn.sh`;
const installScriptMirrorUrl = `${mirrorBaseUrl}/mirrors/openclaw/install.sh`;
const buildEnv = {
  ...process.env,
  https_proxy: process.env.https_proxy || 'http://127.0.0.1:7890',
  http_proxy: process.env.http_proxy || 'http://127.0.0.1:7890',
  all_proxy: process.env.all_proxy || 'socks5://127.0.0.1:7890',
  npm_config_loglevel: process.env.OPENCLAW_NPM_LOGLEVEL || process.env.npm_config_loglevel || 'error',
  NPM_CONFIG_LOGLEVEL: process.env.OPENCLAW_NPM_LOGLEVEL || process.env.NPM_CONFIG_LOGLEVEL || 'error',
};

const REQUIRED_OPENCLAW_PACKAGE_ENTRIES = [
  'package/package.json',
  'package/docs/reference/templates/AGENTS.md',
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function fileMatchesSha256(path, sha256) {
  return existsSync(path) && sha256 && sha256File(path) === sha256;
}

function removeSiblingFiles(dir, predicate, keepName) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === keepName) continue;
    if (predicate(entry)) {
      rmSync(join(dir, entry), { force: true, recursive: true });
    }
  }
}

function buildTempOutputPath(outputPath) {
  return `${outputPath}.partial-${process.pid}-${Date.now()}`;
}

function validateTarArchive(filePath, label) {
  try {
    execFileSync('tar', ['-tzf', filePath], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 归档校验失败: ${detail}`);
  }
}

function validateTarEntriesExist(filePath, entries, label) {
  for (const entry of entries) {
    try {
      execFileSync('tar', ['-xOf', filePath, entry], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} 缺少关键文件 ${entry}: ${detail}`);
    }
  }
}

function validateNodeArchive(filePath, label) {
  try {
    if (filePath.endsWith('.zip')) {
      execFileSync('tar', ['-tf', filePath], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return;
    }

    validateTarArchive(filePath, label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 校验失败: ${detail}`);
  }
}

function validateOpenClawPackage(filePath, expectedVersion, label) {
  validateTarArchive(filePath, label);
  validateTarEntriesExist(filePath, REQUIRED_OPENCLAW_PACKAGE_ENTRIES, label);

  let packageJsonRaw = '';
  try {
    packageJsonRaw = execFileSync('tar', ['-xOf', filePath, 'package/package.json'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 缺少 package/package.json: ${detail}`);
  }

  let packageJson = null;
  try {
    packageJson = JSON.parse(packageJsonRaw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} package.json 解析失败: ${detail}`);
  }

  if (packageJson?.name !== 'openclaw') {
    throw new Error(`${label} 包名异常: ${packageJson?.name || '<unknown>'}`);
  }

  if (normalizeVersion(packageJson?.version || '') !== normalizeVersion(expectedVersion)) {
    throw new Error(
      `${label} 版本异常: ${normalizeVersion(packageJson?.version || '') || '<unknown>'} != ${normalizeVersion(expectedVersion)}`,
    );
  }
}

function isValidatedFile(filePath, validator) {
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    validator(filePath);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[bootstrap-assets] invalid cached asset ignored: ${filePath}; ${detail}`);
    return false;
  }
}

async function downloadFile(url, outputPath, validator) {
  const tempPath = buildTempOutputPath(outputPath);
  try {
    execFileSync('curl', ['-fsSL', '--connect-timeout', '10', '--retry', '1', '-o', tempPath, url], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: buildEnv,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`download failed: ${url} -> ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(tempPath, buffer);
    } catch (fetchError) {
      const fetchDetail = fetchError instanceof Error ? fetchError.message : String(fetchError);
      throw new Error(`download failed: ${url}; curl=${detail}; fetch=${fetchDetail}`);
    }
  }

  try {
    validator?.(tempPath);
    rmSync(outputPath, { force: true });
    renameSync(tempPath, outputPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function packOpenClawPackage(outputDir, resolvedOpenclawVersion) {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'rhopenclaw-bootstrap-openclaw-'));
  const expectedTgzName = `openclaw-${resolvedOpenclawVersion}.tgz`;
  const tempTgzPath = join(tempDir, expectedTgzName);

  try {
    run('npm', [
      '--silent',
      'pack',
      `openclaw@${resolvedOpenclawVersion}`,
      '--pack-destination',
      tempDir,
      '--registry',
      'https://registry.npmmirror.com',
    ]);

    if (!existsSync(tempTgzPath)) {
      throw new Error(`openclaw npm tgz not found after npm pack: ${expectedTgzName}`);
    }

    validateOpenClawPackage(tempTgzPath, resolvedOpenclawVersion, `OpenClaw npm tgz (${expectedTgzName})`);

    removeSiblingFiles(outputDir, (entry) => entry.endsWith('.tgz'), expectedTgzName);
    copyFileSync(tempTgzPath, join(outputDir, expectedTgzName));
    return expectedTgzName;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function run(command, commandArgs, options = {}) {
  const isWin = process.platform === 'win32';
  return execFileSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: buildEnv,
    shell: isWin,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
}

function resolvePackageVersion() {
  return run('npm', [
    '--silent',
    'view',
    `openclaw@${openclawVersionInput}`,
    'version',
    '--registry',
    'https://registry.npmmirror.com',
  ]);
}

function resolveNodePlatform() {
  if (nodePlatformInput) return nodePlatformInput;
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win';
  throw new Error(`unsupported platform for offline node bundle: ${process.platform}`);
}

function resolveNodeArch() {
  if (nodeArchInput) return nodeArchInput;
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`unsupported arch for offline node bundle: ${process.arch}`);
}

function normalizeVersion(version) {
  return String(version).trim().replace(/^v/i, '').split('-')[0];
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const [major = '0', minor = '0', patch = '0'] = normalized.split('.');
  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0,
    patch: Number.parseInt(patch, 10) || 0,
  };
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isStableNodeVersion(version) {
  return /^v?\d+\.\d+\.\d+$/.test(String(version).trim());
}

async function fetchNodeIndexVersions() {
  const sources = [
    'https://npmmirror.com/mirrors/node/index.json',
    'https://nodejs.org/dist/index.json',
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source);
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        continue;
      }

      return payload
        .map((entry) => entry?.version)
        .filter((version) => typeof version === 'string' && isStableNodeVersion(version));
    } catch {
      // Try next source.
    }
  }

  return [];
}

async function resolveNodeVersion() {
  if (nodeVersionInput !== 'latest') {
    return normalizeVersion(nodeVersionInput);
  }

  const minVersion = normalizeVersion(nodeMinVersion);
  const candidates = await fetchNodeIndexVersions();
  const filtered = candidates
    .map((version) => normalizeVersion(version))
    .filter((version) => compareVersion(version, minVersion) >= 0)
    .sort((left, right) => compareVersion(right, left));

  if (filtered.length === 0) {
    throw new Error(`failed to resolve latest Node version >= ${minVersion}`);
  }

  return filtered[0];
}

function buildManifestEntry(rootDir, filePath, sourceUrl) {
  return {
    path: relative(rootDir, filePath).replace(/\\/g, '/'),
    size: statSync(filePath).size,
    sha256: sha256File(filePath),
    sourceUrl,
  };
}

function copyExecutable(sourcePath, targetPath) {
  const content = readFileSync(sourcePath, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  writeFileSync(targetPath, content, 'utf8');
  chmodSync(targetPath, 0o755);
}

function sanitizeWarning(message) {
  return message
    .replace(/https?:\/\/[^\s)]+/g, '[redacted-build-source]')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const warnings = [];
  const offlineManifestPath = join(fullOfflineRoot, 'manifests', 'full-offline-materials.json');
  const existingOfflineManifest = readJsonIfExists(offlineManifestPath);

  ensureDir(outputRoot);
  ensureDir(join(fullOfflineRoot, 'openclaw'));
  ensureDir(join(fullOfflineRoot, 'packages', 'openclaw'));
  ensureDir(join(fullOfflineRoot, 'packages', 'node'));
  ensureDir(join(fullOfflineRoot, 'manifests'));
  ensureDir(join(mirrorRoot, 'mirrors', 'openclaw'));
  ensureDir(join(mirrorRoot, 'mirrors', 'openclaw', 'packages'));
  ensureDir(join(mirrorRoot, 'mirrors', 'gum', `v${gumVersion}`));
  ensureDir(join(mirrorRoot, 'manifests'));

  const installCnOfflinePath = join(fullOfflineRoot, 'openclaw', 'install-cn.sh');
  const installScriptOfflinePath = join(fullOfflineRoot, 'openclaw', 'install.sh');
  const installCnMirrorPath = join(mirrorRoot, 'mirrors', 'openclaw', 'install-cn.sh');
  const installScriptMirrorPath = join(mirrorRoot, 'mirrors', 'openclaw', 'install.sh');
  copyExecutable(installCnPath, installCnOfflinePath);
  copyExecutable(installCnPath, installScriptOfflinePath);
  copyExecutable(installCnPath, installCnMirrorPath);
  copyExecutable(installCnPath, installScriptMirrorPath);

  const resolvedOpenclawVersion = resolvePackageVersion();
  const nodeVersion = await resolveNodeVersion();
  const openclawPackagesDir = join(fullOfflineRoot, 'packages', 'openclaw');
  const expectedTgzName = `openclaw-${resolvedOpenclawVersion}.tgz`;
  const expectedTgzPath = join(openclawPackagesDir, expectedTgzName);
  const existingOpenclawEntry = existingOfflineManifest?.files?.find((item) => item.path === `packages/openclaw/${expectedTgzName}`);
  const openclawTgzIsReusable = fileMatchesSha256(expectedTgzPath, existingOpenclawEntry?.sha256)
    && isValidatedFile(expectedTgzPath, (filePath) =>
      validateOpenClawPackage(filePath, resolvedOpenclawVersion, `OpenClaw npm tgz (${expectedTgzName})`),
    );
  if (!openclawTgzIsReusable) {
    packOpenClawPackage(openclawPackagesDir, resolvedOpenclawVersion);
  }
  if (!existsSync(expectedTgzPath)) {
    throw new Error(`openclaw npm tgz not found after npm pack: ${expectedTgzName}`);
  }
  const tgzName = expectedTgzName;
  copyFileSync(
    join(fullOfflineRoot, 'packages', 'openclaw', tgzName),
    join(mirrorRoot, 'mirrors', 'openclaw', 'packages', tgzName),
  );

  const nodePlatform = resolveNodePlatform();
  const nodeArch = resolveNodeArch();
  const nodeArchiveExt = nodePlatform === 'win' ? 'zip' : 'tar.gz';
  const nodeArchiveName = `node-v${nodeVersion}-${nodePlatform}-${nodeArch}.${nodeArchiveExt}`;
  const nodeUrl = `https://npmmirror.com/mirrors/node/v${nodeVersion}/${nodeArchiveName}`;
  const nodePackagesDir = join(fullOfflineRoot, 'packages', 'node');
  const nodeArchivePath = join(nodePackagesDir, nodeArchiveName);
  const existingNodeEntry = existingOfflineManifest?.files?.find((item) => item.path === `packages/node/${nodeArchiveName}`);
  const nodeArchiveIsReusable = fileMatchesSha256(nodeArchivePath, existingNodeEntry?.sha256)
    && isValidatedFile(nodeArchivePath, (filePath) => validateNodeArchive(filePath, `Node 离线包 (${nodeArchiveName})`));
  if (!nodeArchiveIsReusable) {
    removeSiblingFiles(nodePackagesDir, (entry) => entry.endsWith('.tar.gz') || entry.endsWith('.zip'), nodeArchiveName);
    await downloadFile(nodeUrl, nodeArchivePath, (filePath) => validateNodeArchive(filePath, `Node 离线包 (${nodeArchiveName})`));
  }

  const gumAssets = [
    `gum_${gumVersion}_Darwin_arm64.tar.gz`,
    `gum_${gumVersion}_Darwin_x86_64.tar.gz`,
    `gum_${gumVersion}_Linux_arm64.tar.gz`,
    `gum_${gumVersion}_Linux_x86_64.tar.gz`,
    'checksums.txt',
  ];
  const downloadedGumAssets = [];
  for (const asset of gumAssets) {
    const assetUrl = `https://github.com/charmbracelet/gum/releases/download/v${gumVersion}/${asset}`;
    const targetPath = join(mirrorRoot, 'mirrors', 'gum', `v${gumVersion}`, asset);
    try {
      if (!existsSync(targetPath)) {
        await downloadFile(assetUrl, targetPath);
      }
      downloadedGumAssets.push(asset);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(sanitizeWarning(`gum asset skipped: ${asset}; ${detail}`));
    }
  }

  const offlineEntries = [
    buildManifestEntry(fullOfflineRoot, installCnOfflinePath, installCnMirrorUrl),
    buildManifestEntry(fullOfflineRoot, installScriptOfflinePath, installScriptMirrorUrl),
    buildManifestEntry(fullOfflineRoot, join(fullOfflineRoot, 'packages', 'openclaw', tgzName), `https://registry.npmmirror.com/openclaw/-/${tgzName}`),
    buildManifestEntry(fullOfflineRoot, nodeArchivePath, nodeUrl),
  ];

  const mirrorEntries = [
    buildManifestEntry(mirrorRoot, installCnMirrorPath, installCnMirrorUrl),
    buildManifestEntry(mirrorRoot, installScriptMirrorPath, installScriptMirrorUrl),
    buildManifestEntry(mirrorRoot, join(mirrorRoot, 'mirrors', 'openclaw', 'packages', tgzName), `${mirrorBaseUrl}/mirrors/openclaw/packages/${tgzName}`),
    ...downloadedGumAssets.map((asset) =>
      buildManifestEntry(
        mirrorRoot,
        join(mirrorRoot, 'mirrors', 'gum', `v${gumVersion}`, asset),
        `${mirrorBaseUrl}/mirrors/gum/v${gumVersion}/${asset}`,
      ),
    ),
  ];

  writeFileSync(
    join(fullOfflineRoot, 'manifests', 'full-offline-materials.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        openclawVersion: resolvedOpenclawVersion,
        nodeVersion,
        nodeVersionInput,
        nodeMinVersion,
        mirrorBaseUrl,
        warnings,
        files: offlineEntries,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(mirrorRoot, 'manifests', 'openclaw-mirror-manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        openclawVersion: resolvedOpenclawVersion,
        gumVersion,
        mirrorBaseUrl,
        warnings,
        files: mirrorEntries,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputRoot,
        fullOfflineMaterials: fullOfflineRoot,
        mirrorAssets: mirrorRoot,
        openclawVersion: resolvedOpenclawVersion,
        nodeVersion,
        nodeVersionInput,
        nodeMinVersion,
        nodeArchiveName,
        openclawPackage: tgzName,
        warnings,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});