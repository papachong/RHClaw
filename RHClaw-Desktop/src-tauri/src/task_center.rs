use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::ManagedRuntimeStateHandle;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    InstallRuntime,
    BindExistingRuntime,
    RepairRuntime,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEntry {
    pub task_id: String,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub progress_percent: u8,
    pub progress_note: String,
    pub started_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    pub task_id: String,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub progress_percent: u8,
    pub note: String,
    pub log: String,
    pub error: Option<String>,
    pub timestamp_ms: u64,
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct TaskCenterInner {
    pub tasks: HashMap<String, TaskEntry>,
    pub cancel_flags: HashMap<String, Arc<Mutex<bool>>>,
}

#[derive(Clone)]
pub struct TaskCenterState {
    pub inner: Arc<Mutex<TaskCenterInner>>,
}

impl Default for TaskCenterState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(TaskCenterInner {
                tasks: HashMap::new(),
                cancel_flags: HashMap::new(),
            })),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn generate_task_id(task_type: &TaskType) -> String {
    let prefix = match task_type {
        TaskType::InstallRuntime => "install",
        TaskType::BindExistingRuntime => "bind",
        TaskType::RepairRuntime => "repair",
    };
    format!("{}-{}", prefix, current_unix_ms())
}

fn is_cancelled(cancel_flag: &Arc<Mutex<bool>>) -> bool {
    cancel_flag.lock().map(|f| *f).unwrap_or(false)
}

fn emit_progress(
    app: &AppHandle,
    state: &Arc<Mutex<TaskCenterInner>>,
    task_id: &str,
    status: TaskStatus,
    percent: u8,
    note: &str,
    log: &str,
    error: Option<String>,
    task_type: &TaskType,
) {
    if let Ok(mut center) = state.lock() {
        if let Some(entry) = center.tasks.get_mut(task_id) {
            entry.status = status.clone();
            entry.progress_percent = percent;
            entry.progress_note = note.to_string();
            entry.logs.push(log.to_string());
            if error.is_some() {
                entry.error = error.clone();
            }
            if matches!(
                status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
            ) {
                entry.completed_at_ms = Some(current_unix_ms());
            }
        }
    }

    let event = TaskProgressEvent {
        task_id: task_id.to_string(),
        task_type: task_type.clone(),
        status,
        progress_percent: percent,
        note: note.to_string(),
        log: log.to_string(),
        error,
        timestamp_ms: current_unix_ms(),
    };
    let _ = app.emit("task-center-progress", &event);
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start a background task. Returns the initial `TaskEntry` immediately; the
/// actual work runs on a dedicated thread which pushes progress via
/// `task-center-progress` events.
#[tauri::command]
pub fn task_start(
    app: AppHandle,
    state: State<'_, TaskCenterState>,
    runtime_state: State<'_, ManagedRuntimeStateHandle>,
    task_type: TaskType,
    params: serde_json::Value,
) -> Result<TaskEntry, String> {
    let task_id = generate_task_id(&task_type);
    let cancel_flag = Arc::new(Mutex::new(false));

    let entry = TaskEntry {
        task_id: task_id.clone(),
        task_type: task_type.clone(),
        status: TaskStatus::Queued,
        progress_percent: 0,
        progress_note: "任务已创建".to_string(),
        started_at_ms: current_unix_ms(),
        completed_at_ms: None,
        error: None,
        logs: vec!["任务已加入队列".to_string()],
    };

    {
        let mut center = state
            .inner
            .lock()
            .map_err(|_| "task center state poisoned")?;

        // Prevent launching duplicate tasks of the same type while one is in-flight
        let type_tag = format!("{:?}", task_type);
        for existing in center.tasks.values() {
            if format!("{:?}", existing.task_type) == type_tag
                && matches!(existing.status, TaskStatus::Queued | TaskStatus::Running)
            {
                return Err(format!(
                    "同类型任务 {} 已在执行中 ({}), 请等待完成后再试",
                    type_tag, existing.task_id,
                ));
            }
        }

        center
            .tasks
            .insert(task_id.clone(), entry.clone());
        center
            .cancel_flags
            .insert(task_id.clone(), cancel_flag.clone());
    }

    let state_handle = state.inner.clone();
    let runtime_handle = runtime_state.inner.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let tid_for_panic = task_id.clone();
        let tt_for_panic = task_type.clone();
        let state_for_panic = state_handle.clone();
        let app_for_panic = app_handle.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_task(
                app_handle,
                state_handle,
                runtime_handle,
                task_id,
                task_type,
                params,
                cancel_flag,
            );
        }));

        if let Err(panic_info) = result {
            let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                format!("任务线程发生 panic: {s}")
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                format!("任务线程发生 panic: {s}")
            } else {
                "任务线程发生未知 panic".to_string()
            };
            eprintln!("[rhopenclaw] {msg}");
            emit_progress(
                &app_for_panic, &state_for_panic, &tid_for_panic,
                TaskStatus::Failed, 100, "任务异常中止", &msg, Some(msg.clone()), &tt_for_panic,
            );
        }
    });

    Ok(entry)
}

