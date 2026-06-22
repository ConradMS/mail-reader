import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ModelPicker, StylePicker } from "../components/ui";
import {
  ChevronLeftIcon, LightbulbIcon, ArrowRightIcon, StopIcon,
  CopyIcon, CheckIcon, FilePenIcon,
} from "../components/ui";

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface DraftEditorProps {
  emailId: string;
  convId: string;
  emailRow: {
    subject: string | null;
    from_name: string | null;
    from_address: string;
    received_at: string;
  };
  showEmailByDefault?: boolean;
  onApplyDraft?: (text: string) => void;
  onClose?: () => void;
  showToast: (msg: string, type?: "error" | "success" | "info", duration?: number) => void;
  /** When true, renders inline inside an existing layout (no overlay, no back button). */
  inline?: boolean;
}

interface DraftCardProps {
  version: number;
  content: string;
  isStreaming: boolean;
  streamText: string;
  isCurrent: boolean;
  onUseThisVersion?: () => void;
  onSave?: (text: string) => void;
}

function DraftCard({ version, content, isStreaming, streamText, isCurrent, onUseThisVersion, onSave }: DraftCardProps) {
  const [copied, setCopied] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editMode) setEditText(content);
  }, [content, editMode]);

  function handleCopy() {
    navigator.clipboard.writeText(isStreaming ? streamText : (editMode ? editText : content));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isStreaming && onSave) {
      // Capture caret position NOW, while the div's text node is still in the DOM.
      // caretRangeFromPoint works on real text nodes but not inside a <textarea>.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = document as any;
      let clickOffset = content.length;
      if (doc.caretRangeFromPoint) {
        const range = doc.caretRangeFromPoint(e.clientX, e.clientY);
        if (range?.startContainer.nodeType === Node.TEXT_NODE) {
          clickOffset = range.startOffset;
        }
      } else if (doc.caretPositionFromPoint) {
        const cp = doc.caretPositionFromPoint(e.clientX, e.clientY);
        if (cp) clickOffset = Math.min(cp.offset, content.length);
      }
      setEditMode(true);
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
        el.focus();
        el.setSelectionRange(clickOffset, clickOffset);
      }, 0);
    }
  }

  return (
    <div className={`draft-card ${isStreaming ? "draft-card-streaming" : ""} ${isCurrent ? "draft-card-current" : ""}`}>
      <div className={`draft-card-header ${isCurrent ? "draft-card-header-current" : ""}`}>
        <span className={`draft-card-version ${isCurrent ? "draft-card-version-current" : ""}`}>
          Draft v{version}
        </span>
        {isCurrent && !isStreaming && (
          <span className="draft-card-current-badge">✓ Current</span>
        )}
        {!isCurrent && !isStreaming && onUseThisVersion && (
          <button
            className="draft-card-set-current-btn"
            onClick={onUseThisVersion}
          >
            Use this version
          </button>
        )}
        <button
          className={`msg-copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title="Copy"
          style={{ fontSize: "0.72rem" }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <div
        className="draft-card-body"
        onClick={handleBodyClick}
        title={!isStreaming && onSave ? "Click to edit" : undefined}
      >
        {isStreaming ? (
          <>{streamText}<span className="msg-cursor" /></>
        ) : editMode ? (
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={e => {
              setEditText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = e.target.scrollHeight + "px";
            }}
            onBlur={() => { setEditMode(false); setEditText(content); }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          content
        )}
      </div>
      {editMode && (
        <div className="draft-card-edit-actions">
          <button
            className="draft-card-cancel-btn"
            onMouseDown={e => { e.preventDefault(); setEditText(content); setEditMode(false); }}
          >
            Cancel
          </button>
          <button
            className="draft-card-save-btn"
            onMouseDown={e => {
              e.preventDefault();
              if (onSave) onSave(editText);
              setEditMode(false);
            }}
          >
            Save draft
          </button>
        </div>
      )}
    </div>
  );
}

export function DraftEditor({ emailId, convId, emailRow, showEmailByDefault = true, onApplyDraft, onClose, showToast, inline = false }: DraftEditorProps) {
  const [emailBody, setEmailBody]       = useState<string | null>(null);
  const [messages, setMessages]         = useState<ConversationMessage[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [sending, setSending]           = useState(false);
  const [streamText, setStreamText]     = useState("");
  const [models, setModels]             = useState<string[]>([]);
  const [model, setModel]               = useState("");
  const [thinkOn, setThinkOn]           = useState(false);
  const [showEmail, setShowEmail]       = useState(showEmailByDefault);
  // In inline mode the parent controls show/hide via the showEmailByDefault prop
  useEffect(() => { if (inline) setShowEmail(showEmailByDefault); }, [showEmailByDefault, inline]);
  const [currentDraftId, setCurrentDraftId] = useState<number | null>(null);
  const [styleTemplates, setStyleTemplates] = useState<{ id: string; name: string }[]>([]);
  const [activeStyleId, setActiveStyleId]   = useState("");

  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const convIdRef = useRef(convId);
  convIdRef.current = convId;
  // Kept as refs so the unmount cleanup always sees the latest values.
  const messagesRef      = useRef<ConversationMessage[]>([]);
  messagesRef.current    = messages;
  const currentDraftIdRef = useRef<number | null>(null);
  currentDraftIdRef.current = currentDraftId;

  useEffect(() => {
    // Load email body
    invoke<string | null>("get_email_body", { id: emailId })
      .then(b => setEmailBody(b))
      .catch(() => {});

    // Load messages
    invoke<ConversationMessage[]>("get_conversation_messages", { id: convId })
      .then(setMessages)
      .catch(() => {});

    // Load current draft id
    invoke<{ current_draft_message_id: number | null } | null>("get_conversation_info", { convId })
      .then(info => { if (info) setCurrentDraftId(info.current_draft_message_id); })
      .catch(() => {});

    // Load models + settings + writing templates
    invoke<Record<string, string>>("get_settings")
      .then(s => {
        if (s.ollama_model) setModel(s.ollama_model);
        setActiveStyleId(s.active_template_id ?? "");
      })
      .catch(() => {});
    invoke<string[]>("get_ollama_models")
      .then(setModels)
      .catch(() => {});
    invoke<{ id: string; name: string; instructions: string; created_at: string }[]>("list_writing_templates")
      .then(ts => setStyleTemplates(ts.map(t => ({ id: t.id, name: t.name }))))
      .catch(() => {});

    // Listen for chat_stream events
    const unsub = listen<{ conv_id: string; text: string }>("chat_stream", e => {
      if (e.payload.conv_id === convIdRef.current) {
        setStreamText(e.payload.text);
      }
    });

    return () => { unsub.then(fn => fn()); };
  }, [emailId, convId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  // Auto-apply the current draft version to the inbox textarea whenever the editor
  // unmounts — covers Back button, nav tab clicks, and any other close path.
  // Uses refs so the cleanup always sees the latest messages / currentDraftId.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (onApplyDraft && currentDraftIdRef.current !== null) {
      const msg = messagesRef.current.find(m => m.id === currentDraftIdRef.current);
      if (msg) onApplyDraft(msg.content);
    }
  }, []);

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setChatInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleSend() {
    if (!chatInput.trim() || sending || !model) return;
    const text = chatInput.trim();
    setChatInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setSending(true);
    setStreamText("");

    const tempUserMsg: ConversationMessage = {
      id: -Date.now(), role: "user", content: text, created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUserMsg]);

    try {
      const assistantMsg = await invoke<ConversationMessage>("send_draft_message", {
        convId,
        emailId,
        content: text,
        model,
      });
      setMessages(prev => [
        ...prev.filter(m => m.id !== tempUserMsg.id),
        assistantMsg,
      ]);
      setCurrentDraftId(assistantMsg.id);
    } catch (e) {
      showToast(String(e), "error", 8000);
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
    } finally {
      setSending(false);
      setStreamText("");
    }
  }

  // Inline edit save: updates the existing message in place (no new version created).
  async function handleSaveInlineEdit(msgId: number, content: string) {
    try {
      await invoke("update_draft_message", { messageId: msgId, text: content });
      await invoke("set_current_draft", { convId, messageId: msgId });
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content } : m));
      setCurrentDraftId(msgId);
      if (onApplyDraft) onApplyDraft(content);
    } catch (e) {
      showToast(String(e), "error");
    }
  }

  // "Use this version": mark as current in DB + update inbox textarea. Stays open.
  async function handleUseThisVersion(msgId: number, content: string) {
    try {
      await invoke("set_current_draft", { convId, messageId: msgId });
      setCurrentDraftId(msgId);
      if (onApplyDraft) onApplyDraft(content);
    } catch (e) {
      showToast(String(e), "error");
    }
  }

  // Separate messages by role for DraftCard versioning
  const assistantMessages = messages.filter(m => m.role === "assistant");
  let assistantIndex = 0; // track index across render

  const canSend = !!chatInput.trim() && !sending && !!model;

  const title = emailRow.subject ? `Reply draft: ${emailRow.subject}` : "Reply draft";

  const emailPanel = showEmail && (
    <div className="draft-editor-email-panel">
      <div className="draft-email-meta-card">
        <div className="draft-email-meta-row">
          <span className="draft-email-meta-key">From</span>
          <span className="draft-email-meta-val">
            {emailRow.from_name
              ? `${emailRow.from_name} <${emailRow.from_address}>`
              : emailRow.from_address}
          </span>
        </div>
        <div className="draft-email-meta-row">
          <span className="draft-email-meta-key">Subject</span>
          <span className="draft-email-meta-val">{emailRow.subject ?? "(no subject)"}</span>
        </div>
        <div className="draft-email-meta-row">
          <span className="draft-email-meta-key">Date</span>
          <span className="draft-email-meta-val">
            {new Date(emailRow.received_at).toLocaleString()}
          </span>
        </div>
      </div>
      {emailBody != null ? (
        <div className="draft-email-body-text">{emailBody}</div>
      ) : (
        <div style={{ color: "var(--muted)", fontSize: "0.8rem" }}>Loading…</div>
      )}
    </div>
  );

  const chatPanel = (
    <div className="draft-editor-chat-panel">
      <div className="conv-messages" style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem" }}>
        {messages.length === 0 && !sending && (
          <div className="conv-start-hint">
            <span>Ask for changes to the draft below</span>
          </div>
        )}

        {messages.map(m => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="msg-row msg-row-user">
                <div className="msg-content-wrap">
                  <div className="msg-user">{m.content}</div>
                </div>
              </div>
            );
          }
          assistantIndex++;
          const idx = assistantIndex;
          const msgId = m.id;
          const isCurrent = currentDraftId === msgId;
          return (
            <DraftCard
              key={m.id}
              version={idx}
              content={m.content}
              isStreaming={false}
              streamText=""
              isCurrent={isCurrent}
              onUseThisVersion={!isCurrent ? () => handleUseThisVersion(msgId, m.content) : undefined}
              onSave={(text) => handleSaveInlineEdit(msgId, text)}
            />
          );
        })}

        {sending && (
          <DraftCard
            version={assistantMessages.length + 1}
            content=""
            isStreaming={true}
            streamText={streamText}
            isCurrent={false}
          />
        )}

        <div ref={bottomRef} />
      </div>

      <div className="conv-input-area">
        {!model && (
          <div className="conv-no-model">No model selected — pick one above.</div>
        )}
        <div className="conv-input-box">
          <button
            className={`conv-lightbulb-btn ${thinkOn ? "think-on" : ""}`}
            onClick={() => setThinkOn(v => !v)}
            title={thinkOn ? "Thinking: On" : "Thinking: Off"}
            type="button"
          >
            <LightbulbIcon />
          </button>

          <textarea
            ref={inputRef}
            className="conv-input-textarea"
            rows={1}
            placeholder="Ask for changes to the draft…"
            value={chatInput}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={!model}
          />

          <div className="conv-input-actions">
            {sending ? (
              <button
                className="conv-stop-btn"
                onClick={() => invoke("cancel_chat_stream")}
                title="Stop generating"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className="conv-send-btn-circle"
                onClick={handleSend}
                disabled={!canSend}
                title="Send (Enter)"
              >
                <ArrowRightIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  async function handleSetStyle(id: string) {
    setActiveStyleId(id);
    await invoke("set_setting", { key: "active_template_id", value: id }).catch(() => {});
  }

  const stylePicker = styleTemplates.length > 0 ? (
    <StylePicker styles={styleTemplates} value={activeStyleId} onChange={handleSetStyle} nav />
  ) : null;

  if (inline) {
    return (
      <div className="draft-editor-layout" style={{ flex: 1, overflow: "hidden" }}>
        {emailPanel}
        {chatPanel}
      </div>
    );
  }

  return (
    <div className="draft-editor-overlay">
      <div className="draft-editor-topbar">
        <button className="draft-editor-back-btn" onClick={onClose} title="Back">
          <ChevronLeftIcon />
          Back
        </button>
        <span className="draft-editor-title">{title}</span>
        {stylePicker}
        <button
          className={`btn btn-sm draft-editor-email-toggle ${showEmail ? "active" : ""}`}
          onClick={() => setShowEmail(v => !v)}
          title={showEmail ? "Hide original email" : "Show original email"}
        >
          <FilePenIcon />
          {showEmail ? "Hide email" : "Show email"}
        </button>
        <ModelPicker models={models} value={model} onChange={setModel} disabled={sending} nav />
      </div>

      <div className="draft-editor-layout">
        {emailPanel}
        {chatPanel}
      </div>
    </div>
  );
}
