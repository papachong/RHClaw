mod desktop_trace;
mod task_center;

use flate2::read::GzDecoder;
use reqwest::{
    blocking::Client,
    header::{AUTHORIZATION, CONTENT_TYPE},
    Method,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tar::Archive as TarArchive;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_updater::UpdaterExt;

pub(crate) const OPENCLAW_DEFAULT_GATEWAY_PORT: u16 = 18789;
pub(crate) const OPENCLAW_DEFAULT_GATEWAY_BIND: &str = "loopback";
const OPENCLAW_DEFAULT_INSTALL_SCRIPT_MIRROR_URL: &str =
    "https://openclaw.ai/install.sh";
const OPENCLAW_DEFAULT_INSTALL_SCRIPT_ORIGIN_MIRROR_URL: &str =
    "https://openclaw.ai/install.sh";
const OPENCLAW_DEFAULT_NPM_REGISTRY: &str = "https://registry.npmmirror.com";
const OPENCLAW_DEFAULT_NODE_MIRROR: &str = "https://npmmirror.com/mirrors/node";
const OPENCLAW_DEFAULT_HOMEBREW_BREW_GIT_REMOTE: &str =
    "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git";
const OPENCLAW_DEFAULT_HOMEBREW_CORE_GIT_REMOTE: &str =
    "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git";
const OPENCLAW_DEFAULT_HOMEBREW_API_DOMAIN: &str =
    "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api";
const OPENCLAW_DEFAULT_HOMEBREW_BOTTLE_DOMAIN: &str =
    "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles";
const RHOPENCLAW_DEFAULT_SERVER_API_BASE_URL: &str = "http://127.0.0.1:3000/api/v1";
const RHOPENCLAW_DESKTOP_UPDATER_PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERBRTIzQTI3RkExQ0YyOTMKUldTVDhoejZKenJpMnRycm9FOG9CK0h3bW1JY0l6N1VHQytTd1BMR0orWGFvTHB3Y0RhVGQ2RHoK";
const SKILLHUB_DEFAULT_SITE_URL: &str = "https://skillhub.tencent.com/";
const SKILLHUB_DEFAULT_INSTALLER_URL: &str =
    "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh";
const SKILLHUB_DEFAULT_ARCHIVE_URL: &str =
    "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz";
const DEFAULT_DESKTOP_RECOMMENDED_SKILLS: &[&str] = &[
    "1password",
    "apple-notes",
    "apple-reminders",
    "api-gateway",
    "agent-browser",
    "akshare-finance",
    "ai-ppt-generator",
    "auto-updater",
    "automation-workflows",
    "byterover",
    "brave-search",
    "canvas",
    "clawdhub",
    "clawddocs",
    "find-skills",
    "free-ride",
    "frontend-design",
    "gmail",
    "github",
    "gog",
    "humanizer",
    "himalaya",
    "healthcheck",
    "model-usage",
    "memory-manager",
    "n8n-workflow-automation",
    "obsidian",
    "openai-whisper",
    "pdf",
    "proactive-agent",
    "session-logs",
    "self-improving",
    "skill-creator",
    "stock-analysis",
    "summarize",
    "stripe-api",
    "tmux",
    "tavily-search",
    "ui-ux-pro-max",
    "video-frames",
    "weather",
    "xurl",
    "acp-router",
    "prose",
    "feishu-doc",
    "feishu-drive",
    "feishu-wiki",
    "code",
    "edge-tts",
    "mbti",
];
const DEFAULT_WORKSPACE_MARKDOWN_TEMPLATES: &[(&str, &str)] = &[
    (
        "AGENTS.md",
        include_str!("../skills/proactive-agent/assets/AGENTS.md"),
    ),
    (
        "IDENTITY.md",
        "# IDENTITY.md - Agent Identity\n\n- Name: RHClaw Agent\n- Role: Desktop-managed OpenClaw workspace assistant\n- Default profile: coding\n- Runtime: local gateway\n- Owner: current device user\n\nUpdate this file when you want to rename the agent, change avatar conventions, or pin a long-term role description.\n",
    ),
    (
        "SOUL.md",
        include_str!("../skills/proactive-agent/assets/SOUL.md"),
    ),
    (
        "USER.md",
        include_str!("../skills/proactive-agent/assets/USER.md"),
    ),
    (
        "TOOLS.md",
        include_str!("../skills/proactive-agent/assets/TOOLS.md"),
    ),
    (
        "MEMORY.md",
        include_str!("../skills/proactive-agent/assets/MEMORY.md"),
    ),
    (
        "HEARTBEAT.md",
        include_str!("../skills/proactive-agent/assets/HEARTBEAT.md"),
    ),
    (
        "BOOT.md",
        "# BOOT.md - Gateway Restart Checklist\n\n1. Confirm the local gateway should run on loopback and port 18789.\n2. Check that the current workspace path is ~/.openclaw/workspace.\n3. Verify required model/provider credentials are still present before reconnecting.\n4. Start or reconnect the local gateway service.\n5. Run a health check and confirm the desktop channel can reach the gateway.\n\nUse this file as a short restart checklist for recurring runtime recovery.\n",
    ),
];
const DEFAULT_WORKSPACE_BOOTSTRAP_TEMPLATE: &str = "# BOOTSTRAP.md - First Run Checklist\n\n1. Read AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md, and HEARTBEAT.md.\n2. Confirm the workspace path and runtime settings match this device.\n3. Fill in IDENTITY.md if you want a custom agent name or role.\n4. Add any stable user preferences to USER.md and operating notes to TOOLS.md.\n5. After the first successful setup, you may delete this file.\n";

#[derive(Clone)]
struct AgentState {
    inner: Arc<Mutex<AgentRuntimeState>>,
}

#[derive(Clone)]
pub(crate) struct ManagedRuntimeStateHandle {
    pub(crate) inner: Arc<Mutex<ManagedRuntimeState>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AgentRuntimeState::default())),
        }
    }
}

impl Default for ManagedRuntimeStateHandle {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ManagedRuntimeState::default())),
        }
    }
}

#[derive(Default)]
struct AgentRuntimeState {
    child: Option<Child>,
    running: bool,
    session_id: Option<String>,
    last_heartbeat_at: Option<String>,
    log_file_path: Option<String>,
    heartbeat_count: u64,
    logs: Vec<AgentLogEntry>,
}

