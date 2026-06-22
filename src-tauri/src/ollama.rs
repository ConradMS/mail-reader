use serde::{Deserialize, Serialize};
use serde_json::json;

const OLLAMA_BASE: &str = "http://localhost:11434";

/// Client with a short connect timeout but NO body-read timeout.
/// Reqwest's `.timeout()` on a RequestBuilder kills the *entire* response body
/// read, which terminates slow-model streams prematurely.
fn streaming_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest streaming client")
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

pub async fn ping() -> Result<(), String> {
    reqwest::Client::new()
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "Ollama is not running — start it with `ollama serve`".to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------

pub async fn get_available_models() -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct TagsResponse { models: Vec<ModelInfo> }
    #[derive(Deserialize)]
    struct ModelInfo { name: String }

    let resp = reqwest::Client::new()
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let tags: TagsResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

// ---------------------------------------------------------------------------
// Structured email analysis — streaming
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AnalysisResult {
    pub priority: String,           // "low" | "medium" | "high"
    pub reasoning: String,
    pub suggested_response: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    /// Either the string "json" or a JSON Schema object for structured output.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<serde_json::Value>,
    stream: bool,
    keep_alive: &'static str,
    /// Controls thinking mode on supported models (Qwen3, DeepSeek-R1, etc.).
    /// None = model default, Some(false) = /no_think, Some(true) = /think.
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
}

#[derive(Serialize, Clone)]
struct ChatMessage { role: String, content: String }

// ---------------------------------------------------------------------------
// Private helpers for analyze_email
// ---------------------------------------------------------------------------

/// Streams one Ollama chat request and returns the full accumulated response.
async fn stream_messages(
    model: &str,
    messages: Vec<ChatMessage>,
    schema: &serde_json::Value,
    on_token: &mut (dyn FnMut(String) + Send),
) -> Result<String, String> {
    #[derive(Serialize)]
    struct Req {
        model: String,
        messages: Vec<ChatMessage>,
        format: serde_json::Value,
        stream: bool,
        keep_alive: &'static str,
        think: bool,
    }
    #[derive(Deserialize)]
    struct StreamLine { message: Option<StreamMsg>, done: bool }
    #[derive(Deserialize)]
    struct StreamMsg { content: String }

    let req = Req {
        model: model.to_string(),
        messages,
        format: schema.clone(),
        stream: true,
        keep_alive: "24h",
        think: false,
    };

    let mut resp = streaming_client()
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Ollama connection error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama {status}: {body}"));
    }

    let mut accumulated = String::new();
    let mut line_buf    = String::new();

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        line_buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = line_buf.find('\n') {
            let raw = line_buf[..nl].trim().to_string();
            line_buf = line_buf[nl + 1..].to_string();
            if raw.is_empty() { continue; }
            if let Ok(item) = serde_json::from_str::<StreamLine>(&raw) {
                if let Some(msg) = item.message {
                    if !msg.content.is_empty() {
                        accumulated.push_str(&msg.content);
                        on_token(accumulated.clone());
                    }
                }
                if item.done { break; }
            }
        }
    }

    Ok(accumulated)
}

