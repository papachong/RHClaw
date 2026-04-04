#!/usr/bin/env node
import { createHash, createVerify } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const manifestPath = resolve(cwd, args.manifest || 'release/release-manifest.json');
const compatibilityPath = resolve(cwd, args.compatibility || 'release/compatibility-matrix.json');
const rollbackPath = resolve(cwd, args.rollback || 'release/rollback-validation.json');
const reportPath = resolve(cwd, args.report || 'release/release-validation-report.json');
const manifestPublicKey = (process.env.RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY || '').trim();
const manifestPublicKeyPath = (process.env.RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH || '').trim();

function sha256File(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

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

function buildCanonicalManifestPayload(manifest) {
  const {
    manifestSha256: _manifestSha256,
    manifestSignature: _manifestSignature,
    signatureAlgorithm: _signatureAlgorithm,
    ...core
  } = manifest;

  return JSON.stringify(core, null, 2);
}

const errors = [];
const warnings = [];

const defaultCompatibilityMatrix = {
  channels: ['stable'],
  platforms: [
    { platform: 'darwin', architectures: [
      { arch: 'aarch64', bundleTargets: ['dmg', 'app.tar.gz'], installMethod: 'dmg', rollbackSupported: true },
      { arch: 'x86_64', bundleTargets: ['dmg', 'app.tar.gz'], installMethod: 'dmg', rollbackSupported: true },
    ] },
    { platform: 'windows', architectures: [
      { arch: 'x86_64', bundleTargets: ['msi', 'nsis'], installMethod: 'nsis', rollbackSupported: true },
    ] },
  ],
};
const defaultRollbackValidation = { scenarios: [] };

if (!existsSync(manifestPath)) {
  errors.push(`缺少 Release Manifest：${relative(cwd, manifestPath)}`);
}

const hasCompatibility = existsSync(compatibilityPath);
if (!hasCompatibility) {
  warnings.push(`缺少兼容矩阵：${relative(cwd, compatibilityPath)}，使用默认值`);
}

const hasRollback = existsSync(rollbackPath);
if (!hasRollback) {
  warnings.push(`缺少回滚验证清单：${relative(cwd, rollbackPath)}，使用默认值`);
}

if (errors.length > 0) {
  console.log(JSON.stringify({ ok: false, errors, warnings }, null, 2));
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const compatibility = hasCompatibility
  ? JSON.parse(readFileSync(compatibilityPath, 'utf8'))
  : defaultCompatibilityMatrix;
const rollback = hasRollback
  ? JSON.parse(readFileSync(rollbackPath, 'utf8'))
  : defaultRollbackValidation;

const compatibilityTargets = (compatibility.platforms || []).flatMap((platform) =>
  (platform.architectures || []).flatMap((architecture) =>
    (architecture.bundleTargets || []).map((bundleTarget) => ({
      platform: platform.platform,
      arch: architecture.arch,
      installerType: bundleTarget,
      rollbackSupported: architecture.rollbackSupported,
      installMethod: architecture.installMethod,
    })),
  ),
);

const artifactMatrix = compatibilityTargets.map((target) => ({
  ...target,
  present: false,
  filePath: null,
  fileSize: null,
}));

if (!Array.isArray(manifest.items)) {
  errors.push('Release Manifest.items 必须为数组。');
}
if (!Array.isArray(compatibility.platforms)) {
  errors.push('兼容矩阵 platforms 必须为数组。');
}
if (!Array.isArray(rollback.scenarios)) {
  errors.push('回滚验证 scenarios 必须为数组。');
}
if (manifest.channel && Array.isArray(compatibility.channels) && compatibility.channels.length > 0 && !compatibility.channels.includes(manifest.channel)) {
  errors.push(`Manifest channel=${manifest.channel} 未在兼容矩阵 channels 中声明。`);
}

if (!manifest.coverage || typeof manifest.coverage !== 'object') {
  errors.push('Release Manifest 缺少 coverage 信息。');
}

if (!Array.isArray(manifest.requiredArtifacts)) {
  errors.push('Release Manifest.requiredArtifacts 必须为数组。');
}

const canonicalManifestPayload = buildCanonicalManifestPayload(manifest);
const calculatedManifestSha256 = createHash('sha256').update(canonicalManifestPayload).digest('hex');
if (manifest.manifestSha256 !== calculatedManifestSha256) {
  errors.push('Release Manifest manifestSha256 不匹配。');
}

const manifestVerifierKey = readOptionalPemValue(manifestPublicKey, manifestPublicKeyPath);
if (manifest.manifestSignature) {
  if (!manifestVerifierKey) {
    warnings.push('Manifest 含签名，但当前未提供公钥，无法执行签名校验。');
  } else {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(canonicalManifestPayload);
    verifier.end();
    const verified = verifier.verify(manifestVerifierKey, manifest.manifestSignature, 'base64');
    if (!verified) {
      errors.push('Release Manifest 签名校验失败。');
    }
  }
} else {
  warnings.push('Release Manifest 当前未附带签名。');
}

for (const item of manifest.items || []) {
  const requiredFields = ['version', 'platform', 'arch', 'installerType', 'filePath', 'sha256'];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`Release Manifest 项缺少字段 ${field}`);
    }
  }

  const absoluteFilePath = resolve(cwd, item.filePath);
  const artifactSummary = artifactMatrix.find(
    (target) => target.platform === item.platform && target.arch === item.arch && target.installerType === item.installerType,
  );
  if (!existsSync(absoluteFilePath)) {
    warnings.push(`安装包文件不存在：${item.filePath}`);
    continue;
  }

  const stats = statSync(absoluteFilePath);
  if (!stats.isFile()) {
    errors.push(`安装包路径不是文件：${item.filePath}`);
    continue;
  }

  if (artifactSummary) {
    artifactSummary.present = true;
    artifactSummary.filePath = item.filePath;
    artifactSummary.fileSize = stats.size;
  }

  const resolvedSha256 = sha256File(absoluteFilePath);
  if (resolvedSha256 !== item.sha256) {
    errors.push(`SHA256 不匹配：${item.filePath}`);
  }
}

