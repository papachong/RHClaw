#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const installCnPath = resolve(__dirname, 'install-cn.sh');
const openclawVersionInput = args['openclaw-version'] || 'latest';
const nodeVersionInput = args['node-version'] || 'latest';
const nodeMinVersion = args['node-min-version'] || '22.16.0';
const nodePlatformInput = args.platform || args['node-platform'] || '';
const nodeArchInput = args.arch || args['node-arch'] || '';
const fullPlatformLabelInput = args['full-platform-label'] || '';
const defaultPlatformLabel = fullPlatformLabelInput
  || (nodePlatformInput === 'darwin'
    ? `macos-${nodeArchInput || 'unknown'}`
    : nodePlatformInput === 'win'
      ? `windows-${nodeArchInput || 'unknown'}`
      : `${nodePlatformInput || 'current'}-${nodeArchInput || 'current'}`);
const outputRoot = resolve(projectRoot, args.output || `release/openclaw-bootstrap/full-offline-only/${defaultPlatformLabel}`);
const buildEnv = {
  ...process.env,
  npm_config_loglevel: process.env.OPENCLAW_NPM_LOGLEVEL || process.env.npm_config_loglevel || 'error',
  NPM_CONFIG_LOGLEVEL: process.env.OPENCLAW_NPM_LOGLEVEL || process.env.NPM_CONFIG_LOGLEVEL || 'error',
};
const npmRegistryCandidates = uniqueUrls([
  args['npm-registry'],
  process.env.RHOPENCLAW_NPM_REGISTRY,
  process.env.NPM_CONFIG_REGISTRY,
  process.env.npm_config_registry,
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]);
const nodeMirrorCandidates = uniqueUrls([
  args['node-mirror'],
  process.env.RHOPENCLAW_NODE_MIRROR,
  process.env.NODEJS_ORG_MIRROR,
  process.env.NVM_NODEJS_ORG_MIRROR,
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
]);

const REQUIRED_OPENCLAW_PACKAGE_ENTRIES = [
  'package/package.json',
  'package/docs/reference/templates/AGENTS.md',
];

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function uniqueUrls(items) {
  return [...new Set(items.map(normalizeUrl).filter(Boolean))];
}