/// Strips markdown fences, extracts the outermost `{}`, escapes raw control
/// characters inside JSON strings, then parses into an `AnalysisResult`.
fn parse_json_output(accumulated: &str, subject: &str) -> Result<AnalysisResult, String> {
    // 1. Strip markdown code fences
    let stripped = {
        let t = accumulated.trim();
        let t = if t.starts_with("```") {
            t.trim_start_matches("```json")
             .trim_start_matches("```")
             .trim_end_matches("```")
             .trim()
        } else { t };
        t.to_string()
    };

    // 2. Extract outermost JSON object (handles <think> prefixes etc.)
    let json_str = match (stripped.find('{'), stripped.rfind('}')) {
        (Some(start), Some(end)) if end > start => stripped[start..=end].to_string(),
        _ => stripped.clone(),
    };

    // 3. Escape raw control characters inside JSON string values.
    //    JSON mode constrains structure but not content — a multi-paragraph
    //    suggested_response will contain literal newlines, which are invalid.
    let json_str = {
        let mut out = String::with_capacity(json_str.len() + 32);
        let mut in_string = false;
        let mut escaped   = false;
        for c in json_str.chars() {
            if escaped { out.push(c); escaped = false; continue; }
            if c == '\\' && in_string { out.push(c); escaped = true; continue; }
            if c == '"' { in_string = !in_string; out.push(c); continue; }
            if in_string && (c as u32) < 0x20 {
                match c {
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    other => { use std::fmt::Write; let _ = write!(out, "\\u{:04x}", other as u32); }
                }
            } else {
                out.push(c);
            }
        }
        out
    };

    // 4. Flexible intermediate — accepts any JSON value per field so a nested
    //    object for suggested_response still round-trips via coerce_string.
    #[derive(Deserialize)]
    struct RawAnalysis {
        #[serde(default)] priority:           serde_json::Value,
        #[serde(default)] reasoning:          serde_json::Value,
        #[serde(default)] suggested_response: serde_json::Value,
    }

    fn coerce_string(v: serde_json::Value) -> String {
        // Try to extract a string value from common model wrapping patterns
        // e.g. {"text": "..."}, {"value": "..."}, {"content": "..."}
        fn unwrap_object(obj: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
            for key in &["text", "value", "content", "response", "reply", "body"] {
                if let Some(serde_json::Value::String(s)) = obj.get(*key) {
                    return Some(s.clone());
                }
            }
            None
        }

        match v {
            serde_json::Value::String(s) => {
                // Some models embed a JSON object inside the string value.
                // If we find one, try to extract a text field; if we can't,
                // discard the JSON blob entirely and return empty so the
                // retry loop gets another chance rather than storing garbage.
                let trimmed = s.trim();
                if trimmed.starts_with('{') || trimmed.starts_with('[') {
                    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str(trimmed) {
                        return unwrap_object(&obj).unwrap_or_default();
                    }
                }
                s
            },
            serde_json::Value::Object(obj) => {
                // Model returned an object instead of a string — extract any text we can find.
                // If nothing useful, return empty rather than showing raw JSON.
                unwrap_object(&obj).unwrap_or_default()
            },
            serde_json::Value::Null => String::new(),
            other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
        }
    }

    let raw: RawAnalysis = serde_json::from_str(&json_str).map_err(|e| {
        eprintln!(
            "[analyze_email] JSON parse failed for '{}'\n  error    : {}\n  raw out  : {}\n  extracted: {}",
            subject, e, accumulated, json_str
        );
        format!("JSON parse error — see terminal for details. Error: {e}")
    })?;

    let priority_raw = coerce_string(raw.priority);
    let reasoning    = coerce_string(raw.reasoning);
    let suggested    = coerce_string(raw.suggested_response);

    if reasoning.is_empty() || suggested.is_empty() {
        eprintln!("[analyze_email] empty field(s) for '{}' — raw: {}", subject, accumulated);
        return Err(format!(
            "Model returned empty {} — the suggested_response must be plain email reply text, not JSON",
            if suggested.is_empty() { "suggested_response" } else { "reasoning" }
        ));
    }

    let priority = match priority_raw.to_lowercase().as_str() {
        "high" | "urgent" | "very_urgent" | "very urgent" => "high".into(),
        "low"  | "non_urgent" | "non-urgent" | "not urgent" => "low".into(),
        _ => "medium".into(),
    };

    Ok(AnalysisResult { priority, reasoning, suggested_response: suggested })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Calls Ollama with stream=true, retrying up to 3 times if JSON parsing fails.
/// On each attempt the bad output + parse error are fed back to the model so it
/// can self-correct.  When `debug` is true, `on_debug(attempt, raw_output)` is
/// called after every attempt so callers can surface the raw model output.
pub async fn analyze_email(
    model: &str,
    from_name: &str,
    from_address: &str,
    subject: &str,
    body: &str,
    extra_instructions: Option<&str>,
    debug: bool,
    mut on_token: impl FnMut(String) + Send,
    mut on_debug: impl FnMut(usize, String) + Send,
) -> Result<AnalysisResult, String> {
    let sender = if from_name.is_empty() { from_address } else { from_name };

    let prompt = format!(
        r#"Analyze this email and return a JSON object with exactly these three fields:

1. "priority": one of "low", "medium", or "high"
2. "reasoning": 1-2 sentences explaining the priority level
3. "suggested_response": the FULL TEXT of a professional email reply, written as plain prose — NOT a JSON object, NOT a boolean, NOT a code block. Write it exactly as you would type the reply, e.g. "Hi {sender}, Thank you for reaching out..."

Email to analyze:
From: {sender} <{from_address}>
Subject: {subject}

{body}

Return only the JSON object. The suggested_response field must contain the actual words of the email reply, nothing else."#
    );

    // JSON Schema enforces exact field names and the priority enum.
    let schema = json!({
        "type": "object",
        "properties": {
            "priority":           { "type": "string", "enum": ["low", "medium", "high"] },
            "reasoning":          { "type": "string" },
            "suggested_response": { "type": "string" }
        },
        "required": ["priority", "reasoning", "suggested_response"],
        "additionalProperties": false
    });

    let system_content = if let Some(instr) = extra_instructions.filter(|s| !s.trim().is_empty()) {
        format!(
            "You are an expert email assistant. Analyze emails and return structured JSON. \
             Respond with only the JSON object — no markdown, no code fences, no explanation.\n\n\
             Additional writing style instructions for suggested_response:\n{instr}"
        )
    } else {
        "You are an expert email assistant. Analyze emails and return structured JSON. \
         Respond with only the JSON object — no markdown, no code fences, no explanation.".into()
    };

    let system_msg = ChatMessage {
        role: "system".into(),
        content: system_content,
    };
    let user_msg = ChatMessage { role: "user".into(), content: prompt };

    let mut messages: Vec<ChatMessage> = vec![system_msg, user_msg];
    let mut last_error = String::new();

    for attempt in 1usize..=4 {
        let accumulated = stream_messages(model, messages.clone(), &schema, &mut on_token).await?;

        if debug {
            on_debug(attempt, accumulated.clone());
        }

        match parse_json_output(&accumulated, subject) {
            Ok(result) => return Ok(result),
            Err(e) => {
                eprintln!("[analyze_email] attempt {attempt}/4 parse failed for '{}': {}", subject, e);
                last_error = e.clone();
                if attempt < 4 {
                    messages.push(ChatMessage { role: "assistant".into(), content: accumulated });
                    messages.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Your previous response contained invalid JSON. Error: {e}\n\
                             Please respond with only a valid JSON object containing exactly these fields:\n\
                             - \"priority\": \"low\", \"medium\", or \"high\"\n\
                             - \"reasoning\": a string\n\
                             - \"suggested_response\": a string\n\
                             No markdown, no code fences, no explanation."
                        ),
                    });
                }
            }
        }
    }

    Err(format!("JSON parse failed after 4 attempts — see terminal for details. Last error: {last_error}"))
}

