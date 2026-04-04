param(
  [Parameter(Mandatory = $true)]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$ArchLabel
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,

    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code: $LASTEXITCODE)"
  }
}

  function Test-NpmPackageInstalled {
    param(
      [Parameter(Mandatory = $true)]
      [string]$PackageName
    )

    $result = & npm ls $PackageName --depth=0 --silent 2>$null
    return $LASTEXITCODE -eq 0
  }

function Get-FullOfflineManifestFilePath {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$Manifest,

    [Parameter(Mandatory = $true)]
    [string]$RequiredPrefix,

    [Parameter(Mandatory = $false)]
    [string]$ContainsText = ''
  )

  $matches = @(
    $Manifest.files | Where-Object {
      $_ -is [string] -and
      $_.StartsWith($RequiredPrefix) -and
      ([string]::IsNullOrEmpty($ContainsText) -or $_.Contains($ContainsText))
    }
  )

  if ($matches.Count -ne 1) {
    throw "[ERROR] full-offline manifest 条目匹配失败: prefix=$RequiredPrefix, contains=$ContainsText, matches=$($matches.Count)"
  }

  return $matches[0]
}

function Restore-NonTargetFullOfflineDirectories {
  if (-not $script:FullOfflineIsolationDir -or -not (Test-Path $script:FullOfflineIsolationDir) -or -not $script:FullOfflineIsolationRoot -or -not (Test-Path $script:FullOfflineIsolationRoot)) {
    return
  }

  try {
    Get-ChildItem $script:FullOfflineIsolationDir -Force | ForEach-Object {
      Move-Item $_.FullName $script:FullOfflineIsolationRoot -Force
    }
  } finally {
    Remove-Item $script:FullOfflineIsolationDir -Recurse -Force -ErrorAction SilentlyContinue
    $script:FullOfflineIsolationDir = $null
    $script:FullOfflineIsolationRoot = $null
  }
}

function Isolate-NonTargetFullOfflineDirectories {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir,

    [Parameter(Mandatory = $true)]
    [string]$OfflineRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPlatform
  )

  $fullOfflineBase = Join-Path $RootDir "$OfflineRoot/full-offline-only"
  if (-not (Test-Path $fullOfflineBase)) {
    return
  }

  $script:FullOfflineIsolationRoot = $fullOfflineBase
  $script:FullOfflineIsolationDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $script:FullOfflineIsolationDir | Out-Null

  Get-ChildItem $fullOfflineBase -Force | Where-Object { $_.Name -ne $ExpectedPlatform } | ForEach-Object {
    Move-Item $_.FullName $script:FullOfflineIsolationDir -Force
  }

  Write-Host "[INFO] 已临时隔离非目标平台 full-offline 目录，仅打包 $ExpectedPlatform"
}

function Assert-FullOfflineMaterialsReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir,

    [Parameter(Mandatory = $true)]
    [string]$OfflineRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPlatform
  )

  $fullOfflineRoot = Join-Path $RootDir "$OfflineRoot/full-offline-only/$ExpectedPlatform"
  $readmePath = Join-Path $fullOfflineRoot 'README_FULL_OFFLINE_ONLY.txt'
  $fullManifestPath = Join-Path $fullOfflineRoot 'manifests/full-offline-materials.json'
  if (-not (Test-Path $readmePath)) {
    throw "[ERROR] 未找到 FULL-OFFLINE-ONLY 标记文件: $readmePath"
  }

  if (-not (Test-Path $fullManifestPath)) {
    throw "[ERROR] 未找到 FULL-OFFLINE-ONLY manifest: $fullManifestPath。请先执行 full-offline 输入物料准备脚本。"
  }

  $fullManifest = Get-Content $fullManifestPath -Raw | ConvertFrom-Json
  if ($fullManifest.platform -ne $ExpectedPlatform) {
    throw "[ERROR] FULL-OFFLINE-ONLY manifest 平台不匹配: 期望 $ExpectedPlatform，实际 $($fullManifest.platform)。请先重新生成当前平台输入物料。"
  }

  $fullOpenClawRelativePath = Get-FullOfflineManifestFilePath -Manifest $fullManifest -RequiredPrefix 'packages/openclaw/' -ContainsText '.tgz'
  $fullNodeRelativePath = Get-FullOfflineManifestFilePath -Manifest $fullManifest -RequiredPrefix 'packages/node/' -ContainsText 'win-x64'
  $fullChannelRelativePath = Get-FullOfflineManifestFilePath -Manifest $fullManifest -RequiredPrefix 'packages/rhclaw-channel/' -ContainsText '.tgz'

  $missingPaths = @(
    foreach ($relPath in $fullManifest.files) {
      $candidate = Join-Path $fullOfflineRoot $relPath
      if (-not (Test-Path $candidate)) {
        $relPath
      }
    }
  )
  if ($missingPaths.Count -gt 0) {
    throw "[ERROR] FULL-OFFLINE-ONLY manifest 引用的输入物料文件不存在，请先重新生成当前平台输入物料。缺失项: $($missingPaths -join ', ')"
  }

  Write-Host "[INFO] FULL-OFFLINE 输入物料已就绪: $fullOfflineRoot"
  Write-Host "[INFO] OpenClaw 包: $fullOpenClawRelativePath"
  Write-Host "[INFO] Node 包: $fullNodeRelativePath"
  Write-Host "[INFO] RHClaw-Channel 包: $fullChannelRelativePath"
}