/// Query task status. When `task_id` is `None` returns all tasks.
#[tauri::command]
pub fn task_status(
    state: State<'_, TaskCenterState>,
    task_id: Option<String>,
) -> Result<Vec<TaskEntry>, String> {
    let center = state
        .inner
        .lock()
        .map_err(|_| "task center state poisoned")?;
    match task_id {
        Some(id) => center
            .tasks
            .get(&id)
            .map(|e| vec![e.clone()])
            .ok_or_else(|| format!("task not found: {id}")),
        None => Ok(center.tasks.values().cloned().collect()),
    }
}

/// Request cancellation of a running task. The background thread checks the
/// flag periodically and will stop at the next checkpoint.
#[tauri::command]
pub fn task_cancel(
    state: State<'_, TaskCenterState>,
    task_id: String,
) -> Result<TaskEntry, String> {
    let center = state
        .inner
        .lock()
        .map_err(|_| "task center state poisoned")?;

    if let Some(flag) = center.cancel_flags.get(&task_id) {
        if let Ok(mut cancelled) = flag.lock() {
            *cancelled = true;
        }
    }

    center
        .tasks
        .get(&task_id)
        .cloned()
        .ok_or_else(|| format!("task not found: {task_id}"))
}

// ---------------------------------------------------------------------------
// Task execution (background thread)
// ---------------------------------------------------------------------------

/// Macro-like helper: check cancel, emit fail on error, continue on success.
macro_rules! step {
    ($app:expr, $tc:expr, $tid:expr, $tt:expr, $flag:expr,
     $pct:expr, $note:expr, $log:expr, $body:expr) => {{
        if is_cancelled($flag) {
            emit_progress($app, $tc, $tid, TaskStatus::Cancelled, 0, "任务已取消", "用户取消了任务", None, $tt);
            return Ok(());
        }
        emit_progress($app, $tc, $tid, TaskStatus::Running, $pct, $note, $log, None, $tt);
        match (|| -> Result<_, String> { $body })() {
            Ok(val) => val,
            Err(e) => {
                emit_progress($app, $tc, $tid, TaskStatus::Failed, $pct, "任务失败", &e, Some(e.clone()), $tt);
                return Ok(());
            }
        }
    }};
}

fn execute_task(
    app: AppHandle,
    state: Arc<Mutex<TaskCenterInner>>,
    runtime_handle: Arc<Mutex<crate::ManagedRuntimeState>>,
    task_id: String,
    task_type: TaskType,
    params: serde_json::Value,
    cancel_flag: Arc<Mutex<bool>>,
) {
    emit_progress(
        &app, &state, &task_id, TaskStatus::Running, 5,
        "任务开始执行", "任务开始执行", None, &task_type,
    );

    let result = match task_type {
        TaskType::InstallRuntime => execute_install_runtime(
            &app, &state, &runtime_handle, &task_id, &task_type, &params, &cancel_flag,
        ),
        TaskType::BindExistingRuntime => execute_bind_existing(
            &app, &state, &runtime_handle, &task_id, &task_type, &params, &cancel_flag,
        ),
        TaskType::RepairRuntime => execute_repair_runtime(
            &app, &state, &runtime_handle, &task_id, &task_type, &cancel_flag,
        ),
    };

    if let Err(e) = result {
        emit_progress(
            &app, &state, &task_id, TaskStatus::Failed, 100,
            "任务失败", &e, Some(e.clone()), &task_type,
        );
    }
}