// ---------------------------------------------------------------------------
// Model warmup — loads model into VRAM without generating any tokens
// ---------------------------------------------------------------------------

/// POST /api/generate with no prompt.  Ollama interprets this as "load the
/// model into memory" and returns immediately without generating output.
/// Setting keep_alive to 24h means Ollama won't evict the model between
/// requests within the same app session.
pub async fn warmup_model(model: &str) -> Result<(), String> {
    // num_predict: 0  →  load the model weights, generate zero tokens, return immediately.
    // stream: false   →  single JSON response instead of an NDJSON stream.
    // Without these, Ollama treats an empty prompt as "generate from BOS" and
    // streams tokens indefinitely, blocking Ollama's inference slot.
    #[derive(Serialize)]
    struct WarmupOptions { num_predict: i32 }
    #[derive(Serialize)]
    struct WarmupReq<'a> {
        model: &'a str,
        prompt: &'static str,
        stream: bool,
        options: WarmupOptions,
        keep_alive: &'static str,
    }

    let resp = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{OLLAMA_BASE}/api/generate"))
        .json(&WarmupReq {
            model,
            prompt: "",
            stream: false,
            options: WarmupOptions { num_predict: 0 },
            keep_alive: "24h",
        })
        .send()
        .await
        .map_err(|e| format!("Warmup connection error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Warmup {status}: {body}"));
    }

    // Drain the single JSON response (done_reason: "load")
    let _ = resp.bytes().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Title generation — fast non-streaming single-shot call