function Get-InstallerArtifacts {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir
  )

  $artifacts = @()

  $msiDir = Join-Path $BundleDir 'msi'
  if (Test-Path $msiDir) {
    $artifacts += Get-ChildItem $msiDir -File | Where-Object { $_.Extension -eq '.msi' }
  }

  $nsisDir = Join-Path $BundleDir 'nsis'
  if (Test-Path $nsisDir) {
    $artifacts += Get-ChildItem $nsisDir -File | Where-Object { $_.Extension -eq '.exe' }
  }

  $artifacts | Sort-Object FullName -Unique
}

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

$bundleDir = "src-tauri/target/$Target/release/bundle"
$offlineRoot = "release/openclaw-bootstrap"
$releaseReport = "release/release-validation-report.json"
$script:FullOfflineIsolationDir = $null
$script:FullOfflineIsolationRoot = $null

if ($env:RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH -and -not (Test-Path $env:RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH)) {
  throw "[ERROR] RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH 指向的文件不存在: $($env:RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH)"
}
if ($env:RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH -and -not (Test-Path $env:RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH)) {
  throw "[ERROR] RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH 指向的文件不存在: $($env:RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH)"
}
if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH -and -not (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
  throw "[ERROR] TAURI_SIGNING_PRIVATE_KEY_PATH 指向的文件不存在: $($env:TAURI_SIGNING_PRIVATE_KEY_PATH)"
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and $env:TAURI_SIGNING_PRIVATE_KEY_PATH -and (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:TAURI_SIGNING_PRIVATE_KEY_PATH -Raw
}
if (-not (Test-Path Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw '[ERROR] npm 未安装，请先安装 Node.js (包含 npm)。'
}

if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
  throw '[ERROR] rustup 未安装，请先安装 Rust 工具链。'
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PATH -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
  Write-Host '[WARN] 未配置 Tauri updater 私钥；公开仓默认不再提供私有默认密钥路径。若当前构建需要签名，请设置 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH。'
}

try {
  if (-not (Test-Path 'node_modules')) {
    Write-Host '[INFO] 未检测到 node_modules，正在执行 npm install...'
    Invoke-Checked -Command { npm install } -FailureMessage '[ERROR] npm install 执行失败'
  }

  if (-not (Test-NpmPackageInstalled '@tauri-apps/plugin-process') -or -not (Test-NpmPackageInstalled '@tauri-apps/cli')) {
    Write-Host '[INFO] 检测到关键依赖缺失，执行 npm install 修复依赖...'
    Invoke-Checked -Command { npm install } -FailureMessage '[ERROR] 依赖修复 npm install 执行失败'
  }

  Write-Host "[INFO] 安装 Rust 目标: $Target"
  Invoke-Checked -Command { rustup target add $Target } -FailureMessage '[ERROR] rustup target add 执行失败'

  Assert-FullOfflineMaterialsReady -RootDir $rootDir -OfflineRoot $offlineRoot -ExpectedPlatform 'windows-x64'

  Write-Host '[INFO] 执行 Tauri 工具链预检...'
  Invoke-Checked -Command { npm run tauri:doctor } -FailureMessage '[ERROR] tauri:doctor 执行失败'

  Write-Host "[INFO] 开始构建 Windows $ArchLabel 安装包..."
  Isolate-NonTargetFullOfflineDirectories -RootDir $rootDir -OfflineRoot $offlineRoot -ExpectedPlatform 'windows-x64'
  Invoke-Checked -Command { npm run tauri:build -- --target $Target } -FailureMessage '[ERROR] tauri:build 执行失败'
  Restore-NonTargetFullOfflineDirectories
  Invoke-Checked -Command {
    $env:RHOPENCLAW_BUNDLE_DIR = $bundleDir
    npm run release:bundle-extras
  } -FailureMessage '[ERROR] release:bundle-extras 执行失败'
  Invoke-Checked -Command { npm run release:normalize } -FailureMessage '[ERROR] release:normalize 执行失败'
  Invoke-Checked -Command { npm run release:manifest -- --artifact-root="src-tauri/target/$Target" } -FailureMessage '[ERROR] release:manifest 执行失败'
  Invoke-Checked -Command { npm run release:verify } -FailureMessage '[ERROR] release:verify 执行失败'

  $missingCount = (Get-Content $releaseReport -Raw | ConvertFrom-Json).coverage.missingCount
  if ($missingCount -eq 0) {
    if ($env:RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH -and $env:TAURI_SIGNING_PRIVATE_KEY) {
      Invoke-Checked -Command { npm run release:gate -- --require-signature=true } -FailureMessage '[ERROR] release:gate 执行失败'
    } else {
      Invoke-Checked -Command { npm run release:gate } -FailureMessage '[ERROR] release:gate 执行失败'
    }
  } else {
    Write-Host "[INFO] 当前仅完成单平台产物构建，兼容矩阵仍缺少 $missingCount 项，跳过 release:gate。"
  }

  Write-Host "[INFO] 构建完成，产物目录: $bundleDir"
  if (Test-Path "$bundleDir/msi") {
    Write-Host '[INFO] MSI 文件:'
    Get-ChildItem "$bundleDir/msi"
  }
  if (Test-Path "$bundleDir/nsis") {
    Write-Host '[INFO] NSIS 文件:'
    Get-ChildItem "$bundleDir/nsis"
  }

  $installerArtifacts = @(Get-InstallerArtifacts -BundleDir $bundleDir)
  if ($installerArtifacts.Count -gt 0) {
    Write-Host '[INFO] 新安装包位置:'
    foreach ($artifact in $installerArtifacts) {
      Write-Host "[INFO] $($artifact.FullName)"
    }
  } else {
    Write-Host '[WARN] 未在 bundle 目录中检测到安装包文件。'
  }
} finally {
  Restore-NonTargetFullOfflineDirectories
}