// ---------------------------------------------------------------------------
// InstallRuntime orchestration
// ---------------------------------------------------------------------------

fn execute_install_runtime(
    app: &AppHandle,
    tc: &Arc<Mutex<TaskCenterInner>>,
    runtime_handle: &Arc<Mutex<crate::ManagedRuntimeState>>,
    tid: &str,
    tt: &TaskType,
    params: &serde_json::Value,
    flag: &Arc<Mutex<bool>>,
) -> Result<(), String> {
    let version = params.get("version").and_then(|v| v.as_str()).map(|s| s.to_string());
    let download_url = params.get("downloadUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
    let expected_sha256 = params.get("expectedSha256").and_then(|v| v.as_str()).map(|s| s.to_string());
    let cli_was_present_before = crate::detect_openclaw_cli().is_some();
    let server_api_base_url = params
        .get("serverApiBaseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let install_skills_config = crate::fetch_desktop_install_skills_config(server_api_base_url.as_deref());

    // Step 1: Ensure CLI is available
    let (package_path, resolved_sha256, verified, installer_source) = step!(
        app, tc, tid, tt, flag,
        10, "正在检测 OpenClaw CLI 安装状态...", "读取已安装版本与离线包版本",
        {
            let paths = crate::runtime_package_paths()?;
            std::fs::create_dir_all(&paths.install_dir)
                .map_err(|e| format!("无法创建运行时安装目录: {e}"))?;

            let normalized = expected_sha256.as_ref()
                .map(|v| crate::normalize_sha256(v))
                .filter(|v| !v.is_empty());

            // Pre-check: determine install intent and emit an accurate status log
            // before the potentially slow npm install starts.
            let cli_available = crate::detect_openclaw_cli().is_some();
            let current_version = crate::detect_current_openclaw_runtime_version();
            let offline_bundle_dir = crate::detect_openclaw_offline_bundle_dir();
            let offline_bundle_version = crate::resolve_offline_bundle_openclaw_version_info(
                offline_bundle_dir.as_ref(),
            ).resolved_version;
            let needs_install = !cli_available
                || crate::should_upgrade_to_offline_bundle_version(
                    current_version.as_deref(),
                    offline_bundle_version.as_deref(),
                );

            if needs_install {
                let action = if cli_available { "升级" } else { "全新安装" };
                let detail = format!(
                    "离线包版本: {} | 当前已安装: {} → 开始{}离线 npm install -g",
                    offline_bundle_version.as_deref().unwrap_or("unknown"),
                    current_version.as_deref().unwrap_or("未安装"),
                    action,
                );
                emit_progress(
                    app, tc, tid, TaskStatus::Running, 13,
                    &format!("正在从离线包{}  OpenClaw CLI，请稍候...", action),
                    &detail, None, tt,
                );
            } else {
                emit_progress(
                    app, tc, tid, TaskStatus::Running, 13,
                    "OpenClaw CLI 已是最新版本，跳过安装",
                    &format!(
                        "CLI 已安装 ({}), 与离线包版本 ({}) 一致，跳过 npm install",
                        current_version.as_deref().unwrap_or("unknown"),
                        offline_bundle_version.as_deref().unwrap_or("unknown"),
                    ),
                    None, tt,
                );
            }

            let t0 = std::time::Instant::now();
            let install_result = crate::install_openclaw_cli_if_missing(
                download_url.as_deref(),
                normalized.as_deref(),
            )?;
            if needs_install {
                emit_progress(
                    app, tc, tid, TaskStatus::Running, 27,
                    "OpenClaw CLI 安装完成，准备执行 onboard...",
                    &format!("npm install -g 执行完毕，耗时 {:.1}s", t0.elapsed().as_secs_f64()),
                    None, tt,
                );
            }
            Ok(install_result)
        }
    );

    // Step 2: Check if CLI was already present, reset if so
    step!(
        app, tc, tid, tt, flag,
        30, "正在准备 OpenClaw onboard 环境...", "CLI 已就绪，准备 onboard",
        {
            // Pre-heal: strip orphan channels.rhclaw from config so CLI validation
            // does not reject "unknown channel id: rhclaw" before onboard/reset.
            crate::strip_channels_rhclaw_if_plugin_missing();
            if cli_was_present_before {
                let _ = crate::execute_openclaw_command(
                    &["reset", "--scope", "full", "--yes", "--non-interactive"], &[],
                );

                // `reset --scope full` removes the entire ~/.openclaw directory,
                // which includes the Desktop-managed CLI installed during step 1
                // at ~/.openclaw/tooling/npm-global/.  Re-run the install to
                // ensure the CLI is available for the subsequent onboard step.
                if crate::detect_openclaw_cli().is_none() {
                    // The stale manifest may still reference the old
                    // bound_install_path (installMode=existing-install) which no
                    // longer exists after reset.  Delete it so the re-install
                    // falls through to the normal offline-bundle install path.
                    if let Ok(paths) = crate::runtime_package_paths() {
                        let _ = std::fs::remove_file(&paths.manifest_path);
                    }

                    emit_progress(
                        app, tc, tid, TaskStatus::Running, 35,
                        "reset 后 CLI 不可用，正在重新安装...",
                        "reset --scope full 删除了 ~/.openclaw，需要重新安装 CLI",
                        None, tt,
                    );
                    let _ = crate::install_openclaw_cli_if_missing(None, None)
                        .map_err(|e| format!("reset 后重新安装 CLI 失败: {e}"))?;
                }
            }
            Ok(())
        }
    );

    // Step 3: Execute onboard
    let onboard_recovery_warning = step!(
        app, tc, tid, tt, flag,
        50, "正在执行 OpenClaw onboard 安装...", "开始执行 openclaw onboard",
        {
            let gateway_token = format!("rhopenclaw-{}", crate::current_unix_ms());
            let mut args = vec![
                "onboard", "--non-interactive", "--json",
                "--mode", "local", "--auth-choice", "skip",
                "--gateway-bind", crate::OPENCLAW_DEFAULT_GATEWAY_BIND,
                "--gateway-port", "18789",
                "--gateway-auth", "token",
                "--gateway-token", gateway_token.as_str(),
                "--install-daemon",
                "--daemon-runtime", "node",
                "--accept-risk",
            ];

            if crate::should_skip_openclaw_builtin_skills(&install_skills_config) {
                args.push("--skip-skills");
            }

            let version_str;
            if let Some(v) = version.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty() && *s != "latest") {
                version_str = v.to_string();
                args.push("--version");
                args.push(&version_str);
            }

            let onboard_envs = crate::build_openclaw_install_env(crate::detect_openclaw_offline_bundle_dir().as_ref());
            let onboard_env_refs = onboard_envs
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>();
            crate::execute_openclaw_onboard_command(&args, &onboard_env_refs)
        }
    );

    if let Some(warning) = onboard_recovery_warning.as_ref() {
        emit_progress(
            app, tc, tid, TaskStatus::Running, 58,
            "Windows 受管安装注册受限，继续验证 Gateway 启动...",
            warning,
            None, tt,
        );
    }

    step!(
        app, tc, tid, tt, flag,
        60, "正在收口 OpenClaw 初始配置...", "onboard 后立即修正 Gateway 配置",
        {
            crate::ensure_openclaw_gateway_config()
                .map_err(|e| format!("onboard 后修正 Gateway 配置失败: {e}"))?;
            Ok(())
        }
    );

    // Skills 安装为非关键步骤，失败不阻塞后续 Gateway 配置和启动
    if is_cancelled(flag) {
        emit_progress(app, tc, tid, TaskStatus::Cancelled, 0, "任务已取消", "用户取消了任务", None, tt);
        return Ok(());
    }
    emit_progress(app, tc, tid, TaskStatus::Running, 65, "正在安装 SkillHub CLI 与附加 skills...", "同步 Desktop skills 安装策略", None, tt);
    if let Err(skills_error) = crate::apply_desktop_install_skills(&install_skills_config) {
        eprintln!("[rhopenclaw] 推荐 skills 安装失败（非致命），继续主流程: {skills_error}");
        emit_progress(
            app, tc, tid, TaskStatus::Running, 67,
            "推荐 skills 安装部分失败，继续安装...",
            &format!("skills 安装警告: {skills_error}"),
            None, tt,
        );
    }

    // Step 4: Build manifest from CLI status
    step!(
        app, tc, tid, tt, flag,
        70, "正在读取安装结果并写入运行时清单...", "构建 manifest",
        {
            let normalized = expected_sha256.as_ref()
                .map(|v| crate::normalize_sha256(v))
                .filter(|v| !v.is_empty());
            let install_target_prefix = crate::resolve_openclaw_install_target_prefix_dir()?;
            let installed_cli_path = crate::resolve_openclaw_cli_path_from_prefix_dir(&install_target_prefix);

            let manifest = crate::build_runtime_manifest_from_cli(
                "official-cli-onboard", "openclaw-cli",
                installer_source.clone().or(download_url.clone()), package_path.clone(),
                normalized.clone(), resolved_sha256.clone(), verified,
                Some(installed_cli_path.to_string_lossy().to_string()),
            )?;

            let paths = crate::runtime_package_paths()?;
            std::fs::write(
                &paths.manifest_path,
                serde_json::to_vec_pretty(&manifest)
                    .map_err(|e| format!("序列化 manifest 失败: {e}"))?,
            ).map_err(|e| format!("写入 manifest 失败: {e}"))?;
            Ok(())
        }
    );

    // Step 5: Ensure gateway config and start gateway
    step!(
        app, tc, tid, tt, flag,
        80, "正在确保 Gateway 配置正确...", "检查 gateway.mode 配置",
        {
            crate::ensure_openclaw_gateway_config()
                .map_err(|e| format!("确保 Gateway 配置失败: {e}"))?;
            Ok(())
        }
    );

    step!(
        app, tc, tid, tt, flag,
        85, "正在启动 OpenClaw Gateway...", "启动 Gateway",
        {
            let probe = crate::probe_gateway_running();
            if !probe.running {
                let _ = crate::start_openclaw_gateway_runtime(Some(runtime_handle))
                    .map_err(|e| format!("Gateway 启动失败: {e}"))?;
                // gateway start 是异步的，等待短暂时间再探测
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
            Ok(())
        }
    );

    // Step 6: Verify gateway is actually running
    step!(
        app, tc, tid, tt, flag,
        92, "正在验证 Gateway 运行状态...", "验证 Gateway",
        {
            let probe = crate::probe_gateway_running();
            if !probe.running {
                let retry_probe = crate::poll_gateway_until_healthy(
                    std::time::Duration::from_secs(15),
                    std::time::Duration::from_millis(500),
                );
                if !retry_probe.running {
                    return Err(format!(
                        "安装完成但 Gateway 启动失败: {}。请稍后手动执行 openclaw gateway start。",
                        retry_probe.detail
                    ));
                }
            }
            crate::run_openclaw_health_check()
                .map_err(|error| format!("Gateway 健康检查失败: {error}"))?;
            Ok(())
        }
    );

    // Step 7: Update runtime state and emit completion
    {
        if let Ok(mut rt) = runtime_handle.lock() {
            rt.running = true;
            rt.last_started_at = Some(crate::now_iso_string());
        }
    }

    let status = crate::build_runtime_package_status(
        "安装完成",
        runtime_handle.lock().ok().as_deref(),
    ).ok();

    let detail = status.map(|s| {
        let mut detail = format!(
            "安装版本: {}, Gateway: {}",
            s.version.unwrap_or_else(|| "unknown".to_string()),
            if s.process_running { "运行中" } else { "未就绪" },
        );
        if onboard_recovery_warning.is_some() {
            detail.push_str("（已自动收敛 Windows 受管安装告警）");
        }
        detail
    }).unwrap_or_else(|| {
        if onboard_recovery_warning.is_some() {
            "安装完成（已自动收敛 Windows 受管安装告警）".to_string()
        } else {
            "安装完成".to_string()
        }
    });

    let completion_log = if onboard_recovery_warning.is_some() {
        "安装任务完成，已自动收敛 Windows 受管安装告警"
    } else {
        "安装任务完成"
    };

    emit_progress(
        app, tc, tid, TaskStatus::Completed, 100,
        &detail, completion_log, None, tt,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// BindExistingRuntime orchestration
// ---------------------------------------------------------------------------

fn execute_bind_existing(
    app: &AppHandle,
    tc: &Arc<Mutex<TaskCenterInner>>,
    runtime_handle: &Arc<Mutex<crate::ManagedRuntimeState>>,
    tid: &str,
    tt: &TaskType,
    params: &serde_json::Value,
    flag: &Arc<Mutex<bool>>,
) -> Result<(), String> {
    let bind_path = params.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Step 1: Detect existing install
    let detected_path = step!(
        app, tc, tid, tt, flag,
        15, "正在检测本机 OpenClaw 安装路径...", "检测已有安装",
        {
            let path = bind_path
                .filter(|v| !v.trim().is_empty())
                .or_else(crate::detect_existing_openclaw_install)
                .ok_or_else(|| "未检测到已安装的 OpenClaw，无法执行绑定。".to_string())?;

            let p = std::path::PathBuf::from(path.trim());
            if !p.exists() {
                return Err(format!("指定的 OpenClaw 安装路径不存在：{}", p.display()));
            }
            Ok(path)
        }
    );

    // Step 2: Build manifest from detected path
    step!(
        app, tc, tid, tt, flag,
        40, "正在读取安装信息并写入运行时清单...", "构建 manifest",
        {
            let manifest = crate::build_runtime_manifest_from_cli(
                "existing-install", "openclaw-cli-existing",
                None, None, None, None, true,
                Some(detected_path.clone()),
            )?;

            let paths = crate::runtime_package_paths()?;
            std::fs::create_dir_all(&paths.install_dir)
                .map_err(|e| format!("无法创建安装目录: {e}"))?;
            std::fs::write(
                &paths.manifest_path,
                serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化失败: {e}"))?,
            ).map_err(|e| format!("写入 manifest 失败: {e}"))?;
            Ok(())
        }
    );

    // Step 3: Ensure gateway config and start gateway
    step!(
        app, tc, tid, tt, flag,
        55, "正在确保 Gateway 配置正确...", "检查 gateway.mode 配置",
        {
            crate::ensure_openclaw_gateway_config()
                .map_err(|e| format!("确保 Gateway 配置失败: {e}"))?;
            Ok(())
        }
    );

    let reuse_summary = step!(
        app, tc, tid, tt, flag,
        82, "正在启动 Gateway、执行状态诊断并确认版本...", "执行复用诊断",
        {
            crate::diagnose_existing_runtime_for_reuse()
        }
    );

    step!(
        app, tc, tid, tt, flag,
        92, "正在刷新运行时清单并回写当前版本...", "刷新 manifest",
        {
            let manifest = crate::build_runtime_manifest_from_cli(
                "existing-install", "openclaw-cli-existing",
                None, None, None, None, true,
                Some(detected_path.clone()),
            )?;

            let paths = crate::runtime_package_paths()?;
            std::fs::write(
                &paths.manifest_path,
                serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化失败: {e}"))?,
            ).map_err(|e| format!("写入 manifest 失败: {e}"))?;
            Ok(())
        }
    );

    // Step 4: Finalize
    {
        if let Ok(mut rt) = runtime_handle.lock() {
            rt.running = true;
            rt.process_mode = Some("openclaw-gateway-daemon".to_string());
            rt.last_started_at = Some(crate::now_iso_string());
        }
    }

    let summary_detail = reuse_summary
        .detail;

    emit_progress(
        app, tc, tid, TaskStatus::Completed, 100,
        &summary_detail, "复用现有安装任务完成", None, tt,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// RepairRuntime orchestration
// ---------------------------------------------------------------------------

fn execute_repair_runtime(
    app: &AppHandle,
    tc: &Arc<Mutex<TaskCenterInner>>,
    runtime_handle: &Arc<Mutex<crate::ManagedRuntimeState>>,
    tid: &str,
    tt: &TaskType,
    flag: &Arc<Mutex<bool>>,
) -> Result<(), String> {
    // Step 1: Ensure bundled CLI version is installed before doctor
    step!(
        app, tc, tid, tt, flag,
        10, "正在检查并同步 OpenClaw 安装版本...", "同步离线包版本",
        {
            let _ = crate::install_openclaw_cli_if_missing(None, None)?;
            Ok(())
        }
    );

    // Step 2: Write back runtime manifest after potential upgrade
    step!(
        app, tc, tid, tt, flag,
        20, "正在更新运行时清单...", "写入 manifest",
        {
            let install_target_prefix = crate::resolve_openclaw_install_target_prefix_dir()?;
            let installed_cli_path = crate::resolve_openclaw_cli_path_from_prefix_dir(&install_target_prefix);
            let manifest = crate::build_runtime_manifest_from_cli(
                "repair", "openclaw-cli",
                None, None, None, None, false,
                Some(installed_cli_path.to_string_lossy().to_string()),
            )?;
            let paths = crate::runtime_package_paths()?;
            std::fs::write(
                &paths.manifest_path,
                serde_json::to_vec_pretty(&manifest)
                    .map_err(|e| format!("序列化 manifest 失败: {e}"))?,
            ).map_err(|e| format!("写入 manifest 失败: {e}"))?;
            Ok(())
        }
    );

    // Step 3: Doctor
    step!(
        app, tc, tid, tt, flag,
        30, "正在执行 OpenClaw 官方诊断...", "执行 doctor",
        {
            crate::execute_openclaw_command(
                &["doctor", "--non-interactive", "--json"], &[],
            ).map_err(|e| format!("doctor 执行失败: {e}"))?;
            Ok(())
        }
    );

    // Step 4: Ensure gateway config and restart
    step!(
        app, tc, tid, tt, flag,
        50, "正在确保 Gateway 配置正确...", "检查 gateway.mode 配置",
        {
            crate::ensure_openclaw_gateway_config()
                .map_err(|e| format!("确保 Gateway 配置失败: {e}"))?;
            Ok(())
        }
    );

    step!(
        app, tc, tid, tt, flag,
        65, "正在重启 Gateway...", "重启 Gateway",
        {
            if let Ok(mut runtime) = runtime_handle.lock() {
                if let Some(mut child) = runtime.child.take() {
                    let _ = child.kill();
                }
                runtime.running = false;
                runtime.process_id = None;
            }
            let _ = crate::execute_openclaw_command(&["gateway", "stop"], &[]);
            let _ = crate::start_openclaw_gateway_runtime(Some(runtime_handle))
                .map_err(|e| format!("Gateway 启动失败: {e}"))?;
            Ok(())
        }
    );

    // Step 5: Verify
    step!(
        app, tc, tid, tt, flag,
        85, "正在验证修复结果...", "验证 Gateway 状态",
        {
            let probe = crate::probe_gateway_running();
            if !probe.running {
                return Err(format!("修复后 Gateway 仍未就绪: {}", probe.detail));
            }
            crate::run_openclaw_health_check()
                .map_err(|error| format!("修复后的 Gateway 健康检查失败: {error}"))?;
            Ok(())
        }
    );

    // Finalize
    {
        if let Ok(mut rt) = runtime_handle.lock() {
            rt.running = true;
            rt.last_started_at = Some(crate::now_iso_string());
        }
    }

    emit_progress(
        app, tc, tid, TaskStatus::Completed, 100,
        "修复完成", "修复任务完成", None, tt,
    );
    Ok(())
}