// ---------------------------------------------------------------------------

/// Calls Ollama with stream=false to produce a short conversation title from
/// the first user message. Returns in ~1-2s since no tokens are streamed.
pub async fn generate_title(model: &str, first_message: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct TitleResp { message: TitleMsg }
    #[derive(Deserialize)]
    struct TitleMsg { content: String }

    let snippet: String = first_message.chars().take(300).collect();
    let prompt = format!(
        "Generate a short, descriptive title (3-6 words) for a chat that starts with:\n\"{snippet}\"\n\nReply with ONLY the title. No quotes, no trailing punctuation."
    );

    let req = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage { role: "system".into(), content: "You generate concise chat titles. Reply with only the title, 3-6 words.".into() },
            ChatMessage { role: "user".into(), content: prompt },
        ],
        format: None::<serde_json::Value>,
        stream: false,
        keep_alive: "24h",
        think: Some(false),
    };

    let resp = streaming_client()
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Ollama connection error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama {status}: {body}"));
    }

    let result: TitleResp = resp.json().await.map_err(|e| e.to_string())?;
    let title = result.message.content
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_end_matches('.')
        .to_string();

    Ok(if title.is_empty() { "New conversation".to_string() } else { title })
}

// ---------------------------------------------------------------------------
// Chat with full history — used by the Conversations tab
// ---------------------------------------------------------------------------

/// Sends a full message history to Ollama and streams the assistant reply.
/// Calls `on_token` with the full accumulated text after every chunk.
/// Returns the complete assistant response string.
pub async fn chat_with_history(
    model: &str,
    system: &str,
    messages: &[(String, String)],  // (role, content) ordered oldest-first
    think: Option<bool>,            // None = model default, false = no_think, true = force think
    mut on_token: impl FnMut(String) + Send,
    cancelled: impl Fn() -> bool + Send,
) -> Result<String, String> {
    let mut chat_messages: Vec<ChatMessage> = vec![
        ChatMessage { role: "system".into(), content: system.to_string() },
    ];
    chat_messages.extend(messages.iter().map(|(role, content)| ChatMessage {
        role: role.clone(),
        content: content.clone(),
    }));

    let req = ChatRequest {
        model: model.to_string(),
        messages: chat_messages,
        format: None::<serde_json::Value>,
        stream: true,
        keep_alive: "24h",
        think,
    };

    let mut resp = streaming_client()
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Ollama connection error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct StreamLine { message: Option<StreamMsg>, done: bool }
    #[derive(Deserialize)]
    struct StreamMsg {
        #[serde(default)]
        content: String,
        #[serde(default)]
        thinking: Option<String>,
    }

    let mut thinking_buf = String::new();   // accumulated thinking tokens
    let mut response_buf = String::new();   // accumulated response tokens
    let mut line_buf     = String::new();

    'outer: while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if cancelled() { break; }
        line_buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = line_buf.find('\n') {
            let raw = line_buf[..nl].trim().to_string();
            line_buf = line_buf[nl + 1..].to_string();
            if raw.is_empty() { continue; }
            if let Ok(item) = serde_json::from_str::<StreamLine>(&raw) {
                if let Some(msg) = item.message {
                    let mut changed = false;
                    if let Some(t) = msg.thinking.filter(|s| !s.is_empty()) {
                        thinking_buf.push_str(&t);
                        changed = true;
                    }
                    if !msg.content.is_empty() {
                        response_buf.push_str(&msg.content);
                        changed = true;
                    }
                    if changed {
                        let display = if thinking_buf.is_empty() {
                            response_buf.clone()
                        } else if response_buf.is_empty() {
                            format!("💭 Thinking…\n{thinking_buf}")
                        } else {
                            format!("💭 Thinking…\n{thinking_buf}\n\n---\n{response_buf}")
                        };
                        on_token(display);
                    }
                }
                if item.done { break 'outer; }
            }
        }
    }

    Ok(response_buf)
}