#[derive(Default)]
pub(crate) struct ManagedRuntimeState {
    pub(crate) child: Option<Child>,
    pub(crate) running: bool,
    pub(crate) process_id: Option<u32>,
    pub(crate) process_mode: Option<String>,
    pub(crate) last_started_at: Option<String>,
    pub(crate) last_stopped_at: Option<String>,
    pub(crate) restart_count: u64,
    pub(crate) log_file_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLogEntry {
    timestamp: String,
    level: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    available: bool,
    running: bool,
    mode: String,
    detail: String,
    session_id: Option<String>,
    last_heartbeat_at: Option<String>,
    heartbeat_count: u64,
    log_file_path: Option<String>,
    logs: Vec<AgentLogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStorageStatus {
    available: bool,
    mode: String,
    detail: String,
    json_state_path: String,
    sqlite_path: String,
    sqlite_ready: bool,
    last_saved_at: Option<String>,
    credential_provider: String,
    credential_path: String,
    credential_secure: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePackageStatus {
    available: bool,
    installed: bool,
    managed: bool,
    cli_available: Option<bool>,
    offline_bundle_version: Option<String>,
    offline_bundle_manifest_version: Option<String>,
    offline_bundle_package_version: Option<String>,
    offline_bundle_update_available: bool,
    detail: String,
    install_mode: Option<String>,
    version: Option<String>,
    package_source: Option<String>,
    download_url: Option<String>,
    package_path: Option<String>,
    expected_sha256: Option<String>,
    resolved_sha256: Option<String>,
    verified: bool,
    install_dir: String,
    manifest_path: String,
    executable_path: String,
    bound_install_path: Option<String>,
    detected_install_path: Option<String>,
    detected_install_paths: Vec<String>,
    managed_endpoint: Option<String>,
    installed_at: Option<String>,
    process_running: bool,
    process_id: Option<u32>,
    process_mode: Option<String>,
    last_started_at: Option<String>,
    last_stopped_at: Option<String>,
    restart_count: u64,
    log_file_path: Option<String>,
    status_logs: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutostartStatus {
    available: bool,
    enabled: bool,
    launcher: String,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdaterStatus {
    available: bool,
    update_available: bool,
    installed: bool,
    current_version: String,
    target_version: Option<String>,
    assigned_channel: String,
    endpoint: String,
    download_url: Option<String>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    last_checked_at: String,
    detail: String,
}

#[derive(Default)]
struct DesktopUpdaterProgressHandle {
    inner: std::sync::Mutex<DesktopUpdaterProgressInner>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdaterProgressInner {
    active: bool,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    completed: bool,
    error: Option<String>,
}

#[derive(Clone)]
struct BackupProgressHandle {
    inner: std::sync::Arc<std::sync::Mutex<BackupProgressInner>>,
}

impl Default for BackupProgressHandle {
    fn default() -> Self {
        Self {
            inner: std::sync::Arc::new(std::sync::Mutex::new(BackupProgressInner::default())),
        }
    }
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupProgressInner {
    active: bool,
    completed: bool,
    error: Option<String>,
    total_files: u64,
    processed_files: u64,
    backup_file_path: String,
    backup_file_name: String,
    backup_size_bytes: u64,
    source_size_bytes: u64,
    detail: String,
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePackageManifest {
    version: String,
    managed_endpoint: String,
    installed_at: String,
    install_mode: String,
    package_source: String,
    download_url: Option<String>,
    package_path: Option<String>,
    expected_sha256: Option<String>,
    resolved_sha256: Option<String>,
    verified: bool,
    bound_install_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RHClawPluginStatus {
    available: bool,
    installed: bool,
    configured: bool,
    detail: String,
    install_mode: Option<String>,
    package_spec: Option<String>,
    package_source: Option<String>,
    package_version: Option<String>,
    local_package_path: Option<String>,
    installed_package_path: Option<String>,
    install_receipt_path: Option<String>,
    package_validated: bool,
    plugin_dir: String,
    manifest_path: String,
    generated_config_path: String,
    plugin_env_path: String,
    gateway_restart_required: bool,
    gateway_probe_passed: bool,
    last_probe_at: Option<String>,
    last_probe_detail: Option<String>,
    gateway_token_env_name: Option<String>,
    secret_ref_source: Option<String>,
    server_url: Option<String>,
    device_socket_url: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    default_agent_id: Option<String>,
    channel_status: Option<String>,
    channel_last_heartbeat_at: Option<String>,
    channel_detail: Option<String>,
}

#[derive(Default)]
struct RHClawGatewayChannelSnapshot {
    status: Option<String>,
    last_heartbeat_at: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RHClawPluginConfigDraft {
    enabled: bool,
    connection_mode: String,
    server_url: String,
    device_socket_url: String,
    device_id: String,
    device_code: String,
    device_name: String,
    default_agent_id: String,
    gateway_token_env_name: String,
    allow_from: Vec<String>,
    dm_policy: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RHClawPluginManifest {
    installed_at: String,
    install_mode: String,
    package_spec: String,
    package_source: String,
    package_version: Option<String>,
    local_package_path: Option<String>,
    installed_package_path: Option<String>,
    install_receipt_path: Option<String>,
    package_validated: bool,
    generated_config_path: String,
    configured: bool,
    gateway_restart_required: bool,
    gateway_probe_passed: bool,
    last_probe_at: Option<String>,
    last_probe_detail: Option<String>,
    config: RHClawPluginConfigDraft,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RHClawPluginInstallReceipt {
    source_path: String,
    package_name: String,
    package_version: String,
    plugin_id: String,
    channels: Vec<String>,
    staged_at: String,
    staged_files: Vec<String>,
}

#[derive(Default)]
pub(crate) struct OpenClawGatewayProbe {
    pub(crate) running: bool,
    pub(crate) detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawRuntimeProbeStatus {
    healthy: bool,
    detail: String,
    endpoint: String,
    checked_at: String,
    version: Option<String>,
}

#[derive(Deserialize)]
struct RHClawPackageJson {
    name: String,
    version: String,
}

#[derive(Deserialize)]
struct RHClawPackagePluginManifest {
    id: String,
    channels: Vec<String>,
}

const STATE_SNAPSHOT_KEY: &str = "desktop-shell-state";
const DEVICE_SECRET_SQLITE_KEY: &str = "device-token-secret";
const KEYCHAIN_SERVICE_NAME: &str = "RHOpenClawDesktop";
const KEYCHAIN_ACCOUNT_NAME: &str = "device-token";
const MODEL_SECRET_KEYCHAIN_ACCOUNT_PREFIX: &str = "model-provider:";
const GATEWAY_AUTH_TOKEN_KEYCHAIN_ACCOUNT_NAME: &str = "gateway-auth-token";
const OPENCLAW_SECRET_EXEC_PROVIDER: &str = "rhdesktop_exec";
const SECRET_RESOLVER_MODE_ARG: &str = "--resolve-secret-refs";
const RHCLAW_DEVICE_TOKEN_ENV_NAME: &str = "RHCLAW_DEVICE_TOKEN";
const GATEWAY_AUTH_TOKEN_SECRET_REF_ID: &str = "gateway/auth/token";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopClientIdentity {
    platform: String,
    app_version: String,
    protocol_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRegisterDeviceArgs {
    api_base_url: String,
    device_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDeviceTokenArgs {
    api_base_url: String,
    device_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeApiBaseUrlArgs {
    api_base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLlmConfigArgs {
    api_key: String,
    base_url: String,
    model: String,
    openai_compat_prefix: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretResolverRequest {
    protocol_version: Option<u32>,
    provider: Option<String>,
    ids: Vec<String>,
}

#[derive(Serialize)]
struct SecretResolverItemError {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretResolverResponse {
    protocol_version: u32,
    values: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    errors: BTreeMap<String, SecretResolverItemError>,
}

enum SecretResolverTarget {
    ModelProvider(String),
    GatewayAuthToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeBindStatusArgs {
    api_base_url: String,
    device_token: String,
    session_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSkillhubConfig {
    site_url: String,
    installer_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopInstallSkillsConfig {
    mode: String,
    skills: Vec<String>,
    notes: String,
    updated_at: Option<String>,
    skillhub: Option<DesktopSkillhubConfig>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawWorkspaceInfo {
    version: String,
    gateway_port: Option<u16>,
    gateway_bind: Option<String>,
    agent_count: usize,
    skill_count: usize,
    plugin_count: usize,
    config_path: Option<String>,
    data_dir: Option<String>,
    workspace_path: Option<String>,
    debug_logs: Vec<String>,
    raw: Option<serde_json::Value>,
}

/// 工作区文件项
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileItem {
    name: String,
    relative_path: String,
    description: String,
    icon: String,
    exists: bool,
    path: String,
    modified_at: Option<String>,
}

/// 工作区文件列表
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFilesList {
    workspace_path: String,
    files: Vec<WorkspaceFileItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawConfigFileItem {
    name: String,
    description: String,
    icon: String,
    exists: bool,
    path: String,
    modified_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawConfigFilesList {
    config_root_path: String,
    files: Vec<OpenClawConfigFileItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawConfigRestoreResult {
    ok: bool,
    restored_from: String,
    restored_count: usize,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawMemoryDayItem {
    day: String,
    file_count: usize,
    chunk_count: usize,
    latest_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawMemoryRecordItem {
    path: String,
    source: String,
    size: Option<i64>,
    file_mtime: Option<String>,
    updated_at: Option<String>,
    chunk_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawMemoryOverview {
    available: bool,
    db_path: String,
    db_size_bytes: u64,
    file_count: usize,
    chunk_count: usize,
    selected_day: Option<String>,
    days: Vec<OpenClawMemoryDayItem>,
    records: Vec<OpenClawMemoryRecordItem>,
    detail: String,
}

#[derive(Clone)]
struct MemoryChunkAggregate {
    path: String,
    source: String,
    chunk_count: usize,
    latest_updated_at: Option<i64>,
}

#[derive(Clone)]
struct MemoryFileRow {
    path: String,
    source: String,
    size: i64,
    mtime: i64,
}

#[derive(Clone)]
struct MemoryRecordRow {
    path: String,
    source: String,
    size: Option<i64>,
    file_mtime: Option<i64>,
    updated_at: Option<i64>,
    chunk_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSkillItem {
    slug: String,
    name: String,
    version: Option<String>,
    enabled: Option<bool>,
    path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawAgentItem {
    id: String,
    name: String,
    model: Option<String>,
    tools: Option<Vec<String>>,
    updated_at: Option<String>,
}

#[tauri::command]
fn agent_status(state: State<'_, AgentState>) -> AgentStatus {
    match state.inner.lock() {
        Ok(runtime) => snapshot(&runtime, "Tauri Commands / sidecar skeleton ready"),
        Err(poisoned) => {
            eprintln!("[rhopenclaw] AgentState Mutex poisoned in agent_status, recovering");
            let runtime = poisoned.into_inner();
            snapshot(&runtime, "Tauri Commands / sidecar skeleton ready (recovered)")
        }
    }
}

#[tauri::command]
fn read_agent_logs(state: State<'_, AgentState>) -> Vec<AgentLogEntry> {
    match state.inner.lock() {
        Ok(runtime) => runtime.logs.clone(),
        Err(poisoned) => {
            eprintln!("[rhopenclaw] AgentState Mutex poisoned in read_agent_logs, recovering");
            poisoned.into_inner().logs.clone()
        }
    }
}

#[tauri::command]
fn start_agent_sidecar(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("openclaw-agent-stub.sh");

    if !script_path.exists() {
        return Err(format!("agent stub not found: {}", script_path.display()));
    }

    let log_path = default_log_path()?;

    {
        let runtime = state.inner.lock().map_err(|_| "agent state poisoned".to_string())?;
        if runtime.running {
            return Ok(snapshot(&runtime, "Agent sidecar already running"));
        }
    }

    let mut child = Command::new("sh")
        .arg(&script_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start agent sidecar: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "agent stdout unavailable".to_string())?;

    let session_id = format!("agent-{}", current_unix_ms());
    let runtime_arc = state.inner.clone();
    let log_path_string = log_path.to_string_lossy().to_string();

    {
        let mut runtime = runtime_arc
            .lock()
            .map_err(|_| "agent state poisoned".to_string())?;
        runtime.child = Some(child);
        runtime.running = true;
        runtime.session_id = Some(session_id.clone());
        runtime.last_heartbeat_at = Some(now_iso_string());
        runtime.log_file_path = Some(log_path_string.clone());
        runtime.heartbeat_count = 0;
        runtime.logs.clear();
        push_log(
            &mut runtime.logs,
            AgentLogEntry {
                timestamp: now_iso_string(),
                level: "info".into(),
                message: format!("Agent sidecar session {session_id} started"),
            },
        );
    }

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(text) = line else {
                continue;
            };

            let timestamp = now_iso_string();
            let entry = AgentLogEntry {
                timestamp: timestamp.clone(),
                level: if text.contains("heartbeat") { "debug".into() } else { "info".into() },
                message: text.clone(),
            };

            let _ = append_log_line(&log_path_string, &entry);

            if let Ok(mut runtime) = runtime_arc.lock() {
                if text.contains("heartbeat") {
                    runtime.last_heartbeat_at = Some(timestamp.clone());
                    runtime.heartbeat_count += 1;
                }
                push_log(&mut runtime.logs, entry);
            }
        }

        if let Ok(mut runtime) = runtime_arc.lock() {
            runtime.running = false;
            runtime.child = None;
            push_log(
                &mut runtime.logs,
                AgentLogEntry {
                    timestamp: now_iso_string(),
                    level: "warn".into(),
                    message: "Agent sidecar stdout stream ended".into(),
                },
            );
        }
    });

    let runtime = state.inner.lock().map_err(|_| "agent state poisoned".to_string())?;
    Ok(snapshot(&runtime, "Agent sidecar skeleton started"))
}

#[tauri::command]
fn stop_agent_sidecar(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let mut runtime = state.inner.lock().map_err(|_| "agent state poisoned".to_string())?;

    if let Some(mut child) = runtime.child.take() {
        child.kill().map_err(|error| format!("failed to stop agent sidecar: {error}"))?;
    }

    runtime.running = false;
    push_log(
        &mut runtime.logs,
        AgentLogEntry {
            timestamp: now_iso_string(),
            level: "info".into(),
            message: "Agent sidecar stopped".into(),
        },
    );

    Ok(snapshot(&runtime, "Agent sidecar stopped"))
}

#[tauri::command]
fn local_storage_status() -> Result<DesktopStorageStatus, String> {
    Ok(storage_status("Desktop 本地 JSON / SQLite / 凭据存储骨架已就绪"))
}

#[tauri::command]
fn save_local_state_snapshot(payload: String) -> Result<DesktopStorageStatus, String> {
    let paths = desktop_storage_paths()?;
    ensure_storage_layout(&paths)?;
    let saved_at = now_iso_string();
    fs::write(&paths.json_state_path, payload)
        .map_err(|error| format!("failed to write local state snapshot: {error}"))?;

    let connection = open_state_database(&paths)?;
    connection
        .execute(
            "INSERT INTO app_state_snapshots (storage_key, payload, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(storage_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            params![STATE_SNAPSHOT_KEY, fs::read_to_string(&paths.json_state_path).map_err(|error| format!("failed to re-read local state snapshot: {error}"))?, saved_at],
        )
        .map_err(|error| format!("failed to upsert sqlite state snapshot: {error}"))?;

    Ok(storage_status("本地状态快照已写入 JSON / SQLite 本地存储"))
}

#[tauri::command]
fn load_local_state_snapshot() -> Result<Option<String>, String> {
    let paths = desktop_storage_paths()?;

    if paths.sqlite_path.exists() {
        let connection = open_state_database(&paths)?;
        let sqlite_payload = connection
            .query_row(
                "SELECT payload FROM app_state_snapshots WHERE storage_key = ?1",
                params![STATE_SNAPSHOT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("failed to read sqlite state snapshot: {error}"))?;

        if sqlite_payload.is_some() {
            return Ok(sqlite_payload);
        }
    }

    if !paths.json_state_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&paths.json_state_path)
        .map_err(|error| format!("failed to read local state snapshot: {error}"))?;
    Ok(Some(content))
}

#[tauri::command]
fn save_device_secret_stub(secret: String) -> Result<DesktopStorageStatus, String> {
    let paths = desktop_storage_paths()?;
    ensure_storage_layout(&paths)?;
    write_device_secret(&paths, &secret)?;
    Ok(storage_status("设备敏感凭据已写入原生安全存储"))
}

#[tauri::command]
fn load_device_secret_stub() -> Result<String, String> {
    let paths = desktop_storage_paths()?;

    read_device_secret(&paths)
}

#[tauri::command]
fn clear_device_secret_stub() -> Result<DesktopStorageStatus, String> {
    let paths = desktop_storage_paths()?;
    ensure_storage_layout(&paths)?;
    clear_device_secret(&paths)?;
    Ok(storage_status("设备敏感凭据已从原生安全存储清除"))
}

#[tauri::command]
fn register_device_http(args: NativeRegisterDeviceArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/register");
    let identity = desktop_client_identity();
    let body = serde_json::json!({
        "deviceCode": args.device_code,
        "platform": identity.platform,
        "appVersion": identity.app_version,
        "protocolVersion": identity.protocol_version,
    });

    perform_native_json_request(Method::POST, &url, Some(body), None)
}

fn desktop_client_identity() -> DesktopClientIdentity {
    DesktopClientIdentity {
        platform: desktop_platform_label().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: "1".to_string(),
    }
}

fn desktop_platform_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "Desktop"
    }
}

fn detect_openclaw_version() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let config_path = std::path::PathBuf::from(home).join(".openclaw").join("openclaw.json");
    let content = std::fs::read_to_string(config_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let version = value.get("meta")?.get("lastTouchedVersion")?.as_str()?;
    sanitize_version_value(version)
}

fn sanitize_version_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    match trimmed.to_ascii_lowercase().as_str() {
        "unknown" | "<none>" | "none" | "null" | "n/a" | "-" => None,
        _ => Some(trimmed.to_string()),
    }
}

fn normalize_openclaw_version_for_compare(value: &str) -> Option<String> {
    let sanitized = sanitize_version_value(value)?;
    let normalized = sanitized
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split('-')
        .next()
        .unwrap_or("")
        .trim();

    if normalized.is_empty() {
        return None;
    }

    Some(normalized.to_string())
}

fn parse_openclaw_version_parts(value: &str) -> Option<(u64, u64, u64)> {
    let normalized = normalize_openclaw_version_for_compare(value)?;
    let mut parts = normalized.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

fn compare_openclaw_versions(left: &str, right: &str) -> Option<Ordering> {
    let left_parts = parse_openclaw_version_parts(left)?;
    let right_parts = parse_openclaw_version_parts(right)?;
    Some(left_parts.cmp(&right_parts))
}

pub(crate) fn should_upgrade_to_offline_bundle_version(
    installed_version: Option<&str>,
    offline_bundle_version: Option<&str>,
) -> bool {
    let Some(offline_version) = offline_bundle_version.and_then(sanitize_version_value) else {
        return false;
    };

    let Some(current_version) = installed_version.and_then(sanitize_version_value) else {
        return true;
    };

    match compare_openclaw_versions(&offline_version, &current_version) {
        Some(Ordering::Greater) => true,
        Some(Ordering::Equal | Ordering::Less) => false,
        None => true,
    }
}

pub(crate) fn detect_current_openclaw_runtime_version() -> Option<String> {
    detect_openclaw_cli_version().or_else(detect_openclaw_version)
}

fn detect_openclaw_cli_version_from_path(cli: &Path) -> Option<String> {
    let mut child = Command::new(cli)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("[WARN] openclaw --version timed out (10s)");
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = stdout.trim();
    if text.is_empty() { return None; }
    let version_part = text
        .strip_prefix("OpenClaw ")
        .or_else(|| text.strip_prefix("openclaw "))
        .unwrap_or(text);
    let version = version_part
        .split(|c: char| c == ' ' || c == '(')
        .next()
        .unwrap_or(version_part)
        .trim();
    sanitize_version_value(version)
}

/// Read openclaw version from the installed package.json under a npm global prefix dir.
/// Checks both `<prefix>/node_modules/openclaw/package.json` and
/// `<prefix>/lib/node_modules/openclaw/package.json` (nvm layout).
fn read_installed_openclaw_version_from_prefix(prefix_dir: &Path) -> Option<String> {
    let candidates = [
        prefix_dir.join("lib").join("node_modules").join("openclaw").join("package.json"),
        prefix_dir.join("node_modules").join("openclaw").join("package.json"),
    ];
    for pkg_json_path in &candidates {
        if let Ok(raw) = fs::read_to_string(pkg_json_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(version) = parsed.get("version").and_then(|v| v.as_str()) {
                    return sanitize_version_value(version);
                }
            }
        }
    }
    None
}

#[derive(Default, Clone)]
struct OfflineBundleOpenClawVersionInfo {
    manifest_version: Option<String>,
    package_version: Option<String>,
    resolved_version: Option<String>,
    consistent: bool,
}

/// Parse version from `openclaw --version` output like "OpenClaw 2026.3.11 (29dc654)"
fn detect_openclaw_cli_version() -> Option<String> {
    let cli = detect_openclaw_cli()?;
    detect_openclaw_cli_version_from_path(Path::new(&cli))
}

/// Resolve OpenClaw workspace path from config file
fn detect_openclaw_workspace_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".openclaw").to_string_lossy().to_string())
}

fn openclaw_config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".openclaw").join("openclaw.json"))
}

fn read_openclaw_config_json() -> Option<(PathBuf, serde_json::Value)> {
    let config_path = openclaw_config_path()?;
    let content = fs::read_to_string(&config_path).ok()?;
    let sanitized = sanitize_json_unquoted_keys(&content);
    let value = serde_json::from_str::<serde_json::Value>(&sanitized).ok()?;
    Some((config_path, value))
}

fn get_json_path<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn get_first_string(value: &serde_json::Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        get_json_path(value, path)
            .and_then(|item| item.as_str())
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
    })
}

fn get_first_u16(value: &serde_json::Value, paths: &[&[&str]]) -> Option<u16> {
    paths.iter().find_map(|path| {
        get_json_path(value, path)
            .and_then(|item| item.as_u64())
            .and_then(|item| u16::try_from(item).ok())
    })
}

fn get_first_count(value: &serde_json::Value, paths: &[&[&str]]) -> Option<usize> {
    paths.iter().find_map(|path| {
        let item = get_json_path(value, path)?;
        if let Some(array) = item.as_array() {
            return Some(array.len());
        }

        if let Some(object) = item.as_object() {
            return Some(object.len());
        }

        item.as_u64().and_then(|count| usize::try_from(count).ok())
    })
}

fn is_skill_already_available_error(detail: &str) -> bool {
    let normalized = detail.trim().to_ascii_lowercase();
    normalized.contains("skill already exists at ")
        || normalized.contains("already installed")
        || normalized.contains("already available")
}

fn parse_local_skills_payload(payload: &serde_json::Value) -> Vec<LocalSkillItem> {
    let items = payload
        .as_array()
        .or_else(|| payload.get("items").and_then(|item| item.as_array()))
        .or_else(|| payload.get("data").and_then(|item| item.as_array()))
        .or_else(|| payload.get("skills").and_then(|item| item.as_array()))
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|item| {
            if let Some(slug) = item.as_str() {
                let trimmed = slug.trim();
                if trimmed.is_empty() {
                    return None;
                }

                return Some(LocalSkillItem {
                    slug: trimmed.to_string(),
                    name: trimmed.to_string(),
                    version: None,
                    enabled: None,
                    path: None,
                });
            }

            let slug = get_first_string(&item, &[&["slug"], &["id"], &["name"]])?;
            let source = get_first_string(&item, &[&["source"]]);
            let has_install_marker = item
                .get("installed")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || item
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
                || item
                    .get("installPath")
                    .and_then(|value| value.as_str())
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
                || item
                    .get("bundled")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                || source
                    .as_deref()
                    .map(|value| value.starts_with("openclaw-"))
                    .unwrap_or(false);

            if !has_install_marker {
                return None;
            }

            Some(LocalSkillItem {
                name: get_first_string(&item, &[&["name"], &["title"]]).unwrap_or_else(|| slug.clone()),
                version: get_first_string(&item, &[&["version"], &["currentVersion"]]),
                enabled: item
                    .get("enabled")
                    .and_then(|value| value.as_bool())
                    .or_else(|| item.get("isEnabled").and_then(|value| value.as_bool()))
                    .or_else(|| item.get("disabled").and_then(|value| value.as_bool()).map(|value| !value))
                    .or_else(|| item.get("eligible").and_then(|value| value.as_bool())),
                path: get_first_string(&item, &[&["path"], &["installPath"]]),
                slug,
            })
        })
        .collect()
}

fn read_skill_dirs_from_filesystem() -> Vec<LocalSkillItem> {
    let skills_dir = skillhub_skills_dir();
    let entries = match fs::read_dir(&skills_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }

            let slug = entry.file_name().to_string_lossy().trim().to_string();
            if slug.is_empty() || slug.starts_with('.') {
                return None;
            }

            Some(LocalSkillItem {
                slug: slug.clone(),
                name: slug,
                version: None,
                enabled: Some(true),
                path: Some(path.to_string_lossy().to_string()),
            })
        })
        .collect()
}

    fn collect_local_skill_slug_set() -> HashSet<String> {
        list_local_skills_internal()
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.slug.trim().to_lowercase())
        .filter(|slug| !slug.is_empty())
        .collect()
    }

fn detect_bundled_skills_dir() -> Option<PathBuf> {
    if let Some(candidate) = std::env::var_os("RHOPENCLAW_BUNDLED_SKILLS_DIR")
        .map(PathBuf::from)
        .filter(|path| path.exists())
    {
        return Some(candidate);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents_dir) = exe.parent().and_then(|p| p.parent()) {
            let mac_candidates = [
                contents_dir.join("Resources").join("_up_").join("skills"),
                contents_dir.join("Resources").join("skills"),
            ];

            for candidate in mac_candidates {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        if let Some(bin_dir) = exe.parent() {
            let runtime_candidates = [
                bin_dir.join("resources").join("skills"),
                bin_dir.join("skills"),
            ];

            for candidate in runtime_candidates {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    let cargo_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_candidate = cargo_dir.join("skills");
    if dev_candidate.exists() {
        return Some(dev_candidate);
    }

    None
}

fn bundled_skill_source_dir(slug: &str) -> Option<PathBuf> {
    let normalized = normalize_skill_slug(slug)?.to_lowercase();

    detect_bundled_skills_dir()
        .map(|root| root.join(normalized))
        .filter(|path| path.is_dir())
}

fn is_bundled_markdown_only_skill(skill_dir: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(skill_dir)
        .map_err(|error| format!("读取内置 skill 目录失败 {}: {error}", skill_dir.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            return Ok(false);
        }

        let allowed = matches!(
            file_name.as_str(),
            "SKILL.md" | "skill.md" | "README.md" | "README.MD" | "LICENSE.txt" | "_meta.json"
        );
        if !allowed {
            return Ok(false);
        }
    }

    Ok(skill_dir.join("SKILL.md").exists() || skill_dir.join("skill.md").exists())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("创建目录失败 {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src)
        .map_err(|e| format!("读取目录失败 {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let src_path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("拷贝文件失败 {} -> {}: {e}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

fn sync_skillhub_lockfile_entry(slug: &str, source: &str, version: Option<String>) {
    let install_root = skillhub_skills_dir();
    let lockfile_path = install_root.join(".skills_store_lock.json");
    let mut lock: serde_json::Value = if lockfile_path.exists() {
        fs::read_to_string(&lockfile_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({"skills": {}}))
    } else {
        serde_json::json!({"skills": {}})
    };

    if let Some(skills) = lock.get_mut("skills").and_then(|value| value.as_object_mut()) {
        skills.insert(
            slug.to_string(),
            serde_json::json!({
                "name": slug,
                "source": source,
                "version": version.unwrap_or_default()
            }),
        );
    }

    if let Ok(json_text) = serde_json::to_string_pretty(&lock) {
        let _ = fs::create_dir_all(&install_root);
        let _ = fs::write(&lockfile_path, json_text);
    }
}

fn install_bundled_markdown_skill(slug: &str) -> Result<bool, String> {
    let Some(normalized_slug) = normalize_skill_slug(slug).map(|value| value.to_lowercase()) else {
        return Ok(false);
    };

    let Some(source_dir) = bundled_skill_source_dir(&normalized_slug) else {
        return Ok(false);
    };

    let target_dir = skillhub_skills_dir().join(&normalized_slug);
    if target_dir.join("SKILL.md").exists() || target_dir.join("skill.md").exists() {
        return Ok(true);
    }

    let version = source_dir
        .join("_meta.json")
        .exists()
        .then(|| fs::read_to_string(source_dir.join("_meta.json")).ok())
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("version").and_then(|item| item.as_str()).map(|item| item.to_string()));

    if is_bundled_markdown_only_skill(&source_dir)? {
        fs::create_dir_all(&target_dir)
            .map_err(|error| format!("创建内置 skill 目录失败 {}: {error}", target_dir.display()))?;

        let entries = fs::read_dir(&source_dir)
            .map_err(|error| format!("读取内置 skill 目录失败 {}: {error}", source_dir.display()))?;
        for entry in entries.flatten() {
            let source_path = entry.path();
            if !source_path.is_file() {
                continue;
            }

            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }

            let target_path = target_dir.join(&file_name);
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "拷贝内置 skill 文件失败 {} -> {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
        sync_skillhub_lockfile_entry(&normalized_slug, "bundled-markdown", version);
    } else {
        copy_dir_recursive(&source_dir, &target_dir)?;
        sync_skillhub_lockfile_entry(&normalized_slug, "bundled-full", version);
    }

    Ok(true)
}

fn merge_local_skill_items(primary: Vec<LocalSkillItem>, secondary: Vec<LocalSkillItem>) -> Vec<LocalSkillItem> {
    let mut merged = std::collections::BTreeMap::<String, LocalSkillItem>::new();

    for item in primary.into_iter().chain(secondary.into_iter()) {
        let slug = item.slug.trim().to_string();
        if slug.is_empty() {
            continue;
        }

        match merged.get_mut(&slug) {
            Some(existing) => {
                if existing.name.trim().is_empty() || existing.name == existing.slug {
                    existing.name = item.name.clone();
                }
                if existing.version.is_none() {
                    existing.version = item.version.clone();
                }
                if existing.enabled.is_none() {
                    existing.enabled = item.enabled;
                }
                if existing.path.is_none() {
                    existing.path = item.path.clone();
                }
            }
            None => {
                merged.insert(slug, item);
            }
        }
    }

    merged.into_values().collect()
}

fn parse_agents_payload(payload: &serde_json::Value) -> Vec<OpenClawAgentItem> {
    let items = payload
        .as_array()
        .or_else(|| payload.get("items").and_then(|item| item.as_array()))
        .or_else(|| payload.get("data").and_then(|item| item.as_array()))
        .or_else(|| payload.get("agents").and_then(|item| item.as_array()))
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|item| {
            let id = get_first_string(&item, &[&["id"], &["agentId"], &["name"]])?;
            let tools = item
                .get("tools")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|tool| {
                            tool.as_str().map(|value| value.to_string()).or_else(|| {
                                tool.get("name")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string())
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|items| !items.is_empty());

            Some(OpenClawAgentItem {
                name: get_first_string(&item, &[&["name"], &["title"]]).unwrap_or_else(|| id.clone()),
                model: get_first_string(&item, &[&["model"], &["modelName"]]),
                updated_at: get_first_string(&item, &[&["updatedAt"], &["lastUpdatedAt"]]),
                tools,
                id,
            })
        })
        .collect()
}

fn list_local_skills_internal() -> Result<Vec<LocalSkillItem>, String> {
    let fs_skills = read_skill_dirs_from_filesystem();
    let openclaw_skills = execute_openclaw_command(&["skills", "list", "--json"], &[])
        .ok()
        .and_then(|(stdout, _)| extract_json_payload(&stdout).ok())
        .map(|payload| parse_local_skills_payload(&payload))
        .unwrap_or_default();

    let merged = merge_local_skill_items(openclaw_skills, fs_skills);
    if merged.is_empty() {
        return Err("未读取到本地 skills，openclaw 列表与 ~/.openclaw/skills 目录均为空。".into());
    }

    Ok(merged)
}

fn list_openclaw_agents_internal() -> Result<Vec<OpenClawAgentItem>, String> {
    let (stdout, _) = execute_openclaw_command(&["agent", "list", "--json"], &[])?;
    let payload = extract_json_payload(&stdout)?;
    Ok(parse_agents_payload(&payload))
}

#[tauri::command]
fn get_openclaw_workspace_info() -> Result<OpenClawWorkspaceInfo, String> {
    let config = read_openclaw_config_json();
    let skills = list_local_skills_internal().unwrap_or_default();
    let agents = list_openclaw_agents_internal().unwrap_or_default();

    let config_path = config
        .as_ref()
        .map(|(path, _)| path.to_string_lossy().to_string());
    let config_json = config.as_ref().map(|(_, value)| value.clone());
    let config_version = detect_openclaw_version();
    let cli_version = detect_openclaw_cli_version();
    let json_version = config_json
        .as_ref()
        .and_then(|value| get_first_string(value, &[&["version"], &["appVersion"]]))
        .and_then(|value| sanitize_version_value(&value));
    let resolved_version = config_version
        .clone()
        .or_else(|| cli_version.clone())
        .or_else(|| json_version.clone());
    let mut debug_logs = Vec::new();
    debug_logs.push(format!(
        "workspace.configPath={}",
        config_path.clone().unwrap_or_else(|| "<none>".into())
    ));
    debug_logs.push(format!(
        "workspace.version.config={}",
        config_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    debug_logs.push(format!(
        "workspace.version.cli={}",
        cli_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    debug_logs.push(format!(
        "workspace.version.json={}",
        json_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    debug_logs.push(format!(
        "workspace.version.selected={}",
        resolved_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    debug_logs.push(format!("workspace.skills.count={}", skills.len()));
    debug_logs.push(format!("workspace.agents.count={}", agents.len()));

    Ok(OpenClawWorkspaceInfo {
        version: resolved_version.unwrap_or_default(),
        gateway_port: config_json.as_ref().and_then(|value| {
            get_first_u16(value, &[&["gateway", "port"], &["gatewayPort"], &["port"]])
        }),
        gateway_bind: config_json.as_ref().and_then(|value| {
            get_first_string(value, &[&["gateway", "bind"], &["gatewayBind"], &["bind"]])
        }),
        agent_count: if agents.is_empty() {
            config_json.as_ref()
                .and_then(|value| get_first_count(value, &[&["agents"], &["counts", "agents"], &["agentCount"]]))
                .unwrap_or(0)
        } else {
            agents.len()
        },
        skill_count: if skills.is_empty() {
            config_json.as_ref()
                .and_then(|value| get_first_count(value, &[&["skills"], &["counts", "skills"], &["skillCount"]]))
                .unwrap_or(0)
        } else {
            skills.len()
        },
        plugin_count: config_json.as_ref()
            .and_then(|value| get_first_count(value, &[&["plugins"], &["counts", "plugins"], &["pluginCount"]]))
            .or_else(|| config_json.as_ref().and_then(|value| get_first_count(value, &[&["plugins"], &["gateway", "plugins"]])))
            .unwrap_or(0),
        config_path,
        data_dir: config_json.as_ref().and_then(|value| {
            get_first_string(value, &[&["dataDir"], &["paths", "dataDir"], &["workspace", "dataDir"]])
        }),
        workspace_path: detect_openclaw_workspace_path()
            .or_else(|| config_json.as_ref().and_then(|value| {
                get_first_string(value, &[&["workspacePath"], &["paths", "workspacePath"], &["workspace", "path"]])
            })),
        debug_logs,
        raw: config_json,
    })
}

#[tauri::command]
fn list_local_skills() -> Result<Vec<LocalSkillItem>, String> {
    list_local_skills_internal()
}

#[tauri::command]
fn install_skill(slug: String, installer_url: Option<String>) -> Result<Vec<LocalSkillItem>, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("技能 slug 不能为空".into());
    }

    let normalized = trimmed.to_lowercase();
    if collect_local_skill_slug_set().contains(&normalized) {
        return list_local_skills_internal().or_else(|_| Ok(Vec::new()));
    }

    if install_bundled_markdown_skill(trimmed)? {
        return list_local_skills_internal();
    }

    if collect_local_skill_slug_set().contains(&normalized) {
        return list_local_skills_internal().or_else(|_| Ok(Vec::new()));
    }

    let mut config = default_desktop_install_skills_config();
    if let Some(url) = installer_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        match config.skillhub.as_mut() {
            Some(skillhub) => skillhub.installer_url = url,
            None => {
                config.skillhub = Some(DesktopSkillhubConfig {
                    site_url: SKILLHUB_DEFAULT_SITE_URL.to_string(),
                    installer_url: url,
                });
            }
        }
    }

    if detect_skillhub_cli().is_none() {
        install_skillhub_cli_if_missing(&config)
            .map_err(|error| format!("安装 SkillHub CLI 失败: {error}"))?;
    }

    match execute_skillhub_command(&["install", trimmed]) {
        Ok(_) => {}
        Err(error) if is_skill_already_available_error(&error) => {}
        Err(error) => return Err(format!("SkillHub 安装失败: {error}")),
    }
    list_local_skills_internal()
}

#[tauri::command]
fn uninstall_skill(slug: String) -> Result<Vec<LocalSkillItem>, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("技能 slug 不能为空".into());
    }

    // 优先通过 SkillHub CLI 卸载（兼容 macOS/Windows），失败时 fallback 到手动删除
    if detect_skillhub_cli().is_some() {
        match execute_skillhub_command(&["uninstall", trimmed]) {
            Ok(_) => return list_local_skills_internal().or_else(|_| Ok(Vec::new())),
            Err(err) => {
                eprintln!("[rhopenclaw] skillhub uninstall {} 失败，回退到手动删除: {}", trimmed, err);
            }
        }
    }

    // Fallback: 手动删除 skill 目录
    let local_skills = list_local_skills_internal().unwrap_or_default();
    let target_path = local_skills
        .iter()
        .find(|item| item.slug == trimmed)
        .and_then(|item| item.path.as_ref())
        .map(PathBuf::from)
        .unwrap_or_else(|| skillhub_skills_dir().join(trimmed));

    let metadata = fs::symlink_metadata(&target_path)
        .map_err(|_| format!("未找到本地技能目录: {}", target_path.display()))?;

    if metadata.is_dir() {
        fs::remove_dir_all(&target_path)
            .map_err(|error| format!("删除技能目录失败: {error}"))?;
    } else {
        fs::remove_file(&target_path)
            .map_err(|error| format!("删除技能文件失败: {error}"))?;
    }

    list_local_skills_internal().or_else(|_| Ok(Vec::new()))
}

#[tauri::command]
fn list_openclaw_agents() -> Result<Vec<OpenClawAgentItem>, String> {
    list_openclaw_agents_internal()
}

fn resolve_workspace_markdown_dir() -> Result<PathBuf, String> {
    if let Some(root) = detect_openclaw_workspace_path() {
        let root_path = PathBuf::from(root);
        if root_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("workspace"))
            .unwrap_or(false)
        {
            return Ok(root_path);
        }

        return Ok(root_path.join("workspace"));
    }

    let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".openclaw").join("workspace"))
}

fn ensure_workspace_markdown_templates(include_bootstrap: bool) -> Result<Vec<String>, String> {
    let workspace_root = resolve_workspace_markdown_dir()?;
    fs::create_dir_all(&workspace_root)
        .map_err(|error| format!("创建 workspace 目录失败: {error}"))?;

    let mut created = Vec::new();
    for (file_name, content) in DEFAULT_WORKSPACE_MARKDOWN_TEMPLATES {
        let target_path = workspace_root.join(file_name);
        let needs_write = match fs::metadata(&target_path) {
            Ok(metadata) => metadata.len() == 0,
            Err(_) => true,
        };

        if !needs_write {
            continue;
        }

        fs::write(&target_path, content)
            .map_err(|error| format!("写入 workspace 模板失败 {}: {error}", target_path.display()))?;
        created.push((*file_name).to_string());
    }

    if include_bootstrap {
        let bootstrap_path = workspace_root.join("BOOTSTRAP.md");
        let needs_write = match fs::metadata(&bootstrap_path) {
            Ok(metadata) => metadata.len() == 0,
            Err(_) => true,
        };

        if needs_write {
            fs::write(&bootstrap_path, DEFAULT_WORKSPACE_BOOTSTRAP_TEMPLATE)
                .map_err(|error| format!("写入 workspace 模板失败 {}: {error}", bootstrap_path.display()))?;
            created.push("BOOTSTRAP.md".to_string());
        }
    }

    Ok(created)
}

fn classify_workspace_markdown_file(file_name: &str) -> (String, String) {
    match file_name.to_ascii_uppercase().as_str() {
        "AGENTS.MD" => ("Agent 操作指令和规则".into(), "file-text".into()),
        "SOUL.MD" => ("Agent 人格和沟通风格".into(), "heart".into()),
        "USER.MD" => ("用户档案和偏好".into(), "user".into()),
        "IDENTITY.MD" => ("Agent 名称和头像".into(), "id-card".into()),
        "TOOLS.MD" => ("本地工具文档".into(), "tool".into()),
        "MEMORY.MD" => ("长期记忆和决策记录".into(), "brain".into()),
        "HEARTBEAT.MD" => ("心跳运行清单".into(), "activity".into()),
        "BOOTSTRAP.MD" => ("首次运行仪式".into(), "rocket".into()),
        "BOOT.MD" => ("网关重启清单".into(), "power".into()),
        _ => ("OpenClaw Workspace Markdown 文件".into(), "file-text".into()),
    }
}

fn sanitize_workspace_relative_path(file_name: &str) -> Result<PathBuf, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空".into());
    }

    let relative = PathBuf::from(trimmed);
    if relative.is_absolute() {
        return Err("不允许使用绝对路径".into());
    }

    if relative.components().any(|component| matches!(component, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("不允许访问 workspace 之外的路径".into());
    }

    let extension = relative.extension().and_then(|value| value.to_str()).unwrap_or("");
    if !extension.eq_ignore_ascii_case("md") {
        return Err("只允许读取 Markdown 文件".into());
    }

    Ok(relative)
}

fn resolve_workspace_markdown_file(file_name: &str) -> Result<PathBuf, String> {
    let relative = sanitize_workspace_relative_path(file_name)?;
    Ok(resolve_workspace_markdown_dir()?.join(relative))
}

fn resolve_openclaw_config_dir() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".openclaw"))
}

fn classify_openclaw_config_file(file_name: &str) -> Result<(&'static str, &'static str), String> {
    match file_name {
        ".env" => Ok(("Gateway环境变量，主要存放 API Key 与兼容网关地址", "tool")),
        "openclaw.json" => Ok(("Gateway主配置，主要存放默认模型与兼容 Provider 定义", "settings")),
        _ => Err("仅支持编辑 .env 和 openclaw.json".into()),
    }
}

fn resolve_openclaw_config_file(file_name: &str) -> Result<PathBuf, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空".into());
    }

    let _ = classify_openclaw_config_file(trimmed)?;
    Ok(resolve_openclaw_config_dir()?.join(trimmed))
}

fn format_modified_time(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(|time| {
            let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
            chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default()
        })
}

fn resolve_workspace_markdown_list_dir(directory: Option<String>) -> Result<PathBuf, String> {
    let root = resolve_workspace_markdown_dir()?;
    let Some(directory) = directory else {
        return Ok(root);
    };

    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Ok(root);
    }

    let relative = PathBuf::from(trimmed);
    if relative.is_absolute() {
        return Err("不允许使用绝对目录".into());
    }

    if relative.components().any(|component| matches!(component, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("不允许访问 workspace 之外的目录".into());
    }

    Ok(root.join(relative))
}

fn openclaw_memory_db_path() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".openclaw").join("memory").join("main.sqlite"))
}

fn format_memory_timestamp(timestamp: i64) -> Option<String> {
    if timestamp <= 0 {
        return None;
    }

    let datetime = if timestamp >= 1_000_000_000_000i64 {
        chrono::DateTime::from_timestamp_millis(timestamp)
    } else {
        chrono::DateTime::from_timestamp(timestamp, 0)
    }?;

    Some(datetime.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
}

fn format_memory_day(timestamp: i64) -> Option<String> {
    if timestamp <= 0 {
        return None;
    }

    let datetime = if timestamp >= 1_000_000_000_000i64 {
        chrono::DateTime::from_timestamp_millis(timestamp)
    } else {
        chrono::DateTime::from_timestamp(timestamp, 0)
    }?;

    Some(datetime.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

fn load_openclaw_memory_overview(selected_day: Option<String>) -> Result<OpenClawMemoryOverview, String> {
    let db_path = openclaw_memory_db_path()?;
    if !db_path.exists() {
        return Ok(OpenClawMemoryOverview {
            available: false,
            db_path: db_path.to_string_lossy().to_string(),
            db_size_bytes: 0,
            file_count: 0,
            chunk_count: 0,
            selected_day,
            days: Vec::new(),
            records: Vec::new(),
            detail: "当前尚未检测到 OpenClaw memory 数据库。".into(),
        });
    }

    let db_size_bytes = fs::metadata(&db_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let connection = Connection::open(&db_path)
        .map_err(|error| format!("打开 OpenClaw memory 数据库失败: {error}"))?;

    let mut files_statement = connection
        .prepare("SELECT path, source, size, mtime FROM files")
        .map_err(|error| format!("读取 memory files 表失败: {error}"))?;
    let file_rows = files_statement
        .query_map([], |row| {
            Ok(MemoryFileRow {
                path: row.get::<_, String>(0)?,
                source: row.get::<_, String>(1)?,
                size: row.get::<_, i64>(2)?,
                mtime: row.get::<_, i64>(3)?,
            })
        })
        .map_err(|error| format!("遍历 memory files 记录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析 memory files 记录失败: {error}"))?;

    let mut chunk_statement = connection
        .prepare(
            "SELECT path, source, COUNT(*) AS chunk_count, MAX(updated_at) AS latest_updated_at
             FROM chunks
             GROUP BY path, source",
        )
        .map_err(|error| format!("读取 memory chunks 表失败: {error}"))?;
    let chunk_rows = chunk_statement
        .query_map([], |row| {
            Ok(MemoryChunkAggregate {
                path: row.get::<_, String>(0)?,
                source: row.get::<_, String>(1)?,
                chunk_count: row.get::<_, i64>(2)? as usize,
                latest_updated_at: row.get::<_, Option<i64>>(3)?,
            })
        })
        .map_err(|error| format!("遍历 memory chunks 记录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析 memory chunks 记录失败: {error}"))?;

    let file_count = file_rows.len();
    let chunk_count = chunk_rows.iter().map(|item| item.chunk_count).sum::<usize>();

    let mut file_map = HashMap::<String, MemoryFileRow>::new();
    for row in file_rows {
        file_map.insert(row.path.clone(), row);
    }

    let mut chunk_map = HashMap::<String, MemoryChunkAggregate>::new();
    let mut seen_paths = HashSet::<String>::new();
    for row in chunk_rows {
        seen_paths.insert(row.path.clone());
        chunk_map.insert(row.path.clone(), row);
    }

    for key in file_map.keys() {
        seen_paths.insert(key.clone());
    }

    let mut all_records = seen_paths
        .into_iter()
        .map(|path| {
            let file_row = file_map.get(&path);
            let chunk_row = chunk_map.get(&path);
            MemoryRecordRow {
                path: path.clone(),
                source: file_row
                    .map(|item| item.source.clone())
                    .or_else(|| chunk_row.map(|item| item.source.clone()))
                    .unwrap_or_else(|| "memory".into()),
                size: file_row.map(|item| item.size),
                file_mtime: file_row.map(|item| item.mtime),
                updated_at: chunk_row.and_then(|item| item.latest_updated_at),
                chunk_count: chunk_row.map(|item| item.chunk_count).unwrap_or(0),
            }
        })
        .collect::<Vec<_>>();

    let mut days_map = BTreeMap::<String, (usize, usize, i64)>::new();
    for record in &all_records {
        let effective_timestamp = record.updated_at.or(record.file_mtime).unwrap_or(0);
        if let Some(day) = format_memory_day(effective_timestamp) {
            let entry = days_map.entry(day).or_insert((0, 0, 0));
            entry.0 += 1;
            entry.1 += record.chunk_count;
            entry.2 = entry.2.max(effective_timestamp);
        }
    }

    let mut days = days_map
        .into_iter()
        .map(|(day, (record_count, chunk_count, latest_ts))| OpenClawMemoryDayItem {
            day,
            file_count: record_count,
            chunk_count,
            latest_at: format_memory_timestamp(latest_ts),
        })
        .collect::<Vec<_>>();
    days.sort_by(|left, right| right.day.cmp(&left.day));

    let resolved_selected_day = selected_day
        .filter(|value| !value.trim().is_empty())
        .or_else(|| days.first().map(|item| item.day.clone()));

    if let Some(day) = resolved_selected_day.as_deref() {
        all_records.retain(|record| {
            let effective_timestamp = record.updated_at.or(record.file_mtime).unwrap_or(0);
            format_memory_day(effective_timestamp).as_deref() == Some(day)
        });
    }

    all_records.sort_by(|left, right| {
        right
            .updated_at
            .or(right.file_mtime)
            .unwrap_or(0)
            .cmp(&left.updated_at.or(left.file_mtime).unwrap_or(0))
    });

    let records = all_records
        .into_iter()
        .map(|item| OpenClawMemoryRecordItem {
            path: item.path,
            source: item.source,
            size: item.size,
            file_mtime: item.file_mtime.and_then(format_memory_timestamp),
            updated_at: item.updated_at.and_then(format_memory_timestamp),
            chunk_count: item.chunk_count,
        })
        .collect::<Vec<_>>();

    let detail = if file_count == 0 && chunk_count == 0 {
        "当前 memory 数据库已初始化，但还没有可展示的记忆记录。".into()
    } else if let Some(day) = resolved_selected_day.as_deref() {
        format!("已读取 {day} 的 {} 条记忆记录。", records.len())
    } else {
        format!("已读取 memory 数据库，共 {} 条文件记录、{} 个 chunks。", file_count, chunk_count)
    };

    Ok(OpenClawMemoryOverview {
        available: true,
        db_path: db_path.to_string_lossy().to_string(),
        db_size_bytes,
        file_count,
        chunk_count,
        selected_day: resolved_selected_day,
        days,
        records,
        detail,
    })
}

/// 获取工作区文件列表
#[tauri::command]
fn list_workspace_files(directory: Option<String>) -> Result<WorkspaceFilesList, String> {
    let _ = ensure_workspace_markdown_templates(false)?;
    let workspace_root = resolve_workspace_markdown_dir()?;
    let workspace_path = resolve_workspace_markdown_list_dir(directory)?;
    let mut files = Vec::new();

    if workspace_path.exists() {
        let mut entries = fs::read_dir(&workspace_path)
            .map_err(|error| format!("读取 workspace 目录失败: {error}"))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_file() {
                    return None;
                }

                let extension = path.extension().and_then(|value| value.to_str())?;
                if !extension.eq_ignore_ascii_case("md") {
                    return None;
                }

                Some(path)
            })
            .collect::<Vec<_>>();

        entries.sort_by(|left, right| {
            left.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .cmp(
                    &right
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                )
        });

        for file_path in entries {
            let name = file_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            let (description, icon) = classify_workspace_markdown_file(&name);
            let modified_at = fs::metadata(&file_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .map(|time| {
                    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                        .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
                        .unwrap_or_default()
                });

            files.push(WorkspaceFileItem {
                name,
                relative_path: file_path
                    .strip_prefix(&workspace_root)
                    .unwrap_or(&file_path)
                    .to_string_lossy()
                    .to_string(),
                description,
                icon,
                exists: true,
                path: file_path.to_string_lossy().to_string(),
                modified_at,
            });
        }
    }

    Ok(WorkspaceFilesList {
        workspace_path: workspace_path.to_string_lossy().to_string(),
        files,
    })
}

/// 读取工作区文件内容
#[tauri::command]
fn read_workspace_file(file_name: String) -> Result<String, String> {
    let _ = ensure_workspace_markdown_templates(false)?;
    let file_path = resolve_workspace_markdown_file(&file_name)?;

    if !file_path.exists() {
        return Err(format!("文件不存在: {}", file_name));
    }

    fs::read_to_string(&file_path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 保存工作区文件内容
#[tauri::command]
fn save_workspace_file(file_name: String, content: String) -> Result<String, String> {
    let _ = ensure_workspace_markdown_templates(false)?;
    let workspace_path = resolve_workspace_markdown_dir()?;

    // 确保目录存在
    if !workspace_path.exists() {
        fs::create_dir_all(&workspace_path).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let file_path = resolve_workspace_markdown_file(&file_name)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(&file_path, &content).map_err(|e| format!("保存文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_openclaw_config_files() -> Result<OpenClawConfigFilesList, String> {
    let config_root = resolve_openclaw_config_dir()?;
    let mut files = Vec::new();

    for file_name in [".env", "openclaw.json"] {
        let (description, icon) = classify_openclaw_config_file(file_name)?;
        let file_path = config_root.join(file_name);

        files.push(OpenClawConfigFileItem {
            name: file_name.to_string(),
            description: description.to_string(),
            icon: icon.to_string(),
            exists: file_path.exists(),
            path: file_path.to_string_lossy().to_string(),
            modified_at: format_modified_time(&file_path),
        });
    }

    Ok(OpenClawConfigFilesList {
        config_root_path: config_root.to_string_lossy().to_string(),
        files,
    })
}

#[tauri::command]
fn read_openclaw_config_file(file_name: String) -> Result<String, String> {
    let file_path = resolve_openclaw_config_file(&file_name)?;
    if !file_path.exists() {
        return Ok(String::new());
    }

    fs::read_to_string(&file_path).map_err(|error| format!("读取配置文件失败: {error}"))
}

#[tauri::command]
fn save_openclaw_config_file(file_name: String, content: String) -> Result<String, String> {
    let config_root = resolve_openclaw_config_dir()?;
    if !config_root.exists() {
        fs::create_dir_all(&config_root).map_err(|error| format!("创建 .openclaw 目录失败: {error}"))?;
    }

    let file_path = resolve_openclaw_config_file(&file_name)?;
    fs::write(&file_path, content).map_err(|error| format!("保存配置文件失败: {error}"))?;

    #[cfg(unix)]
    if file_name.trim() == ".env" {
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&file_path, permissions)
            .map_err(|error| format!("设置 .env 权限失败: {error}"))?;
    }

    Ok(file_path.to_string_lossy().to_string())
}

fn is_excluded_from_openclaw_backup(relative: &Path) -> bool {
    relative
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().eq_ignore_ascii_case("logs"))
        .unwrap_or(false)
}

fn count_openclaw_files_recursive(root: &Path, current: &Path) -> u64 {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    let mut count = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        if is_excluded_from_openclaw_backup(relative) {
            continue;
        }
        if metadata.is_dir() {
            count += count_openclaw_files_recursive(root, &path);
        } else if metadata.is_file() {
            count += 1;
        }
    }
    count
}

fn zip_openclaw_dir_recursive(
    root: &Path,
    current: &Path,
    backup_file_path: &Path,
    zip: &mut zip::ZipWriter<fs::File>,
    source_size_bytes: &mut u64,
    progress: &std::sync::Arc<std::sync::Mutex<BackupProgressInner>>,
) -> Result<usize, String> {
    let mut archived_count = 0usize;

    let entries = fs::read_dir(current)
        .map_err(|error| format!("读取目录失败: {} ({error})", current.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let path = entry.path();
        if path == backup_file_path {
            continue;
        }

        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取文件信息失败: {} ({error})", path.display()))?;

        if metadata.file_type().is_symlink() {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("计算相对路径失败: {error}"))?;

        if is_excluded_from_openclaw_backup(relative) {
            continue;
        }

        let relative_str = relative.to_string_lossy().replace('\\', "/");
        if relative_str.is_empty() {
            continue;
        }

        if metadata.is_dir() {
            let dir_options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o755);
            zip.add_directory(format!("{relative_str}/"), dir_options)
                .map_err(|error| format!("写入目录到 ZIP 失败: {relative_str} ({error})"))?;

            archived_count += zip_openclaw_dir_recursive(
                root,
                &path,
                backup_file_path,
                zip,
                source_size_bytes,
                progress,
            )?;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let file_options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file(relative_str.as_str(), file_options)
            .map_err(|error| format!("写入文件到 ZIP 失败: {relative_str} ({error})"))?;

        let mut file = fs::File::open(&path)
            .map_err(|error| format!("打开文件失败: {} ({error})", path.display()))?;
        std::io::copy(&mut file, zip)
            .map_err(|error| format!("压缩文件失败: {} ({error})", path.display()))?;

        *source_size_bytes = source_size_bytes.saturating_add(metadata.len());
        archived_count += 1;

        if let Ok(mut state) = progress.lock() {
            state.processed_files += 1;
        }
    }

    Ok(archived_count)
}

fn resolve_restore_backup_path(backup_file_path: Option<String>) -> Result<PathBuf, String> {
    let backup_dir = resolve_openclaw_config_dir()?.join("backups");

    if let Some(input) = backup_file_path {
        let trimmed = input.trim().trim_matches('"').trim_matches('\'');
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_absolute() {
                return Ok(candidate);
            }

            // Allow users to pass only the backup file name; resolve under ~/.openclaw/backups.
            return Ok(backup_dir.join(candidate));
        }
    }

    if !backup_dir.exists() {
        return Err("未找到备份目录，请先执行“备份龙虾”".into());
    }

    let mut candidates = Vec::<(SystemTime, PathBuf)>::new();
    for entry in fs::read_dir(&backup_dir).map_err(|error| format!("读取备份目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读取备份目录项失败: {error}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if extension != "zip" {
            continue;
        }

        let modified = fs::metadata(&path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        candidates.push((modified, path));
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, path)| path)
        .ok_or_else(|| "未找到可用备份文件，请先执行“备份龙虾”".to_string())
}

#[tauri::command]
fn pick_openclaw_backup_file() -> Result<Option<String>, String> {
    let backup_dir = resolve_openclaw_config_dir()?.join("backups");

    let mut dialog = rfd::FileDialog::new()
        .set_title("选择龙虾备份文件")
        .add_filter("ZIP 文件", &["zip"]);

    if backup_dir.exists() {
        dialog = dialog.set_directory(&backup_dir);
    }

    Ok(dialog
        .pick_file()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn backup_openclaw_config(progress: State<'_, BackupProgressHandle>) -> Result<(), String> {
    let config_root = resolve_openclaw_config_dir()?;
    if !config_root.exists() {
        return Err("未检测到 ~/.openclaw，请先完成 OpenClaw 安装".into());
    }

    {
        let state = progress
            .inner
            .lock()
            .map_err(|_| "backup state poisoned".to_string())?;
        if state.active {
            return Ok(());
        }
    }

    {
        let mut state = progress
            .inner
            .lock()
            .map_err(|_| "backup state poisoned".to_string())?;
        *state = BackupProgressInner {
            active: true,
            completed: false,
            error: None,
            ..Default::default()
        };
    }

    let progress_arc = progress.inner.clone();

    tauri::async_runtime::spawn(async move {
        let progress_for_blocking = progress_arc.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let total_files = count_openclaw_files_recursive(&config_root, &config_root);
            if let Ok(mut state) = progress_for_blocking.lock() {
                state.total_files = total_files;
            }

            let backup_dir = config_root.join("backups");
            if let Err(error) = fs::create_dir_all(&backup_dir) {
                if let Ok(mut state) = progress_for_blocking.lock() {
                    state.active = false;
                    state.error = Some(format!("创建备份目录失败: {error}"));
                }
                return;
            }

            let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
            let backup_file_name = format!("rhclaw-config-backup-{timestamp}.zip");
            let backup_file_path = backup_dir.join(&backup_file_name);

            let file = match fs::File::create(&backup_file_path) {
                Ok(file) => file,
                Err(error) => {
                    if let Ok(mut state) = progress_for_blocking.lock() {
                        state.active = false;
                        state.error = Some(format!(
                            "创建备份文件失败: {} ({error})",
                            backup_file_path.display()
                        ));
                    }
                    return;
                }
            };
            let mut zip = zip::ZipWriter::new(file);
            let mut source_size_bytes = 0u64;

            let archived_count = match zip_openclaw_dir_recursive(
                &config_root,
                &config_root,
                &backup_file_path,
                &mut zip,
                &mut source_size_bytes,
                &progress_for_blocking,
            ) {
                Ok(count) => count,
                Err(error) => {
                    if let Ok(mut state) = progress_for_blocking.lock() {
                        state.active = false;
                        state.error = Some(error);
                    }
                    return;
                }
            };

            if let Err(error) = zip.finish() {
                if let Ok(mut state) = progress_for_blocking.lock() {
                    state.active = false;
                    state.error = Some(format!("完成备份压缩失败: {error}"));
                }
                return;
            }

            if archived_count == 0 {
                if let Ok(mut state) = progress_for_blocking.lock() {
                    state.active = false;
                    state.error = Some("未发现可备份内容（已排除 logs）".to_string());
                }
                return;
            }

            let backup_size_bytes = match fs::metadata(&backup_file_path) {
                Ok(metadata) => metadata.len(),
                Err(error) => {
                    if let Ok(mut state) = progress_for_blocking.lock() {
                        state.active = false;
                        state.error = Some(format!("读取备份文件信息失败: {error}"));
                    }
                    return;
                }
            };

            if let Ok(mut state) = progress_for_blocking.lock() {
                state.active = false;
                state.completed = true;
                state.backup_file_path = backup_file_path.to_string_lossy().to_string();
                state.backup_file_name = backup_file_name;
                state.backup_size_bytes = backup_size_bytes;
                state.source_size_bytes = source_size_bytes;
                state.detail = format!("备份完成，已归档 {archived_count} 个文件（已排除 logs 目录）");
            }
        })
        .await;

        if let Err(join_error) = result {
            if let Ok(mut state) = progress_arc.lock() {
                if !state.completed && state.error.is_none() {
                    state.active = false;
                    state.error = Some(format!("备份任务异常退出: {join_error}"));
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn get_backup_progress(state: State<'_, BackupProgressHandle>) -> Result<BackupProgressInner, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "backup state poisoned".to_string())?;
    Ok(inner.clone())
}

#[tauri::command]
fn restore_openclaw_config(
    backup_file_path: Option<String>,
) -> Result<OpenClawConfigRestoreResult, String> {
    let backup_path = resolve_restore_backup_path(backup_file_path)?;
    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {}", backup_path.display()));
    }

    let config_root = resolve_openclaw_config_dir()?;
    fs::create_dir_all(&config_root).map_err(|error| format!("创建配置目录失败: {error}"))?;

    let file = fs::File::open(&backup_path)
        .map_err(|error| format!("打开备份文件失败: {} ({error})", backup_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("解析备份 ZIP 失败: {error}"))?;

    let mut restored_count = 0usize;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩条目失败: {error}"))?;
        let entry_name = entry.name().replace('\\', "/");
        if entry_name.is_empty() {
            continue;
        }

        let entry_path = PathBuf::from(entry_name.as_str());
        for component in entry_path.components() {
            match component {
                std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_) => {
                    return Err("备份文件包含非法路径，已拒绝恢复".into());
                }
                _ => {}
            }
        }

        if is_excluded_from_openclaw_backup(&entry_path) {
            continue;
        }

        let output_path = config_root.join(&entry_path);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("创建目录失败: {} ({error})", output_path.display()))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建目录失败: {} ({error})", parent.display()))?;
        }

        let mut output = fs::File::create(&output_path)
            .map_err(|error| format!("创建文件失败: {} ({error})", output_path.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("写入文件失败: {} ({error})", output_path.display()))?;
        restored_count += 1;
    }

    if restored_count == 0 {
        return Err("备份文件未包含可恢复内容（logs 目录会被自动忽略）".into());
    }

    Ok(OpenClawConfigRestoreResult {
        ok: true,
        restored_from: backup_path.to_string_lossy().to_string(),
        restored_count,
        detail: "恢复完成，已覆盖写入 OpenClaw 配置（logs 目录保持不变）".into(),
    })
}

#[tauri::command]
fn get_openclaw_memory_overview(selected_day: Option<String>) -> Result<OpenClawMemoryOverview, String> {
    load_openclaw_memory_overview(selected_day)
}

fn truncate_cli_output(text: &str) -> String {
    const CLI_OUTPUT_LIMIT: usize = 4000;
    let trimmed = text.trim();
    if trimmed.chars().count() <= CLI_OUTPUT_LIMIT {
        return trimmed.to_string();
    }

    let truncated = trimmed.chars().take(CLI_OUTPUT_LIMIT).collect::<String>();
    format!("{truncated}\n...[truncated]")
}

fn classify_openclaw_cli_error(detail: &str) -> &'static str {
    let lowered = detail.to_ascii_lowercase();
    if detail.contains("未检测到 openclaw CLI") {
        "CLI_NOT_FOUND"
    } else if lowered.contains("tty") || lowered.contains("interactive") {
        "TTY_REQUIRED"
    } else if detail.contains("JSON") || detail.contains("json") || detail.contains("解析") {
        "PARSE_FAILED"
    } else {
        "COMMAND_FAILED"
    }
}

fn build_openclaw_cli_result(
    ok: bool,
    stdout: &str,
    stderr: &str,
    parsed: Option<serde_json::Value>,
    error_code: Option<&str>,
    detail: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "ok": ok,
        "stdout": truncate_cli_output(stdout),
        "stderr": truncate_cli_output(stderr),
        "parsed": parsed,
        "errorCode": error_code,
        "detail": detail,
    })
}

fn run_openclaw_cli_json_command(args: Vec<String>) -> serde_json::Value {
    let arg_refs = args.iter().map(|value| value.as_str()).collect::<Vec<_>>();
    match execute_openclaw_command(&arg_refs, &[]) {
        Ok((stdout, stderr)) => match extract_json_payload(&stdout) {
            Ok(parsed) => build_openclaw_cli_result(true, &stdout, &stderr, Some(parsed), None, None),
            Err(error) => build_openclaw_cli_result(
                false,
                &stdout,
                &stderr,
                None,
                Some("PARSE_FAILED"),
                Some(error.as_str()),
            ),
        },
        Err(error) => build_openclaw_cli_result(
            false,
            "",
            &error,
            None,
            Some(classify_openclaw_cli_error(&error)),
            Some(error.as_str()),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsAuthPasteTokenArgs {
    provider: String,
    token: String,
    profile_id: Option<String>,
    expires_in: Option<String>,
}

#[tauri::command]
fn models_capability_probe() -> Result<serde_json::Value, String> {
    let Some(cli_path) = detect_openclaw_cli() else {
        let detail = "未检测到 openclaw CLI，请先安装 OpenClaw 官方 CLI。";
        return Ok(build_openclaw_cli_result(
            false,
            "",
            detail,
            Some(serde_json::json!({
                "cliAvailable": false,
                "listCapability": false,
                "statusCapability": false,
                "setCapability": false,
                "authCapability": false,
            })),
            Some("CLI_NOT_FOUND"),
            Some(detail),
        ));
    };

    let help_args = ["models", "--help"];
    let (stdout, stderr, parsed, error_code, detail) = match execute_openclaw_command(&help_args, &[]) {
        Ok((stdout, stderr)) => {
            let combined = if stderr.trim().is_empty() {
                stdout.clone()
            } else {
                format!("{stdout}\n{stderr}")
            };
            let lowered = combined.to_ascii_lowercase();
            (
                stdout,
                stderr,
                serde_json::json!({
                    "cliAvailable": true,
                    "cliPath": cli_path,
                    "listCapability": lowered.contains("list"),
                    "statusCapability": lowered.contains("status"),
                    "setCapability": lowered.contains("set"),
                    "authCapability": lowered.contains("auth"),
                }),
                None,
                None,
            )
        }
        Err(error) => (
            String::new(),
            error.clone(),
            serde_json::json!({
                "cliAvailable": true,
                "cliPath": cli_path,
                "listCapability": false,
                "statusCapability": false,
                "setCapability": false,
                "authCapability": false,
            }),
            Some(classify_openclaw_cli_error(&error)),
            Some(error),
        ),
    };

    Ok(build_openclaw_cli_result(
        error_code.is_none(),
        &stdout,
        &stderr,
        Some(parsed),
        error_code,
        detail.as_deref(),
    ))
}

#[tauri::command]
fn models_list_all(provider: Option<String>) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "models".to_string(),
        "list".to_string(),
        "--all".to_string(),
        "--json".to_string(),
    ];
    if let Some(provider) = provider.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        args.push("--provider".to_string());
        args.push(provider);
    }
    Ok(run_openclaw_cli_json_command(args))
}

#[tauri::command]
fn models_status() -> Result<serde_json::Value, String> {
    Ok(run_openclaw_cli_json_command(vec![
        "models".to_string(),
        "status".to_string(),
        "--json".to_string(),
    ]))
}

#[tauri::command]
fn models_set(model_key: String) -> Result<serde_json::Value, String> {
    let trimmed = model_key.trim();
    if trimmed.is_empty() {
        return Ok(build_openclaw_cli_result(
            false,
            "",
            "模型标识不能为空。",
            None,
            Some("INVALID_ARGS"),
            Some("模型标识不能为空。"),
        ));
    }

    let args = vec!["models", "set", trimmed];
    match execute_openclaw_command(&args, &[]) {
        Ok((stdout, stderr)) => Ok(build_openclaw_cli_result(true, &stdout, &stderr, None, None, None)),
        Err(error) => Ok(build_openclaw_cli_result(
            false,
            "",
            &error,
            None,
            Some(classify_openclaw_cli_error(&error)),
            Some(error.as_str()),
        )),
    }
}

#[tauri::command]
fn models_auth_paste_token(args: ModelsAuthPasteTokenArgs) -> Result<serde_json::Value, String> {
    let provider = args.provider.trim();
    if provider.is_empty() {
        return Ok(build_openclaw_cli_result(
            false,
            "",
            "Provider 不能为空。",
            None,
            Some("INVALID_ARGS"),
            Some("Provider 不能为空。"),
        ));
    }

    let token = args.token.trim();
    if token.is_empty() {
        return Ok(build_openclaw_cli_result(
            false,
            "",
            "Token 不能为空。",
            None,
            Some("INVALID_ARGS"),
            Some("Token 不能为空。"),
        ));
    }

    let mut argv = vec![
        "models".to_string(),
        "auth".to_string(),
        "paste-token".to_string(),
        "--provider".to_string(),
        provider.to_string(),
    ];

    if let Some(profile_id) = args.profile_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        argv.push("--profile-id".to_string());
        argv.push(profile_id.to_string());
    }

    if let Some(expires_in) = args.expires_in.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        argv.push("--expires-in".to_string());
        argv.push(expires_in.to_string());
    }

    let arg_refs = argv.iter().map(|value| value.as_str()).collect::<Vec<_>>();
    match execute_openclaw_command_with_input(&arg_refs, &[], Some(format!("{token}\n")), std::time::Duration::from_secs(OPENCLAW_COMMAND_TIMEOUT_SECS)) {
        Ok((stdout, stderr)) => Ok(build_openclaw_cli_result(true, &stdout, &stderr, None, None, None)),
        Err(error) => Ok(build_openclaw_cli_result(
            false,
            "",
            &error,
            None,
            Some(classify_openclaw_cli_error(&error)),
            Some(error.as_str()),
        )),
    }
}

#[tauri::command]
fn create_bind_session_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/bind-session");
    let body = serde_json::json!({ "ttlMinutes": 10 });

    perform_native_json_request(Method::POST, &url, Some(body), Some(&args.device_token))
}

#[tauri::command]
fn get_bind_session_status_http(args: NativeBindStatusArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!(
        "{api_base_url}/devices/bind-session/{}/status",
        args.session_token
    );

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn get_current_device_profile_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/profile");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn get_desktop_subscription_status_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/subscription/status");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn get_desktop_version_check_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/version-check");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn get_desktop_llm_overview_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/llm/overview");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn fetch_install_llm_config_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/desktop/install/llm-config");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn fetch_install_skills_config_http(args: NativeApiBaseUrlArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/desktop/install/skills");

    perform_native_json_request(Method::GET, &url, None, None)
}

#[tauri::command]
fn get_desktop_llm_assignment_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/llm/assignment");

    perform_native_json_request(Method::GET, &url, None, Some(&args.device_token))
}

#[tauri::command]
fn reassign_desktop_llm_http(args: NativeDeviceTokenArgs) -> Result<serde_json::Value, String> {
    let api_base_url = normalize_api_base_url(&args.api_base_url);
    let url = format!("{api_base_url}/devices/me/llm/reassign");

    perform_native_json_request(Method::POST, &url, Some(serde_json::json!({})), Some(&args.device_token))
}

/// Returns true when the given OpenClaw provider prefix has a **native driver**
/// (i.e. it is one of the 23 built-in providers shipped with OpenClaw Gateway).
/// For native providers we must NOT override `api` with "openai-completions";
/// only the generic "openai" compat prefix needs that adapter.
fn has_native_openclaw_driver(prefix: &str) -> bool {
    matches!(
        prefix,
        "zai"
            | "anthropic"
            | "google"
            | "google-antigravity"
            | "google-gemini-cli"
            | "google-vertex"
            | "minimax"
            | "minimax-cn"
            | "openrouter"
            | "xai"
            | "mistral"
            | "kimi-coding"
            | "opencode"
            | "opencode-go"
            | "amazon-bedrock"
            | "cerebras"
            | "github-copilot"
            | "groq"
            | "huggingface"
            | "azure-openai-responses"
            | "openai-codex"
            | "vercel-ai-gateway"
    )
}

/// Fix unquoted JSON object keys that the OpenClaw CLI may emit (e.g. `models: {`).
/// Only bare-word keys at line start (with optional leading whitespace) are patched.
fn sanitize_json_unquoted_keys(raw: &str) -> String {
    // Regex: line-start whitespace, then a bare identifier followed by `:`
    // but NOT inside a string value (good-enough heuristic for pretty-printed JSON).
    let re = regex::Regex::new(r#"(?m)^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:"#).unwrap();
    re.replace_all(raw, r#"$1"$2":"#).into_owned()
}

#[tauri::command]
fn write_gateway_llm_config(args: GatewayLlmConfigArgs) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定用户 HOME 目录".to_string())?;
    let config_dir = PathBuf::from(&home).join(".openclaw");
    let config_path = config_dir.join("openclaw.json");
    let env_path = config_dir.join(".env");

    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("创建 .openclaw 目录失败: {e}"))?;

    let mut env_lines = if env_path.exists() {
        fs::read_to_string(&env_path)
            .map_err(|e| format!("读取 .env 失败: {e}"))?
            .lines()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let compat_prefix = args.openai_compat_prefix
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("openai")
        .to_ascii_lowercase();

    save_model_secret_to_native_keyring(&compat_prefix, &args.api_key)?;

    let api_key_env_name = match compat_prefix.as_str() {
        "zai" => "ZAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "google" => "GEMINI_API_KEY",
        "minimax" | "minimax-cn" => "MINIMAX_API_KEY",
        "moonshot" => "MOONSHOT_API_KEY",
        "kimi-coding" => "KIMI_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        "xai" => "XAI_API_KEY",
        "mistral" => "MISTRAL_API_KEY",
        "opencode" | "opencode-go" => "OPENCODE_API_KEY",
        _ => "OPENAI_API_KEY",
    };

    env_lines.retain(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with(&format!("{api_key_env_name}="))
            && !trimmed.starts_with("OPENAI_BASE_URL=")
    });

    if env_lines.is_empty() {
        if env_path.exists() {
            fs::remove_file(&env_path).map_err(|e| format!("清理 .env 失败: {e}"))?;
        }
    } else {
        fs::write(&env_path, format!("{}\n", env_lines.join("\n")))
            .map_err(|e| format!("写入 .env 失败: {e}"))?;
        #[cfg(unix)]
        {
            let permissions = fs::Permissions::from_mode(0o600);
            fs::set_permissions(&env_path, permissions)
                .map_err(|e| format!("设置 .env 权限失败: {e}"))?;
        }
    }

    let mut cfg: serde_json::Value = if config_path.exists() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("读取 openclaw.json 失败: {e}"))?;
        let sanitized = sanitize_json_unquoted_keys(&raw);
        serde_json::from_str(&sanitized)
            .map_err(|e| format!("解析 openclaw.json 失败: {e}"))?
    } else {
        serde_json::json!({})
    };

    if !cfg.get("agents").is_some_and(|v| v.is_object()) {
        cfg["agents"] = serde_json::json!({});
    }
    if !cfg["agents"].get("defaults").is_some_and(|v| v.is_object()) {
        cfg["agents"]["defaults"] = serde_json::json!({});
    }
    if !cfg.get("secrets").is_some_and(|v| v.is_object()) {
        cfg["secrets"] = serde_json::json!({});
    }
    if !cfg["secrets"].get("providers").is_some_and(|v| v.is_object()) {
        cfg["secrets"]["providers"] = serde_json::json!({});
    }
    if !cfg["secrets"].get("defaults").is_some_and(|v| v.is_object()) {
        cfg["secrets"]["defaults"] = serde_json::json!({});
    }

    let legacy_file_provider_name = format!("{}_file", compat_prefix);
    let secret_ref_id = secret_ref_id_for_provider(&compat_prefix);
    let resolver_command = resolve_secret_resolver_command_path()?;
    cfg["secrets"]["providers"][OPENCLAW_SECRET_EXEC_PROVIDER] = serde_json::json!({
        "source": "exec",
        "command": resolver_command,
        "args": [SECRET_RESOLVER_MODE_ARG],
        "jsonOnly": true,
        "timeoutMs": 3000,
        "allowInsecurePath": true,
    });
    cfg["secrets"]["defaults"]["exec"] = serde_json::json!(OPENCLAW_SECRET_EXEC_PROVIDER);
    if let Some(providers_obj) = cfg["secrets"]["providers"].as_object_mut() {
        providers_obj.remove(&legacy_file_provider_name);
    }

    // OpenClaw model identifiers are lowercase
    let model_lower = args.model.to_lowercase();
    let model_value = if model_lower.contains('/') {
        model_lower.clone()
    } else {
        format!("{compat_prefix}/{model_lower}")
    };
    cfg["agents"]["defaults"]["model"] = serde_json::json!(model_value.clone());

    // Ensure the model is registered in models.providers so Gateway can resolve it.
    // Without this, "Unknown model: <prefix>/<model>" occurs when the model is
    // not in OpenClaw's built-in catalog.
    let bare_model = model_value.split('/').last().unwrap_or(&model_lower);
    if !cfg.get("models").is_some_and(|v| v.is_object()) {
        cfg["models"] = serde_json::json!({"mode": "merge", "providers": {}});
    }
    if !cfg["models"].get("providers").is_some_and(|v| v.is_object()) {
        cfg["models"]["providers"] = serde_json::json!({});
    }
    let providers = cfg["models"].get_mut("providers").unwrap();
    // Native OpenClaw providers (zai, anthropic, google …) have their own driver;
    // only the generic "openai" compat prefix needs api: "openai-completions".
    // Reference: https://docs.bigmodel.cn/cn/coding-plan/tool/openclaw
    let native = has_native_openclaw_driver(&compat_prefix);

    // Create or update the provider entry keyed by compat_prefix
    if !providers.get(&compat_prefix).is_some_and(|v| v.is_object()) {
        let mut provider_obj = serde_json::json!({
            "apiKey": {
                "source": "exec",
                "provider": OPENCLAW_SECRET_EXEC_PROVIDER,
                "id": &secret_ref_id
            },
            "baseUrl": args.base_url,
            "models": []
        });
        if !native {
            provider_obj["api"] = serde_json::json!("openai-completions");
        }
        providers[&compat_prefix] = provider_obj;
    } else {
        providers[&compat_prefix]["baseUrl"] = serde_json::json!(args.base_url);
        providers[&compat_prefix]["apiKey"] = serde_json::json!({
            "source": "exec",
            "provider": OPENCLAW_SECRET_EXEC_PROVIDER,
            "id": &secret_ref_id
        });
        if !native {
            if !providers[&compat_prefix].get("api").is_some_and(|v| v.is_string()) {
                providers[&compat_prefix]["api"] = serde_json::json!("openai-completions");
            }
        } else {
            if let Some(obj) = providers[&compat_prefix].as_object_mut() {
                obj.remove("api");
            }
        }
    }
    let model_list = providers[&compat_prefix]
        .get_mut("models")
        .and_then(|v| v.as_array_mut());
    if let Some(arr) = model_list {
        let already = arr.iter().any(|m| m.get("id").and_then(|v| v.as_str()) == Some(bare_model));
        if !already {
            arr.push(serde_json::json!({"id": bare_model, "name": bare_model}));
        }
    } else {
        providers[&compat_prefix]["models"] = serde_json::json!([{"id": bare_model, "name": bare_model}]);
    }

    let serialized = serde_json::to_vec_pretty(&cfg)
        .map_err(|e| format!("序列化 openclaw.json 失败: {e}"))?;
    fs::write(&config_path, &serialized)
        .map_err(|e| format!("写入 openclaw.json 失败: {e}"))?;

    let (restart_required, detail) = match execute_openclaw_command(&["secrets", "reload"], &[]) {
        Ok(_) => (
            false,
            "已写入 OpenClaw SecretRef，并完成本地 secrets reload。".to_string(),
        ),
        Err(error) => (
            true,
            format!(
                "已写入 OpenClaw SecretRef，但 secrets reload 失败，将回退为 Gateway 重启生效：{error}"
            ),
        ),
    };

    Ok(serde_json::json!({
        "envPath": env_path.to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "model": model_value,
        "baseUrl": args.base_url,
        "applyMode": "config-set",
        "restartRequired": restart_required,
        "detail": detail,
        "secretRefProvider": OPENCLAW_SECRET_EXEC_PROVIDER,
        "secretRefId": secret_ref_id,
    }))
}

#[tauri::command]
fn restart_gateway() -> Result<serde_json::Value, String> {
    let _ = execute_openclaw_command(&["gateway", "stop"], &[]);
    // Brief pause after stop to release port
    std::thread::sleep(std::time::Duration::from_millis(500));

    let installed_service = start_openclaw_gateway_runtime(None)
        .map_err(|error| format!("Gateway 启动失败: {error}"))?;

    // Poll /health instead of sleeping a fixed duration
    let probe = poll_gateway_until_healthy(Duration::from_secs(10), Duration::from_millis(500));
    Ok(serde_json::json!({
        "running": probe.running,
        "detail": if installed_service {
            format!("{}（已自动安装 Gateway 服务）", probe.detail)
        } else {
            probe.detail
        },
    }))
}

fn snapshot(runtime: &AgentRuntimeState, detail: &str) -> AgentStatus {
    AgentStatus {
        available: true,
        running: runtime.running,
        mode: "tauri-sidecar".into(),
        detail: detail.into(),
        session_id: runtime.session_id.clone(),
        last_heartbeat_at: runtime.last_heartbeat_at.clone(),
        heartbeat_count: runtime.heartbeat_count,
        log_file_path: runtime.log_file_path.clone(),
        logs: runtime.logs.clone(),
    }
}

fn push_log(logs: &mut Vec<AgentLogEntry>, entry: AgentLogEntry) {
    logs.insert(0, entry);
    if logs.len() > 50 {
        logs.truncate(50);
    }
}

fn default_log_path() -> Result<PathBuf, String> {
    let base_dir = std::env::temp_dir().join("rhopenclaw-desktop").join("logs");
    fs::create_dir_all(&base_dir).map_err(|error| format!("failed to create log dir: {error}"))?;
    Ok(base_dir.join("agent-heartbeat.log"))
}

struct DesktopStoragePaths {
    base_dir: PathBuf,
    json_state_path: PathBuf,
    sqlite_path: PathBuf,
    credential_path: PathBuf,
}

fn legacy_desktop_storage_paths() -> DesktopStoragePaths {
    let base_dir = std::env::temp_dir().join("rhopenclaw-desktop").join("storage");
    DesktopStoragePaths {
        json_state_path: base_dir.join("state").join("desktop-state.json"),
        sqlite_path: base_dir.join("state").join("desktop-state.sqlite3"),
        credential_path: base_dir.join("credentials").join("device-token.stub"),
        base_dir,
    }
}

fn migrate_legacy_desktop_storage_if_needed(paths: &DesktopStoragePaths) -> Result<(), String> {
    let legacy_paths = legacy_desktop_storage_paths();
    if legacy_paths.base_dir == paths.base_dir || !legacy_paths.base_dir.exists() {
        return Ok(());
    }

    ensure_storage_layout(paths)?;

    let migration_pairs = [
        (&legacy_paths.json_state_path, &paths.json_state_path),
        (&legacy_paths.sqlite_path, &paths.sqlite_path),
        (&legacy_paths.credential_path, &paths.credential_path),
    ];

    for (legacy, target) in migration_pairs {
        if target.exists() || !legacy.exists() {
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create migrated storage dir {}: {error}", parent.display()))?;
        }

        fs::copy(legacy, target).map_err(|error| {
            format!(
                "failed to migrate desktop storage from {} to {}: {error}",
                legacy.display(),
                target.display()
            )
        })?;
    }

    Ok(())
}

pub(crate) struct RuntimePackagePaths {
    pub(crate) install_dir: PathBuf,
    pub(crate) manifest_path: PathBuf,
    pub(crate) executable_path: PathBuf,
}

struct RHClawPluginPaths {
    plugin_dir: PathBuf,
    manifest_path: PathBuf,
    generated_config_path: PathBuf,
    plugin_env_path: PathBuf,
    installed_package_dir: PathBuf,
    install_receipt_path: PathBuf,
}

fn desktop_storage_paths() -> Result<DesktopStoragePaths, String> {
    let data_root = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法确定 Desktop 本地数据目录。".to_string())?;
    let base_dir = data_root.join("RHOpenClaw-Desktop").join("storage");
    let paths = DesktopStoragePaths {
        json_state_path: base_dir.join("state").join("desktop-state.json"),
        sqlite_path: base_dir.join("state").join("desktop-state.sqlite3"),
        credential_path: base_dir.join("credentials").join("device-token.stub"),
        base_dir,
    };
    migrate_legacy_desktop_storage_if_needed(&paths)?;
    Ok(paths)
}

fn ensure_storage_layout(paths: &DesktopStoragePaths) -> Result<(), String> {
    fs::create_dir_all(paths.base_dir.join("state"))
        .map_err(|error| format!("failed to create state dir: {error}"))?;
    fs::create_dir_all(paths.base_dir.join("credentials"))
        .map_err(|error| format!("failed to create credential dir: {error}"))?;
    Ok(())
}

#[tauri::command]
fn runtime_package_status(state: State<'_, ManagedRuntimeStateHandle>) -> Result<RuntimePackageStatus, String> {
    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    let gateway = probe_gateway_running();
    let detail = if gateway.running {
        format!("OpenClaw Gateway 已运行。{}", gateway.detail)
    } else {
        format!("OpenClaw Gateway 未运行。{}", gateway.detail)
    };
    build_runtime_package_status(&detail, Some(&runtime))
}

#[tauri::command]
fn probe_openclaw_runtime(
    endpoint: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<OpenClawRuntimeProbeStatus, String> {
    let normalized_endpoint = endpoint
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{OPENCLAW_DEFAULT_GATEWAY_PORT}"));
    let health_url = format!("{normalized_endpoint}/health");
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).max(1000).min(30000));

    let gateway_version = detect_openclaw_version().or_else(detect_openclaw_cli_version);
    let checked_at = now_iso_string();

    let client = Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| Client::new());

    let response = client
        .get(&health_url)
        .header("Accept", "application/json")
        .send();

    match response {
        Ok(resp) => {
            if resp.status().is_success() {
                let body = resp.text().unwrap_or_default();
                let payload = serde_json::from_str::<serde_json::Value>(&body).ok();
                let version = payload
                    .as_ref()
                    .and_then(|value| value.get("version").and_then(|field| field.as_str()))
                    .map(|value| value.to_string())
                    .or_else(|| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("data"))
                            .and_then(|value| value.get("version"))
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                    })
                    .or(gateway_version);

                let detail = payload
                    .as_ref()
                    .and_then(|value| value.get("message").and_then(|field| field.as_str()))
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "Gateway 健康检查通过。".to_string());

                Ok(OpenClawRuntimeProbeStatus {
                    healthy: true,
                    detail,
                    endpoint: normalized_endpoint,
                    checked_at,
                    version,
                })
            } else {
                let status = resp.status().as_u16();
                let gateway = probe_gateway_running();
                let detail = if gateway.running {
                    format!(
                        "Gateway 进程存活，但健康接口返回 HTTP {status}：{health_url}。{}",
                        gateway.detail
                    )
                } else {
                    format!(
                        "Gateway 健康检查失败（HTTP {status}）：{health_url}。{}",
                        gateway.detail
                    )
                };

                Ok(OpenClawRuntimeProbeStatus {
                    healthy: gateway.running,
                    detail,
                    endpoint: normalized_endpoint,
                    checked_at,
                    version: gateway_version,
                })
            }
        }
        Err(error) => {
            let gateway = probe_gateway_running();
            let detail = if gateway.running {
                format!(
                    "Gateway 进程存活，但健康接口暂不可达（{health_url}）：{error}。{}",
                    gateway.detail
                )
            } else {
                format!(
                    "Gateway 健康检查连接失败：{health_url}。{error}。{}",
                    gateway.detail
                )
            };

            Ok(OpenClawRuntimeProbeStatus {
                healthy: gateway.running,
                detail,
                endpoint: normalized_endpoint,
                checked_at,
                version: gateway_version,
            })
        }
    }
}

#[tauri::command]
fn read_runtime_logs(max_lines: Option<usize>) -> Result<Vec<String>, String> {
    let log_path = default_runtime_log_path()?;
    read_log_tail(&log_path, max_lines.unwrap_or(120))
}

#[tauri::command]
fn autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("failed to read autostart status: {error}"))?;

