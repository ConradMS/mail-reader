use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

use crate::graph::GraphMessage;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;

         CREATE TABLE IF NOT EXISTS emails (
             id               TEXT PRIMARY KEY,
             subject          TEXT,
             body_preview     TEXT,
             body             TEXT,
             from_address     TEXT NOT NULL DEFAULT '',
             from_name        TEXT,
             to_recipients    TEXT NOT NULL DEFAULT '[]',
             cc_recipients    TEXT NOT NULL DEFAULT '[]',
             received_at      TEXT NOT NULL,
             is_read          INTEGER NOT NULL DEFAULT 0,
             importance       TEXT NOT NULL DEFAULT 'normal',
             has_attachments  INTEGER NOT NULL DEFAULT 0,
             conversation_id  TEXT,
             folder           TEXT NOT NULL DEFAULT 'inbox',
             synced_at        TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_emails_received  ON emails(received_at DESC);
         CREATE INDEX IF NOT EXISTS idx_emails_folder    ON emails(folder, received_at DESC);
         CREATE INDEX IF NOT EXISTS idx_emails_conv      ON emails(conversation_id);

         CREATE TABLE IF NOT EXISTS conversations (
             id          TEXT PRIMARY KEY,
             title       TEXT NOT NULL,
             created_at  TEXT NOT NULL,
             updated_at  TEXT NOT NULL,
             email_id    TEXT REFERENCES emails(id)
         );

         CREATE TABLE IF NOT EXISTS conversation_messages (
             id                  INTEGER PRIMARY KEY AUTOINCREMENT,
             conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
             role                TEXT NOT NULL CHECK(role IN ('user','assistant')),
             content             TEXT NOT NULL,
             created_at          TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_conv_msg ON conversation_messages(conversation_id, created_at);

         CREATE TABLE IF NOT EXISTS settings (
             key    TEXT PRIMARY KEY,
             value  TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS sync_runs (
             id             INTEGER PRIMARY KEY AUTOINCREMENT,
             started_at     TEXT NOT NULL,
             completed_at   TEXT,
             emails_synced  INTEGER,
             error          TEXT
         );

         CREATE TABLE IF NOT EXISTS email_analysis (
             email_id            TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
             priority            TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
             reasoning           TEXT NOT NULL,
             suggested_response  TEXT NOT NULL,
             model_used          TEXT NOT NULL,
             analyzed_at         TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS email_analysis_errors (
             email_id    TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
             error       TEXT NOT NULL,
             occurred_at TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS writing_templates (
             id           TEXT PRIMARY KEY,
             name         TEXT NOT NULL,
             instructions TEXT NOT NULL,
             created_at   TEXT NOT NULL
         );",
    )?;

    // Seed default settings (no-op if already present)
    conn.execute_batch(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'dark');
         INSERT OR IGNORE INTO settings (key, value) VALUES ('lookback_days', '7');
         INSERT OR IGNORE INTO settings (key, value) VALUES ('ollama_model', '');
         UPDATE settings SET value = '' WHERE key = 'ollama_model' AND value = 'llama3.2:3b';",
    )?;

    // Migrations — ignore errors if column already exists
    let _ = conn.execute_batch(
        "ALTER TABLE emails ADD COLUMN is_completed INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE conversations ADD COLUMN current_draft_message_id INTEGER;",
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Email types + queries
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct EmailRow {
    pub id: String,
    pub subject: Option<String>,
    pub body_preview: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub received_at: String,
    pub is_read: bool,
    pub importance: String,
    pub has_attachments: bool,
    pub conversation_id: Option<String>,
    pub folder: String,
    pub is_completed: bool,
    pub analysis_priority: Option<String>,
}

#[derive(Serialize)]
pub struct HomeStats {
    pub total: i64,
    pub unread: i64,
    pub uncompleted: i64,
    pub high_priority: i64,
    pub normal_priority: i64,
    pub low_priority: i64,
}

pub fn get_home_stats(conn: &Connection) -> Result<HomeStats> {
    conn.query_row(
        "SELECT
             COUNT(*),
             SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END),
             SUM(CASE WHEN is_completed = 0 THEN 1 ELSE 0 END),
             SUM(CASE WHEN is_completed = 0 AND (SELECT a.priority FROM email_analysis a WHERE a.email_id = id) = 'high'   THEN 1 ELSE 0 END),
             SUM(CASE WHEN is_completed = 0 AND (SELECT a.priority FROM email_analysis a WHERE a.email_id = id) = 'medium' THEN 1 ELSE 0 END),
             SUM(CASE WHEN is_completed = 0 AND (SELECT a.priority FROM email_analysis a WHERE a.email_id = id) = 'low'    THEN 1 ELSE 0 END)
         FROM emails WHERE folder = 'inbox'",
        [],
        |row| {
            Ok(HomeStats {
                total:            row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                unread:           row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                uncompleted:      row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                high_priority:    row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                normal_priority:  row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                low_priority:     row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        },
    )
}

#[derive(Serialize)]
pub struct AnalyzedCard {
    pub id: String,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: String,
    pub received_at: String,
    pub is_read: bool,
    pub is_completed: bool,
    pub priority: String,
    pub suggested_response: String,
    pub conversation_id: Option<String>,
}

pub fn list_analyzed_emails(conn: &Connection) -> Result<Vec<AnalyzedCard>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.subject, e.from_name, e.from_address, e.received_at,
                e.is_read, e.is_completed, a.priority, a.suggested_response, e.conversation_id
         FROM emails e
         JOIN email_analysis a ON a.email_id = e.id
         WHERE e.folder = 'inbox' AND e.is_completed = 0
         ORDER BY
           CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           e.received_at DESC
         LIMIT 100",
    )?;
    let rows: Vec<AnalyzedCard> = stmt.query_map([], |row| {
        Ok(AnalyzedCard {
            id:                  row.get(0)?,
            subject:             row.get(1)?,
            from_name:           row.get(2)?,
            from_address:        row.get(3)?,
            received_at:         row.get(4)?,
            is_read:             row.get::<_, i32>(5)? != 0,
            is_completed:        row.get::<_, i32>(6)? != 0,
            priority:            row.get(7)?,
            suggested_response:  row.get(8)?,
            conversation_id:     row.get(9)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows)
}

pub fn list_emails_by_folder(conn: &Connection, folder: &str) -> Result<Vec<EmailRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.subject, e.body_preview, e.from_address, e.from_name,
                e.received_at, e.is_read, e.importance, e.has_attachments,
                e.conversation_id, e.folder, e.is_completed, a.priority
         FROM emails e
         LEFT JOIN email_analysis a ON a.email_id = e.id
         WHERE e.folder = ?1
         ORDER BY e.received_at DESC LIMIT 500",
    )?;
    let rows: Vec<EmailRow> = stmt.query_map(params![folder], email_row_from_row)?.collect::<Result<_>>()?;
    Ok(rows)
}

pub fn list_emails(conn: &Connection) -> Result<Vec<EmailRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.subject, e.body_preview, e.from_address, e.from_name,
                e.received_at, e.is_read, e.importance, e.has_attachments,
                e.conversation_id, e.folder, e.is_completed, a.priority
         FROM emails e
         LEFT JOIN email_analysis a ON a.email_id = e.id
         ORDER BY e.received_at DESC LIMIT 500",
    )?;
    let rows: Vec<EmailRow> = stmt.query_map([], email_row_from_row)?.collect::<Result<_>>()?;
    Ok(rows)
}

fn email_row_from_row(row: &rusqlite::Row) -> rusqlite::Result<EmailRow> {
    Ok(EmailRow {
        id:                row.get(0)?,
        subject:           row.get(1)?,
        body_preview:      row.get(2)?,
        from_address:      row.get(3)?,
        from_name:         row.get(4)?,
        received_at:       row.get(5)?,
        is_read:           row.get::<_, i32>(6)? != 0,
        importance:        row.get(7)?,
        has_attachments:   row.get::<_, i32>(8)? != 0,
        conversation_id:   row.get(9)?,
        folder:            row.get(10)?,
        is_completed:      row.get::<_, i32>(11)? != 0,
        analysis_priority: row.get(12)?,
    })
}

pub fn get_email_row(conn: &Connection, id: &str) -> Result<Option<EmailRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.subject, e.body_preview, e.from_address, e.from_name,
                e.received_at, e.is_read, e.importance, e.has_attachments,
                e.conversation_id, e.folder, e.is_completed, a.priority
         FROM emails e
         LEFT JOIN email_analysis a ON a.email_id = e.id
         WHERE e.id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], email_row_from_row)?;
    rows.next().transpose().map_err(Into::into)
}