for (const target of compatibilityTargets) {
  const manifestRequiredArtifact = (manifest.requiredArtifacts || []).find(
    (item) => item.platform === target.platform && item.arch === target.arch && item.installerType === target.installerType,
  );
  if (!manifestRequiredArtifact) {
    errors.push(`Manifest.requiredArtifacts 缺少 ${target.platform}/${target.arch}/${target.installerType}`);
  }
}

for (const scenario of rollback.scenarios || []) {
  if (!scenario.id || !scenario.platform || !scenario.arch || !scenario.installerType) {
    errors.push('回滚验证场景缺少关键字段。');
    continue;
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length < 3) {
    errors.push(`回滚验证场景 ${scenario.id} 至少需要 3 个步骤。`);
  }

  const matchedItem = (manifest.items || []).find(
    (item) => item.platform === scenario.platform && item.arch === scenario.arch && item.installerType === scenario.installerType,
  );
  if (!matchedItem) {
    warnings.push(`场景 ${scenario.id} 当前未找到对应安装包产物。`);
  }

  const matchedCompatibility = compatibilityTargets.find(
    (item) => item.platform === scenario.platform && item.arch === scenario.arch && item.installerType === scenario.installerType,
  );
  if (!matchedCompatibility) {
    errors.push(`回滚场景 ${scenario.id} 未在兼容矩阵中声明。`);
  } else if (matchedCompatibility.rollbackSupported !== true) {
    errors.push(`回滚场景 ${scenario.id} 对应兼容矩阵项未开启 rollbackSupported。`);
  }
}

for (const platform of compatibility.platforms || []) {
  for (const architecture of platform.architectures || []) {
    for (const bundleTarget of architecture.bundleTargets || []) {
      const matchedItem = (manifest.items || []).find(
        (item) => item.platform === platform.platform && item.arch === architecture.arch && item.installerType === bundleTarget,
      );
      if (!matchedItem) {
        warnings.push(`兼容矩阵声明了 ${platform.platform}/${architecture.arch}/${bundleTarget}，但 Manifest 中尚无产物。`);
      }
    }
  }
}

const result = {
  ok: errors.length === 0,
  manifestPath: relative(cwd, manifestPath),
  reportPath: relative(cwd, reportPath),
  verifiedArtifacts: (manifest.items || []).length,
  requiredArtifacts: compatibilityTargets.length,
  coverage: manifest.coverage || null,
  artifactMatrix,
  rollbackScenarios: (rollback.scenarios || []).length,
  errors,
  warnings,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) {
  process.exit(1);
}