    Ok(AutostartStatus {
        available: true,
        enabled,
        launcher: autostart_launcher_name().into(),
        detail: if enabled {
            "应用已登记为系统启动时自动运行。".into()
        } else {
            "应用当前不会在系统启动时自动运行。".into()
        },
    })
}

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("failed to enable autostart: {error}"))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| format!("failed to disable autostart: {error}"))?;
    }

    Ok(AutostartStatus {
        available: true,
        enabled,
        launcher: autostart_launcher_name().into(),
        detail: if enabled {
            "已启用开机自启，后续系统登录后会自动拉起桌面端。".into()
        } else {
            "已关闭开机自启，应用将仅在手动启动时运行。".into()
        },
    })
}

#[tauri::command]
fn start_runtime_process(state: State<'_, ManagedRuntimeStateHandle>) -> Result<RuntimePackageStatus, String> {
    let had_previous_start = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?
        .last_started_at
        .is_some();
    let installed_service = start_openclaw_gateway_runtime(Some(&state.inner))?;

    let gateway = probe_gateway_running();
    let mut runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    if had_previous_start {
        runtime.restart_count += 1;
    }
    runtime.running = gateway.running;
    runtime.child = None;
    runtime.process_id = None;
    runtime.process_mode = Some("openclaw-gateway-daemon".into());
    runtime.last_started_at = Some(now_iso_string());
    runtime.log_file_path = None;

    build_runtime_package_status(
        if installed_service {
            if cfg!(target_os = "windows") {
                "OpenClaw Gateway 已执行官方受管安装并完成启动检查"
            } else {
                "OpenClaw Gateway 已自动安装 LaunchAgent，并执行官方启动命令"
            }
        } else {
            "OpenClaw Gateway 已执行官方启动命令"
        },
        Some(&runtime),
    )
}

#[tauri::command]
fn stop_runtime_process(state: State<'_, ManagedRuntimeStateHandle>) -> Result<RuntimePackageStatus, String> {
    let mut runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;

    if let Some(mut child) = runtime.child.take() {
        let _ = child.kill();
    }
    execute_openclaw_command(&["gateway", "stop"], &[])?;

    runtime.running = false;
    runtime.process_id = None;
    runtime.process_mode = Some("openclaw-gateway-daemon".into());
    runtime.last_stopped_at = Some(now_iso_string());
    runtime.log_file_path = None;
    build_runtime_package_status(
        "OpenClaw Gateway 已执行官方停止命令",
        Some(&runtime),
    )
}

fn open_state_database(paths: &DesktopStoragePaths) -> Result<Connection, String> {
    ensure_storage_layout(paths)?;
    let connection = Connection::open(&paths.sqlite_path)
        .map_err(|error| format!("failed to open sqlite state db: {error}"))?;
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS app_state_snapshots (
                storage_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|error| format!("failed to initialize sqlite schema: {error}"))?;
    Ok(connection)
}

fn read_state_snapshot_metadata(paths: &DesktopStoragePaths) -> (bool, Option<String>) {
    if !paths.sqlite_path.exists() {
        return (false, None);
    }

    let Ok(connection) = open_state_database(paths) else {
        return (false, None);
    };

    let updated_at = connection
        .query_row(
            "SELECT updated_at FROM app_state_snapshots WHERE storage_key = ?1",
            params![STATE_SNAPSHOT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();

    (true, updated_at)
}

fn write_device_secret(paths: &DesktopStoragePaths, secret: &str) -> Result<(), String> {
    // Persist to SQLite as durable fallback
    let sqlite_ok = write_device_secret_to_sqlite(paths, secret).is_ok();

    // Always write credential file as primary storage (avoids macOS keychain prompts)
    let file_ok = fs::write(&paths.credential_path, secret).is_ok();

    if sqlite_ok || file_ok {
        Ok(())
    } else {
        Err("failed to write device secret to both SQLite and file".to_string())
    }
}

fn read_device_secret(paths: &DesktopStoragePaths) -> Result<String, String> {
    // Try SQLite first
    let sqlite_secret = read_device_secret_from_sqlite(paths).unwrap_or_default();
    if !sqlite_secret.is_empty() {
        return Ok(sqlite_secret);
    }

    // Try credential file
    if paths.credential_path.exists() {
        let file_secret = fs::read_to_string(&paths.credential_path).unwrap_or_default();
        if !file_secret.trim().is_empty() {
            write_device_secret_to_sqlite(paths, file_secret.trim()).ok();
            return Ok(file_secret.trim().to_string());
        }
    }

    Ok(String::new())
}

fn clear_device_secret(paths: &DesktopStoragePaths) -> Result<(), String> {
    clear_device_secret_from_sqlite(paths).ok();

    if paths.credential_path.exists() {
        fs::remove_file(&paths.credential_path)
            .map_err(|error| format!("failed to remove device secret stub: {error}"))?;
    }

    Ok(())
}

fn read_env_value(path: &Path, key: &str) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read env file {}: {error}", path.display()))?;
    let prefix = format!("{key}=");

    for line in content.lines() {
        if let Some(value) = line.strip_prefix(&prefix) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed.to_string()));
            }
        }
    }

    Ok(None)
}

fn resolve_rhclaw_persistent_env_path() -> Result<PathBuf, String> {
    Ok(resolve_openclaw_state_dir()?
        .join("extensions")
        .join("rhclaw-channel")
        .join("generated")
        .join("rhclaw-plugin.env"))
}

fn resolve_rhclaw_gateway_token_env_name() -> String {
    if let Ok(paths) = rhclaw_plugin_paths() {
        if paths.manifest_path.exists() {
            if let Ok(raw_manifest) = fs::read_to_string(&paths.manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<RHClawPluginManifest>(&raw_manifest) {
                    let env_name = manifest.config.gateway_token_env_name.trim();
                    if !env_name.is_empty() {
                        return env_name.to_string();
                    }
                }
            }
        }
    }

    RHCLAW_DEVICE_TOKEN_ENV_NAME.to_string()
}

fn read_rhclaw_device_token_from_sources(
    env_name: &str,
    current_ref_path: Option<&Path>,
) -> Result<Option<String>, String> {
    if let Some(path) = current_ref_path {
        if let Some(value) = read_env_value(path, env_name)? {
            return Ok(Some(value));
        }
    }

    let generated_env_path = rhclaw_plugin_paths()?.plugin_env_path;
    if let Some(value) = read_env_value(&generated_env_path, env_name)? {
        return Ok(Some(value));
    }

    let persistent_env_path = resolve_rhclaw_persistent_env_path()?;
    if let Some(value) = read_env_value(&persistent_env_path, env_name)? {
        return Ok(Some(value));
    }

    if let Ok(storage_paths) = desktop_storage_paths() {
        let secret = read_device_secret(&storage_paths).unwrap_or_default();
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }

    Ok(None)
}

fn write_rhclaw_env_file(path: &Path, env_name: &str, token: &str) -> Result<bool, String> {
    let desired_content = format!("{env_name}={token}\n");
    if let Ok(existing_content) = fs::read_to_string(path) {
        if existing_content == desired_content {
            return Ok(false);
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create RHClaw env dir {}: {error}", parent.display()))?;
    }

    fs::write(path, desired_content)
        .map_err(|error| format!("failed to write RHClaw env file {}: {error}", path.display()))?;
    Ok(true)
}

fn ensure_rhclaw_persistent_gateway_token_ref() -> Result<bool, String> {
    let config_path = resolve_openclaw_state_dir()?.join("openclaw.json");
    if !config_path.exists() {
        return Ok(false);
    }

    let raw_config = fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read openclaw.json for RHClaw token migration: {error}"))?;
    let sanitized = sanitize_json_unquoted_keys(&raw_config);
    let mut config_json = serde_json::from_str::<serde_json::Value>(&sanitized)
        .map_err(|error| format!("failed to parse openclaw.json for RHClaw token migration: {error}"))?;

    let Some(channel_config) = config_json
        .get_mut("channels")
        .and_then(|value| value.get_mut("rhclaw"))
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(false);
    };

    let env_name = resolve_rhclaw_gateway_token_env_name();
    let persistent_env_path = resolve_rhclaw_persistent_env_path()?;
    let current_ref_path = channel_config
        .get("gatewayTokenRef")
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .map(PathBuf::from);

    let mut changed = false;
    if let Some(token) = read_rhclaw_device_token_from_sources(&env_name, current_ref_path.as_deref())? {
        changed |= write_rhclaw_env_file(&persistent_env_path, &env_name, &token)?;
    }

    if persistent_env_path.exists() {
        let desired_id = persistent_env_path.to_string_lossy().to_string();
        let current_id = current_ref_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        let current_source = channel_config
            .get("gatewayTokenRef")
            .and_then(|value| value.get("source"))
            .and_then(|value| value.as_str());
        let current_provider = channel_config
            .get("gatewayTokenRef")
            .and_then(|value| value.get("provider"))
            .and_then(|value| value.as_str());

        if current_id.as_deref() != Some(desired_id.as_str())
            || current_source != Some("file")
            || current_provider != Some("desktop-managed")
        {
            channel_config.insert(
                "gatewayTokenRef".to_string(),
                serde_json::json!({
                    "source": "file",
                    "provider": "desktop-managed",
                    "id": desired_id,
                }),
            );
            changed = true;
        }
    }

    if changed {
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&config_json).map_err(|error| {
                format!("failed to serialize openclaw.json for RHClaw token migration: {error}")
            })?,
        )
        .map_err(|error| format!("failed to write openclaw.json for RHClaw token migration: {error}"))?;
        eprintln!(
            "[rhclaw] self-healed: migrated gatewayTokenRef to {}",
            persistent_env_path.display()
        );
    }

    Ok(changed)
}

fn recover_device_secret_from_rhclaw_env() -> Result<Option<String>, String> {
    let generated_env_path = rhclaw_plugin_paths()?.plugin_env_path;
    if let Some(value) = read_env_value(&generated_env_path, RHCLAW_DEVICE_TOKEN_ENV_NAME)? {
        return Ok(Some(value));
    }

    let persistent_env_path = resolve_rhclaw_persistent_env_path()?;

    read_env_value(&persistent_env_path, RHCLAW_DEVICE_TOKEN_ENV_NAME)
}

#[tauri::command]
fn recover_device_secret_stub() -> Result<String, String> {
    Ok(recover_device_secret_from_rhclaw_env()?.unwrap_or_default())
}

fn write_device_secret_to_sqlite(paths: &DesktopStoragePaths, secret: &str) -> Result<(), String> {
    let connection = open_state_database(paths)?;
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS device_secrets (
                secret_key TEXT PRIMARY KEY,
                secret_value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|error| format!("failed to create device_secrets table: {error}"))?;
    connection
        .execute(
            "INSERT INTO device_secrets (secret_key, secret_value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(secret_key) DO UPDATE SET secret_value = excluded.secret_value, updated_at = excluded.updated_at",
            params![DEVICE_SECRET_SQLITE_KEY, secret, now_iso_string()],
        )
        .map_err(|error| format!("failed to upsert device secret into sqlite: {error}"))?;
    Ok(())
}

fn read_device_secret_from_sqlite(paths: &DesktopStoragePaths) -> Result<String, String> {
    if !paths.sqlite_path.exists() {
        return Ok(String::new());
    }
    let connection = open_state_database(paths)?;
    // Table may not exist yet
    let result = connection
        .query_row(
            "SELECT secret_value FROM device_secrets WHERE secret_key = ?1",
            params![DEVICE_SECRET_SQLITE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to read device secret from sqlite: {error}"))?;
    Ok(result.unwrap_or_default())
}

fn clear_device_secret_from_sqlite(paths: &DesktopStoragePaths) -> Result<(), String> {
    if !paths.sqlite_path.exists() {
        return Ok(());
    }
    let connection = open_state_database(paths)?;
    connection
        .execute(
            "DELETE FROM device_secrets WHERE secret_key = ?1",
            params![DEVICE_SECRET_SQLITE_KEY],
        )
        .ok(); // table may not exist, ignore
    Ok(())
}

fn model_secret_file_path(provider: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定用户 HOME 目录".to_string())?;
    let dir = PathBuf::from(&home)
        .join(".openclaw")
        .join(".secrets");
    Ok(dir.join(format!("provider-{}.key", provider.trim().to_ascii_lowercase())))
}

fn normalize_model_secret_provider(provider: &str) -> String {
    provider.trim().to_ascii_lowercase()
}

fn secret_ref_id_for_provider(provider: &str) -> String {
    format!("providers/{}/apiKey", normalize_model_secret_provider(provider))
}

fn gateway_auth_secret_ref() -> serde_json::Value {
    serde_json::json!({
        "source": "exec",
        "provider": OPENCLAW_SECRET_EXEC_PROVIDER,
        "id": GATEWAY_AUTH_TOKEN_SECRET_REF_ID,
    })
}

fn resolve_secret_resolver_command_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("无法确定 SecretResolver 可执行路径: {error}"))
}

fn ensure_secret_exec_provider_config(cfg: &mut serde_json::Value) -> Result<bool, String> {
    let mut changed = false;

    if !cfg.get("secrets").is_some_and(|v| v.is_object()) {
        cfg["secrets"] = serde_json::json!({});
        changed = true;
    }
    if !cfg["secrets"].get("providers").is_some_and(|v| v.is_object()) {
        cfg["secrets"]["providers"] = serde_json::json!({});
        changed = true;
    }
    if !cfg["secrets"].get("defaults").is_some_and(|v| v.is_object()) {
        cfg["secrets"]["defaults"] = serde_json::json!({});
        changed = true;
    }

    let resolver_command = resolve_secret_resolver_command_path()?;
    let desired_provider = serde_json::json!({
        "source": "exec",
        "command": resolver_command,
        "args": [SECRET_RESOLVER_MODE_ARG],
        "jsonOnly": true,
        "timeoutMs": 3000,
        "allowInsecurePath": true,
    });

    if cfg["secrets"]["providers"]
        .get(OPENCLAW_SECRET_EXEC_PROVIDER)
        != Some(&desired_provider)
    {
        cfg["secrets"]["providers"][OPENCLAW_SECRET_EXEC_PROVIDER] = desired_provider;
        changed = true;
    }

    if cfg["secrets"]["defaults"].get("exec").and_then(|v| v.as_str())
        != Some(OPENCLAW_SECRET_EXEC_PROVIDER)
    {
        cfg["secrets"]["defaults"]["exec"] = serde_json::json!(OPENCLAW_SECRET_EXEC_PROVIDER);
        changed = true;
    }

    Ok(changed)
}

fn remove_legacy_model_secret_file(provider: &str) {
    if let Ok(file_path) = model_secret_file_path(provider) {
        if file_path.exists() {
            let _ = fs::remove_file(file_path);
        }
    }
}

fn load_model_secret_from_legacy_file(provider: &str) -> Result<String, String> {
    let file_path = model_secret_file_path(provider)?;
    if !file_path.exists() {
        return Err(format!("secret not found for provider: {provider}"));
    }

    let secret = fs::read_to_string(&file_path)
        .map_err(|error| format!("failed to read legacy model secret file: {error}"))?;
    let trimmed = secret.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("secret not found for provider: {provider}"));
    }

    Ok(trimmed)
}

#[cfg(target_os = "macos")]
fn run_macos_security_command(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("security")
        .args(args)
        .output()
        .map_err(|error| format!("failed to run macOS security command: {error}"))
}

#[cfg(target_os = "macos")]
fn read_macos_secure_store(account: &str) -> Result<String, String> {
    let output = run_macos_security_command(&[
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-a",
        account,
        "-w",
    ])?;

    if output.status.success() {
        let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !secret.is_empty() {
            return Ok(secret);
        }
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") {
        return Err("secret not found in macOS secure store".to_string());
    }

    Err(format!(
        "failed to read macOS secure store entry {account}: {}",
        stderr.trim()
    ))
}

