Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── FULL-OFFLINE 输入物料缓存检查 ────────────────────────────────────────
# 缓存命中条件：manifest 存在 + 所有文件在磁盘上存在 + openclaw/Channel 版本与当前最新一致。
# 设置 RHOPENCLAW_FORCE_REBUILD_OFFLINE=1 可强制跳过缓存直接重建。
function Test-FullOfflineMaterialsUpToDate {
	param(
		[string]$ManifestPath,
		[string]$MaterialsRoot,
		[string]$ChannelPackageJsonPath
	)

	if (-not (Test-Path $ManifestPath)) { return $false }

	try {
		$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
	} catch {
		return $false
	}

	# 验证 manifest 标记
	if ($manifest.marker -ne 'FULL-OFFLINE-ONLY') { return $false }

	# 验证所有引用文件在磁盘上实际存在
	foreach ($relPath in $manifest.files) {
		if (-not (Test-Path (Join-Path $MaterialsRoot $relPath))) {
			Write-Host "[INFO] 缓存文件缺失: $relPath"
			return $false
		}
	}

	# 比对 Channel 版本（本地读取，无网络）
	if ($ChannelPackageJsonPath -and (Test-Path $ChannelPackageJsonPath)) {
		try {
			$localChannelVersion = (Get-Content $ChannelPackageJsonPath -Raw | ConvertFrom-Json).version
			if ($manifest.channelVersion -ne $localChannelVersion) {
				Write-Host "[INFO] Channel 版本变化: 缓存=$($manifest.channelVersion) 当前=$localChannelVersion"
				return $false
			}
		} catch {
			return $false
		}
	} elseif ($env:RHOPENCLAW_CHANNEL_PACKAGE_PATH) {
		Write-Host '[INFO] 已通过 RHOPENCLAW_CHANNEL_PACKAGE_PATH 提供预打包 Channel，跳过 package.json 版本缓存校验'
	}

	# 比对 openclaw 最新版本（npmmirror，网络失败则信任缓存）
	try {
		$latestOpenClaw = (& npm --silent view "openclaw@latest" version --registry https://registry.npmmirror.com 2>$null)
		if ($LASTEXITCODE -eq 0 -and $latestOpenClaw) {
			$latestOpenClaw = $latestOpenClaw.Trim()
			if ($manifest.openclawVersion -ne $latestOpenClaw) {
				Write-Host "[INFO] openclaw 版本变化: 缓存=$($manifest.openclawVersion) 最新=$latestOpenClaw"
				return $false
			}
		}
	} catch {
		# 网络异常，信任缓存继续
	}

	return $true
}

$fullOfflineManifest  = Join-Path $PSScriptRoot '../release/openclaw-bootstrap/full-offline-only/windows-x64/manifests/full-offline-materials.json'
$fullOfflineRoot      = Join-Path $PSScriptRoot '../release/openclaw-bootstrap/full-offline-only/windows-x64'
$channelPackageJson   = $env:RHOPENCLAW_CHANNEL_PACKAGE_JSON_PATH
if (-not $channelPackageJson -and $env:RHOPENCLAW_CHANNEL_ROOT) {
	$channelPackageJson = Join-Path $env:RHOPENCLAW_CHANNEL_ROOT 'package.json'
}
$forceRebuild         = ($env:RHOPENCLAW_FORCE_REBUILD_OFFLINE -eq '1')

if (-not $forceRebuild -and (Test-FullOfflineMaterialsUpToDate -ManifestPath $fullOfflineManifest -MaterialsRoot $fullOfflineRoot -ChannelPackageJsonPath $channelPackageJson)) {
	Write-Host '[INFO] FULL-OFFLINE 输入物料已是最新，跳过重建。（强制重建: RHOPENCLAW_FORCE_REBUILD_OFFLINE=1）'
} else {
	Write-Host '[INFO] 生成 Windows x64 FULL-OFFLINE 输入物料...'
	& node "$PSScriptRoot/build-full-offline-materials.mjs" --platform=win --arch=x64 --full-platform-label=windows-x64
	if ($LASTEXITCODE -ne 0) {
		throw "[ERROR] full-offline 输入物料生成失败 (exit code: $LASTEXITCODE)"
	}
}

& "$PSScriptRoot/package-win.ps1" -Target 'x86_64-pc-windows-msvc' -ArchLabel 'x64'