function buildIsolatedNpmEnv(extra = {}) {
  const nextEnv = { ...buildEnv };
  for (const key of Object.keys(nextEnv)) {
    const lower = key.toLowerCase();
    if (
      lower === 'npm_config_registry'
      || lower === 'npm_config_userconfig'
      || lower === 'npm_config_globalconfig'
      || lower.startsWith('npm_config_//')
      || lower.endsWith(':_authtoken')
      || lower === 'npm_config__auth'
    ) {
      delete nextEnv[key];
    }
  }

  const npmConfigDir = mkdtempSync(join(os.tmpdir(), 'rhopenclaw-full-offline-npmrc-'));
  const npmrcPath = join(npmConfigDir, '.npmrc');
  writeFileSync(npmrcPath, 'audit=false\nfund=false\nupdate-notifier=false\n', 'utf8');

  return {
    ...nextEnv,
    npm_config_userconfig: npmrcPath,
    NPM_CONFIG_USERCONFIG: npmrcPath,
    ...extra,
  };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyExecutable(sourcePath, targetPath) {
  const content = readFileSync(sourcePath, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  writeFileSync(targetPath, content, 'utf8');
  chmodSync(targetPath, 0o755);
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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function runWithRegistryCandidates(commandBuilder, label) {
  const failures = [];

  for (const registry of npmRegistryCandidates) {
    try {
      console.log(`[DEBUG] Trying ${label} from registry: ${registry}`);
      const result = commandBuilder(registry);
      console.log(`[DEBUG] SUCCESS from ${registry}: ${result}`);
      return {
        registry,
        result,
      };
    } catch (error) {
      const detail = formatError(error);
      console.warn(`[WARN] Failed to ${label} from ${registry}: ${detail}`);
      failures.push(`${registry}: ${detail}`);
    }
  }

  throw new Error(`${label} failed for all registries:\n${failures.map(f => `  - ${f}`).join('\n')}`);
}

async function downloadFromUrlCandidates(urls, outputPath, validator, label) {
  const failures = [];

  for (const url of uniqueUrls(urls)) {
    try {
      await downloadFile(url, outputPath, validator);
      return url;
    } catch (error) {
      failures.push(`${url}: ${formatError(error)}`);
    }
  }

  throw new Error(`${label} failed for all sources: ${failures.join(' | ')}`);
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

function readPackageJsonFromTgz(filePath, label) {
  validateTarArchive(filePath, label);
  validateTarEntriesExist(filePath, ['package/package.json'], label);

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

  try {
    return JSON.parse(packageJsonRaw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} package.json 解析失败: ${detail}`);
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

function resolvePackageVersion() {
  const { registry, result } = runWithRegistryCandidates(
    (candidateRegistry) => run('npm', [
      '--silent',
      'view',
      `openclaw@${openclawVersionInput}`,
      'version',
      '--registry',
      candidateRegistry,
    ]),
    `resolve openclaw@${openclawVersionInput} version`,
  );

  return {
    version: normalizeVersion(result),
    registry,
  };
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
  const sources = nodeMirrorCandidates.map((baseUrl) => `${baseUrl}/index.json`);

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

function getFullPlatformLabel(nodePlatform, nodeArch) {
  if (fullPlatformLabelInput) return fullPlatformLabelInput;
  const platformLabel = nodePlatform === 'darwin' ? 'macos' : nodePlatform === 'win' ? 'windows' : nodePlatform;
  return `${platformLabel}-${nodeArch}`;
}

function buildManifestFileEntry(path) {
  return {
    path,
    size: statSync(join(outputRoot, path)).size,
    sha256: sha256File(join(outputRoot, path)),
  };
}

function buildReadme({ openclawPackageName, nodeArchiveName, channelPackageName, platformLabel, openclawVersion, nodeVersion, channelVersion }) {
  return [
    'RHOpenClaw Full Offline Materials',
    '',
    'Marker: FULL-OFFLINE-ONLY',
    '',
    'Purpose:',
    '- This directory is reserved for the full-offline packaging option.',
    '- It contains an OpenClaw package with production dependencies pre-bundled.',
    '- It must not be used by the normal lightweight packaging flow.',
    '',
    'Metadata:',
    `- platform: ${platformLabel}`,
    `- openclawVersion: ${openclawVersion}`,
    `- nodeVersion: ${nodeVersion}`,
    `- channelVersion: ${channelVersion}`,
    '',
    'Contents:',
    `- packages/openclaw/${openclawPackageName}`,
    `- packages/node/${nodeArchiveName}`,
    `- packages/rhclaw-channel/${channelPackageName}`,
    '- openclaw/install-cn.sh',
    '- openclaw/install.sh',
    '- manifests/full-offline-materials.json',
    '',
  ].join('\n');
}

/**
 * Resolve the platform-specific filename for @matrix-org/matrix-sdk-crypto-nodejs native binary.
 * Returns null if the platform/arch combo is unsupported (skip download gracefully).
 */
function resolveMatrixCryptoNodeBinaryName(nodePlatform, nodeArch) {
  if (nodePlatform === 'win') {
    if (nodeArch === 'x64') return 'matrix-sdk-crypto.win32-x64-msvc.node';
    if (nodeArch === 'arm64') return 'matrix-sdk-crypto.win32-arm64-msvc.node';
    if (nodeArch === 'ia32') return 'matrix-sdk-crypto.win32-ia32-msvc.node';
  } else if (nodePlatform === 'darwin') {
    if (nodeArch === 'x64') return 'matrix-sdk-crypto.darwin-x64.node';
    if (nodeArch === 'arm64') return 'matrix-sdk-crypto.darwin-arm64.node';
  } else if (nodePlatform === 'linux') {
    if (nodeArch === 'x64') return 'matrix-sdk-crypto.linux-x64-gnu.node';
    if (nodeArch === 'arm64') return 'matrix-sdk-crypto.linux-arm64-gnu.node';
    if (nodeArch === 'arm') return 'matrix-sdk-crypto.linux-arm-gnueabihf.node';
  }
  return null;
}

/**
 * Remove files from the packed package tree that are not needed at runtime.
 * Targets (by uncompressed size in the tgz):
 *   .d.ts       ~69 MB  – TypeScript declarations, IDE only
 *   .map        ~33 MB  – source maps, IDE/debug only
 *   .ts/.mts    ~20 MB  – TypeScript source, not executed by Node.js here
 *   /docs/      ~18 MB  – package documentation dirs
 *   /test(s)/   ~3 MB   – test fixtures and examples
 *   CHANGELOG*  ~4 MB   – changelogs
 *
 * Safe to remove: these are never required() at runtime by any Node.js code.
 */
function pruneRuntimePackageTree(rootDir) {
  if (!existsSync(rootDir)) return;

  let removedFiles = 0;
  let removedBytes = 0;
  const rootDocsDir = join(rootDir, 'docs');
  const prunableDirNames = new Set([
    'docs',
    'test',
    'tests',
    '__tests__',
    'example',
    'examples',
    '.github',
    '.vscode',
    'coverage',
    '.nyc_output',
  ]);

  function removePath(targetPath, sizeBytes) {
    rmSync(targetPath, { recursive: true, force: true });
    removedFiles += 1;
    removedBytes += sizeBytes;
  }

  function isDependencyReadme(fileName, fullPath) {
    if (!/^readme(\.|$)/i.test(fileName)) return false;
    return fullPath.includes(`${pathSep()}node_modules${pathSep()}`);
  }

  function pathSep() {
    return process.platform === 'win32' ? '\\' : '/';
  }

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (prunableDirNames.has(entry.name)) {
          if (fullPath === rootDocsDir) {
            // OpenClaw runtime会读取 docs/reference/templates 下的模板文件。
            walk(fullPath);
            continue;
          }
          try {
            const sz = dirSizeSync(fullPath);
            removePath(fullPath, sz);
          } catch { /* ignore */ }
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const name = entry.name;
        const shouldRemove =
          name.endsWith('.d.ts') ||
          name.endsWith('.d.ts.map') ||
          name.endsWith('.map') ||
          name.endsWith('.ts') ||
          name.endsWith('.mts') ||
          name.endsWith('.cts') ||
          name.endsWith('.tsx') ||
          name === 'CHANGELOG.md' || name === 'CHANGELOG' ||
          name === 'CHANGELOG.txt' || name === 'HISTORY.md' ||
          name === 'HISTORY' || name === 'HISTORY.txt' ||
          isDependencyReadme(name, fullPath);
        if (shouldRemove) {
          try {
            const sz = statSync(fullPath).size;
            removePath(fullPath, sz);
          } catch { /* ignore */ }
        }
      }
    }
  }

  function dirSizeSync(dir) {
    let total = 0;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) total += dirSizeSync(p);
        else if (entry.isFile()) try { total += statSync(p).size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return total;
  }

  walk(rootDir);
  console.log(`  [prune] removed ${removedFiles} files, saved ${(removedBytes / 1024 / 1024).toFixed(1)} MB (uncompressed); preserved root docs templates`);
}

async function buildOpenClawWithDeps(openclawVersion, destinationDir, npmRegistry) {
  const tempRoot = mkdtempSync(join(os.tmpdir(), 'rhopenclaw-full-offline-'));
  const archiveName = `openclaw-${openclawVersion}-with-deps.tgz`;
  const outputPath = join(destinationDir, archiveName);
  const packedName = `openclaw-${openclawVersion}.tgz`;
  const isolatedNpmEnv = buildIsolatedNpmEnv();

  try {
    run('npm', [
      '--silent',
      'pack',
      `openclaw@${openclawVersion}`,
      '--pack-destination',
      tempRoot,
      '--registry',
      npmRegistry,
    ]);

    execFileSync('tar', ['-xzf', join(tempRoot, packedName), '-C', tempRoot], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    const packageDir = join(tempRoot, 'package');
    execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--registry', npmRegistry], {
      cwd: packageDir,
      stdio: 'inherit',
      env: isolatedNpmEnv,
      shell: process.platform === 'win32',
    });

    const packageJsonPath = join(packageDir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    // Download platform-specific @matrix-org/matrix-sdk-crypto-nodejs native binary.
    // The package's postinstall (download-lib.js) tries to fetch this from GitHub at
    // runtime, which fails in offline environments. We pre-bundle it here so that
    // npm install --ignore-scripts works and the .node file is already present.
    const cryptoNodejsPkgDir = join(packageDir, 'node_modules', '@matrix-org', 'matrix-sdk-crypto-nodejs');
    if (existsSync(cryptoNodejsPkgDir)) {
      const cryptoPkgJson = JSON.parse(readFileSync(join(cryptoNodejsPkgDir, 'package.json'), 'utf8'));
      const cryptoVersion = cryptoPkgJson.version;
      const nodeBinaryName = resolveMatrixCryptoNodeBinaryName(resolveNodePlatform(), resolveNodeArch());
      if (nodeBinaryName) {
        const binaryOutputPath = join(cryptoNodejsPkgDir, nodeBinaryName);
        if (!existsSync(binaryOutputPath)) {
          const downloadUrl = `https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v${cryptoVersion}/${nodeBinaryName}`;
          console.log(`Downloading matrix-sdk-crypto-nodejs native binary: ${nodeBinaryName} (v${cryptoVersion})`);
          await downloadFile(downloadUrl, binaryOutputPath, (filePath) => {
            const size = statSync(filePath).size;
            if (size < 100 * 1024) {
              throw new Error(`matrix-sdk-crypto-nodejs binary seems too small (${size} bytes): ${filePath}`);
            }
          });
          console.log(`  -> bundled: ${nodeBinaryName}`);
        } else {
          console.log(`  -> matrix-sdk-crypto-nodejs binary already present: ${nodeBinaryName}`);
        }
      } else {
        console.warn(`  [WARN] No known matrix-sdk-crypto-nodejs binary for platform=${resolveNodePlatform()} arch=${resolveNodeArch()}, skipping.`);
      }
    }

    // Collect ALL installed packages in node_modules so that peer dependencies
    // (e.g. @napi-rs/canvas) and their hoisted platform-specific binaries
    // (e.g. @napi-rs/canvas-darwin-x64) are included in the bundled tgz.
    const nodeModulesDir = join(packageDir, 'node_modules');
    const installedPackageNames = [];
    for (const entry of readdirSync(nodeModulesDir)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        const scopeDir = join(nodeModulesDir, entry);
        for (const scopedEntry of readdirSync(scopeDir)) {
          if (!scopedEntry.startsWith('.')) {
            installedPackageNames.push(`${entry}/${scopedEntry}`);
          }
        }
      } else {
        installedPackageNames.push(entry);
      }
    }
    const bundledDependencyNames = [...new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {}),
      ...Object.keys(packageJson.peerDependencies || {}),
      ...installedPackageNames,
    ])].sort((left, right) => left.localeCompare(right));
    packageJson.bundleDependencies = bundledDependencyNames;
    packageJson.bundledDependencies = bundledDependencyNames;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

    // Prune runtime-unnecessary files to reduce tgz size and speed up npm install.
    // .d.ts (~69MB), .js.map (~27MB), /docs/ (~18MB) are pure dev/IDE artifacts.
    pruneRuntimePackageTree(packageDir);

    rmSync(outputPath, { force: true });
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', tempRoot], {
      cwd: packageDir,
      stdio: 'inherit',
      env: isolatedNpmEnv,
      shell: process.platform === 'win32',
    });
    const repackedPath = join(tempRoot, packedName);
    if (!existsSync(repackedPath)) {
      throw new Error(`with-deps npm pack 未生成 tgz 文件: ${packedName}`);
    }
    renameSync(repackedPath, outputPath);

    validateOpenClawPackage(outputPath, openclawVersion, `OpenClaw full-offline tgz (${archiveName})`);

    return archiveName;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function buildChannelPackage(destinationDir) {
  const explicitChannelPackagePath = args['channel-package-path'] || process.env.RHOPENCLAW_CHANNEL_PACKAGE_PATH || '';
  if (explicitChannelPackagePath) {
    const resolvedPackagePath = resolve(projectRoot, explicitChannelPackagePath);
    if (!existsSync(resolvedPackagePath)) {
      throw new Error(`RHClaw-Channel 预打包 tgz 不存在: ${resolvedPackagePath}`);
    }

    const packageName = basename(resolvedPackagePath);
    if (!packageName.endsWith('.tgz')) {
      throw new Error(`RHClaw-Channel 预打包文件必须是 .tgz: ${resolvedPackagePath}`);
    }

    const packageJson = readPackageJsonFromTgz(resolvedPackagePath, `RHClaw-Channel tgz (${packageName})`);
    const channelVersion = String(packageJson?.version || '').trim();
    if (!channelVersion) {
      throw new Error(`RHClaw-Channel 预打包 tgz 未声明 version: ${resolvedPackagePath}`);
    }

    removeSiblingFiles(destinationDir, (entry) => entry.endsWith('.tgz'), packageName);
    copyFileSync(resolvedPackagePath, join(destinationDir, packageName));
    return { packageName, channelVersion };
  }

  const explicitChannelRoot = args['channel-root'] || process.env.RHOPENCLAW_CHANNEL_ROOT || '';
  if (!explicitChannelRoot) {
    throw new Error('未提供 RHClaw-Channel 输入。请设置 RHOPENCLAW_CHANNEL_ROOT，或直接提供 RHOPENCLAW_CHANNEL_PACKAGE_PATH 指向预打包 tgz。');
  }

  const channelRoot = resolve(projectRoot, explicitChannelRoot);
  const packageJsonPath = join(channelRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`RHClaw-Channel 源码目录不存在: ${channelRoot}。请设置 RHOPENCLAW_CHANNEL_ROOT，或直接提供 RHOPENCLAW_CHANNEL_PACKAGE_PATH 指向预打包 tgz。`);
  }

  const channelVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  removeSiblingFiles(destinationDir, (entry) => entry.endsWith('.tgz'), '');
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
    cwd: channelRoot,
    stdio: 'inherit',
    env: buildEnv,
    shell: process.platform === 'win32',
  });
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destinationDir], {
    cwd: channelRoot,
    stdio: 'inherit',
    env: buildEnv,
    shell: process.platform === 'win32',
  });

  const packageName = readdirSync(destinationDir).find((entry) => entry.endsWith('.tgz'));
  if (!packageName) {
    throw new Error('RHClaw-Channel npm pack 未生成 tgz 文件');
  }

  return { packageName, channelVersion };
}

async function main() {
  const openclawDir = join(outputRoot, 'openclaw');
  const openclawPackagesDir = join(outputRoot, 'packages', 'openclaw');
  const nodePackagesDir = join(outputRoot, 'packages', 'node');
  const channelPackagesDir = join(outputRoot, 'packages', 'rhclaw-channel');
  const manifestsDir = join(outputRoot, 'manifests');

  ensureDir(openclawDir);
  ensureDir(openclawPackagesDir);
  ensureDir(nodePackagesDir);
  ensureDir(channelPackagesDir);
  ensureDir(manifestsDir);

  const nodePlatform = resolveNodePlatform();
  const nodeArch = resolveNodeArch();
  const platformLabel = getFullPlatformLabel(nodePlatform, nodeArch);
  const { version: resolvedOpenclawVersion, registry: openclawRegistry } = resolvePackageVersion();
  const nodeVersion = await resolveNodeVersion();

  const installCnTarget = join(openclawDir, 'install-cn.sh');
  const installTarget = join(openclawDir, 'install.sh');
  copyExecutable(installCnPath, installCnTarget);
  copyExecutable(installCnPath, installTarget);

  removeSiblingFiles(openclawPackagesDir, (entry) => entry.endsWith('.tgz'), '');
  const openclawPackageName = await buildOpenClawWithDeps(resolvedOpenclawVersion, openclawPackagesDir, openclawRegistry);

  const nodeArchiveExt = nodePlatform === 'win' ? 'zip' : 'tar.gz';
  const nodeArchiveName = `node-v${nodeVersion}-${nodePlatform}-${nodeArch}.${nodeArchiveExt}`;
  const nodeArchivePath = join(nodePackagesDir, nodeArchiveName);
  removeSiblingFiles(nodePackagesDir, (entry) => entry.endsWith('.tar.gz') || entry.endsWith('.zip'), nodeArchiveName);
  const nodeSourceUrl = await downloadFromUrlCandidates(
    nodeMirrorCandidates.map((baseUrl) => `${baseUrl}/v${nodeVersion}/${nodeArchiveName}`),
    nodeArchivePath,
    (filePath) => validateNodeArchive(filePath, `Node full-offline 包 (${nodeArchiveName})`),
  );

  removeSiblingFiles(channelPackagesDir, (entry) => entry.endsWith('.tgz'), '');
  const { packageName: channelPackageName, channelVersion } = buildChannelPackage(channelPackagesDir);

  const manifest = {
    marker: 'FULL-OFFLINE-ONLY',
    generatedAt: new Date().toISOString(),
    platform: platformLabel,
    openclawVersion: resolvedOpenclawVersion,
    nodeVersion,
    channelVersion,
    description: 'Full offline materials bundle for packaging flows that must avoid external dependency installation.',
    files: [
      'README_FULL_OFFLINE_ONLY.txt',
      'openclaw/install-cn.sh',
      'openclaw/install.sh',
      `packages/openclaw/${openclawPackageName}`,
      `packages/node/${nodeArchiveName}`,
      `packages/rhclaw-channel/${channelPackageName}`,
    ],
    fileDetails: [
      buildManifestFileEntry('openclaw/install-cn.sh'),
      buildManifestFileEntry('openclaw/install.sh'),
      buildManifestFileEntry(`packages/openclaw/${openclawPackageName}`),
      buildManifestFileEntry(`packages/node/${nodeArchiveName}`),
      buildManifestFileEntry(`packages/rhclaw-channel/${channelPackageName}`),
    ],
    sources: {
      openclawRegistry,
      nodeArchive: nodeSourceUrl,
    },
  };

  writeFileSync(join(manifestsDir, 'full-offline-materials.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(outputRoot, 'README_FULL_OFFLINE_ONLY.txt'),
    `${buildReadme({
      openclawPackageName,
      nodeArchiveName,
      channelPackageName,
      platformLabel,
      openclawVersion: resolvedOpenclawVersion,
      nodeVersion,
      channelVersion,
    })}`,
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputRoot,
        platform: platformLabel,
        openclawVersion: resolvedOpenclawVersion,
        nodeVersion,
        channelVersion,
        openclawPackage: openclawPackageName,
        nodeArchiveName,
        channelPackage: channelPackageName,
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