#[cfg(target_os = "macos")]
fn write_macos_secure_store(account: &str, secret: &str) -> Result<(), String> {
    let output = run_macos_security_command(&[
        "add-generic-password",
        "-U",
        "-A",
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-a",
        account,
        "-w",
        secret,
    ])?;

    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "failed to write macOS secure store entry {account}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(target_os = "macos")]
fn load_macos_legacy_keyring_secret(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE_NAME, account)
        .map_err(|error| format!("failed to access legacy macOS keyring entry {account}: {error}"))?;
    match entry.get_password() {
        Ok(secret) => {
            let trimmed = secret.trim().to_string();
            if trimmed.is_empty() {
                Err(format!("legacy macOS keyring entry {account} is empty"))
            } else {
                Ok(trimmed)
            }
        }
        Err(error) => Err(format!("failed to read legacy macOS keyring entry {account}: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn migrate_macos_secret_entry_for_exec(account: &str) -> Result<bool, String> {
    if read_macos_secure_store(account).is_ok() {
        return Ok(false);
    }

    let secret = load_macos_legacy_keyring_secret(account)?;
    write_macos_secure_store(account, &secret)?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn migrate_macos_exec_secret_store() -> Result<bool, String> {
    let mut changed = false;

    if let Some((_, config)) = read_openclaw_config_json() {
        if config
            .get("gateway")
            .and_then(|value| value.get("auth"))
            .and_then(|value| value.get("token"))
            .and_then(|value| value.get("source"))
            .and_then(|value| value.as_str())
            == Some("exec")
        {
            changed |= migrate_macos_secret_entry_for_exec(GATEWAY_AUTH_TOKEN_KEYCHAIN_ACCOUNT_NAME)
                .unwrap_or(false);
        }

        if let Some(providers) = config
            .get("models")
            .and_then(|value| value.get("providers"))
            .and_then(|value| value.as_object())
        {
            for (provider_name, provider_config) in providers {
                let matches_exec_ref = provider_config
                    .get("apiKey")
                    .and_then(|value| value.get("source"))
                    .and_then(|value| value.as_str())
                    == Some("exec");

                if matches_exec_ref {
                    let account = format!(
                        "{MODEL_SECRET_KEYCHAIN_ACCOUNT_PREFIX}{}",
                        normalize_model_secret_provider(provider_name)
                    );
                    changed |= migrate_macos_secret_entry_for_exec(&account).unwrap_or(false);
                }
            }
        }
    }

    Ok(changed)
}

#[cfg(target_os = "windows")]
fn native_secure_store_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        KEYCHAIN_SERVICE_NAME,
        account,
    )
    .map_err(|error| format!("failed to access native secure store entry {account}: {error}"))
}

#[cfg(target_os = "windows")]
fn model_secret_keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    let normalized = normalize_model_secret_provider(provider);
    native_secure_store_entry(&format!("{MODEL_SECRET_KEYCHAIN_ACCOUNT_PREFIX}{normalized}"))
}

#[cfg(target_os = "windows")]
fn gateway_auth_token_keyring_entry() -> Result<keyring::Entry, String> {
    native_secure_store_entry(GATEWAY_AUTH_TOKEN_KEYCHAIN_ACCOUNT_NAME)
}

fn save_model_secret_to_native_keyring(provider: &str, secret: &str) -> Result<(), String> {
    let normalized = normalize_model_secret_provider(provider);
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(format!("secret is empty for provider: {normalized}"));
    }

    #[cfg(target_os = "macos")]
    {
        write_macos_secure_store(
            &format!("{MODEL_SECRET_KEYCHAIN_ACCOUNT_PREFIX}{normalized}"),
            trimmed,
        )?;
        remove_legacy_model_secret_file(&normalized);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let entry = model_secret_keyring_entry(&normalized)?;
        entry
            .set_password(trimmed)
            .map_err(|error| format!("failed to write model secret to native secure store: {error}"))?;
        remove_legacy_model_secret_file(&normalized);
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let file_path = model_secret_file_path(&normalized)?;
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&file_path, trimmed)
            .map_err(|error| format!("failed to write model secret file: {error}"))?;
        #[cfg(unix)]
        {
            let permissions = fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&file_path, permissions);
        }
        return Ok(());
    }
}

fn load_model_secret_from_native_keyring(provider: &str) -> Result<String, String> {
    let normalized = normalize_model_secret_provider(provider);

    #[cfg(target_os = "macos")]
    {
        if let Ok(secret) = read_macos_secure_store(&format!(
            "{MODEL_SECRET_KEYCHAIN_ACCOUNT_PREFIX}{normalized}"
        )) {
            let trimmed = secret.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }

        let legacy_secret = load_model_secret_from_legacy_file(&normalized)?;
        save_model_secret_to_native_keyring(&normalized, &legacy_secret)
            .map_err(|error| format!("failed to migrate legacy model secret to native secure store: {error}"))?;
        return Ok(legacy_secret);
    }

    #[cfg(target_os = "windows")]
    {
        let entry = model_secret_keyring_entry(&normalized)?;
        match entry.get_password() {
            Ok(secret) => {
                let trimmed = secret.trim().to_string();
                if !trimmed.is_empty() {
                    return Ok(trimmed);
                }
            }
            Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "failed to read model secret from native secure store: {error}"
                ));
            }
        }

        let legacy_secret = load_model_secret_from_legacy_file(&normalized)?;
        save_model_secret_to_native_keyring(&normalized, &legacy_secret)
            .map_err(|error| format!("failed to migrate legacy model secret to native secure store: {error}"))?;
        return Ok(legacy_secret);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        load_model_secret_from_legacy_file(&normalized)
    }
}

fn save_gateway_auth_token_to_native_keyring(secret: &str) -> Result<(), String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err("gateway auth token is empty".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        write_macos_secure_store(GATEWAY_AUTH_TOKEN_KEYCHAIN_ACCOUNT_NAME, trimmed)?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let entry = gateway_auth_token_keyring_entry()?;
        entry
            .set_password(trimmed)
            .map_err(|error| format!("failed to write gateway auth token to native secure store: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = trimmed;
        Err("gateway auth token secure storage is unsupported on this platform".to_string())
    }
}

fn load_gateway_auth_token_from_native_keyring() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let secret = read_macos_secure_store(GATEWAY_AUTH_TOKEN_KEYCHAIN_ACCOUNT_NAME)?;
        let trimmed = secret.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
        return Err("gateway auth token not found in native secure store".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let entry = gateway_auth_token_keyring_entry()?;
        match entry.get_password() {
            Ok(secret) => {
                let trimmed = secret.trim().to_string();
                if !trimmed.is_empty() {
                    return Ok(trimmed);
                }
                Err("gateway auth token not found in native secure store".to_string())
            }
            Err(keyring::Error::NoEntry) => {
                Err("gateway auth token not found in native secure store".to_string())
            }
            Err(error) => Err(format!(
                "failed to read gateway auth token from native secure store: {error}"
            )),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("gateway auth token secure storage is unsupported on this platform".to_string())
    }
}

fn secret_resolver_target_from_id(id: &str) -> Option<SecretResolverTarget> {
    if id == GATEWAY_AUTH_TOKEN_SECRET_REF_ID {
        return Some(SecretResolverTarget::GatewayAuthToken);
    }

    let mut segments = id.split('/');
    match (segments.next(), segments.next(), segments.next(), segments.next()) {
        (Some("providers"), Some(provider), Some("apiKey"), None) if !provider.trim().is_empty() => {
            Some(SecretResolverTarget::ModelProvider(provider.trim().to_ascii_lowercase()))
        }
        _ => None,
    }
}

fn run_secret_resolver_mode() -> Result<(), String> {
    let mut stdin_payload = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin_payload)
        .map_err(|error| format!("读取 SecretResolver 输入失败: {error}"))?;

    let request: SecretResolverRequest = serde_json::from_str(&stdin_payload)
        .map_err(|error| format!("解析 SecretResolver 输入失败: {error}"))?;
    if request.protocol_version.unwrap_or(1) != 1 {
        return Err("不支持的 SecretResolver 协议版本".to_string());
    }
    if let Some(provider) = request.provider.as_deref() {
        if provider != OPENCLAW_SECRET_EXEC_PROVIDER {
            return Err(format!("不支持的 secrets provider: {provider}"));
        }
    }

    let mut values = BTreeMap::new();
    let mut errors = BTreeMap::new();

    for id in request.ids {
        let Some(target) = secret_resolver_target_from_id(&id) else {
            errors.insert(
                id,
                SecretResolverItemError {
                    message: "unsupported secret id".to_string(),
                },
            );
            continue;
        };

        let resolved = match &target {
            SecretResolverTarget::ModelProvider(provider) => {
                load_model_secret_from_native_keyring(provider)
            }
            SecretResolverTarget::GatewayAuthToken => load_gateway_auth_token_from_native_keyring(),
        };

        match resolved {
            Ok(secret) => {
                values.insert(id, secret);
            }
            Err(error) => {
                errors.insert(id, SecretResolverItemError { message: error });
            }
        }
    }

    let response = SecretResolverResponse {
        protocol_version: 1,
        values,
        errors,
    };
    let serialized = serde_json::to_string(&response)
        .map_err(|error| format!("序列化 SecretResolver 输出失败: {error}"))?;
    println!("{serialized}");
    Ok(())
}

fn maybe_run_secret_resolver_mode() -> Option<i32> {
    if !std::env::args().any(|arg| arg == SECRET_RESOLVER_MODE_ARG) {
        return None;
    }

    Some(match run_secret_resolver_mode() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    })
}

fn storage_status(detail: &str) -> DesktopStorageStatus {
    let paths = desktop_storage_paths().unwrap_or_else(|_| DesktopStoragePaths {
        base_dir: std::env::temp_dir().join("rhopenclaw-desktop").join("storage"),
        json_state_path: std::env::temp_dir().join("rhopenclaw-desktop").join("storage").join("state").join("desktop-state.json"),
        sqlite_path: std::env::temp_dir().join("rhopenclaw-desktop").join("storage").join("state").join("desktop-state.sqlite3"),
        credential_path: std::env::temp_dir().join("rhopenclaw-desktop").join("storage").join("credentials").join("device-token.stub"),
    });
    let (sqlite_ready, last_saved_at) = read_state_snapshot_metadata(&paths);
    let credential_provider = if cfg!(target_os = "macos") {
        "macos-keychain".to_string()
    } else if cfg!(target_os = "windows") {
        "windows-credential-manager".into()
    } else {
        "file-credential-stub".into()
    };
    let credential_path = if cfg!(target_os = "macos") {
        format!("keychain://{KEYCHAIN_SERVICE_NAME}/{KEYCHAIN_ACCOUNT_NAME}")
    } else if cfg!(target_os = "windows") {
        format!("wincred://{KEYCHAIN_SERVICE_NAME}/{KEYCHAIN_ACCOUNT_NAME}")
    } else {
        paths.credential_path.to_string_lossy().to_string()
    };

    DesktopStorageStatus {
        available: true,
        mode: "tauri-local-storage".into(),
        detail: detail.into(),
        json_state_path: paths.json_state_path.to_string_lossy().to_string(),
        sqlite_path: paths.sqlite_path.to_string_lossy().to_string(),
        sqlite_ready,
        last_saved_at,
        credential_provider,
        credential_path,
        credential_secure: cfg!(target_os = "macos") || cfg!(target_os = "windows"),
    }
}

pub(crate) fn runtime_package_paths() -> Result<RuntimePackagePaths, String> {
    let install_dir = std::env::temp_dir().join("rhopenclaw-desktop").join("runtime").join("openclaw-official");
    let executable_name = if cfg!(target_os = "windows") {
        "openclaw-runtime.cmd"
    } else {
        "openclaw-runtime"
    };
    Ok(RuntimePackagePaths {
        manifest_path: install_dir.join("manifest.json"),
        executable_path: install_dir.join("bin").join(executable_name),
        install_dir,
    })
}

/// Self-heal: if openclaw.json is missing channels.rhclaw, re-merge from the
/// plugin manifest config.  Returns true if config was written.
fn ensure_channels_rhclaw_in_openclaw_json(
    config: &RHClawPluginConfigDraft,
    paths: &RHClawPluginPaths,
) -> bool {
    let home = match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let config_path = PathBuf::from(&home).join(".openclaw").join("openclaw.json");
    if !config_path.exists() {
        return false;
    }
    let raw = match fs::read_to_string(&config_path) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let sanitized = sanitize_json_unquoted_keys(&raw);
    let mut cfg: serde_json::Value = match serde_json::from_str(&sanitized) {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Check if channels.rhclaw already exists and is non-empty
    if cfg
        .get("channels")
        .and_then(|c| c.get("rhclaw"))
        .is_some_and(|r| r.is_object() && !r.as_object().unwrap().is_empty())
    {
        return ensure_rhclaw_persistent_gateway_token_ref().unwrap_or(false);
    }

    // Resolve persistent env path
    let persistent_env_path = match resolve_rhclaw_persistent_env_path() {
        Ok(path) => path,
        Err(_) => return false,
    };
    let token_ref_path = if persistent_env_path.exists() {
        persistent_env_path.to_string_lossy().to_string()
    } else {
        paths.plugin_env_path.to_string_lossy().to_string()
    };

    let channel_rhclaw = serde_json::json!({
        "enabled": config.enabled,
        "connectionMode": config.connection_mode,
        "serverUrl": config.server_url,
        "deviceSocketUrl": config.device_socket_url,
        "deviceId": config.device_id,
        "deviceCode": config.device_code,
        "deviceName": config.device_name,
        "defaultAgentId": config.default_agent_id,
        "gatewayTokenRef": {
            "source": "file",
            "provider": "desktop-managed",
            "id": token_ref_path,
        },
        "allowFrom": config.allow_from,
        "dmPolicy": config.dm_policy,
    });

    if !cfg.get("channels").is_some_and(|v| v.is_object()) {
        cfg["channels"] = serde_json::json!({});
    }
    cfg["channels"]["rhclaw"] = channel_rhclaw;

    if let Ok(serialized) = serde_json::to_vec_pretty(&cfg) {
        if fs::write(&config_path, &serialized).is_ok() {
            eprintln!("[probe_rhclaw_plugin] self-healed: re-merged channels.rhclaw into openclaw.json");
            return true;
        }
    }
    false
}

fn ensure_rhclaw_plugin_allowlisted() -> bool {
    let (config_path, mut cfg) = match read_openclaw_config_json() {
        Some(pair) => pair,
        None => return false,
    };

    if !cfg.get("plugins").is_some_and(|v| v.is_object()) {
        cfg["plugins"] = serde_json::json!({});
    }

    let mut changed = false;
    let plugins_obj = match cfg.get_mut("plugins").and_then(|v| v.as_object_mut()) {
        Some(value) => value,
        None => return false,
    };

    let allow_entry = plugins_obj
        .entry("allow".to_string())
        .or_insert_with(|| serde_json::json!([]));

    if !allow_entry.is_array() {
        *allow_entry = serde_json::json!(["rhclaw-channel"]);
        changed = true;
    } else if let Some(items) = allow_entry.as_array_mut() {
        let has_plugin = items.iter().any(|item| item.as_str() == Some("rhclaw-channel"));
        if !has_plugin {
            items.push(serde_json::json!("rhclaw-channel"));
            changed = true;
        }
    }

    if !changed {
        return false;
    }

    if let Ok(serialized) = serde_json::to_vec_pretty(&cfg) {
        if fs::write(&config_path, &serialized).is_ok() {
            eprintln!("[rhopenclaw] self-healed: added rhclaw-channel to plugins.allow");
            return true;
        }
    }

    false
}

/// Ensure `~/.openclaw/extensions/rhclaw-channel/node_modules/openclaw` symlink
/// points to the global openclaw package.  The `openclaw plugins install` CLI
/// normally creates this symlink, but it can be lost when node_modules is cleaned
/// or version managers switch node versions.  Without it the Gateway fails to load
/// the RHClaw channel plugin (`Cannot find module 'openclaw/plugin-sdk/...'`).
fn ensure_openclaw_sdk_symlink() -> bool {
    // 1. Locate the openclaw CLI binary.
    let cli_path = match detect_openclaw_cli() {
        Some(p) => PathBuf::from(p),
        None => return false,
    };

    // 2. Derive the global package directory.
    //    <prefix>/bin/openclaw  →  <prefix>/lib/node_modules/openclaw
    let global_pkg = match cli_path.parent().and_then(|bin| bin.parent()) {
        Some(prefix) => prefix.join("lib").join("node_modules").join("openclaw"),
        None => return false,
    };
    if !global_pkg.exists() {
        // If the global package itself doesn't exist for the currently active
        // node version, there's nothing we can link to.
        return false;
    }

    // 3. Resolve the symlink location inside the plugin's node_modules.
    let home = match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let nm_dir = PathBuf::from(&home)
        .join(".openclaw")
        .join("extensions")
        .join("rhclaw-channel")
        .join("node_modules");
    if !nm_dir.exists() {
        // Plugin not installed yet; nothing to fix.
        return false;
    }
    let link_path = nm_dir.join("openclaw");

    // 4. Check whether the symlink already exists and is valid.
    if link_path.symlink_metadata().is_ok() {
        // It exists (symlink or real dir). Verify it points somewhere valid.
        if link_path.exists() {
            return false; // already valid, nothing to do
        }
        // Dangling symlink — remove it so we can recreate.
        let _ = fs::remove_file(&link_path);
    }

    // 5. Create the symlink.
    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(&global_pkg, &link_path).is_ok() {
            eprintln!(
                "[ensure_openclaw_sdk_symlink] self-healed: created symlink {} -> {}",
                link_path.display(),
                global_pkg.display()
            );
            return true;
        }
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(&global_pkg, &link_path).is_ok() {
            eprintln!(
                "[ensure_openclaw_sdk_symlink] self-healed: created symlink {} -> {}",
                link_path.display(),
                global_pkg.display()
            );
            return true;
        }
    }
    false
}

fn rhclaw_plugin_paths() -> Result<RHClawPluginPaths, String> {
    // Persist manifest & generated configs under ~/.openclaw/ so they survive
    // system restarts (previously stored in /tmp/ which gets wiped).
    let persistent_dir = resolve_openclaw_state_dir()?
        .join("extensions")
        .join("rhclaw-channel")
        .join(".desktop-managed");

    let plugin_dir = std::env::temp_dir()
        .join("rhopenclaw-desktop")
        .join("plugins")
        .join("rhclaw-channel");

    Ok(RHClawPluginPaths {
        manifest_path: persistent_dir.join("rhclaw-plugin-manifest.json"),
        generated_config_path: persistent_dir.join("channels.rhclaw.json"),
        plugin_env_path: persistent_dir.join("rhclaw-plugin.env"),
        installed_package_dir: plugin_dir.join("installed-package"),
        install_receipt_path: plugin_dir.join("installed-package").join("install-receipt.json"),
        plugin_dir,
    })
}

fn resolve_openclaw_state_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定用户 HOME 目录".to_string())?;
    Ok(PathBuf::from(home).join(".openclaw"))
}

fn resolve_openclaw_agent_auth_store_path(agent_id: &str) -> Result<PathBuf, String> {
    let normalized_agent_id = agent_id.trim();
    if normalized_agent_id.is_empty() {
        return Err("agentId 不能为空。".to_string());
    }

    Ok(resolve_openclaw_state_dir()?
        .join("agents")
        .join(normalized_agent_id)
        .join("agent")
        .join("auth-profiles.json"))
}

fn ensure_agent_auth_profiles_seeded_from_main(agent_id: &str) -> Result<(), String> {
    let normalized_agent_id = agent_id.trim();
    if normalized_agent_id.is_empty() || normalized_agent_id == "main" {
        return Ok(());
    }

    let target_auth_store_path = resolve_openclaw_agent_auth_store_path(normalized_agent_id)?;
    if target_auth_store_path.exists() {
        return Ok(());
    }

    let source_auth_store_path = resolve_openclaw_agent_auth_store_path("main")?;
    if !source_auth_store_path.exists() {
        return Ok(());
    }

    if let Some(parent) = target_auth_store_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create agent auth dir for {normalized_agent_id}: {error}"))?;
    }

    fs::copy(&source_auth_store_path, &target_auth_store_path).map_err(|error| {
        format!(
            "failed to seed auth-profiles.json for agent {normalized_agent_id} from main agent: {error}"
        )
    })?;

    Ok(())
}

fn detect_local_rhclaw_plugin_package() -> Option<String> {
    let src_tauri_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = src_tauri_dir.parent()?.parent()?;
    let candidate = repo_root.join("RHClaw-Channel");

    if candidate.exists() {
        Some(candidate.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 检测离线包中预打包的 RHClaw-Channel tgz 文件（优先级高于 npm 在线安装）
fn detect_bundled_rhclaw_plugin_tgz() -> Option<String> {
    let bundle_dir = detect_openclaw_offline_bundle_dir()?;
    let channel_pkg_dir = bundle_dir.join("packages").join("rhclaw-channel");
    if !channel_pkg_dir.is_dir() {
        return None;
    }
    // 取目录中最新的 .tgz 文件
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(&channel_pkg_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "tgz") {
                let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
                if let Some(mtime) = modified {
                    if newest.as_ref().map_or(true, |(prev, _)| mtime > *prev) {
                        newest = Some((mtime, path));
                    }
                }
            }
        }
    }
    newest.map(|(_, path)| path.to_string_lossy().to_string())
}

fn resolve_installed_rhclaw_extension_dir() -> Result<PathBuf, String> {
    Ok(resolve_openclaw_state_dir()?.join("extensions").join("rhclaw-channel"))
}

fn is_rhclaw_runtime_plugin_installed() -> bool {
    let extension_dir = match resolve_installed_rhclaw_extension_dir() {
        Ok(path) => path,
        Err(_) => return false,
    };
    let plugin_manifest_path = extension_dir.join("openclaw.plugin.json");
    if !plugin_manifest_path.exists() {
        return false;
    }

    let Ok(raw_manifest) = fs::read_to_string(&plugin_manifest_path) else {
        return false;
    };
    let Ok(plugin_manifest) = serde_json::from_str::<RHClawPackagePluginManifest>(&raw_manifest) else {
        return false;
    };

    plugin_manifest.id.trim() == "rhclaw-channel"
        && plugin_manifest.channels.iter().any(|item| item == "rhclaw")
}

fn resolve_rhclaw_plugin_install_target(manifest: &RHClawPluginManifest) -> String {
    manifest
        .local_package_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && PathBuf::from(value).exists())
        .map(|value| value.to_string())
        .or_else(detect_bundled_rhclaw_plugin_tgz)
        .or_else(detect_local_rhclaw_plugin_package)
        .unwrap_or_else(|| manifest.package_spec.clone())
}

fn ensure_rhclaw_runtime_plugin_ready() -> Result<bool, String> {
    let paths = rhclaw_plugin_paths()?;
    let mut healed = ensure_rhclaw_persistent_gateway_token_ref()?;
    if !paths.manifest_path.exists() {
        return Ok(healed);
    }

    let manifest = serde_json::from_str::<RHClawPluginManifest>(
        &fs::read_to_string(&paths.manifest_path)
            .map_err(|error| format!("failed to read RHClaw plugin manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to parse RHClaw plugin manifest: {error}"))?;

    healed |= ensure_openclaw_sdk_symlink();

    if is_rhclaw_runtime_plugin_installed() {
        // Plugin present — safe to ensure channels.rhclaw config exists
        if manifest.configured {
            healed |= ensure_channels_rhclaw_in_openclaw_json(&manifest.config, &paths);
        }
        healed |= ensure_rhclaw_plugin_allowlisted();
        return Ok(healed);
    }

    // Plugin NOT installed — strip orphan channels.rhclaw so CLI validation passes
    strip_channels_rhclaw_if_plugin_missing();

    // If the extension directory exists but the plugin isn't properly installed
    // (e.g. only .desktop-managed/ sub-dir from a previous run), remove it so
    // `openclaw plugins install` can create the directory cleanly.
    if let Ok(ext_dir) = resolve_installed_rhclaw_extension_dir() {
        if ext_dir.exists() {
            eprintln!(
                "[rhopenclaw] self-heal: removing incomplete plugin dir {} before re-install",
                ext_dir.display()
            );
            let _ = fs::remove_dir_all(&ext_dir);
        }
    }

    let install_target = resolve_rhclaw_plugin_install_target(&manifest);
    let install_env_owned = build_openclaw_install_env(detect_openclaw_offline_bundle_dir().as_ref());
    let install_env_refs: Vec<(&str, &str)> = install_env_owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();

    match execute_openclaw_command_with_timeout(
        &["plugins", "install", install_target.as_str()],
        &install_env_refs,
        std::time::Duration::from_secs(300),
    ) {
        Ok(_) => {}
        Err(error) if is_non_fatal_rhclaw_plugin_install_error(&error) => {}
        Err(error) => {
            return Err(format!("执行 RHClaw Channel 插件自愈安装失败: {error}"));
        }
    }

    healed = true;
    healed |= ensure_openclaw_sdk_symlink();

    if !is_rhclaw_runtime_plugin_installed() {
        return Err(
            "RHClaw Channel 插件自愈安装后仍未出现在 ~/.openclaw/extensions/rhclaw-channel。"
                .to_string(),
        );
    }

    // Plugin now installed — restore channels.rhclaw config
    if manifest.configured {
        healed |= ensure_channels_rhclaw_in_openclaw_json(&manifest.config, &paths);
    }
    healed |= ensure_rhclaw_plugin_allowlisted();

    Ok(healed)
}

fn is_rhclaw_unknown_channel_error(detail: &str) -> bool {
    let normalized = detail.to_ascii_lowercase();
    normalized.contains("unknown channel id: rhclaw")
        || normalized.contains("channels.rhclaw")
}

/// Pre-onboard self-heal: if openclaw.json has channels.rhclaw but the runtime
/// plugin is NOT installed, temporarily strip it so CLI config validation passes.
/// `ensure_channels_rhclaw_in_openclaw_json` will restore it once the plugin is ready.
pub(crate) fn strip_channels_rhclaw_if_plugin_missing() -> bool {
    if is_rhclaw_runtime_plugin_installed() {
        return false;
    }
    let (config_path, mut cfg) = match read_openclaw_config_json() {
        Some(pair) => pair,
        None => return false,
    };
    let has_rhclaw = cfg
        .get("channels")
        .and_then(|c| c.get("rhclaw"))
        .is_some();
    if !has_rhclaw {
        return false;
    }
    if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
        channels.remove("rhclaw");
    }
    if let Ok(serialized) = serde_json::to_vec_pretty(&cfg) {
        if fs::write(&config_path, &serialized).is_ok() {
            eprintln!("[rhopenclaw] self-heal: stripped orphan channels.rhclaw from openclaw.json (plugin not installed)");
            return true;
        }
    }
    false
}

fn validate_and_stage_local_rhclaw_package(
    paths: &RHClawPluginPaths,
    source_path: &str,
) -> Result<RHClawPluginInstallReceipt, String> {
    let source_dir = PathBuf::from(source_path.trim());
    if !source_dir.exists() {
        return Err(format!("local RHClaw package path does not exist: {}", source_dir.display()));
    }

    let package_json_path = source_dir.join("package.json");
    let plugin_manifest_path = source_dir.join("openclaw.plugin.json");

    if !package_json_path.exists() {
        return Err(format!("missing RHClaw package.json: {}", package_json_path.display()));
    }
    if !plugin_manifest_path.exists() {
        return Err(format!(
            "missing RHClaw openclaw.plugin.json: {}",
            plugin_manifest_path.display()
        ));
    }

    let package_json = serde_json::from_str::<RHClawPackageJson>(
        &fs::read_to_string(&package_json_path)
            .map_err(|error| format!("failed to read RHClaw package.json: {error}"))?,
    )
    .map_err(|error| format!("failed to parse RHClaw package.json: {error}"))?;
    let plugin_manifest = serde_json::from_str::<RHClawPackagePluginManifest>(
        &fs::read_to_string(&plugin_manifest_path)
            .map_err(|error| format!("failed to read RHClaw plugin manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to parse RHClaw plugin manifest: {error}"))?;

    if package_json.name.trim() != "@ruhooai/rhclaw-channel" {
        return Err(format!("unexpected RHClaw package name: {}", package_json.name));
    }

    if plugin_manifest.id.trim() != "rhclaw-channel" || !plugin_manifest.channels.iter().any(|item| item == "rhclaw") {
        return Err("RHClaw plugin manifest does not expose the expected rhclaw channel".into());
    }

    if paths.installed_package_dir.exists() {
        fs::remove_dir_all(&paths.installed_package_dir)
            .map_err(|error| format!("failed to clear staged RHClaw package dir: {error}"))?;
    }
    fs::create_dir_all(&paths.installed_package_dir)
        .map_err(|error| format!("failed to create staged RHClaw package dir: {error}"))?;

    let staged_package_json_path = paths.installed_package_dir.join("package.json");
    let staged_plugin_manifest_path = paths.installed_package_dir.join("openclaw.plugin.json");
    fs::copy(&package_json_path, &staged_package_json_path)
        .map_err(|error| format!("failed to stage RHClaw package.json: {error}"))?;
    fs::copy(&plugin_manifest_path, &staged_plugin_manifest_path)
        .map_err(|error| format!("failed to stage RHClaw openclaw.plugin.json: {error}"))?;

    let mut staged_files = vec![
        staged_package_json_path.to_string_lossy().to_string(),
        staged_plugin_manifest_path.to_string_lossy().to_string(),
    ];

    let readme_path = source_dir.join("README.md");
    if readme_path.exists() {
        let staged_readme_path = paths.installed_package_dir.join("README.md");
        fs::copy(&readme_path, &staged_readme_path)
            .map_err(|error| format!("failed to stage RHClaw README.md: {error}"))?;
        staged_files.push(staged_readme_path.to_string_lossy().to_string());
    }

    let receipt = RHClawPluginInstallReceipt {
        source_path: source_dir.to_string_lossy().to_string(),
        package_name: package_json.name,
        package_version: package_json.version,
        plugin_id: plugin_manifest.id,
        channels: plugin_manifest.channels,
        staged_at: now_iso_string(),
        staged_files,
    };

    fs::write(
        &paths.install_receipt_path,
        serde_json::to_vec_pretty(&receipt)
            .map_err(|error| format!("failed to serialize RHClaw install receipt: {error}"))?,
    )
    .map_err(|error| format!("failed to write RHClaw install receipt: {error}"))?;

    Ok(receipt)
}

fn verify_staged_local_rhclaw_package(paths: &RHClawPluginPaths) -> Result<RHClawPluginInstallReceipt, String> {
    if !paths.install_receipt_path.exists() {
        return Err("RHClaw install receipt is missing".into());
    }

    let receipt = serde_json::from_str::<RHClawPluginInstallReceipt>(
        &fs::read_to_string(&paths.install_receipt_path)
            .map_err(|error| format!("failed to read RHClaw install receipt: {error}"))?,
    )
    .map_err(|error| format!("failed to parse RHClaw install receipt: {error}"))?;

    if receipt.package_name.trim() != "@ruhooai/rhclaw-channel"
        || receipt.plugin_id.trim() != "rhclaw-channel"
        || !receipt.channels.iter().any(|item| item == "rhclaw")
    {
        return Err("RHClaw install receipt content is invalid".into());
    }

    for file in &receipt.staged_files {
        if !PathBuf::from(file).exists() {
            return Err(format!("RHClaw staged install artifact missing: {file}"));
        }
    }

    Ok(receipt)
}

fn build_rhclaw_plugin_status_with_payload(
    detail: &str,
    runtime: Option<&ManagedRuntimeState>,
    prefetched_gateway_status: Option<serde_json::Value>,
) -> Result<RHClawPluginStatus, String> {
    let paths = rhclaw_plugin_paths()?;
    let manifest = if paths.manifest_path.exists() {
        Some(
            serde_json::from_str::<RHClawPluginManifest>(
                &fs::read_to_string(&paths.manifest_path)
                    .map_err(|error| format!("failed to read RHClaw plugin manifest: {error}"))?,
            )
            .map_err(|error| format!("failed to parse RHClaw plugin manifest: {error}"))?,
        )
    } else {
        None
    };
    // probe_gateway_running() now uses fast HTTP /health — no subprocess.
    let gateway = probe_gateway_running();
    // Fetch CLI gateway status ONCE for channel status (the only remaining CLI call).
    let cli_payload = prefetched_gateway_status.or_else(|| parse_openclaw_gateway_status().ok());
    let gateway_channel = parse_rhclaw_gateway_channel_status_with_payload(cli_payload);
    let runtime_running = gateway.running || runtime.map(|item| item.running).unwrap_or(false);
    let local_receipt = if manifest
        .as_ref()
        .map(|item| item.install_mode == "local-package")
        .unwrap_or(false)
    {
        verify_staged_local_rhclaw_package(&paths).ok()
    } else {
        None
    };

    Ok(RHClawPluginStatus {
        available: true,
        installed: manifest.is_some(),
        configured: manifest.as_ref().map(|item| item.configured).unwrap_or(false),
        detail: detail.into(),
        install_mode: manifest.as_ref().map(|item| item.install_mode.clone()),
        package_spec: manifest.as_ref().map(|item| item.package_spec.clone()),
        package_source: manifest.as_ref().map(|item| item.package_source.clone()),
        package_version: manifest
            .as_ref()
            .and_then(|item| item.package_version.clone())
            .or_else(|| local_receipt.as_ref().map(|item| item.package_version.clone())),
        local_package_path: manifest.as_ref().and_then(|item| item.local_package_path.clone()),
        installed_package_path: manifest.as_ref().and_then(|item| item.installed_package_path.clone()),
        install_receipt_path: manifest.as_ref().and_then(|item| item.install_receipt_path.clone()),
        package_validated: manifest.as_ref().map(|item| item.package_validated).unwrap_or(false)
            && (manifest
                .as_ref()
                .map(|item| item.install_mode != "local-package")
                .unwrap_or(false)
                || local_receipt.is_some()),
        plugin_dir: paths.plugin_dir.to_string_lossy().to_string(),
        manifest_path: paths.manifest_path.to_string_lossy().to_string(),
        generated_config_path: paths.generated_config_path.to_string_lossy().to_string(),
        plugin_env_path: paths.plugin_env_path.to_string_lossy().to_string(),
        gateway_restart_required: manifest
            .as_ref()
            .map(|item| item.gateway_restart_required || !runtime_running)
            .unwrap_or(false),
        gateway_probe_passed: manifest
            .as_ref()
            .map(|item| item.gateway_probe_passed && runtime_running)
            .unwrap_or(false),
        last_probe_at: manifest.as_ref().and_then(|item| item.last_probe_at.clone()),
        last_probe_detail: manifest.as_ref().and_then(|item| item.last_probe_detail.clone()),
        gateway_token_env_name: manifest
            .as_ref()
            .map(|item| item.config.gateway_token_env_name.clone()),
        secret_ref_source: manifest.as_ref().map(|_| "env".to_string()),
        server_url: manifest.as_ref().map(|item| item.config.server_url.clone()),
        device_socket_url: manifest.as_ref().map(|item| item.config.device_socket_url.clone()),
        device_id: manifest.as_ref().map(|item| item.config.device_id.clone()),
        device_name: manifest.as_ref().map(|item| item.config.device_name.clone()),
        default_agent_id: manifest.as_ref().map(|item| item.config.default_agent_id.clone()),
        channel_status: gateway_channel.status,
        channel_last_heartbeat_at: gateway_channel.last_heartbeat_at,
        channel_detail: gateway_channel.detail,
    })
}

fn build_rhclaw_plugin_status(
    detail: &str,
    runtime: Option<&ManagedRuntimeState>,
) -> Result<RHClawPluginStatus, String> {
    build_rhclaw_plugin_status_with_payload(detail, runtime, None)
}

pub(crate) fn detect_existing_openclaw_install() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(cli_path) = detect_openclaw_cli() {
        candidates.push(PathBuf::from(cli_path));
    }

    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/Applications/OpenClaw.app"));
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Applications").join("OpenClaw.app"));
        }
    } else if cfg!(target_os = "windows") {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("OpenClaw.exe"),
            );
        }

        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("OpenClaw").join("OpenClaw.exe"));
        }
    } else if cfg!(target_os = "linux") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin").join("openclaw"));
            candidates.push(home.join("Applications").join("OpenClaw.AppImage"));
        }

        candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
        candidates.push(PathBuf::from("/opt/OpenClaw/openclaw"));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

/// Collect ALL existing OpenClaw install paths (not just the first match).
/// Used when showing a multi-instance selector in the decision UI.
pub(crate) fn detect_all_openclaw_installs() -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 1. shell `command -v openclaw`
    if let Ok(output) = Command::new("sh")
        .args(["-lc", "command -v openclaw"])
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() && seen.insert(path.clone()) {
                result.push(path);
            }
        }
    }

    // 2. well-known OS-specific paths
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin").join("openclaw"));
            candidates.extend(collect_node_manager_openclaw_candidates(&home));
            candidates.push(home.join("Applications").join("OpenClaw.app"));
        }
        candidates.push(PathBuf::from("/Applications/OpenClaw.app"));
    } else if cfg!(target_os = "windows") {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("OpenClaw.exe"),
            );
            candidates.push(
                PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("openclaw.exe"),
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("OpenClaw").join("OpenClaw.exe"));
        }
    } else if cfg!(target_os = "linux") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin").join("openclaw"));
            candidates.push(home.join("Applications").join("OpenClaw.AppImage"));
            candidates.extend(collect_node_manager_openclaw_candidates(&home));
        }
        candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
        candidates.push(PathBuf::from("/opt/OpenClaw/openclaw"));
    }

    for candidate in candidates {
        if candidate.exists() {
            let path = candidate.to_string_lossy().to_string();
            if seen.insert(path.clone()) {
                result.push(path);
            }
        }
    }

    result
}

