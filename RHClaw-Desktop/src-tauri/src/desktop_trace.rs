use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceEntry {
    pub id: String,
    pub timestamp: String,
    pub timestamp_ms: u128,
    pub level: String,
    pub source: String,
    pub module: String,
    pub event: String,
    pub message: String,
    pub status: Option<String>,
    pub trace_id: Option<String>,
    pub execution_id: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub detail: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceWriteInput {
    pub level: String,
    pub source: String,
    pub module: String,
    pub event: String,
    pub message: String,
    pub status: Option<String>,
    pub trace_id: Option<String>,
    pub execution_id: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub detail: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceQuery {
    pub trace_id: Option<String>,
    pub execution_id: Option<String>,
    pub session_id: Option<String>,
    pub event_prefix: Option<String>,
    pub level: Option<String>,
    pub since_ms: Option<u128>,
    pub limit: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceFailureQuery {
    pub source: Option<String>,
    pub session_id: Option<String>,
    pub event_prefix: Option<String>,
    pub since_ms: Option<u128>,
    pub limit: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceBundleRequest {
    pub trace_id: Option<String>,
    pub session_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTraceBundleResult {
    pub bundle_path: String,
    pub created_at: String,
    pub trace_id: Option<String>,
    pub session_id: Option<String>,
    pub entry_count: usize,
    pub failure_count: usize,
}

fn current_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn current_unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn now_iso_string() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn desktop_trace_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base
        .join("rhopenclaw-desktop")
        .join("logs")
        .join("structured");
    fs::create_dir_all(&dir).map_err(|error| format!("failed to create desktop trace dir: {error}"))?;
    Ok(dir)
}

fn desktop_trace_file_path() -> Result<PathBuf, String> {
    Ok(desktop_trace_dir()?.join("trace.ndjson"))
}

fn desktop_bundle_dir() -> Result<PathBuf, String> {
    let dir = desktop_trace_dir()?.join("bundles");
    fs::create_dir_all(&dir).map_err(|error| format!("failed to create desktop trace bundle dir: {error}"))?;
    Ok(dir)
}

fn append_json_line(path: &PathBuf, entry: &DesktopTraceEntry) -> Result<(), String> {
    let serialized = serde_json::to_string(entry)
        .map_err(|error| format!("failed to serialize desktop trace entry: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open desktop trace file: {error}"))?;
    writeln!(file, "{serialized}")
        .map_err(|error| format!("failed to write desktop trace entry: {error}"))
}

fn read_all_entries() -> Result<Vec<DesktopTraceEntry>, String> {
    let path = desktop_trace_file_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read desktop trace file: {error}"))?;
    let mut entries = Vec::new();

    for line in content.lines() {
        let normalized = line.trim();
        if normalized.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<DesktopTraceEntry>(normalized) {
            entries.push(entry);
        }
    }

    Ok(entries)
}

fn parse_timestamp_ms(entry: &DesktopTraceEntry) -> u128 {
    if entry.timestamp_ms > 0 {
        return entry.timestamp_ms;
    }

    DateTime::parse_from_rfc3339(&entry.timestamp)
        .map(|value| value.timestamp_millis().max(0) as u128)
        .unwrap_or(0)
}

fn is_failure_entry(entry: &DesktopTraceEntry) -> bool {
    matches!(entry.level.as_str(), "error" | "fatal") || entry.status.as_deref() == Some("failure")
}

fn sanitize_for_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "trace".to_string()
    } else {
        trimmed.to_string()
    }
}

fn build_entry(input: DesktopTraceWriteInput) -> DesktopTraceEntry {
    let timestamp = now_iso_string();
    let timestamp_ms = current_unix_ms();
    DesktopTraceEntry {
        id: format!("dtl-{}", current_unix_nanos()),
        timestamp,
        timestamp_ms,
        level: input.level,
        source: input.source,
        module: input.module,
        event: input.event,
        message: input.message,
        status: input.status,
        trace_id: input.trace_id,
        execution_id: input.execution_id,
        session_id: input.session_id,
        duration_ms: input.duration_ms,
        detail: input.detail,
        error: input.error,
    }
}

// ---------------------------------------------------------------------------
// 写入级别过滤（与前端 shouldWriteTrace 保持一致）
// 有 trace_id / execution_id 的业务链路事件始终写入
// 其余按最低级别过滤：release 构建默认 warning；可通过
// DESKTOP_TRACE_MIN_LEVEL 环境变量运行时覆盖
// ---------------------------------------------------------------------------

fn level_rank(level: &str) -> u8 {
    match level {
        "debug"   => 0,
        "info"    => 1,
        "warning" => 2,
        "error"   => 3,
        "fatal"   => 4,
        _         => 1,
    }
}

fn min_write_level_rank() -> u8 {
    if let Ok(val) = std::env::var("DESKTOP_TRACE_MIN_LEVEL") {
        return level_rank(val.trim());
    }
    // debug 构建写 info+，release 构建写 warning+
    if cfg!(debug_assertions) { 1 } else { 2 }
}

fn should_write_trace(input: &DesktopTraceWriteInput) -> bool {
    // 业务链路事件始终写入
    if input.trace_id.is_some() || input.execution_id.is_some() {
        return true;
    }
    // error / fatal 始终写入
    let rank = level_rank(&input.level);
    if rank >= 3 {
        return true;
    }
    rank >= min_write_level_rank()
}

#[tauri::command]
pub fn append_desktop_trace(input: DesktopTraceWriteInput) -> Result<DesktopTraceEntry, String> {
    if !should_write_trace(&input) {
        // 返回一个占位 entry，不落盘（与前端过滤保持一致，通常前端已先过滤）
        return Ok(build_entry(input));
    }
    let entry = build_entry(input);
    let path = desktop_trace_file_path()?;
    append_json_line(&path, &entry)?;
    Ok(entry)
}

#[tauri::command]
pub fn query_desktop_traces(query: Option<DesktopTraceQuery>) -> Result<Vec<DesktopTraceEntry>, String> {
    let query = query.unwrap_or_default();
    let mut entries = read_all_entries()?;

    entries.retain(|entry| {
        if let Some(trace_id) = query.trace_id.as_ref() {
            if entry.trace_id.as_ref() != Some(trace_id) {
                return false;
            }
        }
        if let Some(execution_id) = query.execution_id.as_ref() {
            if entry.execution_id.as_ref() != Some(execution_id) {
                return false;
            }
        }
        if let Some(session_id) = query.session_id.as_ref() {
            if entry.session_id.as_ref() != Some(session_id) {
                return false;
            }
        }
        if let Some(event_prefix) = query.event_prefix.as_ref() {
            if !entry.event.starts_with(event_prefix) {
                return false;
            }
        }
        if let Some(level) = query.level.as_ref() {
            if &entry.level != level {
                return false;
            }
        }
        if let Some(since_ms) = query.since_ms {
            if parse_timestamp_ms(entry) < since_ms {
                return false;
            }
        }
        true
    });

    entries.sort_by(|left, right| parse_timestamp_ms(right).cmp(&parse_timestamp_ms(left)));
    if let Some(limit) = query.limit {
        entries.truncate(limit);
    }
    Ok(entries)
}

#[tauri::command]
pub fn get_trace_timeline(trace_id: String, limit: Option<usize>) -> Result<Vec<DesktopTraceEntry>, String> {
    let mut entries = read_all_entries()?
        .into_iter()
        .filter(|entry| entry.trace_id.as_ref() == Some(&trace_id))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| parse_timestamp_ms(left).cmp(&parse_timestamp_ms(right)));
    if let Some(limit) = limit {
        if entries.len() > limit {
            entries = entries.split_off(entries.len().saturating_sub(limit));
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn find_recent_failures(query: Option<DesktopTraceFailureQuery>) -> Result<Vec<DesktopTraceEntry>, String> {
    let query = query.unwrap_or_default();
    let mut entries = read_all_entries()?;

    entries.retain(|entry| {
        if !is_failure_entry(entry) {
            return false;
        }
        if let Some(source) = query.source.as_ref() {
            if &entry.source != source {
                return false;
            }
        }
        if let Some(session_id) = query.session_id.as_ref() {
            if entry.session_id.as_ref() != Some(session_id) {
                return false;
            }
        }
        if let Some(event_prefix) = query.event_prefix.as_ref() {
            if !entry.event.starts_with(event_prefix) {
                return false;
            }
        }
        if let Some(since_ms) = query.since_ms {
            if parse_timestamp_ms(entry) < since_ms {
                return false;
            }
        }
        true
    });

    entries.sort_by(|left, right| parse_timestamp_ms(right).cmp(&parse_timestamp_ms(left)));
    entries.truncate(query.limit.unwrap_or(12));
    Ok(entries)
}

#[tauri::command]
pub fn collect_debug_bundle(request: Option<DesktopTraceBundleRequest>) -> Result<DesktopTraceBundleResult, String> {
    let request = request.unwrap_or_default();
    let trace_id = request.trace_id.clone();
    let session_id = request.session_id.clone();
    let mut entries = read_all_entries()?;

    if let Some(trace_id) = trace_id.as_ref() {
        entries.retain(|entry| entry.trace_id.as_ref() == Some(trace_id));
    }
    if let Some(session_id) = session_id.as_ref() {
        entries.retain(|entry| entry.session_id.as_ref() == Some(session_id));
    }

    entries.sort_by(|left, right| parse_timestamp_ms(right).cmp(&parse_timestamp_ms(left)));
    if let Some(limit) = request.limit {
        entries.truncate(limit);
    }

    let failures = entries
        .iter()
        .filter(|entry| is_failure_entry(entry))
        .cloned()
        .collect::<Vec<_>>();
    let created_at = now_iso_string();
    let entry_count = entries.len();
    let failure_count = failures.len();
    let bundle_payload = json!({
        "createdAt": created_at,
        "traceId": trace_id,
        "sessionId": session_id,
        "entryCount": entry_count,
        "failureCount": failure_count,
        "failures": failures,
        "entries": entries,
    });

    let bundle_name = if let Some(trace_id) = trace_id.as_ref() {
        format!("debug-bundle-trace-{}-{}.json", sanitize_for_file_name(trace_id), current_unix_ms())
    } else if let Some(session_id) = session_id.as_ref() {
        format!("debug-bundle-session-{}-{}.json", sanitize_for_file_name(session_id), current_unix_ms())
    } else {
        format!("debug-bundle-{}.json", current_unix_ms())
    };
    let bundle_path = desktop_bundle_dir()?.join(bundle_name);
    let serialized = serde_json::to_vec_pretty(&bundle_payload)
        .map_err(|error| format!("failed to serialize desktop trace bundle: {error}"))?;
    fs::write(&bundle_path, serialized)
        .map_err(|error| format!("failed to write desktop trace bundle: {error}"))?;

    Ok(DesktopTraceBundleResult {
        bundle_path: bundle_path.to_string_lossy().to_string(),
        created_at,
        trace_id,
        session_id,
        entry_count,
        failure_count,
    })
}