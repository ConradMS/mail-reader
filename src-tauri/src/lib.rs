mod db;
mod graph;
mod ollama;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::Utc;
use rand::RngCore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const CLIENT_ID: &str = "be368ed0-a13a-4573-9680-b0aff33983a6";
const REDIRECT_URI: &str = "mailreader://auth";

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct PendingAuth { code_verifier: String, csrf_state: String }
struct TokenData { access_token: String, #[allow(dead_code)] refresh_token: Option<String> }

pub struct AppState {
    pending_auth:    Mutex<Option<PendingAuth>>,
    tokens:          Mutex<Option<TokenData>>,
    db:              Mutex<Connection>,
    data_dir:        std::path::PathBuf,
    is_analyzing:    Mutex<bool>,
    stop_requested:  Mutex<bool>,
    cancel_chat:     Arc<AtomicBool>,
}

fn db_filename(email: &str) -> String {
    // Sanitise email into a safe filename: keep alphanumeric + dot, replace rest with _
    let safe: String = email.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' { c } else { '_' })
        .collect();
    format!("mailreader_{safe}.db")
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct AccountInfo {
    pub name:  Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct SyncResult { pub emails_synced: usize }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn random_base64url(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

fn new_id() -> String { random_base64url(12) }

// ---------------------------------------------------------------------------
// Auth commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_microsoft_auth(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let code_verifier = random_base64url(32);
    let csrf_state    = random_base64url(16);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

    *state.pending_auth.lock().unwrap() = Some(PendingAuth { code_verifier, csrf_state: csrf_state.clone() });

    let mut url = url::Url::parse("https://login.microsoftonline.com/common/oauth2/v2.0/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_mode", "query")
        .append_pair("scope", "openid profile email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send")
        .append_pair("state", &csrf_state)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256");

    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn complete_microsoft_auth(redirect_url: String, state: State<'_, AppState>) -> Result<AccountInfo, String> {
    let parsed = url::Url::parse(&redirect_url).map_err(|e| e.to_string())?;
    let params: HashMap<_, _> = parsed.query_pairs().into_owned().collect();

    if let Some(err) = params.get("error") {
        let desc = params.get("error_description").map(|s| s.as_str()).unwrap_or("");
        return Err(format!("{err}: {desc}"));
    }

    let code = params.get("code").ok_or("missing code")?.clone();
    let ret_state = params.get("state").ok_or("missing state")?.clone();
    let pending = state.pending_auth.lock().unwrap().take().ok_or("no pending auth")?;

    if ret_state != pending.csrf_state { return Err("CSRF mismatch".into()); }

    #[derive(Deserialize)]
    struct TokenResponse { access_token: String, refresh_token: Option<String>, id_token: Option<String> }

    let client = reqwest::Client::new();
    let resp = client
        .post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .form(&[("client_id", CLIENT_ID), ("code", &code), ("redirect_uri", REDIRECT_URI),
                ("grant_type", "authorization_code"), ("code_verifier", &pending.code_verifier)])
        .send().await.map_err(|e| e.to_string())?;

    let tokens: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    *state.tokens.lock().unwrap() = Some(TokenData {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    });

    #[derive(Deserialize)]
    struct IdClaims { name: Option<String>, email: Option<String>, preferred_username: Option<String> }

    let claims = tokens.id_token.as_deref()
        .and_then(|jwt| jwt.split('.').nth(1))
        .and_then(|p| {
            let rem = p.len() % 4;
            let padded = if rem == 0 { p.to_string() } else { format!("{p}{}", "=".repeat(4 - rem)) };
            URL_SAFE.decode(padded).ok()
        })
        .and_then(|b| serde_json::from_slice::<IdClaims>(&b).ok());

    let account = AccountInfo {
        name:  claims.as_ref().and_then(|c| c.name.clone()),
        email: claims.as_ref().and_then(|c| c.email.clone().or_else(|| c.preferred_username.clone())),
    };

    // Open the per-account database and swap it in
    let filename = db_filename(account.email.as_deref().unwrap_or("default"));
    let path = state.data_dir.join(&filename);
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    db::init(&conn).map_err(|e| e.to_string())?;
    *state.db.lock().unwrap() = conn;

    Ok(account)
}

// ---------------------------------------------------------------------------
// Email commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn sync_emails(state: State<'_, AppState>) -> Result<SyncResult, String> {
    let token = state.tokens.lock().unwrap().as_ref().map(|t| t.access_token.clone())
        .ok_or("not authenticated")?;

    let lookback_days: i64 = {
        let db = state.db.lock().unwrap();
        db::get_all_settings(&db).ok()
            .and_then(|s| s.get("lookback_days").and_then(|v| v.parse().ok()))
            .unwrap_or(7)
    };

    let (inbox, sent, drafts) = graph::fetch_all_folders(&token, lookback_days).await?;
    let count = inbox.len() + sent.len() + drafts.len();

    let db = state.db.lock().unwrap();
    db::upsert_emails(&db, &inbox,  "inbox").map_err(|e| e.to_string())?;
    db::upsert_emails(&db, &sent,   "sent").map_err(|e| e.to_string())?;
    db::upsert_emails(&db, &drafts, "drafts").map_err(|e| e.to_string())?;
    db::set_setting(&db, "last_synced_at", &Utc::now().to_rfc3339()).map_err(|e| e.to_string())?;

    Ok(SyncResult { emails_synced: count })
}

#[tauri::command]
fn list_emails(state: State<AppState>) -> Result<Vec<db::EmailRow>, String> {
    db::list_emails(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_emails_by_folder(folder: String, state: State<AppState>) -> Result<Vec<db::EmailRow>, String> {
    db::list_emails_by_folder(&state.db.lock().unwrap(), &folder).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_email_row(id: String, state: State<AppState>) -> Result<Option<db::EmailRow>, String> {
    db::get_email_row(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_email_body(id: String, state: State<AppState>) -> Result<Option<String>, String> {
    db::get_email_body(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn mark_email_read(id: String, state: State<AppState>) -> Result<(), String> {
    db::mark_email_read(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn mark_email_completed(id: String, completed: bool, state: State<AppState>) -> Result<(), String> {
    db::mark_email_completed(&state.db.lock().unwrap(), &id, completed).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_home_stats(state: State<AppState>) -> Result<db::HomeStats, String> {
    db::get_home_stats(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_analyzed_emails(state: State<AppState>) -> Result<Vec<db::AnalyzedCard>, String> {
    db::list_analyzed_emails(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn seed_test_emails(state: State<AppState>) -> Result<(), String> {
    db::seed_test_emails(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<HashMap<String, String>, String> {
    db::get_all_settings(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(key: String, value: String, state: State<AppState>) -> Result<(), String> {
    db::set_setting(&state.db.lock().unwrap(), &key, &value).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Writing template commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_writing_templates(state: State<AppState>) -> Result<Vec<db::WritingTemplate>, String> {
    db::list_writing_templates(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_writing_template(id: Option<String>, name: String, instructions: String, state: State<AppState>) -> Result<db::WritingTemplate, String> {
    let tid = id.unwrap_or_else(|| new_id());
    db::upsert_writing_template(&state.db.lock().unwrap(), &tid, &name, &instructions).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_writing_template(id: String, state: State<AppState>) -> Result<(), String> {
    db::delete_writing_template(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Conversation commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_conversations(state: State<AppState>) -> Result<Vec<db::ConversationRow>, String> {
    db::list_conversations(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_conversation(title: String, email_id: Option<String>, state: State<AppState>) -> Result<db::ConversationRow, String> {
    db::create_conversation(&state.db.lock().unwrap(), &new_id(), &title, email_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_conversation_messages(id: String, state: State<AppState>) -> Result<Vec<db::ConversationMessage>, String> {
    db::get_conversation_messages(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_conversation(id: String, title: String, state: State<AppState>) -> Result<(), String> {
    db::rename_conversation(&state.db.lock().unwrap(), &id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_chat_stream(state: State<'_, AppState>) {
    state.cancel_chat.store(true, Ordering::Relaxed);
}

/// Uses the currently configured Ollama model to generate a short title for a
/// new conversation from its first message. Runs with thinking disabled so it
/// returns in ~1-2 seconds and doesn't block the UI.
#[tauri::command]
async fn generate_conversation_title(
    first_message: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let model = {
        let db = state.db.lock().unwrap();
        db::get_all_settings(&db)
            .unwrap_or_default()
            .remove("ollama_model")
            .unwrap_or_else(|| "llama3.2:3b".to_string())
    };
    ollama::generate_title(&model, &first_message).await
}

#[tauri::command]
fn delete_conversation(id: String, state: State<AppState>) -> Result<(), String> {
    db::delete_conversation(&state.db.lock().unwrap(), &id).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
struct ChatStreamEvent { conv_id: String, text: String }

/// Saves the user message, streams the assistant reply from Ollama (emitting
/// `chat_stream` events as tokens arrive), then saves and returns the
/// completed assistant message.
#[tauri::command]
async fn send_chat_message(
    conv_id: String,
    content: String,
    model: String,
    think: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<db::ConversationMessage, String> {
    // 1. Persist user turn
    {
        let db = state.db.lock().unwrap();
        db::add_message(&db, &conv_id, "user", &content).map_err(|e| e.to_string())?;
    }

    // 2. Load the full history (including the message we just saved)
    let history: Vec<(String, String)> = {
        let db = state.db.lock().unwrap();
        db::get_conversation_messages(&db, &conv_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| (m.role, m.content))
            .collect()
    };

    // 3. Stream the assistant reply
    let app2     = app.clone();
    let conv_id2 = conv_id.clone();
    let cancel   = Arc::clone(&state.cancel_chat);
    cancel.store(false, Ordering::Relaxed);
    let response = ollama::chat_with_history(
        &model,
        "You are a helpful AI assistant.",
        &history,
        think,
        move |full_text| {
            let _ = app2.emit("chat_stream", ChatStreamEvent {
                conv_id: conv_id2.clone(),
                text: full_text,
            });
        },
        move || cancel.load(Ordering::Relaxed),
    ).await?;

    // 4. Persist assistant turn and return it so the frontend can commit the bubble
    let assistant_msg = {
        let db = state.db.lock().unwrap();
        db::add_message(&db, &conv_id, "assistant", &response).map_err(|e| e.to_string())?
    };

    Ok(assistant_msg)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strip HTML tags and decode common entities, then collapse whitespace.
/// Keeps text content only — prevents huge HTML email bodies from blowing
/// up the model's context window.
fn strip_html(html: &str) -> String {
    // Remove <style> and <script> blocks entirely (content is not readable text)
    let mut s = String::from(html);
    for tag in &["style", "script", "head"] {
        loop {
            let open  = format!("<{tag}");
            let close = format!("</{tag}>");
            let start = s.to_lowercase().find(&open);
            let end   = s.to_lowercase().find(&close).map(|i| i + close.len());
            match (start, end) {
                (Some(a), Some(b)) if b > a => { s.replace_range(a..b, ""); }
                _ => break,
            }
        }
    }
    // Remove remaining tags
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Decode common HTML entities
    let out = out
        .replace("&nbsp;",  " ")
        .replace("&amp;",   "&")
        .replace("&lt;",    "<")
        .replace("&gt;",    ">")
        .replace("&quot;",  "\"")
        .replace("&#39;",   "'")
        .replace("&apos;",  "'");
    // Collapse runs of whitespace / blank lines down to two newlines max
    let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Analysis commands
// ---------------------------------------------------------------------------

// Emitted whenever a single email fails to analyze (parse error, timeout, model error)
#[derive(Serialize, Clone)]
struct AnalysisError {
    email_id: String,
    subject:  String,
    error:    String,
}

// Emitted once per email being processed + once when the whole queue is done
#[derive(Serialize, Clone)]
struct AnalysisProgress {
    processed:        usize,
    total:            usize,
    current_email_id: Option<String>,
    current_subject:  Option<String>,
    current_model:    Option<String>,
    done:             bool,
    stopped:          bool,
    error:            Option<String>,
}

// Emitted periodically with the full accumulated stream text for the current email
#[derive(Serialize, Clone)]
struct AnalysisStreamEvent {
    email_id: String,
    text:     String,   // full accumulated text so far (not a delta)
}

// Emitted after each attempt when debug mode is enabled
#[derive(Serialize, Clone)]
struct AnalysisDebugEvent {
    email_id:   String,
    attempt:    usize,
    raw_output: String,
}

#[tauri::command]
async fn start_analysis(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut flag = state.is_analyzing.lock().unwrap();
        if *flag { return Err("Analysis already in progress".into()); }
        *flag = true;
    }
    *state.stop_requested.lock().unwrap() = false;

    if let Err(e) = ollama::ping().await {
        *state.is_analyzing.lock().unwrap() = false;
        return Err(e);
    }

    let (model, debug_mode, extra_instructions) = {
        let db = state.db.lock().unwrap();
        let settings = db::get_all_settings(&db).ok().unwrap_or_default();
        let model = settings.get("ollama_model").cloned().unwrap_or_default();
        let debug = settings.get("debug_mode").map(|v| v == "true").unwrap_or(false);
        let instr = db::get_active_template_instructions(&db).ok().flatten();
        (model, debug, instr)
    };

    if model.is_empty() {
        *state.is_analyzing.lock().unwrap() = false;
        return Err("No model selected — go to Settings and pick an Ollama model.".into());
    }

    match ollama::get_available_models().await {
        Ok(models) => {
            if !models.iter().any(|m| m == &model) {
                *state.is_analyzing.lock().unwrap() = false;
                return Err(format!(
                    "Model '{model}' is not installed. Run: ollama pull {model}\nInstalled: {}",
                    if models.is_empty() { "none".into() } else { models.join(", ") }
                ));
            }
        }
        Err(e) => {
            *state.is_analyzing.lock().unwrap() = false;
            return Err(e);
        }
    }

    let queue = {
        let db = state.db.lock().unwrap();
        db::get_unanalyzed_emails(&db).map_err(|e| e.to_string())?
    };

    let total = queue.len();

    if total == 0 {
        *state.is_analyzing.lock().unwrap() = false;
        let _ = app.emit("analysis_progress", AnalysisProgress {
            processed: 0, total: 0,
            current_email_id: None, current_subject: Some("All emails already analyzed".into()),
            current_model: None, done: true, stopped: false, error: None,
        });
        return Ok(());
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<AppState>();

        // ── Inner async block ────────────────────────────────────────────────
        // Doing the work inside a separate block means the cleanup code below
        // ALWAYS runs regardless of how the inner block exits (early return,
        // error, or even if Tokio catches a panic in a future poll).
        let (success_count, last_error, stopped) = async {
            let mut success_count: usize = 0;
            let mut last_error: Option<String> = None;

            for (i, item) in queue.iter().enumerate() {
                // Check stop flag before each email
                if *state.stop_requested.lock().unwrap_or_else(|e| e.into_inner()) {
                    return (success_count, last_error, true);
                }

                // Signal: starting this email
                let _ = app2.emit("analysis_progress", AnalysisProgress {
                    processed: i, total,
                    current_email_id: Some(item.id.clone()),
                    current_subject:  Some(item.subject.clone()),
                    current_model:    Some(model.clone()),
                    done: false, stopped: false, error: None,
                });

                let app3 = app2.clone();
                let app4 = app2.clone();
                let email_id_for_stream = item.id.clone();
                let email_id_for_debug  = item.id.clone();
                let mut call_count = 0usize;

                // Per-email timeout: if the model hangs, skip after 3 minutes
                let analysis = tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    ollama::analyze_email(
                        &model,
                        &item.from_name,
                        &item.from_address,
                        &item.subject,
                        &item.body,
                        extra_instructions.as_deref(),
                        debug_mode,
                        move |full_text| {
                            call_count += 1;
                            if call_count % 5 == 0 {
                                let _ = app3.emit("analysis_stream", AnalysisStreamEvent {
                                    email_id: email_id_for_stream.clone(),
                                    text: full_text,
                                });
                            }
                        },
                        move |attempt, raw_output| {
                            let _ = app4.emit("analysis_debug", AnalysisDebugEvent {
                                email_id: email_id_for_debug.clone(),
                                attempt,
                                raw_output,
                            });
                        },
                    ),
                ).await;

                match analysis {
                    Ok(Ok(result)) => {
                        // Emit the final formatted text
                        let _ = app2.emit("analysis_stream", AnalysisStreamEvent {
                            email_id: item.id.clone(),
                            text: format!(
                                "priority: {}\n\nreasoning: {}\n\nsuggested response:\n{}",
                                result.priority, result.reasoning, result.suggested_response
                            ),
                        });
                        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        if db::save_analysis(
                            &db, &item.id,
                            &result.priority, &result.reasoning,
                            &result.suggested_response, &model,
                        ).is_ok() {
                            success_count += 1;
                            last_error = None;
                        }
                    }
                    Ok(Err(e)) => {
                        eprintln!("[analysis] '{}' failed: {}", item.subject, e);
                        let _ = app2.emit("analysis_error", AnalysisError {
                            email_id: item.id.clone(),
                            subject:  item.subject.clone(),
                            error:    e.clone(),
                        });
                        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = db::save_analysis_error(&db, &item.id, &e);
                        last_error = Some(e);
                    }
                    Err(_) => {
                        let msg = "Timed out after 180s — model took too long on this email".to_string();
                        eprintln!("[analysis] timeout: '{}'", item.subject);
                        let _ = app2.emit("analysis_error", AnalysisError {
                            email_id: item.id.clone(),
                            subject:  item.subject.clone(),
                            error:    msg.clone(),
                        });
                        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = db::save_analysis_error(&db, &item.id, &msg);
                        last_error = Some(msg);
                    }
                }
            }

            (success_count, last_error, false)
        }.await;
        // ── End inner block — cleanup ALWAYS runs from here ─────────────────

        *state.is_analyzing.lock().unwrap_or_else(|e| e.into_inner()) = false;
        let _ = app2.emit("analysis_progress", AnalysisProgress {
            processed: success_count, total,
            current_email_id: None, current_subject: None,
            current_model: None, done: true, stopped, error: last_error,
        });
    });

    Ok(())
}

#[tauri::command]
fn stop_analysis(state: State<AppState>) {
    *state.stop_requested.lock().unwrap() = true;
}

#[tauri::command]
fn get_analysis_stats(state: State<AppState>) -> Result<db::AnalysisStats, String> {
    db::get_analysis_stats(&state.db.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_email_analysis(email_id: String, state: State<AppState>) -> Result<Option<db::AnalysisRow>, String> {
    db::get_email_analysis(&state.db.lock().unwrap(), &email_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_email_analysis_error(email_id: String, state: State<AppState>) -> Result<Option<db::AnalysisErrorRow>, String> {
    db::get_analysis_error(&state.db.lock().unwrap(), &email_id).map_err(|e| e.to_string())
}

/// Analyzes a single email immediately using the configured model.
/// Returns the saved AnalysisRow so the frontend can display it right away.
#[tauri::command]
async fn analyze_email_now(
    email_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<db::AnalysisRow, String> {
    if *state.is_analyzing.lock().unwrap() {
        return Err("A batch analysis is already running — wait for it to finish.".into());
    }

    let (model, debug_mode, extra_instructions) = {
        let db = state.db.lock().unwrap();
        let settings = db::get_all_settings(&db).ok().unwrap_or_default();
        let model = settings.get("ollama_model").cloned().unwrap_or_default();
        let debug = settings.get("debug_mode").map(|v| v == "true").unwrap_or(false);
        let instr = db::get_active_template_instructions(&db).ok().flatten();
        (model, debug, instr)
    };
    if model.is_empty() {
        return Err("No model selected — go to Settings and pick an Ollama model.".into());
    }

    let email = {
        let db = state.db.lock().unwrap();
        db::get_email_for_test(&db, &email_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Email not found".to_string())?
    };

    let clean_body = strip_html(&email.body);
    let eid_debug  = email_id.clone();
    let result = ollama::analyze_email(
        &model,
        &email.from_name,
        &email.from_address,
        &email.subject,
        &clean_body,
        extra_instructions.as_deref(),
        debug_mode,
        |_| {},
        move |attempt, raw_output| {
            let _ = app.emit("analysis_debug", AnalysisDebugEvent {
                email_id: eid_debug.clone(),
                attempt,
                raw_output,
            });
        },
    ).await.map_err(|e| {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let _ = db::save_analysis_error(&db, &email_id, &e);
        e
    })?;

    let db = state.db.lock().unwrap();
    db::save_analysis(
        &db, &email_id,
        &result.priority, &result.reasoning,
        &result.suggested_response, &model,
    ).map_err(|e| e.to_string())?;

    db::get_email_analysis(&db, &email_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Analysis not saved".to_string())
}

#[derive(Serialize, Clone)]
struct TestStreamEvent { text: String }

#[derive(Serialize)]
struct TestResult { elapsed_ms: u64, output: String }

/// Three test modes let you benchmark individual phases of email processing.
/// Emits `test_stream` events with the full accumulated text while running,
/// then returns the final text + wall-clock time in milliseconds.
#[tauri::command]
async fn test_analyze_email(
    email_id: String,
    mode: String,   // "summarize" | "extract" | "full"
    think: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<TestResult, String> {
    let model = {
        let db = state.db.lock().unwrap();
        db::get_all_settings(&db).ok()
            .and_then(|s| s.get("ollama_model").cloned())
            .unwrap_or_default()
    };
    if model.is_empty() {
        return Err("No model selected — go to Settings and pick an Ollama model.".into());
    }

    let email = {
        let db = state.db.lock().unwrap();
        db::get_email_for_test(&db, &email_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Email not found".to_string())?
    };

    let sender = if email.from_name.is_empty() { email.from_address.clone() }
                 else { format!("{} <{}>", email.from_name, email.from_address) };

    // Strip HTML so the model sees readable text, not thousands of tag tokens
    let clean_body = strip_html(&email.body);

    let (system, user_msg, _json_mode) = match mode.as_str() {
        "summarize" => (
            "You are a concise email assistant.".to_string(),
            format!(
                "Summarize this email in 2-3 sentences.\n\nFrom: {sender}\nSubject: {subject}\n\n{body}",
                subject = email.subject,
                body    = clean_body,
            ),
            false,
        ),
        "extract" => (
            "You are an email content extractor.".to_string(),
            format!(
                "Extract from this email:\n\
                 • Sender intent\n• Required action\n• Deadline\n• Tone\n• Key entities\n\n\
                 From: {sender}\nSubject: {subject}\n\n{body}",
                subject = email.subject,
                body    = clean_body,
            ),
            false,
        ),
        _ => (
            "You are an expert email assistant. Return only valid JSON.".to_string(),
            format!(
                "Return JSON with fields priority (low/medium/high), reasoning, suggested_response.\n\
                 From: {sender}\nSubject: {subject}\n\n{body}",
                subject = email.subject,
                body    = clean_body,
            ),
            true,
        ),
    };

    // Show the exact prompt in the stream box so you can inspect it
    let _ = app.emit("test_stream", TestStreamEvent {
        text: format!(
            "=== MODEL: {model} ===\n=== SYSTEM ===\n{system}\n=== USER ({} chars) ===\n{user_msg}\n=== WAITING FOR RESPONSE ===",
            user_msg.len()
        ),
    });

    let start = std::time::Instant::now();
    let app2  = app.clone();

    // Build the single user turn — same shape as send_chat_message uses
    let messages = vec![("user".to_string(), user_msg)];

    let output = ollama::chat_with_history(
        &model,
        &system,
        &messages,
        think,
        move |full_text| {
            let _ = app2.emit("test_stream", TestStreamEvent { text: full_text });
        },
        || false,
    ).await?;

    Ok(TestResult { elapsed_ms: start.elapsed().as_millis() as u64, output })
}

#[tauri::command]
async fn get_ollama_models() -> Result<Vec<String>, String> {
    ollama::get_available_models().await
}

/// Returns true if Ollama is reachable. Done in the backend (reqwest) rather
/// than a frontend fetch because WebView2 on Windows blocks plain-HTTP requests
/// to localhost from the app's web context.
#[tauri::command]
async fn check_ollama() -> bool {
    ollama::ping().await.is_ok()
}

/// Loads the model into Ollama's memory without generating any output.
/// Call this on startup and whenever the selected model changes so that
/// subsequent inference requests don't pay the cold-start penalty.
#[tauri::command]
async fn warmup_model(state: State<'_, AppState>) -> Result<(), String> {
    let model = {
        let db = state.db.lock().unwrap();
        db::get_all_settings(&db).ok()
            .and_then(|s| s.get("ollama_model").cloned())
            .unwrap_or_default()
    };
    if model.is_empty() {
        return Ok(()); // nothing to warm up
    }
    ollama::warmup_model(&model).await
}

#[tauri::command]
fn is_analyzing(state: State<AppState>) -> bool {
    *state.is_analyzing.lock().unwrap()
}

// ---------------------------------------------------------------------------
// Draft session commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct DraftSessionResult {
    conv: db::ConversationRow,
    is_new: bool,
}

/// Gets or creates a conversation linked to the given email for reply drafting.
/// Returns true if a draft conversation already exists for the given email.
#[tauri::command]
fn check_draft_session_exists(
    email_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    let exists = db::get_conversation_by_email_id(&db, &email_id)
        .map_err(|e| e.to_string())?
        .is_some();
    Ok(exists)
}

/// If a conversation already exists for this email, returns it with is_new=false.
/// Otherwise, creates a new conversation and seeds it with the initial_draft as
/// an assistant message, returning is_new=true.
#[tauri::command]
fn get_draft_session(
    email_id: String,
    subject: String,
    initial_draft: String,
    state: State<'_, AppState>,
) -> Result<DraftSessionResult, String> {
    let db = state.db.lock().unwrap();

    if let Some(conv) = db::get_conversation_by_email_id(&db, &email_id).map_err(|e| e.to_string())? {
        return Ok(DraftSessionResult { conv, is_new: false });
    }

    let title = format!("Reply draft: {subject}");
    let conv = db::create_conversation(&db, &new_id(), &title, Some(&email_id))
        .map_err(|e| e.to_string())?;

    let initial_msg = db::add_message(&db, &conv.id, "assistant", &initial_draft)
        .map_err(|e| e.to_string())?;
    let _ = db::set_current_draft_message(&db, &conv.id, initial_msg.id);

    Ok(DraftSessionResult { conv, is_new: true })
}

/// Sends a user message to the draft conversation and streams the assistant reply.
/// The email body is loaded from DB and used to build a reply-drafting system prompt.
#[tauri::command]
async fn send_draft_message(
    conv_id: String,
    email_id: String,
    content: String,
    model: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<db::ConversationMessage, String> {
    // Load email for context
    let email = {
        let db = state.db.lock().unwrap();
        db::get_email_for_test(&db, &email_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Email '{email_id}' not found"))?
    };

    let clean_body = strip_html(&email.body);

    let extra_instructions = {
        let db = state.db.lock().unwrap();
        db::get_active_template_instructions(&db).ok().flatten()
    };

    let style_section = match extra_instructions.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(instr) => format!("\n\nWriting style instructions:\n{instr}"),
        None => String::new(),
    };

    let system_prompt = format!(
        "You are an email writing assistant helping draft a reply to this email:\n\n\
         From: {from_name} <{from_address}>\n\
         Subject: {subject}\n\n\
         {clean_body}\n\n\
         When the user asks for changes, respond with ONLY the updated email body — \
         no explanations, no \"Here is the revised draft:\", no preamble, no markdown. \
         Just the email text itself.{style_section}",
        from_name    = email.from_name,
        from_address = email.from_address,
        subject      = email.subject,
        clean_body   = clean_body,
        style_section = style_section,
    );

    // Persist user message
    {
        let db = state.db.lock().unwrap();
        db::add_message(&db, &conv_id, "user", &content).map_err(|e| e.to_string())?;
    }

    // Load full history
    let history: Vec<(String, String)> = {
        let db = state.db.lock().unwrap();
        db::get_conversation_messages(&db, &conv_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| (m.role, m.content))
            .collect()
    };

    // Stream response
    let app2      = app.clone();
    let conv_id2  = conv_id.clone();
    let cancel    = Arc::clone(&state.cancel_chat);
    cancel.store(false, Ordering::Relaxed);

    let response = ollama::chat_with_history(
        &model,
        &system_prompt,
        &history,
        Some(false), // no thinking for draft editing
        move |full_text| {
            let _ = app2.emit("chat_stream", ChatStreamEvent {
                conv_id: conv_id2.clone(),
                text: full_text,
            });
        },
        move || cancel.load(Ordering::Relaxed),
    ).await?;

    // Persist assistant message and mark it as current draft
    let assistant_msg = {
        let db = state.db.lock().unwrap();
        let msg = db::add_message(&db, &conv_id, "assistant", &response).map_err(|e| e.to_string())?;
        let _ = db::set_current_draft_message(&db, &conv_id, msg.id);
        msg
    };

    Ok(assistant_msg)
}

#[tauri::command]
fn set_current_draft(
    conv_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::set_current_draft_message(&db, &conv_id, message_id).map_err(|e| e.to_string())
}

/// Returns text + version/total for the current draft of an email's conversation.
#[tauri::command]
fn get_draft_info(
    email_id: String,
    state: State<'_, AppState>,
) -> Result<Option<db::DraftInfoResult>, String> {
    db::get_draft_info(&state.db.lock().unwrap(), &email_id).map_err(|e| e.to_string())
}

/// Resets the conversation's current draft pointer to the first (v1) assistant message.
#[tauri::command]
fn reset_draft_to_first(
    email_id: String,
    state: State<'_, AppState>,
) -> Result<Option<db::DraftInfoResult>, String> {
    db::reset_draft_to_first(&state.db.lock().unwrap(), &email_id).map_err(|e| e.to_string())
}

/// Saves text as a new draft version in the conversation for this email,
/// creating the conversation if one doesn't exist yet.
#[tauri::command]
fn save_inline_draft(
    email_id: String,
    subject: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<db::DraftInfoResult, String> {
    let db = state.db.lock().unwrap();
    let conv_id = match db::get_conversation_by_email_id(&db, &email_id).map_err(|e| e.to_string())? {
        Some(c) => c.id,
        None => {
            let title = format!("Reply draft: {subject}");
            db::create_conversation(&db, &new_id(), &title, Some(&email_id))
                .map_err(|e| e.to_string())?.id
        }
    };
    let msg = db::add_message(&db, &conv_id, "assistant", &text).map_err(|e| e.to_string())?;
    db::set_current_draft_message(&db, &conv_id, msg.id).map_err(|e| e.to_string())?;
    db::get_draft_info(&db, &email_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Draft info not found after save".to_string())
}

/// Updates an existing draft message's content in place.
/// Used by DraftEditor inline card edits so editing v2 stays v2, not v3.
#[tauri::command]
fn update_draft_message(
    message_id: i64,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::update_message_content(&db, message_id, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_conversation_info(
    conv_id: String,
    state: State<'_, AppState>,
) -> Result<Option<db::ConversationRow>, String> {
    let db = state.db.lock().unwrap();
    db::get_conversation_by_id(&db, &conv_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_create_reply_draft(
    email_id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let token = state.tokens.lock().unwrap().as_ref()
        .map(|t| t.access_token.clone())
        .ok_or("Not authenticated")?;
    graph::create_reply_draft(&token, &email_id, &body).await
}

#[tauri::command]
async fn graph_send_reply(
    email_id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let token = state.tokens.lock().unwrap().as_ref()
        .map(|t| t.access_token.clone())
        .ok_or("Not authenticated")?;
    graph::send_reply(&token, &email_id, &body).await
}

#[tauri::command]
fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
    // Clear auth tokens
    *state.tokens.lock().unwrap() = None;
    // Swap DB back to a fresh in-memory placeholder so no account data leaks
    let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
    *state.db.lock().unwrap() = placeholder;
    Ok(())
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only used on Windows/Linux where the single-instance plugin is added.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered FIRST. On Windows/Linux a deep link
    // (mailreader://auth?...) launches a *new* process; this routes it back to
    // the running instance so the OAuth callback reaches the open window. With
    // the `deep-link` feature, the URL is re-emitted to the existing onOpenUrl
    // listener automatically — we just focus the window here.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Start with an in-memory placeholder; swapped to per-account file after login
            let placeholder = Connection::open_in_memory().expect("in-memory db failed");
            app.manage(AppState {
                pending_auth:   Mutex::new(None),
                tokens:         Mutex::new(None),
                db:             Mutex::new(placeholder),
                data_dir,
                is_analyzing:   Mutex::new(false),
                stop_requested: Mutex::new(false),
                cancel_chat:    Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            start_microsoft_auth,
            complete_microsoft_auth,
            sign_out,
            sync_emails,
            list_emails,
            list_emails_by_folder,
            get_email_row,
            get_email_body,
            mark_email_read,
            mark_email_completed,
            get_home_stats,
            list_analyzed_emails,
            seed_test_emails,
            get_settings,
            set_setting,
            list_writing_templates,
            save_writing_template,
            delete_writing_template,
            list_conversations,
            create_conversation,
            get_conversation_messages,
            rename_conversation,
            delete_conversation,
            generate_conversation_title,
            cancel_chat_stream,
            send_chat_message,
            start_analysis,
            stop_analysis,
            get_analysis_stats,
            get_email_analysis,
            get_email_analysis_error,
            analyze_email_now,
            get_ollama_models,
            check_ollama,
            warmup_model,
            is_analyzing,
            test_analyze_email,
            check_draft_session_exists,
            get_draft_session,
            send_draft_message,
            set_current_draft,
            get_draft_info,
            reset_draft_to_first,
            save_inline_draft,
            update_draft_message,
            get_conversation_info,
            graph_create_reply_draft,
            graph_send_reply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