fn collect_node_manager_openclaw_candidates(home: &PathBuf) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if cfg!(target_os = "windows") {
        let prefix_dir = resolve_openclaw_npm_global_prefix_dir(home);
        candidates.push(prefix_dir.join("openclaw.cmd"));
        candidates.push(prefix_dir.join("openclaw"));
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let npm_dir = PathBuf::from(app_data).join("npm");
            candidates.push(npm_dir.join("openclaw.cmd"));
            candidates.push(npm_dir.join("openclaw"));
        }
        return candidates;
    }

    let nvm_versions_dir = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = fs::read_dir(&nvm_versions_dir) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin").join("openclaw"));
        }
    }

    let fnm_versions_dir = home.join("Library").join("Application Support").join("fnm").join("node-versions");
    if let Ok(entries) = fs::read_dir(&fnm_versions_dir) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("installation").join("bin").join("openclaw"));
        }
    }

    let asdf_installs_dir = home.join(".asdf").join("installs").join("nodejs");
    if let Ok(entries) = fs::read_dir(&asdf_installs_dir) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin").join("openclaw"));
        }
    }

    candidates.push(home.join(".volta").join("bin").join("openclaw"));
    candidates.push(home.join(".npm-global").join("bin").join("openclaw"));
    candidates.push(home.join("Library").join("pnpm").join("openclaw"));
    candidates.push(home.join(".local").join("share").join("pnpm").join("openclaw"));
    candidates.push(resolve_openclaw_npm_global_bin_dir(home).join("openclaw"));

    candidates
}

fn resolve_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
    .map(PathBuf::from)
    .or_else(dirs::home_dir)
}

fn resolve_openclaw_npm_global_prefix_dir(home: &Path) -> PathBuf {
    home.join(".openclaw").join("tooling").join("npm-global")
}

fn resolve_openclaw_npm_global_bin_dir_from_prefix(prefix_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        prefix_dir.to_path_buf()
    } else {
        prefix_dir.join("bin")
    }
}

fn resolve_openclaw_npm_global_node_modules_dir_from_prefix(prefix_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        prefix_dir.join("node_modules")
    } else {
        prefix_dir.join("lib").join("node_modules")
    }
}

fn resolve_openclaw_npm_global_bin_dir(home: &Path) -> PathBuf {
    let prefix_dir = resolve_openclaw_npm_global_prefix_dir(home);
    resolve_openclaw_npm_global_bin_dir_from_prefix(&prefix_dir)
}

pub(crate) fn resolve_openclaw_cli_path_from_prefix_dir(prefix_dir: &Path) -> PathBuf {
    let bin_dir = resolve_openclaw_npm_global_bin_dir_from_prefix(prefix_dir);
    if cfg!(target_os = "windows") {
        resolve_windows_runnable_command_path(&bin_dir.join("openclaw"))
    } else {
        bin_dir.join("openclaw")
    }
}

fn read_runtime_package_manifest() -> Option<RuntimePackageManifest> {
    let paths = runtime_package_paths().ok()?;
    if !paths.manifest_path.exists() {
        return None;
    }

    fs::read_to_string(&paths.manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RuntimePackageManifest>(&raw).ok())
}

fn resolve_bound_openclaw_cli_path() -> Option<PathBuf> {
    let bound_path = read_runtime_package_manifest()?.bound_install_path?;
    let candidate = if cfg!(target_os = "windows") {
        resolve_windows_runnable_command_path(Path::new(&bound_path))
    } else {
        PathBuf::from(bound_path)
    };

    if candidate.exists() && is_executable_arch_compatible(&candidate.to_string_lossy()) {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_openclaw_install_prefix_dir_from_cli_path(cli_path: &Path) -> Option<PathBuf> {
    fn prefix_contains_openclaw(prefix_dir: &Path) -> bool {
        prefix_dir.join("node_modules").join("openclaw").exists()
            || prefix_dir.join("lib").join("node_modules").join("openclaw").exists()
    }

    let parent = cli_path.parent()?;

    if prefix_contains_openclaw(parent) {
        return Some(parent.to_path_buf());
    }

    if parent.file_name().and_then(|value| value.to_str()) == Some("bin") {
        let prefix_dir = parent.parent()?;
        if prefix_contains_openclaw(prefix_dir) {
            return Some(prefix_dir.to_path_buf());
        }
    }

    None
}

pub(crate) fn resolve_openclaw_install_target_prefix_dir() -> Result<PathBuf, String> {
    let manifest = read_runtime_package_manifest();
    let use_bound_install_path = manifest
        .as_ref()
        .map(|item| item.install_mode == "existing-install")
        .unwrap_or(false);

    if use_bound_install_path {
        if let Some(bound_cli) = resolve_bound_openclaw_cli_path() {
            if let Some(prefix) = resolve_openclaw_install_prefix_dir_from_cli_path(&bound_cli) {
                return Ok(prefix);
            }
        }
        // Bound path no longer valid (e.g. after `reset --scope full` partially
        // deleted ~/.openclaw).  Remove the stale manifest so subsequent calls
        // don't repeat the same failure, then fall through to the default path.
        if let Ok(paths) = runtime_package_paths() {
            let _ = fs::remove_file(&paths.manifest_path);
        }
    }

    let home = resolve_user_home_dir()
        .ok_or_else(|| "无法确定用户 HOME 目录。".to_string())?;
    Ok(resolve_openclaw_npm_global_prefix_dir(&home))
}

fn command_for_executable(program: &Path) -> Command {
    if cfg!(target_os = "windows") {
        if let Some(ext) = program.extension().and_then(|value| value.to_str()) {
            if ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat") {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(program);
                return command;
            }
        }
    }

    Command::new(program)
}

fn resolve_windows_runnable_command_path(program: &Path) -> PathBuf {
    if !cfg!(target_os = "windows") {
        return program.to_path_buf();
    }

    if let Some(ext) = program.extension().and_then(|value| value.to_str()) {
        if ext.eq_ignore_ascii_case("exe")
            || ext.eq_ignore_ascii_case("cmd")
            || ext.eq_ignore_ascii_case("bat")
            || ext.eq_ignore_ascii_case("com")
        {
            return program.to_path_buf();
        }
    }

    for candidate_ext in ["cmd", "exe", "bat", "com"] {
        let candidate = program.with_extension(candidate_ext);
        if candidate.exists() {
            return candidate;
        }
    }

    program.to_path_buf()
}

fn is_known_incompatible_skillhub_package(candidate: &Path) -> bool {
    let Some(parent) = candidate.parent() else {
        return false;
    };
    let package_json_path = parent.join("node_modules").join("skillhub").join("package.json");
    let Ok(raw_package_json) = fs::read_to_string(&package_json_path) else {
        return false;
    };
    let Ok(package_json) = serde_json::from_str::<serde_json::Value>(&raw_package_json) else {
        return false;
    };

    let homepage = package_json
        .get("homepage")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let repository_url = package_json
        .get("repository")
        .and_then(|value| value.get("url"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    homepage.contains("skills.palebluedot.live") || repository_url.contains("airano-ir/skillhub")
}

fn is_windows_runnable_command_file(candidate: &Path) -> bool {
    let Some(ext) = candidate.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        ext.to_ascii_lowercase().as_str(),
        "exe" | "cmd" | "bat" | "com"
    )
}

fn is_supported_skillhub_cli(candidate: &Path) -> bool {
    if !candidate.exists() {
        return false;
    }

    if cfg!(target_os = "windows") && !is_windows_runnable_command_file(candidate) {
        eprintln!(
            "[rhopenclaw] ignoring non-win32 skillhub CLI at {}",
            candidate.display()
        );
        return false;
    }

    if is_known_incompatible_skillhub_package(candidate) {
        eprintln!(
            "[rhopenclaw] ignoring incompatible npm skillhub CLI at {}",
            candidate.display()
        );
        return false;
    }

    true
}

fn detect_skillhub_shell() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        for shell in ["bash", "sh"] {
            if let Ok(output) = Command::new("where.exe").arg(shell).output() {
                if output.status.success() {
                    for line in String::from_utf8_lossy(&output.stdout).lines() {
                        let resolved = resolve_windows_runnable_command_path(Path::new(line.trim()));
                        if resolved.exists() {
                            return Some(resolved);
                        }
                    }
                }
            }
        }
        // Fallback: check common Git Bash locations not in PATH
        for candidate in [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
            "C:\\Git\\bin\\bash.exe",
        ] {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return Some(path);
            }
        }
        return None;
    }

    if let Ok(output) = Command::new("sh")
        .args(["-lc", "command -v bash || command -v sh"])
        .output()
    {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }

    None
}

fn merge_path_entries(entries: Vec<PathBuf>, base_path: Option<&str>) -> Option<String> {
    let mut merged = Vec::new();

    for entry in entries {
        if entry.as_os_str().is_empty() {
            continue;
        }
        if !merged.iter().any(|item: &PathBuf| item == &entry) {
            merged.push(entry);
        }
    }

    if let Some(base_path) = base_path {
        for entry in std::env::split_paths(base_path) {
            if entry.as_os_str().is_empty() {
                continue;
            }
            if !merged.iter().any(|item| item == &entry) {
                merged.push(entry);
            }
        }
    }

    if merged.is_empty() {
        None
    } else {
        std::env::join_paths(merged)
            .ok()
            .map(|value| value.to_string_lossy().to_string())
    }
}

fn collect_offline_bundle_node_bin_dirs(home: &PathBuf) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let tooling_node_dir = home.join(".openclaw").join("tooling").join("node");
    let expected_arch_tag = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        ""
    };
    if let Ok(entries) = fs::read_dir(&tooling_node_dir) {
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip node dirs whose name explicitly contains a *different* arch.
            if !expected_arch_tag.is_empty() {
                let dominated_by_other_arch = if cfg!(target_arch = "x86_64") {
                    dir_name.contains("arm64") && !dir_name.contains("x64")
                } else if cfg!(target_arch = "aarch64") {
                    (dir_name.contains("x64") || dir_name.contains("x86_64")) && !dir_name.contains("arm64")
                } else {
                    false
                };
                if dominated_by_other_arch {
                    continue;
                }
            }
            if cfg!(target_os = "windows") {
                let node_dir = entry.path();
                if node_dir.join("node.exe").exists() {
                    dirs.push(node_dir);
                }
            } else {
                let bin_dir = entry.path().join("bin");
                if bin_dir.exists() {
                    dirs.push(bin_dir);
                }
            }
        }
    }
    dirs.push(resolve_openclaw_npm_global_bin_dir(home));
    dirs
}

fn collect_node_runtime_bin_dirs(home: &PathBuf) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    dirs.extend(collect_offline_bundle_node_bin_dirs(home));

    let nvm_versions_dir = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = fs::read_dir(&nvm_versions_dir) {
        for entry in entries.flatten() {
            dirs.push(entry.path().join("bin"));
        }
    }

    let fnm_versions_dir = home
        .join("Library")
        .join("Application Support")
        .join("fnm")
        .join("node-versions");
    if let Ok(entries) = fs::read_dir(&fnm_versions_dir) {
        for entry in entries.flatten() {
            dirs.push(entry.path().join("installation").join("bin"));
        }
    }

    let asdf_installs_dir = home.join(".asdf").join("installs").join("nodejs");
    if let Ok(entries) = fs::read_dir(&asdf_installs_dir) {
        for entry in entries.flatten() {
            dirs.push(entry.path().join("bin"));
        }
    }

    dirs.push(home.join(".volta").join("bin"));
    dirs.push(home.join(".npm-global").join("bin"));
    dirs.push(home.join("Library").join("pnpm"));
    dirs.push(home.join(".local").join("share").join("pnpm"));

    dirs
}

fn resolve_offline_bundle_node_platform() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("darwin")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "windows") {
        Some("win")
    } else {
        None
    }
}

fn resolve_offline_bundle_node_arch() -> Option<&'static str> {
    if cfg!(target_arch = "aarch64") {
        Some("arm64")
    } else if cfg!(target_arch = "x86_64") {
        Some("x64")
    } else {
        None
    }
}

fn is_safe_archive_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn extract_zip_archive_to_dir(archive_path: &Path, destination_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|error| format!("打开 ZIP 失败 {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("解析 ZIP 失败 {}: {error}", archive_path.display()))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 ZIP 条目失败: {error}"))?;
        let relative_path = entry
            .enclosed_name()
            .map(PathBuf::from)
            .ok_or_else(|| format!("ZIP 包含非法路径: {}", entry.name()))?;

        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let output_path = destination_dir.join(&relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("创建 ZIP 目录失败 {}: {error}", output_path.display()))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 ZIP 父目录失败 {}: {error}", parent.display()))?;
        }

        let mut output_file = fs::File::create(&output_path)
            .map_err(|error| format!("创建 ZIP 输出文件失败 {}: {error}", output_path.display()))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("写入 ZIP 文件失败 {}: {error}", output_path.display()))?;
    }

    Ok(())
}

fn extract_tar_gz_archive_to_dir(archive_path: &Path, destination_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|error| format!("打开 tgz 失败 {}: {error}", archive_path.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = TarArchive::new(decoder);

    for entry in archive
        .entries()
        .map_err(|error| format!("读取 tgz 条目失败 {}: {error}", archive_path.display()))?
    {
        let mut entry = entry.map_err(|error| format!("读取 tgz 条目失败: {error}"))?;
        entry
            .unpack_in(destination_dir)
            .map_err(|error| format!("解压 tgz 到 {} 失败: {error}", destination_dir.display()))?;
    }

    Ok(())
}

fn extract_tar_gz_prefix_to_dir(
    archive_path: &Path,
    entry_prefix: &Path,
    strip_prefix: &Path,
    destination_dir: &Path,
) -> Result<usize, String> {
    let file = fs::File::open(archive_path)
        .map_err(|error| format!("打开 tgz 失败 {}: {error}", archive_path.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = TarArchive::new(decoder);
    let mut extracted_count = 0usize;

    for entry in archive
        .entries()
        .map_err(|error| format!("读取 tgz 条目失败 {}: {error}", archive_path.display()))?
    {
        let mut entry = entry.map_err(|error| format!("读取 tgz 条目失败: {error}"))?;
        let entry_path = entry
            .path()
            .map_err(|error| format!("读取 tgz 条目路径失败: {error}"))?
            .into_owned();

        if !entry_path.starts_with(entry_prefix) {
            continue;
        }

        let relative_path = entry_path.strip_prefix(strip_prefix).map_err(|error| {
            format!(
                "计算 tgz 条目相对路径失败 {}: {error}",
                entry_path.display()
            )
        })?;

        if relative_path.as_os_str().is_empty() {
            continue;
        }

        if !is_safe_archive_relative_path(relative_path) {
            return Err(format!(
                "tgz 包含非法相对路径: {}",
                relative_path.display()
            ));
        }

        let output_path = destination_dir.join(relative_path);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 tgz 父目录失败 {}: {error}", parent.display()))?;
        }

        entry
            .unpack(&output_path)
            .map_err(|error| format!("解压 tgz 条目失败 {}: {error}", output_path.display()))?;
        extracted_count += 1;
    }

    Ok(extracted_count)
}

fn prepare_offline_bundle_node_bin_dir(offline_bundle_dir: &PathBuf) -> Option<PathBuf> {
    let home = resolve_user_home_dir()?;
    let platform = resolve_offline_bundle_node_platform()?;
    let arch = resolve_offline_bundle_node_arch()?;
    let node_packages_dir = offline_bundle_dir.join("packages").join("node");
    let archive_suffix = if cfg!(target_os = "windows") {
        format!("-{platform}-{arch}.zip")
    } else {
        format!("-{platform}-{arch}.tar.gz")
    };
    let archive = fs::read_dir(&node_packages_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|item| item.to_str())
                .map(|name| name.starts_with("node-v") && name.ends_with(&archive_suffix))
                .unwrap_or(false)
        })?;

    let archive_name = archive.file_name()?.to_str()?.to_string();
    let extracted_name = if cfg!(target_os = "windows") {
        archive_name.trim_end_matches(".zip").to_string()
    } else {
        archive_name.trim_end_matches(".tar.gz").to_string()
    };
    let extract_root = home.join(".openclaw").join("tooling").join("node");
    if fs::create_dir_all(&extract_root).is_err() {
        return None;
    }

    let extracted_dir = extract_root.join(&extracted_name);
    // On Windows a proper extraction includes npm.cmd at the root; treat missing
    // npm.cmd as a partial/failed extraction and re-extract from scratch.
    let is_complete = if cfg!(target_os = "windows") {
        extracted_dir.join("node.exe").exists() && extracted_dir.join("npm.cmd").exists()
    } else {
        extracted_dir.join("bin").join("npm").exists()
    };
    if !is_complete {
        if extracted_dir.exists() {
            let _ = fs::remove_dir_all(&extracted_dir);
        }
        let extracted = if cfg!(target_os = "windows") {
            extract_zip_archive_to_dir(&archive, &extract_root).is_ok()
        } else {
            Command::new("tar")
                .arg("-xzf")
                .arg(&archive)
                .arg("-C")
                .arg(&extract_root)
                .status()
                .map(|status| status.success())
                .ok()?
        };
        if !extracted {
            return None;
        }
    }

    if cfg!(target_os = "windows") {
        if extracted_dir.join("node.exe").exists() && extracted_dir.join("npm.cmd").exists() {
            Some(extracted_dir)
        } else {
            None
        }
    } else {
        let bin_dir = extracted_dir.join("bin");
        if bin_dir.exists() {
            Some(bin_dir)
        } else {
            None
        }
    }
}

/// Check whether a given executable file is compatible with the current CPU
/// architecture.  On macOS this inspects the Mach-O header via `file(1)`.
/// Returns `true` for scripts, non-existent files, or when the check is
/// inconclusive – i.e. we only return `false` when we can *positively*
/// determine an architecture mismatch.
fn is_executable_arch_compatible(path: &str) -> bool {
    if cfg!(not(target_os = "macos")) {
        return true;
    }
    let output = match Command::new("file").arg("-b").arg(path).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return true,
    };
    let lower = output.to_lowercase();
    // Text / scripts are always runnable.
    if lower.contains("text") || lower.contains("script") {
        return true;
    }
    // Not a Mach-O binary → skip the check.
    if !lower.contains("mach-o") {
        return true;
    }
    // Universal (fat) binaries contain all slices.
    if lower.contains("universal") {
        return true;
    }
    if cfg!(target_arch = "x86_64") {
        lower.contains("x86_64")
    } else if cfg!(target_arch = "aarch64") {
        lower.contains("arm64")
    } else {
        true
    }
}

pub(crate) fn detect_openclaw_cli() -> Option<String> {
    if let Some(path) = detect_managed_openclaw_cli() {
        return Some(path);
    }

    // Check the Desktop-managed npm-global prefix first.
    if let Some(home) = resolve_user_home_dir() {
        let bin_dir = resolve_openclaw_npm_global_bin_dir(&home);
        let candidate = if cfg!(target_os = "windows") {
            resolve_windows_runnable_command_path(&bin_dir.join("openclaw"))
        } else {
            bin_dir.join("openclaw")
        };
        if candidate.exists() && is_executable_arch_compatible(&candidate.to_string_lossy()) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    if cfg!(target_os = "windows") {
        if let Ok(output) = Command::new("where.exe").arg("openclaw").output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let resolved = resolve_windows_runnable_command_path(Path::new(line.trim()));
                    let path = resolved.to_string_lossy().to_string();
                    if !path.is_empty() && is_executable_arch_compatible(&path) {
                        return Some(path);
                    }
                }
            }
        }
    } else if let Ok(output) = Command::new("sh")
        .args(["-lc", "command -v openclaw"])
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && is_executable_arch_compatible(&path) {
                return Some(path);
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin").join("openclaw"));
            candidates.extend(collect_node_manager_openclaw_candidates(&home));
            candidates.push(home.join("Applications").join("OpenClaw.app").join("Contents").join("MacOS").join("openclaw"));
        }
        candidates.push(PathBuf::from("/Applications/OpenClaw.app/Contents/MacOS/openclaw"));
        candidates.push(PathBuf::from("/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"));
    } else if cfg!(target_os = "windows") {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("openclaw.exe"),
            );
            candidates.push(
                PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("OpenClaw.exe"),
            );
        }
        if let Some(home) = resolve_user_home_dir() {
            candidates.extend(collect_node_manager_openclaw_candidates(&home));
        }
    } else if cfg!(target_os = "linux") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin").join("openclaw"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/openclaw"));
        candidates.push(PathBuf::from("/usr/bin/openclaw"));
    }

    candidates
        .into_iter()
        .map(|candidate| {
            if cfg!(target_os = "windows") {
                resolve_windows_runnable_command_path(&candidate)
            } else {
                candidate
            }
        })
        .find(|candidate| candidate.exists() && is_executable_arch_compatible(&candidate.to_string_lossy()))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

pub(crate) fn detect_desktop_managed_npm_global_openclaw_cli() -> Option<String> {
    let home = resolve_user_home_dir()?;
    let prefix_dir = resolve_openclaw_npm_global_prefix_dir(&home);
    let candidate = resolve_openclaw_cli_path_from_prefix_dir(&prefix_dir);
    if candidate.exists() && is_executable_arch_compatible(&candidate.to_string_lossy()) {
        Some(candidate.to_string_lossy().to_string())
    } else {
        None
    }
}

fn ensure_openclaw_optional_module_shim(
    module_owner_dir: &Path,
    package_name: &str,
    index_js: &str,
) -> Result<bool, String> {
    let mut parts = package_name.split('/');
    let scope = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if !scope.starts_with('@') || name.is_empty() || parts.next().is_some() {
        return Err(format!("不支持的 npm 包名: {package_name}"));
    }

    let module_dir = module_owner_dir.join("node_modules").join(scope).join(name);
    if module_dir.join("package.json").exists() {
        return Ok(false);
    }

    fs::create_dir_all(&module_dir)
        .map_err(|e| format!("创建 {package_name} 目录失败: {e}"))?;

    let package_json = format!(
        "{{\n  \"name\": \"{package_name}\",\n  \"version\": \"0.0.0-rhclaw-shim\",\n  \"main\": \"index.js\",\n  \"description\": \"RHClaw offline shim for optional dependency\"\n}}\n"
    );

    fs::write(module_dir.join("package.json"), package_json.as_bytes())
        .map_err(|e| format!("写入 {package_name} package.json 失败: {e}"))?;
    fs::write(module_dir.join("index.js"), index_js.as_bytes())
        .map_err(|e| format!("写入 {package_name} index.js 失败: {e}"))?;

    Ok(true)
}

/// Ensure optional Slack SDK modules exist so gateway optional stages do not
/// throw noisy MODULE_NOT_FOUND errors in offline deployments.
fn ensure_openclaw_slack_dependency_shims() -> Result<bool, String> {
    let cli = match detect_openclaw_cli() {
        Some(path) => PathBuf::from(path),
        None => return Ok(false),
    };
    let prefix_dir = match resolve_openclaw_install_prefix_dir_from_cli_path(&cli) {
        Some(prefix) => prefix,
        None => match cli.parent() {
            Some(parent) => parent.to_path_buf(),
            None => return Ok(false),
        },
    };
    let npm_global_node_modules_dir = resolve_openclaw_npm_global_node_modules_dir_from_prefix(&prefix_dir);
    let npm_global_module_owner = match npm_global_node_modules_dir.parent() {
        Some(parent) => parent.to_path_buf(),
        None => return Ok(false),
    };
    let mut modified = false;

    let web_api_index_js = r#""use strict";

class WebClient {
  constructor(token, options) {
    this.token = token;
    this.options = options || {};
  }
}

module.exports = { WebClient };
"#;

    let bolt_index_js = r#""use strict";

class App {
  constructor(options) {
    this.options = options || {};
  }
  start() {
    return Promise.resolve();
  }
  stop() {
    return Promise.resolve();
  }
}

module.exports = { App };
"#;

    // jiti may resolve optional modules from either npm-global/node_modules
    // or openclaw/node_modules, so install shims in both locations.
    let mut shim_owners = vec![npm_global_module_owner.clone()];
    let package_local_owner = npm_global_node_modules_dir.join("openclaw");
    if package_local_owner.join("node_modules").exists() {
        shim_owners.push(package_local_owner);
    }

    for owner in shim_owners {
        modified |= ensure_openclaw_optional_module_shim(
            &owner,
            "@slack/web-api",
            web_api_index_js,
        )?;
        modified |= ensure_openclaw_optional_module_shim(
            &owner,
            "@slack/bolt",
            bolt_index_js,
        )?;
    }

    Ok(modified)
}

fn detect_managed_openclaw_cli() -> Option<String> {
    let paths = runtime_package_paths().ok()?;

    if paths.executable_path.exists() {
        let path = paths.executable_path.to_string_lossy().to_string();
        if is_executable_arch_compatible(&path) {
            return Some(path);
        }
    }

    let manifest = read_runtime_package_manifest();
    let bound_cli = resolve_bound_openclaw_cli_path();
    let use_bound_install_path = manifest
        .as_ref()
        .map(|item| item.install_mode == "existing-install")
        .unwrap_or(false);

    if use_bound_install_path {
        if let Some(bound_cli) = bound_cli {
            return Some(bound_cli.to_string_lossy().to_string());
        }
    }

    if let Some(managed_cli) = detect_desktop_managed_npm_global_openclaw_cli() {
        return Some(managed_cli);
    }

    if use_bound_install_path {
        return bound_cli.map(|path| path.to_string_lossy().to_string());
    }

    None
}

pub(crate) fn extract_json_payload(text: &str) -> Result<serde_json::Value, String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        return Ok(value);
    }

    let sanitized_text = sanitize_json_unquoted_keys(text);
    if sanitized_text != text {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&sanitized_text) {
            return Ok(value);
        }
    }

    if let Some(value) = extract_embedded_json_payload(text) {
        return Ok(value);
    }

    for line in text.lines().rev() {
        let candidate = line.trim();
        if candidate.starts_with('{') && candidate.ends_with('}') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                return Ok(value);
            }
        }
    }

    Err("OpenClaw CLI 未返回可解析的 JSON 输出。".into())
}

fn extract_embedded_json_payload(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        let current = bytes[index];
        if current != b'{' && current != b'[' {
            index += 1;
            continue;
        }

        if let Some(end) = find_json_payload_end(bytes, index) {
            let candidate = &text[index..=end];
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                return Some(value);
            }

            let sanitized = sanitize_json_unquoted_keys(candidate);
            if sanitized != candidate {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&sanitized) {
                    return Some(value);
                }
            }

            index = end + 1;
            continue;
        }

        index += 1;
    }

    None
}

fn find_json_payload_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut stack = vec![bytes.get(start).copied()?];
    let mut in_string = false;
    let mut escaping = false;

    for (index, current) in bytes.iter().copied().enumerate().skip(start + 1) {
        if in_string {
            if escaping {
                escaping = false;
                continue;
            }

            match current {
                b'\\' => escaping = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match current {
            b'"' => in_string = true,
            b'{' | b'[' => stack.push(current),
            b'}' => {
                if stack.pop() != Some(b'{') {
                    return None;
                }
                if stack.is_empty() {
                    return Some(index);
                }
            }
            b']' => {
                if stack.pop() != Some(b'[') {
                    return None;
                }
                if stack.is_empty() {
                    return Some(index);
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod json_extract_tests {
    use super::extract_json_payload;

    #[test]
    fn extracts_multiline_json_after_version_warning_prefix() {
        let raw = r#"Config was last written by a newer OpenClaw (2026.3.31); current version is 2026.3.23-2.
◇
{
    "service": {
        "runtime": {
            "status": "running",
            "pid": 90195
    }
  },
    "rpc": {
        "ok": true
  }
}"#;

        let payload = extract_json_payload(raw).expect("should parse embedded json");
        assert_eq!(
            payload.pointer("/service/runtime/status").and_then(|v| v.as_str()),
            Some("running")
        );
        assert_eq!(payload.pointer("/rpc/ok").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn extracts_embedded_json_with_nested_array() {
        let raw = r#"warning line
{
    "items": [
        { "name": "alpha" },
        { "name": "beta" }
  ]
}
tail"#;

        let payload = extract_json_payload(raw).expect("should parse nested json");
        assert_eq!(
            payload
                .pointer("/items/1/name")
                .and_then(|value| value.as_str()),
            Some("beta")
        );
    }
}

#[cfg(test)]
mod skillhub_cli_tests {
    use super::{
        collect_missing_desktop_install_skills, is_bundled_markdown_only_skill,
        is_windows_runnable_command_file, mark_skill_installed,
        partition_missing_desktop_install_skills,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static BUNDLED_SKILLS_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn create_temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("rhopenclaw-{name}-{suffix}"));
        fs::create_dir_all(&dir).expect("should create temp test dir");
        dir
    }

    #[test]
    fn rejects_extensionless_bash_skillhub_wrapper() {
        let dir = create_temp_dir("skillhub-bash");
        let path = dir.join("skillhub");
        fs::write(&path, "#!/usr/bin/env bash\nexec python3 \"$@\"\n")
            .expect("should write bash wrapper");

        assert!(!is_windows_runnable_command_file(&path));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn accepts_cmd_skillhub_wrapper() {
        let dir = create_temp_dir("skillhub-cmd");
        let path = dir.join("skillhub.cmd");
        fs::write(&path, "@echo off\r\nexit /b 0\r\n").expect("should write cmd wrapper");

        assert!(is_windows_runnable_command_file(&path));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_markdown_only_bundled_skill() {
        let dir = create_temp_dir("bundled-markdown");
        fs::write(dir.join("SKILL.md"), "# skill\n").expect("should write skill file");
        fs::write(dir.join("README.md"), "# readme\n").expect("should write readme file");
        fs::write(dir.join("_meta.json"), "{\"version\":\"1.0.0\"}")
            .expect("should write meta file");

        assert!(is_bundled_markdown_only_skill(&dir).expect("should classify markdown-only skill"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bundled_skill_with_runtime_assets() {
        let dir = create_temp_dir("bundled-runtime");
        fs::write(dir.join("SKILL.md"), "# skill\n").expect("should write skill file");
        fs::write(dir.join("index.js"), "console.log('hi')\n")
            .expect("should write runtime file");

        assert!(!is_bundled_markdown_only_skill(&dir).expect("should classify runtime skill"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn partitions_missing_skills_between_bundled_and_skillhub() {
        let _lock = BUNDLED_SKILLS_ENV_LOCK.lock().expect("should acquire env lock");
        let root = create_temp_dir("bundled-skill-plan");
        let markdown_dir = root.join("markdown-skill");
        let runtime_dir = root.join("runtime-skill");
        fs::create_dir_all(&markdown_dir).expect("should create markdown skill dir");
        fs::create_dir_all(&runtime_dir).expect("should create runtime skill dir");
        fs::write(markdown_dir.join("SKILL.md"), "# skill\n").expect("should write markdown skill");
        fs::write(runtime_dir.join("SKILL.md"), "# skill\n").expect("should write runtime skill");
        fs::write(runtime_dir.join("main.py"), "print('hi')\n")
            .expect("should write runtime asset");

        let previous = std::env::var_os("RHOPENCLAW_BUNDLED_SKILLS_DIR");
        std::env::set_var("RHOPENCLAW_BUNDLED_SKILLS_DIR", &root);

        let missing = vec![
            "markdown-skill".to_string(),
            "runtime-skill".to_string(),
            "remote-skill".to_string(),
        ];
        let (bundled_markdown, skillhub_required, classification_failures) =
            partition_missing_desktop_install_skills(&missing);

        assert_eq!(bundled_markdown, vec!["markdown-skill".to_string(), "runtime-skill".to_string()]);
        assert_eq!(skillhub_required, vec!["remote-skill".to_string()]);
        assert!(classification_failures.is_empty());

        match previous {
            Some(value) => std::env::set_var("RHOPENCLAW_BUNDLED_SKILLS_DIR", value),
            None => std::env::remove_var("RHOPENCLAW_BUNDLED_SKILLS_DIR"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn computes_missing_skills_case_insensitively() {
        let required = vec!["find-skills".to_string(), "markdown-skill".to_string()];
        let installed = HashSet::from(["find-skills".to_string(), "remote-skill".to_string()]);

        let missing = collect_missing_desktop_install_skills(&required, &installed);

        assert_eq!(missing, vec!["markdown-skill".to_string()]);
    }

    #[test]
    fn marks_installed_skill_case_insensitively() {
        let mut installed = HashSet::new();

        mark_skill_installed(&mut installed, " Find-Skills ");

        assert!(installed.contains("find-skills"));
        assert_eq!(installed.len(), 1);
    }

    #[test]
    fn ignores_empty_installed_skill_slug() {
        let mut installed = HashSet::from(["existing-skill".to_string()]);

        mark_skill_installed(&mut installed, "   ");

        assert_eq!(installed, HashSet::from(["existing-skill".to_string()]));
    }
}

/// Default timeout for general openclaw CLI commands (e.g. doctor, gateway start/stop).
const OPENCLAW_COMMAND_TIMEOUT_SECS: u64 = 300;

/// Longer timeout for heavyweight operations like `onboard`.
const OPENCLAW_ONBOARD_TIMEOUT_SECS: u64 = 600;

pub(crate) fn execute_openclaw_command(
    args: &[&str],
    extra_envs: &[(&str, &str)],
) -> Result<(String, String), String> {
    let is_heavy = args.first().map(|a| *a == "onboard").unwrap_or(false);
    let timeout_secs = if is_heavy { OPENCLAW_ONBOARD_TIMEOUT_SECS } else { OPENCLAW_COMMAND_TIMEOUT_SECS };
    execute_openclaw_command_with_timeout(args, extra_envs, std::time::Duration::from_secs(timeout_secs))
}

fn is_recoverable_windows_onboard_failure(detail: &str) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let normalized = detail.to_ascii_lowercase();
    // Match schtasks create failures regardless of whether the CLI prefixed with
    // "daemon-install" — newer openclaw versions may emit just
    // "Gateway service install failed: Error: schtasks create failed: …".
    if normalized.contains("schtasks create failed") {
        return true;
    }
    normalized.contains("daemon-install")
        && (
            normalized.contains("gateway service install did not complete successfully")
                || normalized.contains("gateway service install failed")
        )
}

/// Detect `schtasks /Run` failure when the scheduled task doesn't exist.
/// This happens when `gateway install` was previously denied (access denied)
/// so the task was never created, and now `gateway start` cannot run it.
fn is_gateway_task_not_found_error(detail: &str) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    let normalized = detail.to_ascii_lowercase();
    // "schtasks run failed" covers both English and Chinese Windows system messages
    // ("The system cannot find the file specified" / 系统找不到指定的文件).
    normalized.contains("schtasks run failed")
}

pub(crate) fn execute_openclaw_onboard_command(
    args: &[&str],
    extra_envs: &[(&str, &str)],
) -> Result<Option<String>, String> {
    match execute_openclaw_command(args, extra_envs) {
        Ok(_) => Ok(None),
        Err(error) => {
            if is_recoverable_windows_onboard_failure(&error) {
                let warning = "OpenClaw onboard 在 Windows 的 daemon-install 阶段返回可恢复告警，继续执行 Gateway 启动与健康校验。".to_string();
                eprintln!("[rhopenclaw] {warning} 原始输出: {error}");
                Ok(Some(warning))
            } else {
                Err(error)
            }
        }
    }
}

pub(crate) fn execute_openclaw_command_with_input(
    args: &[&str],
    extra_envs: &[(&str, &str)],
    stdin_input: Option<String>,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    execute_openclaw_command_with_input_and_timeout(args, extra_envs, stdin_input, timeout)
}

/// Resolve PATH from a login shell so that nvm/fnm/asdf initialisation is
/// included.  Tauri GUI apps inherit a bare system PATH that lacks node
/// version-manager entries, causing `#!/usr/bin/env node` to pick up the
/// wrong node version.
fn resolve_login_shell_path() -> String {
    if cfg!(target_os = "windows") {
        return std::env::var("PATH").unwrap_or_default();
    }
    Command::new("sh")
        .args(["-lc", "echo \"$PATH\""])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

pub(crate) fn execute_openclaw_command_with_timeout(
    args: &[&str],
    extra_envs: &[(&str, &str)],
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    execute_openclaw_command_with_input_and_timeout(args, extra_envs, None, timeout)
}

pub(crate) fn execute_openclaw_command_with_input_and_timeout(
    args: &[&str],
    extra_envs: &[(&str, &str)],
    stdin_input: Option<String>,
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let cli = detect_openclaw_cli().ok_or_else(|| "未检测到 openclaw CLI，请先安装 OpenClaw 官方 CLI。".to_string())?;
    let cli_path = PathBuf::from(&cli);
    let log_dir = std::env::temp_dir().join("rhopenclaw-desktop").join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| format!("failed to create openclaw log dir: {error}"))?;
    let log_suffix = if args.is_empty() {
        "cmd".to_string()
    } else {
        args.iter()
            .take(2)
            .map(|item| {
                item.chars()
                    .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("-")
    };
    let log_path = log_dir.join(format!("openclaw-{}-{}.log", log_suffix, current_unix_ms()));
    let log_path_string = log_path.to_string_lossy().to_string();
    let command_preview = std::iter::once(cli.as_str())
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let _ = append_log_line(
        &log_path_string,
        &AgentLogEntry {
            timestamp: now_iso_string(),
            level: "meta".into(),
            message: format!("spawn: {command_preview}"),
        },
    );
    let mut command = command_for_executable(&cli_path);
    command.args(args);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_input.is_some() {
        command.stdin(Stdio::piped());
    }

    // Ensure the child process can find the correct `node` binary.
    // Tauri GUI apps don't inherit login-shell PATH, so nvm/fnm/asdf
    // entries are invisible and `#!/usr/bin/env node` may resolve to an
    // old system node.  We resolve the login shell's PATH (which has
    // version-manager init applied) and prepend the CLI's own bin dir
    // plus known node runtime dirs for extra safety.
    if !extra_envs.iter().any(|(k, _)| *k == "PATH") {
        let mut extra_dirs: Vec<PathBuf> = Vec::new();
        if let Some(cli_dir) = PathBuf::from(&cli).parent().map(|p| p.to_path_buf()) {
            extra_dirs.push(cli_dir);
        }
        // If the offline bundle has a Node binary, extract it and prepend.
        if let Some(bundle_dir) = detect_openclaw_offline_bundle_dir() {
            if let Some(bin_dir) = prepare_offline_bundle_node_bin_dir(&bundle_dir) {
                if !extra_dirs.iter().any(|item| item == &bin_dir) {
                    extra_dirs.insert(0, bin_dir);
                }
            }
        }
        if let Some(home) = resolve_user_home_dir() {
            for dir in collect_node_runtime_bin_dirs(&home) {
                if !extra_dirs.iter().any(|item| item == &dir) {
                    extra_dirs.push(dir);
                }
            }
        }
        let base_path = resolve_login_shell_path();
        if let Some(merged) = merge_path_entries(extra_dirs, Some(&base_path)) {
            command.env("PATH", merged);
        } else if base_path != std::env::var("PATH").unwrap_or_default() {
            command.env("PATH", base_path);
        }
    }

    for (key, value) in extra_envs {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| {
            if error.raw_os_error() == Some(86) {
                format!(
                    "openclaw CLI ({}) 的 CPU 架构与当前系统不兼容（Bad CPU type in executable）。\
                    请安装匹配当前 CPU 架构的 OpenClaw CLI 或删除不兼容的旧版本后重试。",
                    cli
                )
            } else {
                format!("启动 openclaw 命令失败: {error}")
            }
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("openclaw 命令 stdout 不可用，日志: {log_path_string}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("openclaw 命令 stderr 不可用，日志: {log_path_string}"))?;

    let stdout_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));

    let stdout_reader_buffer = Arc::clone(&stdout_buffer);
    let stdout_log_path = log_path_string.clone();
    let stdout_reader = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(text) = line else {
                continue;
            };

            if let Ok(mut output) = stdout_reader_buffer.lock() {
                output.push_str(&text);
                output.push('\n');
            }

            let _ = append_log_line(
                &stdout_log_path,
                &AgentLogEntry {
                    timestamp: now_iso_string(),
                    level: "stdout".into(),
                    message: text,
                },
            );
        }
    });

    let stderr_reader_buffer = Arc::clone(&stderr_buffer);
    let stderr_log_path = log_path_string.clone();
    let stderr_reader = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(text) = line else {
                continue;
            };

            if let Ok(mut output) = stderr_reader_buffer.lock() {
                output.push_str(&text);
                output.push('\n');
            }

            let _ = append_log_line(
                &stderr_log_path,
                &AgentLogEntry {
                    timestamp: now_iso_string(),
                    level: "stderr".into(),
                    message: text,
                },
            );
        }
    });

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| format!("写入 openclaw 命令输入失败: {error}"))?;
            stdin
                .flush()
                .map_err(|error| format!("刷新 openclaw 命令输入失败: {error}"))?;
        }
    }

    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let mut exit_status = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status);
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = append_log_line(
                        &log_path_string,
                        &AgentLogEntry {
                            timestamp: now_iso_string(),
                            level: "warn".into(),
                            message: format!(
                                "timeout after {}s; terminating child process",
                                timeout.as_secs()
                            ),
                        },
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(format!("等待 openclaw 命令完成失败: {error}")),
        }
    }

    let _ = stdout_reader.join();
    let _ = stderr_reader.join();

    let stdout = stdout_buffer
        .lock()
        .map(|output| output.clone())
        .unwrap_or_default();
    let stderr = stderr_buffer
        .lock()
        .map(|output| output.clone())
        .unwrap_or_default();

    if timed_out {
        return Err(format!(
            "openclaw {} 超时 ({}s)，已终止子进程；日志: {}",
            args.first().unwrap_or(&""),
            timeout.as_secs(),
            log_path_string
        ));
    }

    let output = exit_status.ok_or_else(|| format!("openclaw 命令未返回退出状态；日志: {log_path_string}"))?;

    if output.success() {
        return Ok((stdout, stderr));
    }

    let detail = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("openclaw 命令退出码异常: {output}")
    };

    Err(format!("{detail}；日志: {log_path_string}"))
}

pub(crate) fn install_openclaw_cli_if_missing(
    _download_url: Option<&str>,
    _expected_sha256: Option<&str>,
) -> Result<(Option<String>, Option<String>, bool, Option<String>), String> {
    let cli_available = detect_openclaw_cli().is_some();
    let current_version = detect_current_openclaw_runtime_version();
    let offline_bundle_dir = detect_openclaw_offline_bundle_dir();
    let offline_bundle_version = resolve_offline_bundle_openclaw_version_info(offline_bundle_dir.as_ref())
        .resolved_version;

    if cli_available
        && !should_upgrade_to_offline_bundle_version(
            current_version.as_deref(),
            offline_bundle_version.as_deref(),
        )
    {
        return Ok((None, None, false, None));
    }

    let bundle_dir = offline_bundle_dir
        .as_ref()
        .ok_or_else(|| "安装/升级 OpenClaw CLI 缺少离线包资源。".to_string())?;

    let install_envs = build_openclaw_install_env(Some(bundle_dir));

    // ── 统一离线包升级（macOS / Windows / Linux 共用 npm install -g） ──
    let node_dir = prepare_offline_bundle_node_bin_dir(bundle_dir)
        .ok_or_else(|| "离线包缺少可用的 Node.js 运行时。".to_string())?;

    let openclaw_package = fs::read_dir(bundle_dir.join("packages").join("openclaw"))
        .map_err(|e| format!("读取离线包 openclaw 目录失败: {e}"))?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|v| v.to_str())
                .map(|name| name.starts_with("openclaw-") && name.ends_with(".tgz"))
                .unwrap_or(false)
        })
        .ok_or_else(|| "离线包缺少 openclaw tgz 包。".to_string())?;

    let npm_exe = if cfg!(target_os = "windows") {
        node_dir.join("npm.cmd")
    } else {
        node_dir.join("npm")
    };
    if !npm_exe.exists() {
        return Err(format!("离线包缺少 npm 可执行文件: {}", npm_exe.display()));
    }

    let npm_prefix = resolve_openclaw_install_target_prefix_dir()?;
    fs::create_dir_all(&npm_prefix)
        .map_err(|e| format!("创建 npm 全局目录失败: {e}"))?;
    let offline_npmrc = prepare_offline_npm_config_file()?;

    let mut command = command_for_executable(&npm_exe);
    command
        .arg("install")
        .arg("-g")
        .arg("--force")
        .arg("--offline")
        .arg("--ignore-scripts")
        .arg(&openclaw_package)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NPM_CONFIG_PREFIX", &npm_prefix)
        .env("npm_config_prefix", &npm_prefix)
        .env("NPM_CONFIG_USERCONFIG", &offline_npmrc)
        .env("npm_config_userconfig", &offline_npmrc)
        .env("NPM_CONFIG_OFFLINE", "true")
        .env("npm_config_offline", "true")
        .env("OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL", "1");
    if let Some(path_value) = merge_path_entries(
        vec![node_dir.clone(), npm_prefix.clone()],
        std::env::var("PATH").ok().as_deref(),
    ) {
        command.env("PATH", path_value);
    }
    // 离线安装：过滤掉网络源配置，禁止 npm 联网
    for (key, value) in &install_envs {
        match key.as_str() {
            "NPM_CONFIG_REGISTRY" | "NODEJS_ORG_MIRROR" | "NVM_NODEJS_ORG_MIRROR" => continue,
            _ => { command.env(key, value); }
        }
    }

    let _ = run_child_with_timeout_and_drain(
        &mut command, OPENCLAW_ONBOARD_TIMEOUT_SECS, "离线包 npm 安装",
    )?;

    let installed_cli_path = resolve_openclaw_cli_path_from_prefix_dir(&npm_prefix);
    if !installed_cli_path.exists() {
        return Err(format!(
            "离线包安装已执行，但目标路径未生成 openclaw CLI 入口：{}",
            installed_cli_path.display(),
        ));
    }

    // Detect version from installed package.json instead of running `openclaw --version`,
    // because the Tauri GUI process may not have Node.js in PATH (e.g. nvm node),
    // causing `#!/usr/bin/env node` scripts to fail silently.
    let installed_version = read_installed_openclaw_version_from_prefix(&npm_prefix)
        .or_else(|| detect_openclaw_cli_version_from_path(&installed_cli_path));
    if should_upgrade_to_offline_bundle_version(
        installed_version.as_deref(),
        offline_bundle_version.as_deref(),
    ) {
        return Err(format!(
            "离线包安装已执行，但版本仍低于离线包版本：{} -> {}",
            installed_version.unwrap_or_else(|| installed_cli_path.to_string_lossy().to_string()),
            offline_bundle_version.unwrap_or_else(|| "<unknown>".to_string()),
        ));
    }

    // npm install -g 在某些环境下不会释放 docs/reference/templates/ 目录，
    // 但 gateway 的 workspace-templates 模块在 dispatch 时需要读取该目录中的
    // AGENTS.md 等模板文件，缺失会导致消息处理失败。
    // 安装完成后从离线包 tgz 中补充提取 templates 目录。
    ensure_openclaw_package_templates(&npm_prefix, &openclaw_package);

    Ok((
        Some(openclaw_package.to_string_lossy().to_string()),
        None,
        false,
        Some("full-offline-only-npm".to_string()),
    ))
}

// ---------------------------------------------------------------------------
// 子进程执行 + stdout/stderr drain + 超时控制
// ---------------------------------------------------------------------------
fn run_child_with_timeout_and_drain(
    command: &mut Command,
    timeout_secs: u64,
    label: &str,
) -> Result<(String, String), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动{label}失败: {error}"))?;

    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();
    let stdout_thread = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut out) = child_stdout {
            let _ = std::io::Read::read_to_string(&mut out, &mut buf);
        }
        buf
    });
    let stderr_thread = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut err) = child_stderr {
            let _ = std::io::Read::read_to_string(&mut err, &mut buf);
        }
        buf
    });

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(format!("等待{label}完成失败: {error}")),
        }
    }

    let stdout_output = stdout_thread.join().unwrap_or_default();
    let stderr_output = stderr_thread.join().unwrap_or_default();

    if timed_out {
        return Err(format!(
            "{label}超时 ({}s)，已终止子进程",
            timeout.as_secs()
        ));
    }

    let status = child
        .wait()
        .map_err(|error| format!("读取{label}输出失败: {error}"))?;
    if !status.success() {
        let detail = if !stderr_output.trim().is_empty() {
            stderr_output.trim().to_string()
        } else if !stdout_output.trim().is_empty() {
            stdout_output.trim().to_string()
        } else {
            format!("{label}退出异常: {status}")
        };
        return Err(detail);
    }

    Ok((stdout_output, stderr_output))
}

