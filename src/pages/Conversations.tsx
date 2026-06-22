import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ModelPicker, StylePicker } from "../components/ui";
import {
  SidebarIcon, DotsVerticalIcon, PencilIcon, ChatBubbleIcon,
  ArrowRightIcon, StopIcon, LightbulbIcon, CopyIcon, CheckIcon, FilePenIcon,
} from "../components/ui";
import { DraftEditor } from "./DraftEditor";

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  email_id: string | null;
  current_draft_message_id: number | null;
}

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

type ShowToast = (msg: string, type?: "error" | "success" | "info", duration?: number) => void;

export type { ConversationRow };

function formatConvDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });
  if (diffDays < 365) return date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function Conversations({
  showToast,
}: {
  showToast: ShowToast;
  onOpenDraftSession?: (conv: ConversationRow) => void;
}) {
  const [convs, setConvs]             = useState<ConversationRow[]>([]);
  const [selected, setSelected]       = useState<ConversationRow | null>(null);
  const [messages, setMessages]       = useState<ConversationMessage[]>([]);
  const [draft, setDraft]             = useState("");
  const [sending, setSending]         = useState(false);
  const [streamText, setStreamText]   = useState("");
  const [models, setModels]           = useState<string[]>([]);
  const [model, setModel]             = useState("");
  const [thinkOn, setThinkOn]         = useState(false); // simple on/off
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [copiedId, setCopiedId]       = useState<number | null>(null);

  // Draft conversation inline state
  const [draftEmailRow, setDraftEmailRow] = useState<{
    subject: string | null; from_name: string | null; from_address: string; received_at: string;
  } | null>(null);
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const [styleTemplates, setStyleTemplates] = useState<{ id: string; name: string }[]>([]);
  const [activeStyleId, setActiveStyleId]   = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch]           = useState("");

  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [menuOpen, setMenuOpen]         = useState(false);

  const menuRef       = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);
  const selectedRef   = useRef<ConversationRow | null>(null);
  selectedRef.current = selected;

  useEffect(() => {
    invoke<ConversationRow[]>("list_conversations").then(setConvs).catch(console.error);
    invoke<Record<string, string>>("get_settings").then(s => {
      setModel(s.ollama_model ?? "");
      setActiveStyleId(s.active_template_id ?? "");
    }).catch(console.error);
    invoke<string[]>("get_ollama_models").then(setModels).catch(() => {});
    invoke<{ id: string; name: string; instructions: string; created_at: string }[]>("list_writing_templates")
      .then(ts => setStyleTemplates(ts.map(t => ({ id: t.id, name: t.name }))))
      .catch(() => {});

    const unsub = listen<{ conv_id: string; text: string }>("chat_stream", e => {
      if (selectedRef.current?.id === e.payload.conv_id) {
        setStreamText(e.payload.text);
      }
    });
    return () => { unsub.then(fn => fn()); };
  }, []);

  // Close dots menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (editingTitle !== null) titleInputRef.current?.select();
  }, [editingTitle]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
  }

  async function selectConv(conv: ConversationRow) {
    setSelected(conv);
    setMessages([]);
    setStreamText("");
    setEditingTitle(null);
    setMenuOpen(false);
    setDraftEmailRow(null);
    setShowDraftEmail(false);

    if (conv.email_id !== null) {
      // Load email metadata for the inline draft editor
      invoke<{ subject: string | null; from_name: string | null; from_address: string; received_at: string } | null>(
        "get_email_row", { id: conv.email_id }
      ).then(row => {
        if (row) setDraftEmailRow(row);
      }).catch(() => {});
      return;
    }

    setLoadingMsgs(true);
    try {
      const msgs = await invoke<ConversationMessage[]>("get_conversation_messages", { id: conv.id });
      setMessages(msgs);
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function handleNew() {
    const conv = await invoke<ConversationRow>("create_conversation", { title: "New conversation" });
    setConvs(prev => [conv, ...prev]);
    setSelected(conv);
    setMessages([]);
    setStreamText("");
    setEditingTitle(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function handleDelete(conv: ConversationRow, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke("delete_conversation", { id: conv.id }).catch(console.error);
    setConvs(prev => prev.filter(c => c.id !== conv.id));
    if (selected?.id === conv.id) { setSelected(null); setMessages([]); }
  }

  async function applyTitle(convId: string, title: string) {
    const clean = title.trim() || "New conversation";
    await invoke("rename_conversation", { id: convId, title: clean }).catch(() => {});
    setConvs(prev => prev.map(c => c.id === convId ? { ...c, title: clean } : c));
    setSelected(prev => prev && prev.id === convId ? { ...prev, title: clean } : prev);
  }

  async function saveEditTitle() {
    if (editingTitle === null || !selected) return;
    const val = editingTitle;
    setEditingTitle(null);
    await applyTitle(selected.id, val);
  }

  function handleCopy(id: number, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(prev => prev === id ? null : prev), 2000);
  }

  async function handleSend() {
    if (!selected || !draft.trim() || sending || !model) return;
    const text = draft.trim();
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setSending(true);
    setStreamText("");

    const tempUserMsg: ConversationMessage = {
      id: -Date.now(), role: "user", content: text, created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUserMsg]);

    if (messages.length === 0 && selected.title === "New conversation") {
      const convId = selected.id;
      invoke<string>("generate_conversation_title", { firstMessage: text })
        .then(aiTitle => applyTitle(convId, aiTitle))
        .catch(() => applyTitle(convId, text.length > 46 ? text.slice(0, 46) + "…" : text));
    }

    try {
      const assistantMsg = await invoke<ConversationMessage>("send_chat_message", {
        convId: selected.id,
        content: text,
        model,
        think: thinkOn ? true : null,
      });
      setMessages(prev => [...prev, assistantMsg]);
      invoke<ConversationRow[]>("list_conversations").then(setConvs).catch(() => {});
    } catch (e) {
      showToast(String(e), "error", 8000);
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
    } finally {
      setSending(false);
      setStreamText("");
    }
  }

  async function handleSetStyle(id: string) {
    setActiveStyleId(id);
    await invoke("set_setting", { key: "active_template_id", value: id }).catch(() => {});
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  const filteredConvs = convs.filter(c =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );
  const canSend = !!selected && !!draft.trim() && !sending && !!model;

  return (
    <div className="conversations-layout page-enter">

      {/* ── Sidebar ── */}
      <aside className={`conv-sidebar ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="conv-sidebar-header">
          <span className="conv-sidebar-title">Chats</span>
          <button className="btn btn-sm btn-primary" onClick={handleNew}>+ New</button>
        </div>
        <div className="conv-search-wrap">
          <input
            type="text"
            className="conv-search-input"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="conv-list">
          {filteredConvs.length === 0 && (
            <p className="list-empty">{search ? "No results." : "No conversations yet."}</p>
          )}
          {filteredConvs.map(c => (
            <div
              key={c.id}
              className={`conv-item ${selected?.id === c.id ? "selected" : ""}`}
              onClick={() => selectConv(c)}
            >
              <div className="conv-item-row">
                <div className="conv-item-title">{c.title}</div>
                <div className="conv-item-date">{formatConvDate(c.updated_at)}</div>
              </div>
              <div className="conv-item-footer">
                {c.email_id !== null ? (
                  <span className="conv-draft-tag">draft</span>
                ) : (
                  <span className="conv-item-meta">{c.message_count} {c.message_count === 1 ? "msg" : "msgs"}</span>
                )}
                <button className="conv-delete-btn" onClick={e => handleDelete(c, e)} title="Delete">×</button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Chat area ── */}
      <div className="conv-main">
        {!selected ? (
          <>
            <div className="conv-main-topbar">
              <button className="conv-toggle-btn" onClick={() => setSidebarOpen(o => !o)} title={sidebarOpen ? "Close sidebar" : "Open sidebar"}>
                <SidebarIcon />
              </button>
            </div>
            <div className="conv-empty">
              <div className="conv-empty-card">
                <div className="conv-empty-icon"><ChatBubbleIcon /></div>
                <h3 className="conv-empty-title">No conversation selected</h3>
                <p className="conv-empty-desc">Pick one from the sidebar or start a new chat.</p>
                <button className="btn btn-primary" onClick={handleNew}>+ New conversation</button>
              </div>
            </div>
          </>
        ) : selected.email_id !== null ? (
          // ── Draft conversation: render DraftEditor inline ──
          <>
            <div className="conv-header">
              <div className="conv-header-left">
                <button className="conv-toggle-btn" onClick={() => setSidebarOpen(o => !o)} title={sidebarOpen ? "Close sidebar" : "Open sidebar"}>
                  <SidebarIcon />
                </button>
              </div>
              <div className="conv-header-center">
                <span className="conv-header-title" title={selected.title}>{selected.title}</span>
              </div>
              <div className="conv-header-right">
                {styleTemplates.length > 0 && (
                  <StylePicker styles={styleTemplates} value={activeStyleId} onChange={handleSetStyle} nav />
                )}
                {draftEmailRow && (
                  <button
                    className={`btn btn-sm draft-editor-email-toggle ${showDraftEmail ? "active" : ""}`}
                    onClick={() => setShowDraftEmail(v => !v)}
                    title={showDraftEmail ? "Hide original email" : "Show original email"}
                  >
                    <FilePenIcon />
                    {showDraftEmail ? "Hide email" : "Show email"}
                  </button>
                )}
              </div>
            </div>
            {draftEmailRow ? (
              <DraftEditor
                key={selected.id}
                emailId={selected.email_id}
                convId={selected.id}
                emailRow={draftEmailRow}
                showEmailByDefault={showDraftEmail}
                showToast={showToast}
                inline
              />
            ) : (
              <div className="conv-empty" style={{ flex: 1 }}>
                <div className="conv-loading">Loading…</div>
              </div>
            )}
          </>
        ) : (
          // ── Regular conversation ──
          <>
            <div className="conv-header">
              <div className="conv-header-left">
                <button className="conv-toggle-btn" onClick={() => setSidebarOpen(o => !o)} title={sidebarOpen ? "Close sidebar" : "Open sidebar"}>
                  <SidebarIcon />
                </button>
                <ModelPicker models={models} value={model} onChange={setModel} disabled={sending} nav />
              </div>

              <div className="conv-header-center">
                {editingTitle !== null ? (
                  <input
                    ref={titleInputRef}
                    className="conv-title-input"
                    value={editingTitle}
                    onChange={e => setEditingTitle(e.target.value)}
                    onBlur={saveEditTitle}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); saveEditTitle(); }
                      if (e.key === "Escape") setEditingTitle(null);
                    }}
                  />
                ) : (
                  <span className="conv-header-title" title={selected.title}>{selected.title}</span>
                )}

                <div className="conv-menu-wrap" ref={menuRef}>
                  <button
                    className="conv-menu-btn"
                    onClick={() => setMenuOpen(o => !o)}
                    title="Options"
                  >
                    <DotsVerticalIcon />
                  </button>
                  {menuOpen && (
                    <div className="conv-menu-dropdown">
                      <button
                        className="conv-menu-item"
                        onClick={() => { setEditingTitle(selected.title); setMenuOpen(false); }}
                      >
                        <PencilIcon /> Rename
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="conv-header-right" />
            </div>

            <div className="conv-messages">
              {loadingMsgs && <p className="conv-loading">Loading…</p>}
              {!loadingMsgs && messages.length === 0 && !sending && (
                <div className="conv-start-hint"><span>Start the conversation below</span></div>
              )}

              {messages.map(m => (
                <div key={m.id} className={`msg-row msg-row-${m.role}`}>
                  <div className="msg-content-wrap">
                    <div className={`msg-${m.role}`}>{m.content}</div>
                    <div className="msg-actions">
                      <button
                        className={`msg-copy-btn ${copiedId === m.id ? "copied" : ""}`}
                        onClick={() => handleCopy(m.id, m.content)}
                        title="Copy"
                      >
                        {copiedId === m.id ? <CheckIcon /> : <CopyIcon />}
                        <span>{copiedId === m.id ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {sending && (
                <div className="msg-row msg-row-assistant">
                  <div className="msg-content-wrap">
                    <div className="msg-assistant msg-streaming">
                      {streamText ? (
                        <>{streamText}<span className="msg-cursor" /></>
                      ) : (
                        <span className="msg-typing"><span /><span /><span /></span>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="conv-input-area">
              {!model && <div className="conv-no-model">No model selected — pick one in Settings or above.</div>}
              <div className="conv-input-box">
                <button
                  className={`conv-lightbulb-btn ${thinkOn ? "think-on" : ""}`}
                  onClick={() => setThinkOn(v => !v)}
                  title={thinkOn ? "Thinking: On (click to turn off)" : "Thinking: Off (click to turn on)"}
                  type="button"
                >
                  <LightbulbIcon />
                </button>

                <textarea
                  ref={inputRef}
                  className="conv-input-textarea"
                  rows={1}
                  placeholder="Message…"
                  value={draft}
                  onChange={handleDraftChange}
                  onKeyDown={handleKeyDown}
                  disabled={!model}
                />

                <div className="conv-input-actions">
                  {sending ? (
                    <button className="conv-stop-btn" onClick={() => invoke("cancel_chat_stream")} title="Stop generating">
                      <StopIcon />
                    </button>
                  ) : (
                    <button className="conv-send-btn-circle" onClick={handleSend} disabled={!canSend} title="Send (Enter)">
                      <ArrowRightIcon />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