pub fn get_email_body(conn: &Connection, id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT body FROM emails WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
}

pub fn mark_email_read(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE emails SET is_read = 1 WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn mark_email_completed(conn: &Connection, id: &str, completed: bool) -> Result<()> {
    conn.execute(
        "UPDATE emails SET is_completed = ?1 WHERE id = ?2",
        params![completed as i32, id],
    )?;
    Ok(())
}

pub fn upsert_emails(conn: &Connection, messages: &[GraphMessage], folder: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    for msg in messages {
        let from_address = msg.from.as_ref()
            .and_then(|f| f.email_address.address.clone())
            .unwrap_or_default();
        let from_name = msg.from.as_ref().and_then(|f| f.email_address.name.clone());
        let to_json = serde_json::to_string(&msg.to_recipients).unwrap_or_else(|_| "[]".into());
        let cc_json = serde_json::to_string(&msg.cc_recipients).unwrap_or_else(|_| "[]".into());
        let body = msg.body.as_ref().and_then(|b| b.content.clone());

        conn.execute(
            "INSERT INTO emails (
                 id, subject, body_preview, body,
                 from_address, from_name, to_recipients, cc_recipients,
                 received_at, is_read, importance, has_attachments,
                 conversation_id, folder, synced_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
                 subject      = excluded.subject,
                 body_preview = excluded.body_preview,
                 body         = excluded.body,
                 is_read      = excluded.is_read,
                 synced_at    = excluded.synced_at",
            params![
                msg.id, msg.subject, msg.body_preview, body,
                from_address, from_name, to_json, cc_json,
                msg.received_at, msg.is_read as i32,
                msg.importance.as_deref().unwrap_or("normal"),
                msg.has_attachments as i32,
                msg.conversation_id, folder, now,
            ],
        )?;
    }
    Ok(())
}

pub fn seed_test_emails(conn: &Connection) -> Result<()> {

    let now = Utc::now().to_rfc3339();
    let to = r#"[{"emailAddress":{"name":"Conrad Stanek","address":"conradstanektesting@outlook.com"}}]"#;

    type Row = (&'static str, &'static str, &'static str, &'static str, &'static str, bool, &'static str, bool, &'static str);
    let emails: &[Row] = &[
        ("test-001","URGENT: Contract renewal deadline tomorrow",
         "Hi, just a reminder that the contract with Acme Corp expires tomorrow at 5pm. I need your signature on the renewal document before EOD or we'll have a lapse in coverage. Please review and sign ASAP.",
         "sarah.johnson@acmecorp.com","Sarah Johnson",false,"high",false,"inbox"),
        ("test-002","Q3 planning sync — can you do Thursday?",
         "Hey, want to get 30 mins on the calendar to walk through the Q3 roadmap before we present to the team. Are you free Thursday afternoon? Let me know what works.",
         "mike.chen@company.com","Mike Chen",false,"normal",false,"inbox"),
        ("test-003","Updated budget spreadsheet for your review",
         "Hi, attached is the updated budget breakdown for next quarter. A few line items changed based on the conversation we had last week. No action needed right now, just wanted to loop you in.",
         "finance@company.com","Finance Team",true,"normal",true,"inbox"),
        ("test-004","Your weekly digest is ready",
         "Here's what happened this week in your industry. Top stories: market trends, new funding rounds, and a roundup of tools people are talking about.",
         "digest@weeklybrief.com","Weekly Brief",true,"low",false,"inbox"),
        ("test-005","Your invoice #4821 has been paid",
         "This is a confirmation that payment of $240.00 has been received for invoice #4821. Your account is up to date. Thank you for your business.",
         "billing@vendor.com","Billing System",true,"low",false,"inbox"),
        ("test-006","Re: Q3 planning sync",
         "Thursday 3pm works great for me. I'll send a calendar invite. Talk soon.",
         "conradstanektesting@outlook.com","You",true,"normal",false,"sent"),
    ];

    for (i, (id, subject, body, from_addr, from_name, is_read, importance, has_attach, folder)) in emails.iter().enumerate() {
        let received = (Utc::now() - chrono::Duration::hours(i as i64 * 4)).to_rfc3339();
        conn.execute(
            "INSERT INTO emails (id, subject, body_preview, body, from_address, from_name,
                 to_recipients, cc_recipients, received_at, is_read, importance,
                 has_attachments, conversation_id, folder, synced_at)
             VALUES (?1,?2,?3,?3,?4,?5,?6,'[]',?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO NOTHING",
            params![
                id, subject, body, from_addr, from_name, to,
                received, *is_read as i32, importance, *has_attach as i32,
                format!("conv-{id}"), folder, now,
            ],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn get_all_settings(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let map = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Writing templates
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct WritingTemplate {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub created_at: String,
}

pub fn list_writing_templates(conn: &Connection) -> Result<Vec<WritingTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, instructions, created_at FROM writing_templates ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| Ok(WritingTemplate {
            id:           row.get(0)?,
            name:         row.get(1)?,
            instructions: row.get(2)?,
            created_at:   row.get(3)?,
        }))?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn upsert_writing_template(conn: &Connection, id: &str, name: &str, instructions: &str) -> Result<WritingTemplate> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO writing_templates (id, name, instructions, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions",
        params![id, name, instructions, now],
    )?;
    conn.query_row(
        "SELECT id, name, instructions, created_at FROM writing_templates WHERE id = ?1",
        params![id],
        |row| Ok(WritingTemplate { id: row.get(0)?, name: row.get(1)?, instructions: row.get(2)?, created_at: row.get(3)? }),
    )
}

pub fn delete_writing_template(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM writing_templates WHERE id = ?1", params![id])?;
    Ok(())
}

/// Returns the instructions of the active template, or None if none is set/found.
pub fn get_active_template_instructions(conn: &Connection) -> Result<Option<String>> {
    let active_id: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'active_template_id'", [], |r| r.get(0))
        .ok();
    match active_id {
        None => Ok(None),
        Some(id) if id.is_empty() => Ok(None),
        Some(id) => {
            conn.query_row(
                "SELECT instructions FROM writing_templates WHERE id = ?1",
                params![id],
                |r| r.get(0),
            ).optional()
        }
    }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub email_id: Option<String>,
    pub current_draft_message_id: Option<i64>,
}

#[derive(Serialize)]
pub struct ConversationMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub fn add_message(conn: &Connection, conv_id: &str, role: &str, content: &str) -> Result<ConversationMessage> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO conversation_messages (conversation_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![conv_id, role, content, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![now, conv_id],
    )?;
    Ok(ConversationMessage { id, role: role.to_string(), content: content.to_string(), created_at: now })
}

pub fn rename_conversation(conn: &Connection, id: &str, title: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now, id],
    )?;
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.created_at, c.updated_at,
                COUNT(m.id) as message_count, c.email_id, c.current_draft_message_id
         FROM conversations c
         LEFT JOIN conversation_messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.updated_at DESC",
    )?;
    let rows: Vec<ConversationRow> = stmt.query_map([], |row| {
        Ok(ConversationRow {
            id:                        row.get(0)?,
            title:                     row.get(1)?,
            created_at:                row.get(2)?,
            updated_at:                row.get(3)?,
            message_count:             row.get(4)?,
            email_id:                  row.get(5)?,
            current_draft_message_id:  row.get(6)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows)
}

pub fn create_conversation(conn: &Connection, id: &str, title: &str, email_id: Option<&str>) -> Result<ConversationRow> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, email_id) VALUES (?1, ?2, ?3, ?3, ?4)",
        params![id, title, now, email_id],
    )?;
    Ok(ConversationRow {
        id: id.to_string(),
        title: title.to_string(),
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        email_id: email_id.map(|s| s.to_string()),
        current_draft_message_id: None,
    })
}

pub fn get_conversation_by_email_id(conn: &Connection, email_id: &str) -> Result<Option<ConversationRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.created_at, c.updated_at,
                COUNT(m.id) as message_count, c.email_id, c.current_draft_message_id
         FROM conversations c
         LEFT JOIN conversation_messages m ON m.conversation_id = c.id
         WHERE c.email_id = ?1
         GROUP BY c.id",
    )?;
    let rows: Vec<ConversationRow> = stmt.query_map(params![email_id], |row| {
        Ok(ConversationRow {
            id:                        row.get(0)?,
            title:                     row.get(1)?,
            created_at:                row.get(2)?,
            updated_at:                row.get(3)?,
            message_count:             row.get(4)?,
            email_id:                  row.get(5)?,
            current_draft_message_id:  row.get(6)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows.into_iter().next())
}

pub fn set_current_draft_message(conn: &Connection, conv_id: &str, message_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET current_draft_message_id = ?1 WHERE id = ?2",
        params![message_id, conv_id],
    )?;
    Ok(())
}

pub fn get_conversation_by_id(conn: &Connection, conv_id: &str) -> Result<Option<ConversationRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.created_at, c.updated_at,
                COUNT(m.id) as message_count, c.email_id, c.current_draft_message_id
         FROM conversations c
         LEFT JOIN conversation_messages m ON m.conversation_id = c.id
         WHERE c.id = ?1
         GROUP BY c.id",
    )?;
    let rows: Vec<ConversationRow> = stmt.query_map(params![conv_id], |row| {
        Ok(ConversationRow {
            id:                        row.get(0)?,
            title:                     row.get(1)?,
            created_at:                row.get(2)?,
            updated_at:                row.get(3)?,
            message_count:             row.get(4)?,
            email_id:                  row.get(5)?,
            current_draft_message_id:  row.get(6)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows.into_iter().next())
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/// A lightweight email record for the analysis queue (no heavy body loading).
pub struct AnalysisQueueItem {
    pub id: String,
    pub subject: String,
    pub body: String,
    pub from_name: String,
    pub from_address: String,
}

#[derive(Serialize, Clone)]
pub struct AnalysisRow {
    pub email_id: String,
    pub priority: String,
    pub reasoning: String,
    pub suggested_response: String,
    pub model_used: String,
    pub analyzed_at: String,
}

#[derive(Serialize)]
pub struct AnalysisStats {
    pub total: i64,
    pub analyzed: i64,
    pub pending: i64,
}

pub fn get_email_for_test(conn: &Connection, id: &str) -> Result<Option<AnalysisQueueItem>> {
    let mut stmt = conn.prepare(
        "SELECT id,
                COALESCE(subject, '(no subject)'),
                COALESCE(body, body_preview, ''),
                COALESCE(from_name, ''),
                from_address
         FROM emails WHERE id = ?1",
    )?;
    let rows: Vec<AnalysisQueueItem> = stmt.query_map(params![id], |row| {
        Ok(AnalysisQueueItem {
            id:           row.get(0)?,
            subject:      row.get(1)?,
            body:         row.get(2)?,
            from_name:    row.get(3)?,
            from_address: row.get(4)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows.into_iter().next())
}

pub fn get_unanalyzed_emails(conn: &Connection) -> Result<Vec<AnalysisQueueItem>> {
    let mut stmt = conn.prepare(
        "SELECT e.id,
                COALESCE(e.subject, '(no subject)'),
                COALESCE(e.body, e.body_preview, ''),
                COALESCE(e.from_name, ''),
                e.from_address
         FROM emails e
         LEFT JOIN email_analysis a ON a.email_id = e.id
         WHERE a.email_id IS NULL
           AND e.folder = 'inbox'
         ORDER BY e.received_at DESC",
    )?;
    let rows: Vec<AnalysisQueueItem> = stmt.query_map([], |row| {
        Ok(AnalysisQueueItem {
            id:           row.get(0)?,
            subject:      row.get(1)?,
            body:         row.get(2)?,
            from_name:    row.get(3)?,
            from_address: row.get(4)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows)
}

pub fn save_analysis(
    conn: &Connection,
    email_id: &str,
    priority: &str,
    reasoning: &str,
    suggested_response: &str,
    model_used: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO email_analysis
             (email_id, priority, reasoning, suggested_response, model_used, analyzed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(email_id) DO UPDATE SET
             priority           = excluded.priority,
             reasoning          = excluded.reasoning,
             suggested_response = excluded.suggested_response,
             model_used         = excluded.model_used,
             analyzed_at        = excluded.analyzed_at",
        params![email_id, priority, reasoning, suggested_response, model_used, now],
    )?;
    let _ = clear_analysis_error(conn, email_id);
    Ok(())
}

pub fn get_email_analysis(conn: &Connection, email_id: &str) -> Result<Option<AnalysisRow>> {
    let mut stmt = conn.prepare(
        "SELECT email_id, priority, reasoning, suggested_response, model_used, analyzed_at
         FROM email_analysis WHERE email_id = ?1",
    )?;
    let rows: Vec<AnalysisRow> = stmt.query_map(params![email_id], |row| {
        Ok(AnalysisRow {
            email_id:           row.get(0)?,
            priority:           row.get(1)?,
            reasoning:          row.get(2)?,
            suggested_response: row.get(3)?,
            model_used:         row.get(4)?,
            analyzed_at:        row.get(5)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows.into_iter().next())
}

// ---------------------------------------------------------------------------
// Analysis error persistence
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct AnalysisErrorRow {
    pub email_id:    String,
    pub error:       String,
    pub occurred_at: String,
}

pub fn save_analysis_error(conn: &Connection, email_id: &str, error: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO email_analysis_errors (email_id, error, occurred_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(email_id) DO UPDATE SET
             error       = excluded.error,
             occurred_at = excluded.occurred_at",
        params![email_id, error, now],
    )?;
    Ok(())
}

pub fn get_analysis_error(conn: &Connection, email_id: &str) -> Result<Option<AnalysisErrorRow>> {
    let mut stmt = conn.prepare(
        "SELECT email_id, error, occurred_at FROM email_analysis_errors WHERE email_id = ?1",
    )?;
    let rows: Vec<AnalysisErrorRow> = stmt.query_map(params![email_id], |row| {
        Ok(AnalysisErrorRow {
            email_id:    row.get(0)?,
            error:       row.get(1)?,
            occurred_at: row.get(2)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows.into_iter().next())
}

pub fn clear_analysis_error(conn: &Connection, email_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM email_analysis_errors WHERE email_id = ?1",
        params![email_id],
    )?;
    Ok(())
}

pub fn get_analysis_stats(conn: &Connection) -> Result<AnalysisStats> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM emails WHERE folder = 'inbox'", [], |r| r.get(0))?;
    let analyzed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM email_analysis
         WHERE email_id IN (SELECT id FROM emails WHERE folder = 'inbox')",
        [], |r| r.get(0))?;
    Ok(AnalysisStats { total, analyzed, pending: total - analyzed })
}

pub fn update_message_content(conn: &Connection, message_id: i64, content: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversation_messages SET content = ?1 WHERE id = ?2",
        params![content, message_id],
    )?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct DraftInfoResult {
    pub message_id: i64,
    pub text: String,
    pub version: i64,
    pub total: i64,
}

pub fn get_draft_info(conn: &Connection, email_id: &str) -> Result<Option<DraftInfoResult>> {
    let conv = match get_conversation_by_email_id(conn, email_id)? {
        Some(c) => c,
        None => return Ok(None),
    };
    let current_id = match conv.current_draft_message_id {
        Some(id) => id,
        None => return Ok(None),
    };
    let messages = get_conversation_messages(conn, &conv.id)?;
    let assistant_msgs: Vec<&ConversationMessage> = messages.iter().filter(|m| m.role == "assistant").collect();
    let total = assistant_msgs.len() as i64;
    if total == 0 { return Ok(None); }
    let version = assistant_msgs.iter().position(|m| m.id == current_id).map(|i| i as i64 + 1).unwrap_or(total);
    let text = messages.iter().find(|m| m.id == current_id).map(|m| m.content.clone()).unwrap_or_default();
    Ok(Some(DraftInfoResult { message_id: current_id, text, version, total }))
}

pub fn reset_draft_to_first(conn: &Connection, email_id: &str) -> Result<Option<DraftInfoResult>> {
    let conv = match get_conversation_by_email_id(conn, email_id)? {
        Some(c) => c,
        None => return Ok(None),
    };
    let messages = get_conversation_messages(conn, &conv.id)?;
    let first = messages.iter().find(|m| m.role == "assistant");
    match first {
        Some(msg) => {
            set_current_draft_message(conn, &conv.id, msg.id)?;
            get_draft_info(conn, email_id)
        }
        None => Ok(None),
    }
}

pub fn get_conversation_messages(conn: &Connection, conv_id: &str) -> Result<Vec<ConversationMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, created_at FROM conversation_messages
         WHERE conversation_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows: Vec<ConversationMessage> = stmt.query_map(params![conv_id], |row| {
        Ok(ConversationMessage {
            id:         row.get(0)?,
            role:       row.get(1)?,
            content:    row.get(2)?,
            created_at: row.get(3)?,
        })
    })?.collect::<Result<_>>()?;
    Ok(rows)
}