/// npm install -g 在某些 Node/npm 版本组合下（如通过 nvm 安装、或高版本 npm
/// 配合 --offline --ignore-scripts 参数）不会释放包中的 `docs/` 目录。
/// 而 OpenClaw gateway 的 workspace-templates 模块在消息 dispatch 时会从
/// `<packageRoot>/docs/reference/templates/AGENTS.md` 等文件加载模板，
/// 缺失会抛 `Missing workspace template` 错误，导致消息回复
/// "[OpenClaw] 消息处理失败，请稍后重试。"。
///
/// 本函数在 npm install -g 完成后检查 templates 目录是否完整，
/// 不完整时从离线包 tgz 中补充提取。
fn ensure_openclaw_package_templates(npm_prefix: &Path, tgz_path: &Path) {
    let package_root = npm_prefix
        .join("lib")
        .join("node_modules")
        .join("openclaw");
    let templates_dir = package_root
        .join("docs")
        .join("reference")
        .join("templates");

    // 检查关键模板文件是否存在
    let sentinel = templates_dir.join("AGENTS.md");
    if sentinel.exists() {
        return;
    }

    // 从 tgz 中提取 docs/reference/templates/ 到 package_root。
    let result = if cfg!(target_os = "windows") {
        extract_tar_gz_prefix_to_dir(
            tgz_path,
            Path::new("package/docs/reference/templates"),
            Path::new("package"),
            &package_root,
        )
        .map(|count| count > 0)
    } else {
        std::process::Command::new("tar")
            .arg("xzf")
            .arg(tgz_path)
            .arg("--strip-components=1")
            .arg("package/docs/reference/templates/")
            .current_dir(&package_root)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map(|output| {
                if output.status.success() {
                    true
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!(
                        "[openclaw-install] 补充提取 templates 失败 (exit {}): {}",
                        output.status,
                        stderr.trim(),
                    );
                    false
                }
            })
            .map_err(|error| format!("补充提取 templates 时无法执行 tar: {error}"))
    };

    match result {
        Ok(true) => {
            eprintln!(
                "[openclaw-install] 已从离线包补充提取 docs/reference/templates/ 到 {}",
                package_root.display(),
            );
        }
        Ok(false) => {
            eprintln!("[openclaw-install] 补充提取 templates 后未写入任何文件");
        }
        Err(error) => {
            eprintln!("[openclaw-install] {error}");
        }
    }
}

fn prepare_offline_npm_config_file() -> Result<PathBuf, String> {
    let config_dir = std::env::temp_dir()
        .join("rhopenclaw-desktop")
        .join("npm-config");
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("创建离线 npm 配置目录失败: {error}"))?;
    let config_path = config_dir.join("offline.npmrc");
    fs::write(
        &config_path,
        "offline=true\naudit=false\nfund=false\nupdate-notifier=false\n",
    )
    .map_err(|error| format!("写入离线 npm 配置失败: {error}"))?;
    Ok(config_path)
}

fn resolve_full_offline_bundle_platform_label() -> Option<&'static str> {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Some("macos-arm64")
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        Some("macos-x64")
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        Some("windows-x64")
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        Some("linux-x64")
    } else {
        None
    }
}

fn detect_openclaw_offline_bundle_dir_from_root(root: &Path) -> Option<PathBuf> {
    if let Some(platform_label) = resolve_full_offline_bundle_platform_label() {
        let full_offline_dir = root
            .join("full-offline-only")
            .join(platform_label);
        if full_offline_dir.exists() {
            return Some(full_offline_dir);
        }
    }

    None
}

pub(crate) fn detect_openclaw_offline_bundle_dir() -> Option<PathBuf> {
    if let Some(candidate) = std::env::var_os("RHOPENCLAW_OFFLINE_BUNDLE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.exists())
    {
        return Some(candidate);
    }

    if let Ok(exe) = std::env::current_exe() {
        // macOS .app layout:
        // 1. Contents/MacOS/<binary> -> Contents/Resources/_up_/release/openclaw-bootstrap/full-offline-only/<platform>
        // 2. Contents/MacOS/<binary> -> Contents/Resources/release/openclaw-bootstrap/full-offline-only/<platform>
        if let Some(contents_dir) = exe.parent().and_then(|p| p.parent()) {
            let bundled_candidates = [
                contents_dir
                    .join("Resources")
                    .join("_up_")
                    .join("release")
                    .join("openclaw-bootstrap"),
                contents_dir
                    .join("Resources")
                    .join("release")
                    .join("openclaw-bootstrap"),
            ];

            for bundled in bundled_candidates {
                if let Some(bundle_dir) = detect_openclaw_offline_bundle_dir_from_root(&bundled) {
                    return Some(bundle_dir);
                }
            }
        }

        // Windows NSIS / standalone layout: Tauri bundles resources outside src-tauri/ under _up_/
        // e.g. {install_dir}/_up_/release/openclaw-bootstrap/full-offline-only/{platform}
        if let Some(bin_dir) = exe.parent() {
            let up_sibling = bin_dir
                .join("_up_")
                .join("release")
                .join("openclaw-bootstrap");
            if let Some(bundle_dir) = detect_openclaw_offline_bundle_dir_from_root(&up_sibling) {
                return Some(bundle_dir);
            }
        }

        // dev / other layouts fallback: alongside executable
        if let Some(bin_dir) = exe.parent() {
            let sibling = bin_dir
                .join("release")
                .join("openclaw-bootstrap");
            if let Some(bundle_dir) = detect_openclaw_offline_bundle_dir_from_root(&sibling) {
                return Some(bundle_dir);
            }
        }
    }

    // Dev-mode fallback: CARGO_MANIFEST_DIR (src-tauri/) -> parent (RHOpenClaw-Desktop/) -> release/...
    {
        let cargo_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(project_root) = cargo_dir.parent() {
            let dev_bundle = project_root
                .join("release")
                .join("openclaw-bootstrap");
            if let Some(bundle_dir) = detect_openclaw_offline_bundle_dir_from_root(&dev_bundle) {
                return Some(bundle_dir);
            }
        }
    }

    None
}

fn read_offline_bundle_manifest_openclaw_version(bundle_dir: &Path) -> Option<String> {
    let manifest_path = bundle_dir
        .join("manifests")
        .join("full-offline-materials.json");
    let content = fs::read_to_string(manifest_path).ok()?;
    let payload = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    payload
        .get("openclawVersion")
        .and_then(|value| value.as_str())
        .and_then(sanitize_version_value)
}

fn extract_openclaw_version_from_package_name(file_name: &str) -> Option<String> {
    let mut version = file_name
        .trim()
        .strip_prefix("openclaw-")?
        .strip_suffix(".tgz")?;
    // The full-offline tgz is named openclaw-X.Y.Z-with-deps.tgz — strip the suffix.
    if let Some(base) = version.strip_suffix("-with-deps") {
        version = base;
    }
    sanitize_version_value(version)
}

fn read_offline_bundle_package_openclaw_version(bundle_dir: &Path) -> Option<String> {
    let packages_dir = bundle_dir.join("packages").join("openclaw");
    let mut versions = fs::read_dir(packages_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|value| value.to_str())
                .and_then(extract_openclaw_version_from_package_name)
        })
        .collect::<Vec<_>>();

    versions.sort_by(|left, right| compare_openclaw_versions(left, right).unwrap_or(Ordering::Equal));
    versions.pop()
}

pub(crate) fn resolve_offline_bundle_openclaw_version_info(
    offline_bundle_dir: Option<&PathBuf>,
) -> OfflineBundleOpenClawVersionInfo {
    let Some(bundle_dir) = offline_bundle_dir else {
        return OfflineBundleOpenClawVersionInfo::default();
    };

    let manifest_version = read_offline_bundle_manifest_openclaw_version(bundle_dir.as_path());
    let package_version = read_offline_bundle_package_openclaw_version(bundle_dir.as_path());
    let consistent = match (&manifest_version, &package_version) {
        (Some(manifest), Some(package)) => {
            matches!(compare_openclaw_versions(manifest, package), Some(Ordering::Equal))
        }
        _ => true,
    };
    if !consistent {
        eprintln!(
            "[WARN] 离线包版本不一致: manifest={}, package={} — 以 tgz 包版本为准",
            manifest_version.as_deref().unwrap_or("<none>"),
            package_version.as_deref().unwrap_or("<none>"),
        );
    }
    // tgz 包版本 > manifest 声明版本 > 无
    let resolved_version = match (&manifest_version, &package_version) {
        (_, Some(package)) => Some(package.clone()),
        (Some(manifest), None) => Some(manifest.clone()),
        (None, None) => None,
    };

    OfflineBundleOpenClawVersionInfo {
        manifest_version,
        package_version,
        resolved_version,
        consistent,
    }
}

fn append_unique_source(target: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !target.iter().any(|item| item == &value) {
        target.push(value);
    }
}

fn collect_openclaw_installer_sources(
    download_url: Option<&str>,
    offline_bundle_dir: Option<&PathBuf>,
) -> Vec<String> {
    let mut sources = Vec::new();

    if let Some(bundle_dir) = offline_bundle_dir {
        for path in [
            bundle_dir.join("openclaw").join("install-cn.sh"),
            bundle_dir.join("install-cn.sh"),
            bundle_dir.join("mirrors").join("openclaw").join("install-cn.sh"),
            bundle_dir.join("openclaw").join("install.sh"),
        ] {
            if path.exists() {
                append_unique_source(&mut sources, path.to_string_lossy().to_string());
            }
        }
    }

    if let Some(value) = download_url
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        append_unique_source(&mut sources, value.to_string());
    }

    append_unique_source(
        &mut sources,
        OPENCLAW_DEFAULT_INSTALL_SCRIPT_MIRROR_URL.to_string(),
    );
    append_unique_source(
        &mut sources,
        OPENCLAW_DEFAULT_INSTALL_SCRIPT_ORIGIN_MIRROR_URL.to_string(),
    );

    sources
}

pub(crate) fn build_openclaw_install_env(offline_bundle_dir: Option<&PathBuf>) -> Vec<(String, String)> {
    let mut envs = vec![
        (
            "NPM_CONFIG_REGISTRY".to_string(),
            OPENCLAW_DEFAULT_NPM_REGISTRY.to_string(),
        ),
        (
            "NODEJS_ORG_MIRROR".to_string(),
            OPENCLAW_DEFAULT_NODE_MIRROR.to_string(),
        ),
        (
            "NVM_NODEJS_ORG_MIRROR".to_string(),
            OPENCLAW_DEFAULT_NODE_MIRROR.to_string(),
        ),
        (
            "HOMEBREW_BREW_GIT_REMOTE".to_string(),
            OPENCLAW_DEFAULT_HOMEBREW_BREW_GIT_REMOTE.to_string(),
        ),
        (
            "HOMEBREW_CORE_GIT_REMOTE".to_string(),
            OPENCLAW_DEFAULT_HOMEBREW_CORE_GIT_REMOTE.to_string(),
        ),
        (
            "HOMEBREW_API_DOMAIN".to_string(),
            OPENCLAW_DEFAULT_HOMEBREW_API_DOMAIN.to_string(),
        ),
        (
            "HOMEBREW_BOTTLE_DOMAIN".to_string(),
            OPENCLAW_DEFAULT_HOMEBREW_BOTTLE_DOMAIN.to_string(),
        ),
        ("NO_PROMPT".to_string(), "1".to_string()),
        ("OPENCLAW_NO_ONBOARD".to_string(), "1".to_string()),
        ("OPENCLAW_NPM_LOGLEVEL".to_string(), "error".to_string()),
        (
            "RHOPENCLAW_OPENCLAW_INSTALL_SCRIPT_MIRROR_URL".to_string(),
            OPENCLAW_DEFAULT_INSTALL_SCRIPT_ORIGIN_MIRROR_URL.to_string(),
        ),
    ];

    if let Some(bundle_dir) = offline_bundle_dir {
        envs.push((
            "RHOPENCLAW_OFFLINE_BUNDLE_DIR".to_string(),
            bundle_dir.to_string_lossy().to_string(),
        ));
    }

    if let Some(home) = resolve_user_home_dir() {
        let home_value = home.to_string_lossy().to_string();
        envs.push(("HOME".to_string(), home_value.clone()));
        if cfg!(target_os = "windows") {
            envs.push(("USERPROFILE".to_string(), home_value));
        }
    }

    // Finder 启动的 macOS App 常常只有最小 PATH，需显式补齐 node 相关 bin 路径。
    let mut merged_path_parts: Vec<PathBuf> = Vec::new();
    let mut push_unique_path = |value: PathBuf| {
        if value.as_os_str().is_empty() {
            return;
        }
        if !merged_path_parts.iter().any(|item| item == &value) {
            merged_path_parts.push(value);
        }
    };

    if let Some(home) = resolve_user_home_dir() {

        if let Some(bundle_dir) = offline_bundle_dir {
            if let Some(bin_dir) = prepare_offline_bundle_node_bin_dir(bundle_dir) {
                push_unique_path(bin_dir);
            }
        }

        for dir in collect_node_runtime_bin_dirs(&home) {
            if dir.exists() {
                push_unique_path(dir);
            }
        }
    }

    if cfg!(target_os = "macos") {
        push_unique_path(PathBuf::from("/opt/homebrew/bin"));
        push_unique_path(PathBuf::from("/usr/local/bin"));
        push_unique_path(PathBuf::from("/usr/bin"));
        push_unique_path(PathBuf::from("/bin"));
    }

    if let Some(merged_path) = merge_path_entries(merged_path_parts, std::env::var("PATH").ok().as_deref()) {
        envs.push(("PATH".to_string(), merged_path));
    }

    envs
}

pub(crate) fn default_desktop_install_skills_config() -> DesktopInstallSkillsConfig {
    DesktopInstallSkillsConfig {
        mode: "recommended".to_string(),
        skills: DEFAULT_DESKTOP_RECOMMENDED_SKILLS
            .iter()
            .map(|item| item.to_string())
            .collect(),
        notes: "default recommended skills".to_string(),
        updated_at: None,
        skillhub: Some(DesktopSkillhubConfig {
            site_url: SKILLHUB_DEFAULT_SITE_URL.to_string(),
            installer_url: SKILLHUB_DEFAULT_INSTALLER_URL.to_string(),
        }),
    }
}

fn normalize_skill_slug(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed
        .split(':')
        .next_back()
        .unwrap_or(trimmed)
        .trim()
        .to_string();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_desktop_install_skills(skills: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for skill in skills {
        if let Some(value) = normalize_skill_slug(skill) {
            if !normalized.iter().any(|item| item == &value) {
                normalized.push(value);
            }
        }
    }

    normalized
}

fn collect_missing_desktop_install_skills(
    required_skills: &[String],
    installed_snapshot: &HashSet<String>,
) -> Vec<String> {
    required_skills
        .iter()
        .filter(|slug| !installed_snapshot.contains(&slug.to_lowercase()))
        .cloned()
        .collect()
}

fn mark_skill_installed(installed_snapshot: &mut HashSet<String>, slug: &str) {
    if let Some(normalized) = normalize_skill_slug(slug) {
        installed_snapshot.insert(normalized.to_lowercase());
    }
}

fn partition_missing_desktop_install_skills(
    missing_skills: &[String],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut bundled_markdown = Vec::new();
    let mut skillhub_required = Vec::new();
    let mut classification_failures = Vec::new();

    for slug in missing_skills {
        let is_bundled_markdown = bundled_skill_source_dir(slug)
            .map(|source_dir| is_bundled_markdown_only_skill(&source_dir))
            .transpose();

        match is_bundled_markdown {
            Ok(Some(_)) => bundled_markdown.push(slug.clone()),
            Ok(None) => skillhub_required.push(slug.clone()),
            Err(error) => {
                classification_failures.push(format!("{slug}: {error}"));
                skillhub_required.push(slug.clone());
            }
        }
    }

    (bundled_markdown, skillhub_required, classification_failures)
}

pub(crate) fn fetch_desktop_install_skills_config(
    server_api_base_url: Option<&str>,
) -> DesktopInstallSkillsConfig {
    let normalized_base_url = normalize_api_base_url(
        server_api_base_url.unwrap_or(RHOPENCLAW_DEFAULT_SERVER_API_BASE_URL),
    );
    let url = format!("{normalized_base_url}/desktop/install/skills");
    perform_native_json_request(Method::GET, &url, None, None)
        .and_then(|payload| {
            serde_json::from_value::<DesktopInstallSkillsConfig>(payload)
                .map_err(|error| format!("failed to parse desktop install skills config: {error}"))
        })
        .map(|mut config| {
            config.mode = "recommended".to_string();
            config.skills = normalize_desktop_install_skills(&config.skills);
            if config.skills.is_empty() {
                config.skills = default_desktop_install_skills_config().skills;
            }
            config
        })
        .unwrap_or_else(|_| default_desktop_install_skills_config())
}

pub(crate) fn should_skip_openclaw_builtin_skills(config: &DesktopInstallSkillsConfig) -> bool {
    let _ = config;
    true
}

fn build_skillhub_env() -> Vec<(String, String)> {
    let mut envs = build_openclaw_install_env(detect_openclaw_offline_bundle_dir().as_ref());

    let home_var = if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" };
    if let Ok(home) = std::env::var(home_var) {
        let extra_paths = vec![
            PathBuf::from(&home).join(".local").join("bin"),
            PathBuf::from(&home).join("bin"),
        ];
        let existing_path = envs
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.as_str());
        if let Some(merged_path) = merge_path_entries(extra_paths, existing_path) {
            if let Some((_, current)) = envs.iter_mut().find(|(key, _)| key == "PATH") {
                *current = merged_path;
            } else {
                envs.push(("PATH".to_string(), merged_path));
            }
        }
    }

    envs
}

pub(crate) fn detect_skillhub_cli() -> Option<String> {
    if cfg!(target_os = "windows") {
        if let Ok(output) = Command::new("where.exe").arg("skillhub").output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let resolved = resolve_windows_runnable_command_path(Path::new(line.trim()));
                    if is_supported_skillhub_cli(&resolved) {
                        return Some(resolved.to_string_lossy().to_string());
                    }
                }
            }
        }

        if let Some(home) = resolve_user_home_dir() {
            // Check ~/.local/bin/skillhub.cmd (native install wrapper)
            let local_bin = home.join(".local").join("bin");
            for candidate in [
                local_bin.join("skillhub.cmd"),
                local_bin.join("skillhub.exe"),
                local_bin.join("skillhub"),
            ] {
                if is_supported_skillhub_cli(&candidate) {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }

            let prefix_dir = resolve_openclaw_npm_global_prefix_dir(&home);
            for candidate in [
                prefix_dir.join("skillhub.cmd"),
                prefix_dir.join("skillhub.exe"),
                prefix_dir.join("skillhub"),
            ] {
                if is_supported_skillhub_cli(&candidate) {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }

        if let Some(app_data) = std::env::var_os("APPDATA") {
            let npm_dir = PathBuf::from(app_data).join("npm");
            for candidate in [
                npm_dir.join("skillhub.cmd"),
                npm_dir.join("skillhub.exe"),
                npm_dir.join("skillhub"),
            ] {
                if is_supported_skillhub_cli(&candidate) {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }

        return None;
    }

    if let Ok(output) = Command::new("sh")
        .args(["-lc", "command -v skillhub"])
        .output()
    {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    let home = std::env::var("HOME").ok()?;
    [
        format!("{home}/.local/bin/skillhub"),
        format!("{home}/bin/skillhub"),
    ]
    .into_iter()
    .find(|candidate| is_supported_skillhub_cli(&PathBuf::from(candidate)))
}

pub(crate) fn install_skillhub_cli_if_missing(
    config: &DesktopInstallSkillsConfig,
) -> Result<(), String> {
    if detect_skillhub_cli().is_some() {
        return Ok(());
    }

    let installer_url = config
        .skillhub
        .as_ref()
        .map(|item| item.installer_url.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(SKILLHUB_DEFAULT_INSTALLER_URL);

    // Try bash-based install first (works on macOS/Linux, and Windows with Git Bash)
    if let Some(shell) = detect_skillhub_shell() {
        let mut command = command_for_executable(&shell);
        command
            .args(["-c", "curl -fsSL \"$SKILLHUB_INSTALLER_URL\" | bash"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("SKILLHUB_INSTALLER_URL", installer_url);

        for (key, value) in build_skillhub_env() {
            command.env(key, value);
        }

        let timeout = std::time::Duration::from_secs(180);
        let spawn_result = command.spawn();

        if let Ok(mut child) = spawn_result {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            let _ = child.kill();
                            eprintln!("[rhopenclaw] SkillHub bash 安装超时，尝试原生部署");
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                    Err(_) => break,
                }
            }

            if let Ok(output) = child.wait_with_output() {
                if output.status.success() && detect_skillhub_cli().is_some() {
                    return Ok(());
                }
            }
        }
    }

    // Fallback: Windows native install (download tar.gz, extract, deploy files)
    if cfg!(target_os = "windows") {
        eprintln!("[rhopenclaw] bash 安装不可用，使用 Windows 原生方式部署 SkillHub CLI");
        return install_skillhub_cli_native_windows();
    }

    Err(format!(
        "未检测到 bash/sh，无法安装 SkillHub CLI。请手动执行: curl -fsSL {installer_url} | bash"
    ))
}

/// 返回 skillhub skills 的标准安装目录: `$HOME/.openclaw/skills`
/// Windows 兼容: 优先使用 HOME，fallback 到 USERPROFILE
fn skillhub_skills_dir() -> PathBuf {
    let home = resolve_user_home_dir().unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            std::env::temp_dir()
        } else {
            PathBuf::from("/tmp")
        }
    });
    home.join(".openclaw").join("skills")
}

fn build_skillhub_command_args(args: &[&str]) -> Vec<String> {
    let mut command_args = Vec::with_capacity(args.len() + 2);
    command_args.push("--dir".to_string());
    command_args.push(skillhub_skills_dir().to_string_lossy().to_string());
    command_args.extend(args.iter().map(|value| (*value).to_string()));
    command_args
}

pub(crate) fn execute_skillhub_command(args: &[&str]) -> Result<(String, String), String> {
    let timeout = if matches!(args.first().copied(), Some("install") | Some("update")) {
        std::time::Duration::from_secs(180)
    } else {
        std::time::Duration::from_secs(30)
    };
    execute_skillhub_command_with_timeout(args, timeout)
}

pub(crate) fn execute_skillhub_command_with_timeout(
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<(String, String), String> {
    let cli = detect_skillhub_cli().ok_or_else(|| "未检测到 skillhub CLI。".to_string())?;
    let command_args = build_skillhub_command_args(args);
    let cli_path = PathBuf::from(&cli);
    let mut command = command_for_executable(&cli_path);
    command
        .args(&command_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in build_skillhub_env() {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 skillhub 命令失败: {error}"))?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(format!(
                        "skillhub {} 超时 ({}s)，已终止子进程",
                        args.first().unwrap_or(&""),
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(format!("等待 skillhub 命令完成失败: {error}")),
        }
    }

    let output = child.wait_with_output()
        .map_err(|error| format!("读取 skillhub 命令输出失败: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        return Ok((stdout, stderr));
    }

    Err(if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("skillhub 命令退出码异常: {}", output.status)
    })
}

/// Windows 原生部署 SkillHub CLI 文件（不依赖 bash / Python）。
/// 从 COS 下载 latest.tar.gz → 用内置 Rust 解压 →
/// 拷贝 python 脚本到 ~/.skillhub/ → 创建 .cmd wrapper。
fn install_skillhub_cli_native_windows() -> Result<(), String> {
    let home = resolve_user_home_dir()
        .ok_or_else(|| "无法获取用户主目录".to_string())?;

    let skillhub_home = home.join(".skillhub");
    let bin_dir = home.join(".local").join("bin");
    fs::create_dir_all(&skillhub_home)
        .map_err(|err| format!("创建 ~/.skillhub 失败: {err}"))?;
    fs::create_dir_all(&bin_dir)
        .map_err(|err| format!("创建 ~/.local/bin 失败: {err}"))?;

    // Download latest.tar.gz
    let tmp_dir = std::env::temp_dir().join("rhclaw-skillhub-install");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir)
        .map_err(|err| format!("创建临时目录失败: {err}"))?;

    let tar_gz_path = tmp_dir.join("latest.tar.gz");
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| format!("HTTP client 创建失败: {err}"))?;

    let response = client
        .get(SKILLHUB_DEFAULT_ARCHIVE_URL)
        .send()
        .map_err(|err| format!("下载 SkillHub 安装包失败: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "下载 SkillHub 安装包 HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|err| format!("读取 SkillHub 安装包失败: {err}"))?;

    fs::write(&tar_gz_path, &bytes)
        .map_err(|err| format!("写入 tar.gz 失败: {err}"))?;

    extract_tar_gz_archive_to_dir(&tar_gz_path, &tmp_dir)
        .map_err(|error| format!("SkillHub 安装包解压失败: {error}"))?;

    // Copy CLI files to ~/.skillhub/
    let cli_src = tmp_dir.join("cli");
    if !cli_src.exists() {
        return Err("解压后未找到 cli 目录".to_string());
    }

    for file_name in [
        "skills_store_cli.py",
        "skills_upgrade.py",
        "version.json",
        "metadata.json",
    ] {
        let src = cli_src.join(file_name);
        if src.exists() {
            fs::copy(&src, skillhub_home.join(file_name))
                .map_err(|err| format!("拷贝 {file_name} 失败: {err}"))?;
        }
    }

    // Write config.json if it doesn't exist
    let config_path = skillhub_home.join("config.json");
    if !config_path.exists() {
        let config_json = serde_json::json!({
            "self_update_url": "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/version.json"
        });
        if let Ok(text) = serde_json::to_string_pretty(&config_json) {
            let _ = fs::write(&config_path, text);
        }
    }

    // Create skillhub.cmd wrapper in ~/.local/bin/
    // This wrapper checks for python3/python and calls the CLI script
    let wrapper_path = bin_dir.join("skillhub.cmd");
    let wrapper_content = format!(
        r#"@echo off
setlocal
set "CLI={skillhub_home}\skills_store_cli.py"
if not exist "%CLI%" (
    echo Error: SkillHub CLI not found at %CLI% >&2
    exit /b 1
)
where python3 >nul 2>&1 && (python3 "%CLI%" %* & exit /b %errorlevel%)
where python >nul 2>&1 && (python "%CLI%" %* & exit /b %errorlevel%)
echo Error: python3/python not found. SkillHub CLI requires Python 3. >&2
exit /b 1
"#,
        skillhub_home = skillhub_home.display()
    );
    fs::write(&wrapper_path, wrapper_content)
        .map_err(|err| format!("创建 skillhub.cmd 失败: {err}"))?;

    // Install workspace skills (find-skills, skillhub-preference) from the archive
    let skill_src = cli_src.join("skill");
    if skill_src.exists() {
        let workspace_skills_base = home.join(".openclaw").join("workspace").join("skills");

        let find_skill_src = skill_src.join("SKILL.md");
        if find_skill_src.exists() {
            let target = workspace_skills_base.join("find-skills");
            fs::create_dir_all(&target)
                .map_err(|err| format!("创建 find-skills 目录失败: {err}"))?;
            fs::copy(&find_skill_src, target.join("SKILL.md"))
                .map_err(|err| format!("拷贝 find-skills SKILL.md 失败: {err}"))?;
        }

        let pref_skill_src = skill_src.join("SKILL.skillhub-preference.md");
        if pref_skill_src.exists() {
            let target = workspace_skills_base.join("skillhub-preference");
            fs::create_dir_all(&target)
                .map_err(|err| format!("创建 skillhub-preference 目录失败: {err}"))?;
            fs::copy(&pref_skill_src, target.join("SKILL.md"))
                .map_err(|err| format!("拷贝 skillhub-preference SKILL.md 失败: {err}"))?;
        }
    }

    // Cleanup temp dir
    let _ = fs::remove_dir_all(&tmp_dir);

    eprintln!(
        "[rhopenclaw] SkillHub CLI 已原生部署: {} (wrapper: {})",
        skillhub_home.display(),
        bin_dir.join("skillhub.cmd").display()
    );

    Ok(())
}

pub(crate) fn apply_desktop_install_skills(
    config: &DesktopInstallSkillsConfig,
) -> Result<(), String> {
    let required_skills = {
        let normalized = normalize_desktop_install_skills(&config.skills);
        if normalized.is_empty() {
            default_desktop_install_skills_config().skills
        } else {
            normalized
        }
    };

    let mut installed_snapshot = collect_local_skill_slug_set();

    let missing_slugs = collect_missing_desktop_install_skills(&required_skills, &installed_snapshot);

    if missing_slugs.is_empty() {
        return Ok(());
    }

    let (bundled_markdown_slugs, mut skillhub_slugs, mut install_failures) =
        partition_missing_desktop_install_skills(&missing_slugs);

    for slug in &bundled_markdown_slugs {
        let normalized_slug = slug.to_lowercase();
        if installed_snapshot.contains(&normalized_slug) {
            continue;
        }

        match install_bundled_markdown_skill(slug) {
            Ok(true) => {
                mark_skill_installed(&mut installed_snapshot, slug);
            }
            Ok(false) => {
                skillhub_slugs.push(slug.clone());
            }
            Err(error) if is_skill_already_available_error(&error) => {
                mark_skill_installed(&mut installed_snapshot, slug);
            }
            Err(error) => {
                install_failures.push(format!("{slug}: {error}"));
            }
        }
    }

    if !skillhub_slugs.is_empty() && detect_skillhub_cli().is_none() {
        install_skillhub_cli_if_missing(config)
            .map_err(|err| format!("SkillHub CLI 部署失败: {err}"))?;
        installed_snapshot = collect_local_skill_slug_set();
    }

    for slug in &skillhub_slugs {
        let normalized_slug = slug.to_lowercase();
        if installed_snapshot.contains(&normalized_slug) {
            continue;
        }

        match execute_skillhub_command(&["install", slug]).map(|_| ()) {
            Ok(()) => {
                mark_skill_installed(&mut installed_snapshot, slug);
            }
            Err(error) if is_skill_already_available_error(&error) => {
                mark_skill_installed(&mut installed_snapshot, slug);
            }
            Err(error) => {
                install_failures.push(format!("{slug}: {error}"));
            }
        }
    }

    let verify_snapshot = collect_local_skill_slug_set();
    let missing = collect_missing_desktop_install_skills(&required_skills, &verify_snapshot);

    if !missing.is_empty() {
        if missing.len() == required_skills.len() {
            return Err(format!(
                "推荐 skills 安装失败，全部缺失：{}",
                missing.join(", ")
            ));
        }

        eprintln!(
            "[rhopenclaw] 部分推荐 skills 安装失败，将继续主流程。缺失项: {}",
            missing.join(", ")
        );
        if !install_failures.is_empty() {
            eprintln!(
                "[rhopenclaw] skills 安装错误详情: {}",
                install_failures.join(" | ")
            );
        }
    }

    Ok(())
}

fn download_runtime_package_from_sources(
    sources: &[String],
    output_path: &PathBuf,
) -> Result<String, String> {
    let mut last_error = None;

    for source in sources {
        let candidate = source.trim();
        if candidate.is_empty() {
            continue;
        }

        let path_candidate = PathBuf::from(candidate);
        let result = if path_candidate.exists() {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create runtime package dir: {error}"))?;
            }
            fs::copy(&path_candidate, output_path)
                .map(|_| ())
                .map_err(|error| format!("failed to copy runtime package from local source: {error}"))
        } else {
            download_runtime_package(candidate, output_path)
        };

        match result {
            Ok(()) => return Ok(candidate.to_string()),
            Err(error) => last_error = Some(format!("{candidate}: {error}")),
        }
    }

    Err(last_error.unwrap_or_else(|| "没有可用的 OpenClaw 安装源。".to_string()))
}

fn is_non_fatal_rhclaw_plugin_install_error(detail: &str) -> bool {
    let lowered = detail.to_lowercase();

    lowered.contains("already installed")
        || lowered.contains("已安装")
        || lowered.contains("plugin already exists")
        || lowered.contains("plugins.allow is empty")
}

#[allow(dead_code)]
#[derive(Default, Clone)]
pub(crate) struct OpenClawUpdateSummary {
    pub(crate) current_version: Option<String>,
    pub(crate) latest_version: Option<String>,
    pub(crate) update_available: bool,
    pub(crate) detail: String,
}

pub(crate) fn parse_openclaw_status() -> Result<serde_json::Value, String> {
    let (stdout, _) = execute_openclaw_command(&["status", "--json"], &[])?;
    extract_json_payload(&stdout)
}

pub(crate) fn parse_openclaw_update_status() -> Result<serde_json::Value, String> {
    let (stdout, _) = execute_openclaw_command(&["update", "status", "--json"], &[])?;
    extract_json_payload(&stdout)
}

pub(crate) fn parse_openclaw_gateway_status() -> Result<serde_json::Value, String> {
    let (stdout, _) = execute_openclaw_command(&["gateway", "status", "--json"], &[])?;
    extract_json_payload(&stdout)
}

pub(crate) fn run_openclaw_health_check() -> Result<serde_json::Value, String> {
    let (stdout, _) = execute_openclaw_command(&["health", "--json"], &[])?;
    extract_json_payload(&stdout)
}

fn wait_for_openclaw_health_check(timeout: Duration, interval: Duration) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_error = None;

    loop {
        match run_openclaw_health_check() {
            Ok(payload) => return Ok(payload),
            Err(error) => last_error = Some(error),
        }

        if std::time::Instant::now() + interval >= deadline {
            break;
        }

        thread::sleep(interval);
    }

    Err(last_error.unwrap_or_else(|| "Gateway 健康检查超时".to_string()))
}

