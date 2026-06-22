use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};

const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

#[derive(Deserialize, Serialize)]
pub struct GraphMessage {
    pub id: String,
    pub subject: Option<String>,
    #[serde(rename = "bodyPreview")]
    pub body_preview: Option<String>,
    pub body: Option<MessageBody>,
    pub from: Option<Recipient>,
    #[serde(rename = "toRecipients")]
    pub to_recipients: Option<Vec<Recipient>>,
    #[serde(rename = "ccRecipients")]
    pub cc_recipients: Option<Vec<Recipient>>,
    #[serde(rename = "receivedDateTime")]
    pub received_at: String,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    pub importance: Option<String>,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct MessageBody {
    pub content: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Recipient {
    #[serde(rename = "emailAddress")]
    pub email_address: EmailAddress,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Deserialize)]
struct MessagesPage {
    value: Vec<GraphMessage>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

/// Fetch emails from a specific mail folder for the last `lookback_days` days.
/// `folder_path` is the Graph folder name: "inbox" or "sentItems".
async fn fetch_folder(
    client: &reqwest::Client,
    access_token: &str,
    folder_path: &str,
    lookback_days: i64,
) -> Result<Vec<GraphMessage>, String> {
    let since = (Utc::now() - Duration::days(lookback_days))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();

    let filter = format!("receivedDateTime ge {since}");
    let select = "id,subject,bodyPreview,body,from,toRecipients,ccRecipients,\
                  receivedDateTime,isRead,importance,hasAttachments,conversationId";

    let mut first_url = url::Url::parse(
        &format!("{GRAPH_BASE}/me/mailFolders/{folder_path}/messages")
    ).unwrap();
    first_url
        .query_pairs_mut()
        .append_pair("$filter", &filter)
        .append_pair("$select", select)
        .append_pair("$top", "100")
        .append_pair("$orderby", "receivedDateTime desc");

    let mut messages: Vec<GraphMessage> = Vec::new();
    let mut next: Option<String> = Some(first_url.to_string());
    let mut pages = 0;

    while let Some(url) = next {
        if pages >= 10 { break; }

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Prefer", r#"outlook.body-content-type="text""#)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph API {status}: {body}"));
        }

        let page: MessagesPage = resp.json().await.map_err(|e| e.to_string())?;
        next = page.next_link;
        messages.extend(page.value);
        pages += 1;
    }

    Ok(messages)
}

/// Fetch inbox + sent + drafts for the last `lookback_days` days.
/// Returns `(inbox, sent, drafts)`.
pub async fn fetch_all_folders(
    access_token: &str,
    lookback_days: i64,
) -> Result<(Vec<GraphMessage>, Vec<GraphMessage>, Vec<GraphMessage>), String> {
    let client = reqwest::Client::new();
    let inbox  = fetch_folder(&client, access_token, "inbox",      lookback_days).await?;
    let sent   = fetch_folder(&client, access_token, "sentItems",  lookback_days).await?;
    let drafts = fetch_folder(&client, access_token, "drafts",     lookback_days).await?;
    Ok((inbox, sent, drafts))
}

/// Create a reply draft in the user's mailbox for `message_id` with `body_text`.
/// Returns the Graph ID of the new draft message.
pub async fn create_reply_draft(
    access_token: &str,
    message_id: &str,
    body_text: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    struct ReplyPayload {
        comment: String,
    }

    let client = reqwest::Client::new();
    let url = format!("{GRAPH_BASE}/me/messages/{message_id}/createReply");

    let payload = ReplyPayload {
        comment: body_text.to_string(),
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Graph API {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct DraftResp { id: String }
    let draft: DraftResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(draft.id)
}

/// Send a reply to `message_id` with `body_text` immediately.
pub async fn send_reply(
    access_token: &str,
    message_id: &str,
    body_text: &str,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct ReplyPayload {
        comment: String,
    }

    let client = reqwest::Client::new();
    let url = format!("{GRAPH_BASE}/me/messages/{message_id}/reply");

    let payload = ReplyPayload {
        comment: body_text.to_string(),
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Graph API {status}: {body}"));
    }

    Ok(())
}
