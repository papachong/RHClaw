param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('before', 'after-upgrade', 'after-rollback')]
  [string]$Stage,

  [string]$EvidenceDir,
  [string]$DataDir,
  [string]$AppPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($EvidenceDir)) {
  $EvidenceDir = Join-Path $env:USERPROFILE 'Desktop\rhclaw-desktop-rollback-evidence\windows'
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $env:LOCALAPPDATA 'RHOpenClaw'
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path $env:LOCALAPPDATA 'Programs\RHOpenClaw Desktop\RHOpenClaw Desktop.exe'
}

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Write-FailureJson {
  param(
    [string]$OutputPath,
    [string]$Command,
    [string]$Message
  )

  @{
    ok = $false
    command = $Command
    note = $Message
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $OutputPath -Encoding utf8
}

if ($Stage -eq 'before' -or -not (Test-Path (Join-Path $EvidenceDir 'machine-info.txt'))) {
  @(
    '=== collected_at ==='
    (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    ''
    '=== computer_info ==='
    (Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsHardwareAbstractionLayer, OsArchitecture | Out-String)
    '=== systeminfo ==='
    (systeminfo | Out-String)
  ) | Set-Content -Path (Join-Path $EvidenceDir 'machine-info.txt') -Encoding utf8
}

$appVersion = 'missing'
$appBuild = 'missing'
if (Test-Path $AppPath) {
  $versionInfo = (Get-Item $AppPath).VersionInfo
  if ($null -ne $versionInfo) {
    $appVersion = $versionInfo.ProductVersion
    $appBuild = $versionInfo.FileVersion
  }
}

@(
  "stage=$Stage"
  "collected_at=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  "app_path=$AppPath"
  "app_version=$appVersion"
  "app_build=$appBuild"
  "data_dir=$DataDir"
) | Set-Content -Path (Join-Path $EvidenceDir "$Stage-desktop-version.txt") -Encoding utf8

if (Test-Path $DataDir) {
  Get-ChildItem $DataDir -Recurse -Force |
    Select-Object FullName, Length, LastWriteTime |
    Out-File (Join-Path $EvidenceDir "$Stage-files.txt") -Encoding utf8
} else {
  "missing data dir: $DataDir" | Set-Content -Path (Join-Path $EvidenceDir "$Stage-files.txt") -Encoding utf8
}

try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18789/health |
    Select-Object -ExpandProperty Content |
    Set-Content -Path (Join-Path $EvidenceDir "$Stage-runtime-health.json") -Encoding utf8
} catch {
  Write-FailureJson -OutputPath (Join-Path $EvidenceDir "$Stage-runtime-health.json") -Command 'Invoke-WebRequest http://127.0.0.1:18789/health' -Message $_.Exception.Message
}

try {
  openclaw gateway status --json |
    Set-Content -Path (Join-Path $EvidenceDir "$Stage-gateway-status.json") -Encoding utf8
} catch {
  Write-FailureJson -OutputPath (Join-Path $EvidenceDir "$Stage-gateway-status.json") -Command 'openclaw gateway status --json' -Message $_.Exception.Message
}

Write-Host "collected evidence for stage '$Stage' into $EvidenceDir"