fn is_gateway_service_loaded(payload: &serde_json::Value) -> bool {
    payload
        .pointer("/service/loaded")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn ensure_gateway_service_installed() -> Result<bool, String> {
    let service_loaded = parse_openclaw_gateway_status()
        .ok()
        .map(|payload| is_gateway_service_loaded(&payload))
        .unwrap_or(false);

    #[cfg(target_os = "windows")]
    let (service_loaded, force_reinstall) = if service_loaded {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let gateway_cmd = PathBuf::from(&home).join(".openclaw").join("gateway.cmd");
        if !gateway_cmd.exists() {
            eprintln!("[rhopenclaw] gateway.cmd missing despite service.loaded=true, forcing reinstall");
            (false, true)
        } else {
            (true, false)
        }
    } else {
        (false, false)
    };
    #[cfg(not(target_os = "windows"))]
    let force_reinstall = false;

    if service_loaded {
        return Ok(false);
    }

    let install_args: Vec<&str> = if force_reinstall {
        vec!["gateway", "install", "--force"]
    } else {
        vec!["gateway", "install"]
    };

    match execute_openclaw_command(&install_args, &[]) {
        Ok(_) => Ok(true),
        Err(error) if is_recoverable_windows_onboard_failure(&error) => {
            eprintln!("[rhopenclaw] gateway install: schtasks denied, Startup-folder fallback active");
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

/// Attempt `openclaw gateway install` via UAC elevation (Windows-only).
/// Returns true if the elevated process exited successfully.
pub(crate) fn try_elevated_gateway_install() -> bool {
    #[cfg(not(target_os = "windows"))]
    return false;

    #[cfg(target_os = "windows")]
    {
        let cli = match detect_openclaw_cli() {
            Some(p) => p,
            None => return false,
        };
        // Escape single quotes for PowerShell string literals ('' = escaped ')
        let cli_str = cli.replace('\'', "''");
        // Use PowerShell Start-Process -Verb RunAs to trigger UAC prompt and
        // run `openclaw gateway install` with admin privileges.
        let ps_cmd = format!(
            "Start-Process -FilePath '{cli}' -ArgumentList 'gateway','install' -Verb RunAs -Wait -WindowStyle Hidden",
            cli = cli_str,
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_cmd])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

pub(crate) fn start_openclaw_gateway_runtime(
    runtime_handle: Option<&Arc<Mutex<ManagedRuntimeState>>>,
) -> Result<bool, String> {
    let rhclaw_plugin_healed = ensure_rhclaw_runtime_plugin_ready()?;

    if let Err(e) = ensure_openclaw_slack_dependency_shims() {
        eprintln!("[rhopenclaw] ensure_openclaw_slack_dependency_shims: {e}");
    }

    // [Windows] The plugin install (or onboard) may have (re-)written
    // openclaw.json with file-based secrets providers that trigger the
    // broken `icacls /sid` ACL check.  Re-apply the inline-secrets fix
    // AFTER all config writers have finished, right before the gateway
    // is started, so the on-disk config is always safe.
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = ensure_openclaw_gateway_config() {
            eprintln!("[rhopenclaw] ensure_openclaw_gateway_config (pre-start): {e}");
        }
    }

    let installed_service = ensure_gateway_service_installed()?;

    if probe_gateway_running().running {
        if rhclaw_plugin_healed {
            // Plugin was just installed/configured — the config change triggers
            // a SIGUSR1 gateway restart that takes 10-30s.  Rather than racing
            // the restart, do a clean stop → start → poll cycle.
            let _ = execute_openclaw_command(&["gateway", "stop"], &[]);
            thread::sleep(Duration::from_secs(1));
            let _ = execute_openclaw_command(&["gateway", "start"], &[]);
            let probe = poll_gateway_until_healthy(Duration::from_secs(30), Duration::from_millis(500));
            if !probe.running {
                return Err(format!("插件安装后 Gateway 重启超时: {}", probe.detail));
            }
        }
        if let Some(handle) = runtime_handle {
            let mut runtime = handle
                .lock()
                .map_err(|_| "managed runtime state poisoned".to_string())?;
            runtime.running = true;
            runtime.child = None;
            runtime.process_id = None;
            runtime.process_mode = Some("openclaw-gateway-daemon".into());
            runtime.log_file_path = None;
            if runtime.last_started_at.is_none() {
                runtime.last_started_at = Some(now_iso_string());
            }
        }
        wait_for_openclaw_health_check(Duration::from_secs(45), Duration::from_secs(2))?;
        return Ok(installed_service);
    }

    match execute_openclaw_command(&["gateway", "start"], &[]) {
        Ok(_) => {}
        Err(error) if is_rhclaw_unknown_channel_error(&error) && !rhclaw_plugin_healed => {
            ensure_rhclaw_runtime_plugin_ready()?;
            execute_openclaw_command(&["gateway", "start"], &[])?;
        }
        Err(error) if is_gateway_task_not_found_error(&error) => {
            eprintln!("[rhopenclaw] gateway start: task not found, trying gateway restart (Startup fallback)");
            execute_openclaw_command(&["gateway", "restart"], &[])
                .map_err(|e| format!("Gateway 启动失败（restart fallback）: {e}"))?;
        }
        Err(error) => return Err(error),
    }

    let probe = poll_gateway_until_healthy(Duration::from_secs(60), Duration::from_millis(500));
    if !probe.running {
        #[cfg(target_os = "windows")]
        {
            eprintln!(
                "[rhopenclaw] gateway start succeeded but health poll failed ({}), attempting stop + restart cycle",
                probe.detail
            );
            let _ = execute_openclaw_command(&["gateway", "stop"], &[]);
            thread::sleep(Duration::from_secs(2));
            let _ = execute_openclaw_command(&["gateway", "start"], &[]);
            let retry_probe = poll_gateway_until_healthy(Duration::from_secs(30), Duration::from_millis(500));
            if !retry_probe.running {
                return Err(format!("Gateway 启动后仍未就绪: {}", retry_probe.detail));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(format!("Gateway 启动后仍未就绪: {}", probe.detail));
        }
    }

    wait_for_openclaw_health_check(Duration::from_secs(45), Duration::from_secs(2))?;

    if let Some(handle) = runtime_handle {
        let mut runtime = handle
            .lock()
            .map_err(|_| "managed runtime state poisoned".to_string())?;
        if let Some(mut existing_child) = runtime.child.take() {
            let _ = existing_child.kill();
        }
        runtime.running = true;
        runtime.process_id = None;
        runtime.process_mode = Some("openclaw-gateway-daemon".into());
        runtime.last_started_at = Some(now_iso_string());
        runtime.log_file_path = None;
    }

    Ok(installed_service)
}

/// Poll Gateway /health endpoint until healthy or deadline exceeded.
/// Returns the last probe result.
fn poll_gateway_until_healthy(timeout: Duration, interval: Duration) -> OpenClawGatewayProbe {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let probe = probe_gateway_running();
        if probe.running {
            return probe;
        }
        if std::time::Instant::now() + interval >= deadline {
            return probe;
        }
        thread::sleep(interval);
    }
}

#[allow(dead_code)]
pub(crate) fn summarize_openclaw_update_status(payload: &serde_json::Value) -> OpenClawUpdateSummary {
    let current_version = payload
        .get("currentVersion")
        .and_then(|value| value.as_str())
        .or_else(|| payload.get("installedVersion").and_then(|value| value.as_str()))
        .or_else(|| payload.get("version").and_then(|value| value.as_str()))
        .map(|value| value.to_string());
    let latest_version = payload
        .get("latestVersion")
        .and_then(|value| value.as_str())
        .or_else(|| payload.get("targetVersion").and_then(|value| value.as_str()))
        .or_else(|| payload.get("availableVersion").and_then(|value| value.as_str()))
        .map(|value| value.to_string());

    let update_available = payload
        .get("updateAvailable")
        .and_then(|value| value.as_bool())
        .or_else(|| payload.get("hasUpdate").and_then(|value| value.as_bool()))
        .or_else(|| payload.get("available").and_then(|value| value.as_bool()))
        .unwrap_or_else(|| match (&current_version, &latest_version) {
            (Some(current), Some(latest)) => current != latest,
            _ => false,
        });

    let detail = match (&current_version, &latest_version, update_available) {
        (Some(current), Some(latest), true) => {
            format!("检测到 OpenClaw 可升级：{current} -> {latest}")
        }
        (Some(current), Some(_latest), false) => format!("OpenClaw 当前已是最新版本：{current}"),
        (Some(current), None, false) => format!("OpenClaw 当前版本：{current}"),
        _ => "已完成 OpenClaw 版本检查。".to_string(),
    };

    OpenClawUpdateSummary {
        current_version,
        latest_version,
        update_available,
        detail,
    }
}

pub(crate) fn diagnose_existing_runtime_for_reuse() -> Result<OpenClawUpdateSummary, String> {
    let version_before_upgrade = detect_current_openclaw_runtime_version();
    let offline_bundle_info =
        resolve_offline_bundle_openclaw_version_info(detect_openclaw_offline_bundle_dir().as_ref());
    let (package_path, _, _, _) = install_openclaw_cli_if_missing(None, None)?;
    let version_after_upgrade = detect_current_openclaw_runtime_version()
        .or_else(|| version_before_upgrade.clone())
        .or_else(|| offline_bundle_info.resolved_version.clone());

    if package_path.is_some()
        && should_upgrade_to_offline_bundle_version(
            version_after_upgrade.as_deref(),
            offline_bundle_info.resolved_version.as_deref(),
        )
    {
        return Err(format!(
            "已执行离线 OpenClaw 升级，但当前版本仍低于安装包版本：{} -> {}",
            version_after_upgrade
                .clone()
                .unwrap_or_else(|| "<unknown>".to_string()),
            offline_bundle_info
                .resolved_version
                .clone()
                .unwrap_or_else(|| "<unknown>".to_string())
        ));
    }

    ensure_openclaw_gateway_config()?;

    let _ = start_openclaw_gateway_runtime(None)?;
    let initial_probe = probe_gateway_running();
    if !initial_probe.running {
        start_openclaw_gateway_runtime(None)?;
        thread::sleep(Duration::from_secs(3));
    }

    let mut probe = probe_gateway_running();
    if !probe.running {
        let _ = execute_openclaw_command(&["doctor", "--non-interactive", "--json"], &[]);
        ensure_openclaw_gateway_config()?;
        let _ = start_openclaw_gateway_runtime(None)?;
        thread::sleep(Duration::from_secs(5));
        probe = probe_gateway_running();
        if !probe.running {
            return Err(format!(
                "复用安装已命中本机 OpenClaw，但 Gateway 启动失败：{}",
                probe.detail
            ));
        }
    }

    let mut last_status_error = None;
    for attempt in 0..2 {
        match parse_openclaw_status() {
            Ok(_) => {
                last_status_error = None;
                break;
            }
            Err(error) => {
                last_status_error = Some(error);
                if attempt == 0 {
                    let _ = execute_openclaw_command(&["doctor", "--non-interactive", "--json"], &[]);
                    ensure_openclaw_gateway_config()?;
                    let _ = start_openclaw_gateway_runtime(None)?;
                    thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }

    if let Some(error) = last_status_error {
        return Err(format!("复用安装后 OpenClaw 状态诊断失败：{error}"));
    }

    let detail = if package_path.is_some() {
        match (
            version_before_upgrade.as_deref(),
            version_after_upgrade.as_deref(),
            offline_bundle_info.resolved_version.as_deref(),
        ) {
            (Some(previous), Some(current), Some(target)) if previous != current => format!(
                "已按离线安装包版本升级 OpenClaw：{previous} -> {current}，并完成复用诊断。目标版本：{target}"
            ),
            (_, Some(current), Some(target)) => {
                format!("已按离线安装包版本校准 OpenClaw，当前版本：{current}，目标版本：{target}")
            }
            (_, Some(current), None) => format!("已完成 OpenClaw 复用诊断，当前版本：{current}"),
            _ => "已完成 OpenClaw 复用诊断。".to_string(),
        }
    } else {
        match (
            version_after_upgrade.as_deref(),
            offline_bundle_info.resolved_version.as_deref(),
        ) {
            (Some(current), Some(target)) if current == target => {
                format!("已完成 OpenClaw 复用诊断，当前版本与离线安装包一致：{current}")
            }
            (Some(current), Some(target)) => {
                format!("已完成 OpenClaw 复用诊断，当前版本：{current}，离线安装包版本：{target}")
            }
            (Some(current), None) => format!("已完成 OpenClaw 复用诊断，当前版本：{current}"),
            _ => "已完成 OpenClaw 复用诊断。".to_string(),
        }
    };

    Ok(OpenClawUpdateSummary {
        current_version: version_after_upgrade,
        latest_version: offline_bundle_info.resolved_version,
        update_available: false,
        detail,
    })
}

fn normalize_rhclaw_channel_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "connected" | "healthy" | "running" | "ready" | "ok" => "connected".to_string(),
        "error" | "failed" | "disconnected" | "stopped" | "offline" => "error".to_string(),
        _ => "unknown".to_string(),
    }
}

fn extract_rhclaw_channel_snapshot(channel: &serde_json::Value) -> RHClawGatewayChannelSnapshot {
    let status = channel
        .get("status")
        .and_then(|value| value.as_str())
        .map(normalize_rhclaw_channel_status)
        .or_else(|| {
            channel
                .get("connected")
                .and_then(|value| value.as_bool())
                .map(|value| if value { "connected".to_string() } else { "error".to_string() })
        });
    let last_heartbeat_at = channel
        .get("lastHeartbeat")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| {
            channel
                .get("lastHeartbeatAt")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        })
        .or_else(|| {
            channel
                .get("lastHeartbeatAtMs")
                .and_then(|value| value.as_u64())
                .map(|value| value.to_string())
        });
    let detail = channel
        .get("detail")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| {
            channel
                .get("message")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        })
        .or_else(|| {
            channel
                .get("reason")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });

    RHClawGatewayChannelSnapshot {
        status,
        last_heartbeat_at,
        detail,
    }
}

fn latest_openclaw_gateway_log_path() -> Option<PathBuf> {
    let log_dir = std::env::temp_dir().join("openclaw");
    let entries = fs::read_dir(&log_dir).ok()?;
    let mut latest: Option<(SystemTime, PathBuf)> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
        if !file_name.starts_with("openclaw-") || !file_name.ends_with(".log") {
            continue;
        }

        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(UNIX_EPOCH);

        match latest.as_ref() {
            Some((current_modified, _)) if modified <= *current_modified => {}
            _ => latest = Some((modified, path)),
        }
    }

    latest.map(|(_, path)| path)
}

fn parse_rhclaw_channel_snapshot_from_gateway_log() -> Option<RHClawGatewayChannelSnapshot> {
    let log_path = latest_openclaw_gateway_log_path()?;
    let lines = read_log_tail(&log_path, 400).ok()?;

    for line in lines.iter().rev() {
        if !line.contains("gateway/channels/rhclaw") {
            continue;
        }

        let timestamp = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|value| value.get("time").and_then(|field| field.as_str()).map(|field| field.to_string()));

        if line.contains("skeleton runtime started") {
            return Some(RHClawGatewayChannelSnapshot {
                status: Some("connected".to_string()),
                last_heartbeat_at: timestamp,
                detail: Some("Gateway 日志显示 RHClaw Channel 已启动。".to_string()),
            });
        }

        if line.contains("skeleton runtime stopped") {
            return Some(RHClawGatewayChannelSnapshot {
                status: Some("error".to_string()),
                last_heartbeat_at: timestamp,
                detail: Some("Gateway 日志显示 RHClaw Channel 已停止。".to_string()),
            });
        }

        if line.to_ascii_lowercase().contains("error") {
            return Some(RHClawGatewayChannelSnapshot {
                status: Some("error".to_string()),
                last_heartbeat_at: timestamp,
                detail: Some("Gateway 日志显示 RHClaw Channel 存在异常。".to_string()),
            });
        }
    }

    None
}

/// Core channel-status parser. When `prefetched` is `Some`, skips the expensive
/// `openclaw gateway status --json` CLI call and uses the provided payload instead.
fn parse_rhclaw_gateway_channel_status_with_payload(
    prefetched: Option<serde_json::Value>,
) -> RHClawGatewayChannelSnapshot {
    let payload = match prefetched {
        Some(v) => v,
        None => match parse_openclaw_gateway_status() {
            Ok(value) => value,
            Err(error) => {
                return RHClawGatewayChannelSnapshot {
                    status: Some("error".to_string()),
                    last_heartbeat_at: None,
                    detail: Some(error),
                }
            }
        },
    };

    let pointers = [
        "/channels/rhclaw",
        "/status/channels/rhclaw",
        "/rpc/channels/rhclaw",
        "/rpc/status/channels/rhclaw",
        "/gateway/channels/rhclaw",
    ];

    for pointer in pointers {
        if let Some(channel) = payload.pointer(pointer) {
            return extract_rhclaw_channel_snapshot(channel);
        }
    }

    if let Some(snapshot) = parse_rhclaw_channel_snapshot_from_gateway_log() {
        return snapshot;
    }

    let gateway_running = payload
        .pointer("/service/runtime/status")
        .and_then(|value| value.as_str())
        .map(|value| value == "running")
        .unwrap_or(false)
        || payload
            .pointer("/rpc/ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        || payload
            .pointer("/port/status")
            .and_then(|value| value.as_str())
            .map(|value| value == "busy")
            .unwrap_or(false);

    RHClawGatewayChannelSnapshot {
        status: Some(if gateway_running { "unknown" } else { "error" }.to_string()),
        last_heartbeat_at: None,
        detail: Some(if gateway_running {
            "Gateway 已运行，但当前未暴露 RHClaw Channel 状态。".to_string()
        } else {
            payload
                .pointer("/rpc/error")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .or_else(|| {
                    payload
                        .pointer("/service/runtime/detail")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                })
                .unwrap_or_else(|| "Gateway 未运行，无法读取 RHClaw Channel 状态。".to_string())
        }),
    }
}

/// Ensure `~/.openclaw/openclaw.json` contains `gateway.mode = "local"`.
/// Without this key the gateway process starts but refuses to listen
/// (`Gateway start blocked: set gateway.mode=local`).
/// Also ensures `gateway.auth.mode = "token"` is present.
/// Returns `Ok(true)` if the config was modified, `Ok(false)` if already correct.
pub(crate) fn ensure_openclaw_gateway_config() -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定用户 HOME 目录".to_string())?;
    let config_dir = PathBuf::from(&home).join(".openclaw");
    let config_path = config_dir.join("openclaw.json");

    let mut cfg: serde_json::Value = if config_path.exists() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("读取 openclaw.json 失败: {e}"))?;
        let sanitized = sanitize_json_unquoted_keys(&raw);
        serde_json::from_str(&sanitized)
            .map_err(|e| format!("解析 openclaw.json 失败: {e}"))?
    } else {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("创建 .openclaw 目录失败: {e}"))?;
        serde_json::json!({})
    };

    let mut modified = false;

    if ensure_secret_exec_provider_config(&mut cfg)? {
        modified = true;
    }

    // Ensure gateway object exists
    if !cfg.get("gateway").is_some_and(|v| v.is_object()) {
        cfg["gateway"] = serde_json::json!({});
        modified = true;
    }

    // Ensure gateway.mode = "local"
    let gw = cfg.get_mut("gateway").ok_or_else(|| "gateway 配置节不存在".to_string())?;
    if gw.get("mode").and_then(|v| v.as_str()) != Some("local") {
        gw["mode"] = serde_json::json!("local");
        modified = true;
    }

    // Ensure gateway.auth.mode = "token"
    if !gw.get("auth").is_some_and(|v| v.is_object()) {
        gw["auth"] = serde_json::json!({"mode": "token"});
        modified = true;
    } else if gw["auth"].get("mode").and_then(|v| v.as_str()) != Some("token") {
        gw["auth"]["mode"] = serde_json::json!("token");
        modified = true;
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(token) = gw
            .get("auth")
            .and_then(|value| value.get("token"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        {
            let _ = save_gateway_auth_token_to_native_keyring(&token);
        } else if gw
            .get("auth")
            .and_then(|value| value.get("token"))
            .and_then(|value| value.as_object())
            .is_some()
        {
            if let Ok(token) = load_gateway_auth_token_from_native_keyring() {
                gw["auth"]["token"] = serde_json::json!(token);
                modified = true;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(token) = gw
            .get("auth")
            .and_then(|value| value.get("token"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        {
            save_gateway_auth_token_to_native_keyring(&token)?;
            gw["auth"]["token"] = gateway_auth_secret_ref();
            modified = true;
        } else if gw
            .get("auth")
            .and_then(|value| value.get("token"))
            .and_then(|value| value.as_object())
            != gateway_auth_secret_ref().as_object()
        {
            if load_gateway_auth_token_from_native_keyring().is_ok() {
                gw["auth"]["token"] = gateway_auth_secret_ref();
                modified = true;
            }
        }
    }

    // [Windows] OpenClaw CLI runs `icacls <path> /sid` to verify file-based
    // secrets providers.  The `/sid` flag is unsupported on many Windows
    // versions, causing "SecretProviderResolutionError: ACL verification
    // unavailable on Windows" and a hard gateway startup failure.
    //
    // Workaround: read the secret value from the file, inline it directly
    // into the model-provider `apiKey` field, then remove the file-based
    // secrets provider so the gateway never reaches the broken ACL check.
    #[cfg(target_os = "windows")]
    {
        let mut resolved_secrets: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut inlined_secret_names: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        if let Some(providers) = cfg
            .pointer("/secrets/providers")
            .and_then(|v| v.as_object())
        {
            for (name, provider) in providers {
                let is_file = provider
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s == "file")
                    .unwrap_or(false);
                if !is_file {
                    continue;
                }
                if let Some(path_str) = provider.get("path").and_then(|v| v.as_str()) {
                    if let Ok(value) = fs::read_to_string(path_str) {
                        let trimmed = value.trim().to_string();
                        if !trimmed.is_empty() {
                            resolved_secrets.insert(name.clone(), trimmed);
                        }
                    }
                }
            }
        }

        if !resolved_secrets.is_empty() {
            // Inline resolved values into model-provider apiKey references.
            if let Some(providers) = cfg
                .pointer_mut("/models/providers")
                .and_then(|v| v.as_object_mut())
            {
                for (_prov_name, prov_cfg) in providers.iter_mut() {
                    let ref_provider = prov_cfg
                        .get("apiKey")
                        .and_then(|v| v.as_object())
                        .and_then(|obj| obj.get("provider"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if let Some(ref_name) = ref_provider {
                        if let Some(value) = resolved_secrets.get(&ref_name) {
                            prov_cfg["apiKey"] = serde_json::json!(value);
                            inlined_secret_names.insert(ref_name);
                            modified = true;
                        }
                    }
                }
            }

            if !inlined_secret_names.is_empty() {
                // Remove only the file-based secrets providers that were
                // successfully inlined into model-provider apiKey values.
                if let Some(providers) = cfg
                    .pointer_mut("/secrets/providers")
                    .and_then(|v| v.as_object_mut())
                {
                    for name in inlined_secret_names {
                        if providers.remove(&name).is_some() {
                            modified = true;
                        }
                    }
                }
            }
        }
    }

    if modified {
        let serialized = serde_json::to_vec_pretty(&cfg)
            .map_err(|e| format!("序列化 openclaw.json 失败: {e}"))?;
        fs::write(&config_path, &serialized)
            .map_err(|e| format!("写入 openclaw.json 失败: {e}"))?;
    }

    Ok(modified)
}

/// Fast gateway liveness check via HTTP GET /health (replaces slow CLI subprocess).
/// Falls back to CLI probe only when the HTTP endpoint is unreachable and we need
/// richer diagnostics (e.g. service-not-loaded vs stopped).
pub(crate) fn probe_gateway_running() -> OpenClawGatewayProbe {
    let url = format!("http://127.0.0.1:{OPENCLAW_DEFAULT_GATEWAY_PORT}/health");
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| Client::new());

    match client.get(&url).send() {
        Ok(resp) if resp.status().is_success() => {
            // /health returns {"ok":true,"status":"live"}
            let detail = format!(
                "Gateway 运行中 (port={OPENCLAW_DEFAULT_GATEWAY_PORT})"
            );
            OpenClawGatewayProbe {
                running: true,
                detail,
            }
        }
        _ => {
            // HTTP unreachable — fall back to CLI for richer diagnostics
            probe_gateway_running_via_cli()
        }
    }
}

/// CLI-based probe kept for fallback diagnostics when HTTP /health is unreachable.
fn probe_gateway_running_via_cli() -> OpenClawGatewayProbe {
    match parse_openclaw_gateway_status() {
        Ok(payload) => {
            let _service_running = payload
                .pointer("/service/runtime/status")
                .and_then(|v| v.as_str())
                .map(|s| s == "running")
                .unwrap_or(false);

            let rpc_ok = payload
                .pointer("/rpc/ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let top_level_running = payload
                .get("running")
                .and_then(|v| v.as_bool())
                .or_else(|| {
                    payload.get("status").and_then(|v| v.as_str()).map(|s| s == "running" || s == "healthy")
                })
                .unwrap_or(false);

            // service_running alone (launchd pid exists) is NOT sufficient —
            // during startup or config-triggered restart the process has a pid
            // and even the TCP port may already be bound while the websocket
            // handshake still cannot complete. Only consider the gateway
            // "running" when there is real evidence of readiness.
            let running = rpc_ok || top_level_running;

            let detail = if running {
                let pid = payload
                    .pointer("/service/runtime/pid")
                    .and_then(|v| v.as_u64());
                let port = payload
                    .pointer("/gateway/port")
                    .and_then(|v| v.as_u64());
                match (pid, port) {
                    (Some(p), Some(pt)) => format!("Gateway 运行中 (pid={p}, port={pt})"),
                    (Some(p), None) => format!("Gateway 运行中 (pid={p})"),
                    _ => "Gateway 运行中".to_string(),
                }
            } else {
                let service_loaded = payload
                    .pointer("/service/loaded")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if !service_loaded {
                    "Gateway 服务未加载，需要执行 gateway install".to_string()
                } else {
                    let status_str = payload
                        .pointer("/service/runtime/status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    format!("Gateway 未运行 (service.runtime.status={status_str})")
                }
            };

            OpenClawGatewayProbe { running, detail }
        }
        Err(error) => OpenClawGatewayProbe {
            running: false,
            detail: error,
        },
    }
}

pub(crate) fn build_runtime_manifest_from_cli(
    install_mode: &str,
    package_source: &str,
    download_url: Option<String>,
    package_path: Option<String>,
    expected_sha256: Option<String>,
    resolved_sha256: Option<String>,
    verified: bool,
    bound_install_path: Option<String>,
) -> Result<RuntimePackageManifest, String> {
    let update_status = parse_openclaw_update_status().unwrap_or(serde_json::Value::Null);
    let version = update_status
        .get("currentVersion")
        .and_then(|value| value.as_str())
        .or_else(|| update_status.get("version").and_then(|value| value.as_str()))
        .and_then(sanitize_version_value)
        .or_else(detect_openclaw_version)
        .or_else(detect_openclaw_cli_version)
        .unwrap_or_else(|| "".to_string());
    let bound_install_path = if install_mode == "existing-install" {
        bound_install_path
    } else {
        None
    };

    Ok(RuntimePackageManifest {
        version,
        managed_endpoint: format!("http://127.0.0.1:{OPENCLAW_DEFAULT_GATEWAY_PORT}"),
        installed_at: now_iso_string(),
        install_mode: install_mode.to_string(),
        package_source: package_source.to_string(),
        download_url,
        package_path,
        expected_sha256,
        resolved_sha256,
        verified,
        bound_install_path,
    })
}

pub(crate) fn build_runtime_package_status(
    detail: &str,
    runtime: Option<&ManagedRuntimeState>,
) -> Result<RuntimePackageStatus, String> {
    let paths = runtime_package_paths()?;
    let manifest = if paths.manifest_path.exists() {
        Some(
            serde_json::from_str::<RuntimePackageManifest>(
                &fs::read_to_string(&paths.manifest_path)
                    .map_err(|error| format!("failed to read runtime manifest: {error}"))?,
            )
            .map_err(|error| format!("failed to parse runtime manifest: {error}"))?,
        )
    } else {
        None
    };
    let cli_path = detect_openclaw_cli();
    let cli_available = cli_path.is_some();
    let detected_install_path = detect_existing_openclaw_install();
    let detected_install_paths = detect_all_openclaw_installs();
    let offline_bundle_info =
        resolve_offline_bundle_openclaw_version_info(detect_openclaw_offline_bundle_dir().as_ref());
    let manifest_version = manifest
        .as_ref()
        .and_then(|item| sanitize_version_value(&item.version));
    let config_version = detect_openclaw_version();
    let cli_version = detect_openclaw_cli_version();
    let selected_version = cli_version
        .clone()
        .or_else(|| config_version.clone())
        .or_else(|| manifest_version.clone());
    let offline_bundle_update_available = should_upgrade_to_offline_bundle_version(
        selected_version.as_deref(),
        offline_bundle_info.resolved_version.as_deref(),
    );

    let gateway = probe_gateway_running();
    let mut status_logs = Vec::new();
    status_logs.push(format!("cli.available={cli_available}"));
    status_logs.push(format!(
        "cli.path={}",
        cli_path.clone().unwrap_or_else(|| "<not-found>".into())
    ));
    status_logs.push(format!(
        "runtime.detectedInstallPath={}",
        detected_install_path.clone().unwrap_or_else(|| "<not-found>".into())
    ));
    status_logs.push(format!(
        "runtime.detectedInstallPaths=[{}]",
        detected_install_paths.join(", ")
    ));
    status_logs.push(format!("runtime.manifestExists={}", manifest.is_some()));
    status_logs.push(format!(
        "runtime.manifest.installMode={}",
        manifest
            .as_ref()
            .map(|item| item.install_mode.clone())
            .unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "runtime.manifest.packageSource={}",
        manifest
            .as_ref()
            .map(|item| item.package_source.clone())
            .unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "runtime.version.manifest={}",
        manifest_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "runtime.version.config={}",
        config_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "runtime.version.cli={}",
        cli_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "runtime.version.selected={}",
        selected_version.clone().unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "offlineBundle.version.manifest={}",
        offline_bundle_info
            .manifest_version
            .clone()
            .unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "offlineBundle.version.package={}",
        offline_bundle_info
            .package_version
            .clone()
            .unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "offlineBundle.version.resolved={}",
        offline_bundle_info
            .resolved_version
            .clone()
            .unwrap_or_else(|| "<none>".into())
    ));
    status_logs.push(format!(
        "offlineBundle.version.consistent={}",
        offline_bundle_info.consistent
    ));
    status_logs.push(format!(
        "offlineBundle.updateAvailable={offline_bundle_update_available}"
    ));
    status_logs.push(format!("gateway.running={}", gateway.running));
    status_logs.push(format!("gateway.detail={}", gateway.detail));
    status_logs.push(format!("runtime.detail={detail}"));

    let managed = cli_available && manifest.is_some();

    Ok(RuntimePackageStatus {
        available: true,
        installed: manifest.is_some(),
        managed,
        cli_available: Some(cli_available),
        offline_bundle_version: offline_bundle_info.resolved_version,
        offline_bundle_manifest_version: offline_bundle_info.manifest_version,
        offline_bundle_package_version: offline_bundle_info.package_version,
        offline_bundle_update_available,
        detail: detail.into(),
        install_mode: manifest.as_ref().map(|item| item.install_mode.clone()),
        version: selected_version,
        package_source: manifest.as_ref().map(|item| item.package_source.clone()),
        download_url: manifest.as_ref().and_then(|item| item.download_url.clone()),
        package_path: manifest.as_ref().and_then(|item| item.package_path.clone()),
        expected_sha256: manifest.as_ref().and_then(|item| item.expected_sha256.clone()),
        resolved_sha256: manifest.as_ref().and_then(|item| item.resolved_sha256.clone()),
        verified: manifest.as_ref().map(|item| item.verified).unwrap_or(false),
        install_dir: paths.install_dir.to_string_lossy().to_string(),
        manifest_path: paths.manifest_path.to_string_lossy().to_string(),
        executable_path: paths.executable_path.to_string_lossy().to_string(),
        bound_install_path: manifest
            .as_ref()
            .and_then(|item| if item.install_mode == "existing-install" { item.bound_install_path.clone() } else { None }),
        detected_install_path,
        detected_install_paths,
        managed_endpoint: manifest.as_ref().map(|item| item.managed_endpoint.clone()),
        installed_at: manifest.as_ref().map(|item| item.installed_at.clone()),
        process_running: gateway.running || runtime.map(|item| item.running).unwrap_or(false),
        process_id: runtime.and_then(|item| item.process_id),
        process_mode: runtime
            .and_then(|item| item.process_mode.clone())
            .or_else(|| if gateway.running { Some("openclaw-gateway-daemon".into()) } else { None }),
        last_started_at: runtime.and_then(|item| item.last_started_at.clone()),
        last_stopped_at: runtime.and_then(|item| item.last_stopped_at.clone()),
        restart_count: runtime.map(|item| item.restart_count).unwrap_or(0),
        log_file_path: runtime.and_then(|item| item.log_file_path.clone()),
        status_logs,
        workspace_path: detect_openclaw_workspace_path(),
    })
}

#[tauri::command]
fn rhclaw_plugin_status(
    state: State<'_, ManagedRuntimeStateHandle>,
) -> Result<RHClawPluginStatus, String> {
    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    // Self-heal: ensure channels.rhclaw exists in openclaw.json on every status check
    if let Ok(paths) = rhclaw_plugin_paths() {
        if paths.manifest_path.exists() {
            if let Ok(raw) = fs::read_to_string(&paths.manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<RHClawPluginManifest>(&raw) {
                    if manifest.configured {
                        ensure_channels_rhclaw_in_openclaw_json(&manifest.config, &paths);
                    }
                }
            }
        }
    }
    build_rhclaw_plugin_status("RHClaw Channel 插件托管骨架已就绪", Some(&runtime))
}

#[tauri::command]
fn install_rhclaw_plugin(
    state: State<'_, ManagedRuntimeStateHandle>,
    package_spec: Option<String>,
    local_package_path: Option<String>,
    server_url: String,
    device_socket_url: String,
    device_id: String,
    device_code: Option<String>,
    device_name: Option<String>,
    default_agent_id: Option<String>,
    device_token: Option<String>,
) -> Result<RHClawPluginStatus, String> {
    let paths = rhclaw_plugin_paths()?;
    fs::create_dir_all(&paths.plugin_dir)
        .map_err(|error| format!("failed to create RHClaw plugin dir: {error}"))?;

    // NOTE: Do NOT create paths.generated_config_path parent dir here.
    // Its parent is ~/.openclaw/extensions/rhclaw-channel/.desktop-managed/
    // which would pre-create ~/.openclaw/extensions/rhclaw-channel/ and cause
    // `openclaw plugins install` to fail with "plugin already exists".
    // The dir will be created AFTER plugins install succeeds (see below).

    let detected_local_path = local_package_path
        .filter(|value| !value.trim().is_empty())
        .or_else(detect_bundled_rhclaw_plugin_tgz)
        .or_else(detect_local_rhclaw_plugin_package);
    let detected_local_is_tgz = detected_local_path
        .as_deref()
        .map(|value| value.trim_end().ends_with(".tgz"))
        .unwrap_or(false);
    let resolved_package_spec = package_spec
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "@ruhooai/rhclaw-channel".into());
    let install_mode = if detected_local_path.is_some() {
        if detected_local_is_tgz {
            "local-tgz"
        } else {
            "local-package"
        }
    } else {
        "npm"
    };
    let package_source = if install_mode == "local-package" {
        "workspace-local-plugin"
    } else if install_mode == "local-tgz" {
        "bundled-offline-tgz"
    } else {
        "npm-package"
    };
    let staged_local_receipt = if let Some(local_path) = detected_local_path.as_deref() {
        if detected_local_is_tgz {
            if paths.installed_package_dir.exists() {
                fs::remove_dir_all(&paths.installed_package_dir)
                    .map_err(|error| format!("failed to clear RHClaw staged package dir: {error}"))?;
            }
            None
        } else {
            Some(validate_and_stage_local_rhclaw_package(&paths, local_path)?)
        }
    } else {
        if paths.installed_package_dir.exists() {
            fs::remove_dir_all(&paths.installed_package_dir)
                .map_err(|error| format!("failed to clear RHClaw staged package dir: {error}"))?;
        }
        None
    };
    let install_target = detected_local_path
        .clone()
        .unwrap_or_else(|| resolved_package_spec.clone());
    let install_env_owned = build_openclaw_install_env(detect_openclaw_offline_bundle_dir().as_ref());
    let install_env_refs: Vec<(&str, &str)> = install_env_owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let install_result = execute_openclaw_command_with_timeout(
        &["plugins", "install", install_target.as_str()],
        &install_env_refs,
        std::time::Duration::from_secs(300),
    );
    if let Err(error) = install_result {
        if !is_non_fatal_rhclaw_plugin_install_error(&error) {
            return Err(format!("执行 RHClaw Channel 官方插件安装失败: {error}"));
        }
    }

    // Now that plugins install has created ~/.openclaw/extensions/rhclaw-channel/,
    // safe to create the .desktop-managed sub-directory for our config files.
    if let Some(parent) = paths.generated_config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create RHClaw config dir: {error}"))?;
    }

    // Self-heal: ensure the openclaw SDK symlink exists so the plugin can
    // resolve `openclaw/plugin-sdk/*` imports at Gateway startup.
    ensure_openclaw_sdk_symlink();
    let resolved_device_name = device_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "RHClaw Desktop".into());
    let resolved_default_agent_id = default_agent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "desktop-default-agent".into());
    ensure_agent_auth_profiles_seeded_from_main(&resolved_default_agent_id)?;
    let resolved_device_code = device_code
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let config = RHClawPluginConfigDraft {
        enabled: true,
        connection_mode: "websocket".into(),
        server_url: server_url.trim().to_string(),
        device_socket_url: device_socket_url.trim().to_string(),
        device_id: device_id.trim().to_string(),
        device_code: resolved_device_code,
        device_name: resolved_device_name,
        default_agent_id: resolved_default_agent_id,
        gateway_token_env_name: RHCLAW_DEVICE_TOKEN_ENV_NAME.into(),
        allow_from: vec!["server".into(), "desktop".into()],
        dm_policy: "allowlist".into(),
    };
    let configured = !config.server_url.is_empty()
        && !config.device_socket_url.is_empty()
        && !config.device_id.is_empty();
    let persistent_env_path = resolve_rhclaw_persistent_env_path()?;

    let generated_config = serde_json::json!({
        "channels": {
            "rhclaw": {
                "enabled": config.enabled,
                "connectionMode": config.connection_mode,
                "serverUrl": config.server_url,
                "deviceSocketUrl": config.device_socket_url,
                "deviceId": config.device_id,
                "deviceCode": config.device_code,
                "deviceName": config.device_name,
                "defaultAgentId": config.default_agent_id,
                "gatewayTokenRef": {
                    "source": "file",
                    "provider": "desktop-managed",
                    "id": persistent_env_path.to_string_lossy().to_string(),
                },
                "allowFrom": config.allow_from,
                "dmPolicy": config.dm_policy,
            }
        }
    });

    fs::write(
        &paths.generated_config_path,
        serde_json::to_vec_pretty(&generated_config)
            .map_err(|error| format!("failed to serialize RHClaw config draft: {error}"))?,
    )
    .map_err(|error| format!("failed to write RHClaw config draft: {error}"))?;

    let env_content = format!(
        "{}={}\n",
        config.gateway_token_env_name,
        device_token.unwrap_or_default()
    );
    fs::write(&paths.plugin_env_path, &env_content)
        .map_err(|error| format!("failed to write RHClaw plugin env file: {error}"))?;

    // --- FIX: also write env file to persistent path so temp cleanup won't break it ---
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定用户 HOME 目录".to_string())?;
    let persistent_env_dir = persistent_env_path
        .parent()
        .ok_or_else(|| "RHClaw 持久化 env 路径缺少父目录。".to_string())?
        .to_path_buf();
    fs::create_dir_all(&persistent_env_dir)
        .map_err(|e| format!("创建持久化 env 目录失败: {e}"))?;
    fs::write(&persistent_env_path, &env_content)
        .map_err(|e| format!("写入持久化 env 文件失败: {e}"))?;

    // --- FIX: merge channels.rhclaw into ~/.openclaw/openclaw.json so Gateway can load it ---
    {
        let config_dir = PathBuf::from(&home).join(".openclaw");
        let config_path = config_dir.join("openclaw.json");

        let mut cfg: serde_json::Value = if config_path.exists() {
            let raw = fs::read_to_string(&config_path)
                .map_err(|e| format!("读取 openclaw.json 失败: {e}"))?;
            let sanitized = sanitize_json_unquoted_keys(&raw);
            serde_json::from_str(&sanitized)
                .map_err(|e| format!("解析 openclaw.json 失败: {e}"))?
        } else {
            fs::create_dir_all(&config_dir)
                .map_err(|e| format!("创建 .openclaw 目录失败: {e}"))?;
            serde_json::json!({})
        };

        // Build the channel config with persistent env path for gatewayTokenRef.id
        let channel_rhclaw = serde_json::json!({
            "enabled": config.enabled,
            "connectionMode": config.connection_mode,
            "serverUrl": config.server_url,
            "deviceSocketUrl": config.device_socket_url,
            "deviceId": config.device_id,
            "deviceCode": config.device_code,
            "deviceName": config.device_name,
            "defaultAgentId": config.default_agent_id,
            "gatewayTokenRef": {
                "source": "file",
                "provider": "desktop-managed",
                "id": persistent_env_path.to_string_lossy().to_string(),
            },
            "allowFrom": config.allow_from,
            "dmPolicy": config.dm_policy,
        });

        if !cfg.get("channels").is_some_and(|v| v.is_object()) {
            cfg["channels"] = serde_json::json!({});
        }
        cfg["channels"]["rhclaw"] = channel_rhclaw;

        let serialized = serde_json::to_vec_pretty(&cfg)
            .map_err(|e| format!("序列化 openclaw.json 失败: {e}"))?;
        fs::write(&config_path, &serialized)
            .map_err(|e| format!("写入 openclaw.json 失败: {e}"))?;
    }

    let manifest = RHClawPluginManifest {
        installed_at: now_iso_string(),
        install_mode: install_mode.into(),
        package_spec: resolved_package_spec,
        package_source: package_source.into(),
        package_version: staged_local_receipt.as_ref().map(|item| item.package_version.clone()),
        local_package_path: detected_local_path,
        installed_package_path: staged_local_receipt
            .as_ref()
            .map(|_| paths.installed_package_dir.to_string_lossy().to_string()),
        install_receipt_path: staged_local_receipt
            .as_ref()
            .map(|_| paths.install_receipt_path.to_string_lossy().to_string()),
        package_validated: staged_local_receipt.is_some() || install_mode == "local-tgz",
        generated_config_path: paths.generated_config_path.to_string_lossy().to_string(),
        configured,
        gateway_restart_required: true,
        gateway_probe_passed: false,
        last_probe_at: None,
        last_probe_detail: None,
        config,
    };

    if let Some(parent) = paths.manifest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create manifest dir: {error}"))?;
    }
    fs::write(
        &paths.manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to serialize RHClaw plugin manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to write RHClaw plugin manifest: {error}"))?;

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    build_rhclaw_plugin_status(
        "RHClaw Channel 官方插件安装已执行，本地默认配置草案已生成，等待 Gateway 探活。",
        Some(&runtime),
    )
}

#[tauri::command]
fn probe_rhclaw_plugin(
    state: State<'_, ManagedRuntimeStateHandle>,
) -> Result<RHClawPluginStatus, String> {
    let paths = rhclaw_plugin_paths()?;
    if !paths.manifest_path.exists() {
        return build_rhclaw_plugin_status("RHClaw Channel 插件尚未安装，无法执行探活。", None);
    }

    let mut manifest = serde_json::from_str::<RHClawPluginManifest>(
        &fs::read_to_string(&paths.manifest_path)
            .map_err(|error| format!("failed to read RHClaw plugin manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to parse RHClaw plugin manifest: {error}"))?;

    ensure_agent_auth_profiles_seeded_from_main(&manifest.config.default_agent_id)?;

    // Self-heal: ensure openclaw.json still has channels.rhclaw config.
    // After `openclaw reset --scope full` + `openclaw onboard`, channels get wiped
    // but the plugin manifest remains, causing ensureRHClawPluginReady to shortcircuit
    // without rewriting the channel config.
    if manifest.configured {
        ensure_channels_rhclaw_in_openclaw_json(&manifest.config, &paths);
    }

    // Self-heal: ensure the openclaw SDK symlink exists so the plugin can
    // resolve `openclaw/plugin-sdk/*` imports at Gateway startup.
    ensure_openclaw_sdk_symlink();

    if manifest.install_mode == "local-package" {
        let receipt = verify_staged_local_rhclaw_package(&paths)?;
        manifest.package_validated = true;
        manifest.package_version = Some(receipt.package_version);
        manifest.installed_package_path = Some(paths.installed_package_dir.to_string_lossy().to_string());
        manifest.install_receipt_path = Some(paths.install_receipt_path.to_string_lossy().to_string());
    }

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    let gateway = probe_gateway_running();
    let runtime_running = gateway.running || runtime.running;
    let cli_payload = parse_openclaw_gateway_status().ok();
    let gateway_channel = parse_rhclaw_gateway_channel_status_with_payload(cli_payload.clone());
    let channel_status = gateway_channel.status.as_deref().unwrap_or("unknown");
    let probe_detail = if !manifest.configured {
        manifest.gateway_probe_passed = false;
        manifest.gateway_restart_required = true;
        "RHClaw Channel 插件配置仍不完整，请检查 serverUrl / deviceSocketUrl / deviceId。"
            .to_string()
    } else if !runtime_running {
        manifest.gateway_probe_passed = false;
        manifest.gateway_restart_required = true;
        "RHClaw Channel 插件配置草案已生成，但托管 OpenClaw 运行时尚未运行，请先重启 Gateway。"
            .to_string()
    } else if channel_status == "connected" {
        manifest.gateway_probe_passed = true;
        manifest.gateway_restart_required = false;
        gateway_channel
            .detail
            .clone()
            .unwrap_or_else(|| "RHClaw Channel 已连接，插件探活通过。".to_string())
    } else if channel_status == "error" {
        manifest.gateway_probe_passed = false;
        manifest.gateway_restart_required = true;
        gateway_channel
            .detail
            .clone()
            .unwrap_or_else(|| "Gateway 已运行，但 RHClaw Channel 返回异常状态。".to_string())
    } else {
        manifest.gateway_probe_passed = false;
        manifest.gateway_restart_required = true;
        gateway_channel
            .detail
            .clone()
            .unwrap_or_else(|| "Gateway 已运行，但当前未暴露 RHClaw Channel 状态。".to_string())
    };
    manifest.last_probe_at = Some(now_iso_string());
    manifest.last_probe_detail = Some(probe_detail.clone());

    fs::write(
        &paths.manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to serialize RHClaw plugin manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to write RHClaw plugin manifest: {error}"))?;

    build_rhclaw_plugin_status_with_payload(&probe_detail, Some(&runtime), cli_payload)
}

#[tauri::command]
fn remove_rhclaw_plugin(
    state: State<'_, ManagedRuntimeStateHandle>,
) -> Result<RHClawPluginStatus, String> {
    let paths = rhclaw_plugin_paths()?;
    if paths.plugin_dir.exists() {
        fs::remove_dir_all(&paths.plugin_dir)
            .map_err(|error| format!("failed to remove RHClaw plugin dir: {error}"))?;
    }

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    build_rhclaw_plugin_status("RHClaw Channel 插件本地安装产物已移除。", Some(&runtime))
}

fn default_runtime_log_path() -> Result<PathBuf, String> {
    let base_dir = std::env::temp_dir()
        .join("rhopenclaw-desktop")
        .join("runtime")
        .join("logs");
    fs::create_dir_all(&base_dir)
        .map_err(|error| format!("failed to create runtime log dir: {error}"))?;
    Ok(base_dir.join("managed-runtime.log"))
}

pub(crate) fn normalize_sha256(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_text_file_line_endings_to_lf(content: &[u8]) -> Option<Vec<u8>> {
    if !content.contains(&b'\r') {
        return None;
    }

    let mut normalized = Vec::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        if content[index] == b'\r' {
            normalized.push(b'\n');
            if content.get(index + 1) == Some(&b'\n') {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        normalized.push(content[index]);
        index += 1;
    }

    Some(normalized)
}

fn prepare_shell_script_for_execution(path: &Path) -> Result<(), String> {
    let content = fs::read(path)
        .map_err(|error| format!("failed to read shell script for normalization: {error}"))?;

    if let Some(normalized) = normalize_text_file_line_endings_to_lf(&content) {
        fs::write(path, normalized)
            .map_err(|error| format!("failed to rewrite shell script with LF endings: {error}"))?;
    }

    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("failed to mark shell script executable: {error}"))?;
    }

    Ok(())
}

pub(crate) fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let content = fs::read(path)
        .map_err(|error| format!("failed to read runtime package for sha256: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(content);
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn download_runtime_package(download_url: &str, output_path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create runtime package dir: {error}"))?;
    }

    if cfg!(target_os = "windows") {
        let powershell_status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Invoke-WebRequest -Uri $args[0] -OutFile $args[1] -TimeoutSec 30 -UseBasicParsing",
            ])
            .arg(download_url)
            .arg(output_path)
            .status();

        match powershell_status {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                return Err(format!("failed to download runtime package via PowerShell, exit code: {status}"));
            }
            Err(error) => {
                return Err(format!("failed to invoke PowerShell for runtime package download: {error}"));
            }
        }
    }

    let status = Command::new("curl")
        .args(["-L", "--fail", "--connect-timeout", "30", "--max-time", "120", "-o"])
        .arg(output_path)
        .arg(download_url)
        .status()
        .map_err(|error| format!("failed to invoke curl for runtime package download: {error}"))?;

    if status.success() {
        return Ok(());
    }

    Err(format!("failed to download runtime package via curl, exit code: {status}"))
}

fn normalize_desktop_rollout_channel(channel: Option<&str>) -> &'static str {
    match channel.unwrap_or("stable").trim().to_ascii_lowercase().as_str() {
        "beta" => "beta",
        "canary" => "canary",
        _ => "stable",
    }
}

fn resolve_desktop_updater_base_url() -> Option<String> {
    std::env::var("RHOPENCLAW_DESKTOP_UPDATER_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn build_desktop_updater_endpoint(channel: &str) -> Option<String> {
    resolve_desktop_updater_base_url().map(|base_url| {
        format!(
            "{}/{}/latest.json",
            base_url,
            normalize_desktop_rollout_channel(Some(channel))
        )
    })
}

#[tauri::command]
fn install_runtime_package(
    state: State<'_, ManagedRuntimeStateHandle>,
    version: Option<String>,
    download_url: Option<String>,
    expected_sha256: Option<String>,
    server_api_base_url: Option<String>,
) -> Result<RuntimePackageStatus, String> {
    let paths = runtime_package_paths()?;
    fs::create_dir_all(&paths.install_dir)
        .map_err(|error| format!("failed to create runtime install dir: {error}"))?;
    let cli_was_present_before = detect_openclaw_cli().is_some();
    let normalized_expected_sha256 = expected_sha256
        .as_ref()
        .map(|value| normalize_sha256(value))
        .filter(|value| !value.is_empty());
    let (package_path, resolved_sha256, verified, installer_source) = install_openclaw_cli_if_missing(
        download_url.as_deref(),
        normalized_expected_sha256.as_deref(),
    )?;

    let gateway_token = format!("rhopenclaw-{}", current_unix_ms());
    if cli_was_present_before {
        let _ = execute_openclaw_command(&["reset", "--scope", "full", "--yes", "--non-interactive"], &[]);
    }
    let install_skills_config = fetch_desktop_install_skills_config(server_api_base_url.as_deref());
    let mut command_args = vec![
        "onboard",
        "--non-interactive",
        "--json",
        "--mode",
        "local",
        "--auth-choice",
        "skip",
        "--gateway-bind",
        OPENCLAW_DEFAULT_GATEWAY_BIND,
        "--gateway-port",
        "18789",
        "--gateway-auth",
        "token",
        "--gateway-token",
        gateway_token.as_str(),
        "--install-daemon",
        "--daemon-runtime",
        "node",
        "--accept-risk",
    ];

    if should_skip_openclaw_builtin_skills(&install_skills_config) {
        command_args.push("--skip-skills");
    }

    if let Some(value) = version.as_ref().map(|item| item.trim()).filter(|item| !item.is_empty() && *item != "latest") {
        command_args.push("--version");
        command_args.push(value);
    }

    let onboard_env_owned = build_openclaw_install_env(detect_openclaw_offline_bundle_dir().as_ref());
    let onboard_env_refs = onboard_env_owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let onboard_recovery_warning = execute_openclaw_onboard_command(&command_args, &onboard_env_refs)?;
    let _ = ensure_workspace_markdown_templates(true)?;
    // Skills 安装为非关键步骤，失败不阻塞后续 manifest 写入和 Gateway 启动
    if let Err(skills_error) = apply_desktop_install_skills(&install_skills_config) {
        eprintln!("[rhopenclaw] 推荐 skills 安装失败（非致命），继续主流程: {skills_error}");
    }
    ensure_openclaw_gateway_config()?;
    let _ = start_openclaw_gateway_runtime(Some(&state.inner))?;
    run_openclaw_health_check()?;

    let installed_cli_path = resolve_openclaw_cli_path_from_prefix_dir(&resolve_openclaw_install_target_prefix_dir()?);

    let manifest = build_runtime_manifest_from_cli(
        "official-cli-onboard",
        "openclaw-cli",
        installer_source.or(download_url),
        package_path,
        normalized_expected_sha256,
        resolved_sha256,
        verified,
        Some(installed_cli_path.to_string_lossy().to_string()),
    )?;

    fs::write(
        &paths.manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to serialize runtime manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to write runtime manifest: {error}"))?;

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    let status_detail = if onboard_recovery_warning.is_some() {
        "OpenClaw onboarding 在 Windows 受管安装阶段返回了可恢复告警，但 Gateway 已通过后续启动与健康校验完成收敛。"
    } else {
        "OpenClaw 官方安装脚本与 CLI onboarding 已完成，已写入本地运行时状态。"
    };
    build_runtime_package_status(status_detail, Some(&runtime))
}

#[tauri::command]
fn bind_existing_runtime_package(
    state: State<'_, ManagedRuntimeStateHandle>,
    path: Option<String>,
) -> Result<RuntimePackageStatus, String> {
    let detected_path = path
        .filter(|value| !value.trim().is_empty())
        .or_else(detect_existing_openclaw_install)
        .ok_or_else(|| "未检测到已安装的 OpenClaw，无法执行绑定。".to_string())?;

    let selected_path = if cfg!(target_os = "windows") {
        resolve_windows_runnable_command_path(Path::new(detected_path.trim()))
    } else {
        PathBuf::from(detected_path.trim())
    };
    if !selected_path.exists() {
        return Err(format!("指定的 OpenClaw 安装路径不存在：{}", selected_path.display()));
    }

    let paths = runtime_package_paths()?;
    fs::create_dir_all(&paths.install_dir)
        .map_err(|error| format!("failed to create runtime install dir: {error}"))?;

    let reuse_detail = diagnose_existing_runtime_for_reuse()?;

    let manifest = build_runtime_manifest_from_cli(
        "existing-install",
        "openclaw-cli-existing",
        None,
        Some(selected_path.to_string_lossy().to_string()),
        None,
        None,
        true,
        Some(selected_path.to_string_lossy().to_string()),
    )?;

    fs::write(
        &paths.manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to serialize runtime manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to write runtime manifest: {error}"))?;

    let _ = ensure_workspace_markdown_templates(true)?;

    let mut runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    runtime.running = true;
    runtime.process_mode = Some("openclaw-gateway-daemon".into());
    runtime.last_started_at = Some(now_iso_string());
    build_runtime_package_status(&reuse_detail.detail, Some(&runtime))
}

#[tauri::command]
fn doctor_runtime_package(state: State<'_, ManagedRuntimeStateHandle>) -> Result<RuntimePackageStatus, String> {
    let _ = install_openclaw_cli_if_missing(None, None)?;
    execute_openclaw_command(&["doctor", "--non-interactive"], &[])?;

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    build_runtime_package_status("已执行 OpenClaw 官方诊断并刷新运行时状态。", Some(&runtime))
}

#[tauri::command]
async fn check_and_install_desktop_update(
    app: AppHandle,
    progress_handle: State<'_, DesktopUpdaterProgressHandle>,
) -> Result<DesktopUpdaterStatus, String> {
    let assigned_channel = "stable".to_string();
    let current_version = app.package_info().version.to_string();
    let last_checked_at = now_iso_string();

    let Some(endpoint) = build_desktop_updater_endpoint(&assigned_channel) else {
        return Ok(DesktopUpdaterStatus {
            available: false,
            update_available: false,
            installed: false,
            current_version,
            target_version: None,
            assigned_channel,
            endpoint: String::new(),
            download_url: None,
            downloaded_bytes: None,
            total_bytes: None,
            last_checked_at,
            detail: "公开仓默认未配置桌面升级源；如需启用自升级，请设置 RHOPENCLAW_DESKTOP_UPDATER_BASE_URL。".into(),
        });
    };

    eprintln!(
        "[updater] checking release manifest: channel={}, endpoint={}",
        assigned_channel, endpoint
    );

    let updater = app
        .updater_builder()
        .pubkey(RHOPENCLAW_DESKTOP_UPDATER_PUBLIC_KEY)
        .endpoints(vec![endpoint
            .parse()
            .map_err(|error| format!("桌面升级源地址非法：{error}"))?])
        .map_err(|error| format!("桌面升级配置初始化失败：{error}"))?
        .build()
        .map_err(|error| format!("桌面升级器构建失败：{error}"))?;

    let update = match updater.check().await {
        Ok(result) => result,
        Err(error) => {
            return Ok(DesktopUpdaterStatus {
                available: false,
                update_available: false,
                installed: false,
                current_version,
                target_version: None,
                assigned_channel,
                endpoint: endpoint.clone(),
                download_url: None,
                downloaded_bytes: None,
                total_bytes: None,
                last_checked_at,
                detail: format!(
                    "桌面升级源暂不可用（{error}）。请确认网络连通，或联系管理员检查升级清单地址：{endpoint}"
                ),
            });
        }
    };

    let Some(update) = update else {
        return Ok(DesktopUpdaterStatus {
            available: true,
            update_available: false,
            installed: false,
            current_version,
            target_version: None,
            assigned_channel,
            endpoint,
            download_url: None,
            downloaded_bytes: None,
            total_bytes: None,
            last_checked_at,
            detail: "当前桌面端已是最新发布版本，或当前灰度通道尚未提供可安装更新。".into(),
        });
    };

    let target_version = update.version.clone();
    let download_url = Some(update.download_url.to_string());

    // Guard: prevent duplicate downloads
    {
        let progress = progress_handle.inner.lock().map_err(|_| "updater progress state poisoned".to_string())?;
        if progress.active {
            eprintln!("[updater] download already in progress, skipping duplicate spawn");
            return Ok(DesktopUpdaterStatus {
                available: true,
                update_available: true,
                installed: progress.completed,
                current_version,
                target_version: Some(target_version),
                assigned_channel,
                endpoint,
                download_url,
                downloaded_bytes: Some(progress.downloaded_bytes),
                total_bytes: progress.total_bytes,
                last_checked_at,
                detail: if progress.completed { "下载完毕，请重启。".into() } else { "正在后台下载…".into() },
            });
        }
    }

    // Mark download as active
    {
        let mut progress = progress_handle.inner.lock().map_err(|_| "updater progress state poisoned".to_string())?;
        progress.active = true;
        progress.downloaded_bytes = 0;
        progress.total_bytes = None;
        progress.completed = false;
        progress.error = None;
    }

    // Return immediately so the frontend can show the modal
    let result = DesktopUpdaterStatus {
        available: true,
        update_available: true,
        installed: false,
        current_version,
        target_version: Some(target_version.clone()),
        assigned_channel,
        endpoint,
        download_url,
        downloaded_bytes: Some(0),
        total_bytes: None,
        last_checked_at,
        detail: format!("发现新版本 {target_version}，正在后台下载…"),
    };

    // Spawn background task for download + install
    eprintln!("[updater] spawning background download: version={target_version}, url={}", update.download_url);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let accumulated = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let accumulated_clone = accumulated.clone();
        let app_for_chunk = app_handle.clone();

        let download_result = update
            .download_and_install(
                move |chunk_length, content_length| {
                    let total = accumulated_clone.fetch_add(chunk_length as u64, std::sync::atomic::Ordering::Relaxed) + chunk_length as u64;
                    // Update shared progress state (frontend polls this)
                    if let Ok(mut p) = app_for_chunk.state::<DesktopUpdaterProgressHandle>().inner.lock() {
                        p.downloaded_bytes = total;
                        p.total_bytes = content_length;
                    }
                    if total % (512 * 1024) < chunk_length as u64 {
                        eprintln!("[updater] progress: {total} / {content_length:?}");
                    }
                },
                || {
                    eprintln!("[updater] download finished, applying update…");
                },
            )
            .await;

        match download_result {
            Ok(()) => {
                eprintln!("[updater] update installed successfully");
                if let Ok(mut p) = app_handle.state::<DesktopUpdaterProgressHandle>().inner.lock() {
                    p.completed = true;
                }
            }
            Err(error) => {
                eprintln!("[updater] download/install FAILED: {error}");
                if let Ok(mut p) = app_handle.state::<DesktopUpdaterProgressHandle>().inner.lock() {
                    p.error = Some(format!("桌面升级下载安装失败：{error}"));
                }
            }
        }
    });

    Ok(result)
}

#[tauri::command]
fn get_desktop_update_progress(
    state: State<'_, DesktopUpdaterProgressHandle>,
) -> Result<DesktopUpdaterProgressInner, String> {
    let inner = state.inner.lock().map_err(|_| "updater progress state poisoned".to_string())?;
    Ok(inner.clone())
}

#[tauri::command]
fn relaunch_desktop_app(app: AppHandle) -> Result<(), String> {
    app.restart();
}

#[tauri::command]
fn remove_runtime_package(
    state: State<'_, ManagedRuntimeStateHandle>,
) -> Result<RuntimePackageStatus, String> {
    {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|_| "managed runtime state poisoned".to_string())?;
        if let Some(mut child) = runtime.child.take() {
            let _ = child.kill();
        }
        runtime.running = false;
        runtime.process_id = None;
        runtime.last_stopped_at = Some(now_iso_string());
    }

    let mut uninstall_detail = "未检测到 openclaw CLI，已清理托管目录。".to_string();
    if detect_openclaw_cli().is_some() {
        let _ = execute_openclaw_command(&["gateway", "stop"], &[]);
        execute_openclaw_command(&["reset", "--scope", "full", "--yes", "--non-interactive"], &[])
            .map_err(|error| format!("OpenClaw 原生卸载失败：{error}"))?;
        uninstall_detail = "已执行 OpenClaw 原生卸载并清理托管目录。".to_string();
    }

    let paths = runtime_package_paths()?;
    if paths.install_dir.exists() {
        fs::remove_dir_all(&paths.install_dir)
            .map_err(|error| format!("failed to remove runtime install dir: {error}"))?;
    }

    let runtime = state
        .inner
        .lock()
        .map_err(|_| "managed runtime state poisoned".to_string())?;
    build_runtime_package_status(&uninstall_detail, Some(&runtime))
}

fn append_log_line(path: &str, entry: &AgentLogEntry) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open log file: {error}"))?;

    writeln!(file, "{} [{}] {}", entry.timestamp, entry.level, entry.message)
        .map_err(|error| format!("failed to write log line: {error}"))
}

fn read_log_tail(path: &PathBuf, max_lines: usize) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read log file: {error}"))?;
    let mut lines = content
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<String>>();

    if lines.len() > max_lines {
        lines = lines.split_off(lines.len().saturating_sub(max_lines));
    }

    Ok(lines)
}

fn autostart_launcher_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "launch-agent"
    } else if cfg!(target_os = "windows") {
        "registry-run"
    } else if cfg!(target_os = "linux") {
        "xdg-autostart"
    } else {
        "unsupported"
    }
}

fn normalize_api_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn perform_native_json_request(
    method: Method,
    url: &str,
    body: Option<serde_json::Value>,
    bearer_token: Option<&str>,
) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to initialize native http client: {error}"))?;

    let mut request = client.request(method, url);

    if let Some(token) = bearer_token {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    if let Some(payload) = body {
        request = request.header(CONTENT_TYPE, "application/json").json(&payload);
    }

    let response = request
        .send()
        .map_err(|error| format!("native http request failed: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read native http response: {error}"))?;

    let payload: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("服务端响应不是有效 JSON（HTTP {}）", status.as_u16()))?;

    if !status.is_success() || !payload
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        let message = payload
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Request failed");
        return Err(message.to_string());
    }

    Ok(payload.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

pub(crate) fn now_iso_string() -> String {
    current_unix_ms().to_string()
}

pub(crate) fn current_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn main() {
    if let Some(exit_code) = maybe_run_secret_resolver_mode() {
        std::process::exit(exit_code);
    }

    #[cfg(target_os = "macos")]
    if let Err(error) = migrate_macos_exec_secret_store() {
        eprintln!("[rhopenclaw] migrate_macos_exec_secret_store: {error}");
    }

    if let Err(error) = ensure_openclaw_gateway_config() {
        eprintln!("[rhopenclaw] ensure_openclaw_gateway_config (startup): {error}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(RHOPENCLAW_DESKTOP_UPDATER_PUBLIC_KEY)
                .build(),
        )
        .manage(AgentState::default())
        .manage(ManagedRuntimeStateHandle::default())
        .manage(DesktopUpdaterProgressHandle::default())
        .manage(BackupProgressHandle::default())
        .manage(task_center::TaskCenterState::default())
        .invoke_handler(tauri::generate_handler![
            agent_status,
            read_agent_logs,
            start_agent_sidecar,
            stop_agent_sidecar,
            local_storage_status,
            save_local_state_snapshot,
            load_local_state_snapshot,
            save_device_secret_stub,
            load_device_secret_stub,
            recover_device_secret_stub,
            clear_device_secret_stub,
            register_device_http,
            create_bind_session_http,
            get_bind_session_status_http,
            get_openclaw_workspace_info,
            list_local_skills,
            install_skill,
            uninstall_skill,
            list_openclaw_agents,
            list_workspace_files,
            read_workspace_file,
            save_workspace_file,
            list_openclaw_config_files,
            read_openclaw_config_file,
            save_openclaw_config_file,
            pick_openclaw_backup_file,
            backup_openclaw_config,
            get_backup_progress,
            restore_openclaw_config,
            get_openclaw_memory_overview,
            models_capability_probe,
            models_list_all,
            models_status,
            models_set,
            models_auth_paste_token,
            get_current_device_profile_http,
            get_desktop_subscription_status_http,
            get_desktop_version_check_http,
            get_desktop_llm_overview_http,
            fetch_install_llm_config_http,
            fetch_install_skills_config_http,
            get_desktop_llm_assignment_http,
            reassign_desktop_llm_http,
            write_gateway_llm_config,
            restart_gateway,
            runtime_package_status,
            probe_openclaw_runtime,
            read_runtime_logs,
            autostart_status,
            set_autostart_enabled,
            rhclaw_plugin_status,
            install_rhclaw_plugin,
            probe_rhclaw_plugin,
            remove_rhclaw_plugin,
            install_runtime_package,
            bind_existing_runtime_package,
            doctor_runtime_package,
            check_and_install_desktop_update,
            get_desktop_update_progress,
            relaunch_desktop_app,
            remove_runtime_package,
            start_runtime_process,
            stop_runtime_process,
            desktop_trace::append_desktop_trace,
            desktop_trace::query_desktop_traces,
            desktop_trace::get_trace_timeline,
            desktop_trace::find_recent_failures,
            desktop_trace::collect_debug_bundle,
            task_center::task_start,
            task_center::task_status,
            task_center::task_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
