import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  InboxTrayIcon, PaperPlaneIcon, FilePenIcon, UsersIcon,
  SearchIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  RefreshIcon, LightbulbIcon, CheckIcon, BotIcon, StylePicker,
} from "../components/ui";

interface EmailRow {
  id: string;
  subject: string | null;
  body_preview: string | null;
  from_address: string;
  from_name: string | null;
  received_at: string;
  is_read: boolean;
  importance: string;
  has_attachments: boolean;
  folder: string;
  is_completed: boolean;
  analysis_priority: string | null;
  conversation_id: string | null;
}

interface AnalysisRow {
  email_id: string;
  priority: string;
  reasoning: string;
  suggested_response: string;
  model_used: string;
  analyzed_at: string;
}

interface AnalysisStats { total: number; analyzed: number; pending: number }
interface SyncResult { emails_synced: number }

interface AnalysisProgress {
  processed: number;
  total: number;
  current_email_id: string | null;
  current_subject: string | null;
  current_model: string | null;
  done: boolean;
  stopped: boolean;
  error: string | null;
}

interface StreamEvent { email_id: string; text: string }
interface AnalysisErrorEvent { email_id: string; subject: string; error: string }
interface AnalysisDebugEvent { email_id: string; attempt: number; raw_output: string }

interface DraftSessionResult {
  conv: {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    message_count: number;
    email_id: string | null;
  };
  is_new: boolean;
}

type Folder = "inbox" | "sent" | "drafts";
type SortDir = "desc" | "asc";
type FilterPriority = "all" | "high" | "medium" | "low";

const FOLDERS: { id: Folder; label: string; Icon: React.FC }[] = [
  { id: "inbox",  label: "Inbox",  Icon: InboxTrayIcon },
  { id: "sent",   label: "Sent",   Icon: PaperPlaneIcon },
  { id: "drafts", label: "Drafts", Icon: FilePenIcon },
];

const PER_PAGE = 50;

// ── Email thread parsing ───────────────────────────────────────────────
// Outlook reply chains separate quoted messages with a long underscore line,
// usually followed by From/Sent/To/Subject headers. Split the raw body into
// distinct message segments so each prior email renders as its own block.
interface ThreadSegment {
  headers: { key: string; value: string }[];
  body: string;
}

function parseEmailThread(raw: string): ThreadSegment[] {
  const text = raw.replace(/\r\n/g, "\n");
  // Split on a line that is (mostly) underscores — the Outlook quote divider
  const parts = text.split(/\n_{5,}\s*\n?/);

  const headerKey = /^(From|Sent|To|Cc|Subject|Date):\s*(.*)$/;

  const segments = parts.map(part => {
    const lines = part.split("\n");
    const headers: { key: string; value: string }[] = [];
    let i = 0;
    // Consume a contiguous block of leading header lines
    while (i < lines.length) {
      const m = lines[i].match(headerKey);
      if (m) {
        headers.push({ key: m[1], value: m[2] });
        i++;
      } else if (headers.length > 0 && lines[i].trim() === "") {
        i++; // blank line terminates the header block
        break;
      } else {
        break;
      }
    }
    return { headers, body: lines.slice(i).join("\n").trim() };
  });

  return segments.filter(s => s.body || s.headers.length);
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 86400000)  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 604800000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1)   return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60)  return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 1)  return "1 hour ago";
  if (hrs < 24)   return `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

type ShowToast = (msg: string, type?: "error" | "success" | "info", duration?: number) => void;

interface OpenDraftSessionParams {
  convId: string;
  emailId: string;
  emailRow: {
    subject: string | null;
    from_name: string | null;
    from_address: string;
    received_at: string;
  };
  onApplyDraft?: (text: string) => void;
}

export function InboxPage({
  showToast,
  onOpenDraftSession,
}: {
  showToast: ShowToast;
  onOpenDraftSession: (params: OpenDraftSessionParams) => void;
}) {
  const [folder, setFolder]             = useState<Folder>("inbox");
  const [emails, setEmails]             = useState<EmailRow[]>([]);
  const [selected, setSelected]         = useState<EmailRow | null>(null);
  const [body, setBody]                 = useState<string | null>(null);
  const [analysis, setAnalysis]         = useState<AnalysisRow | null | undefined>(undefined);
  const [analysisError, setAnalysisError] = useState<{ error: string; occurred_at: string } | null | undefined>(undefined);
  const [syncing, setSyncing]           = useState(false);
  const [counts, setCounts]             = useState<Record<string, number>>({});
  const [analyzing, setAnalyzing]       = useState(false);
  const [analyzeMsg, setAnalyzeMsg]     = useState<string | null>(null);
  const [analyzingEmailId, setAnalyzingEmailId] = useState<string | null>(null);
  const [analyzeProgress, setAnalyzeProgress] = useState<{ processed: number; total: number; subject: string | null } | null>(null);
  const [analyzeErrors, setAnalyzeErrors]     = useState<Array<{ emailId: string; subject: string; error: string; time: string }>>([]);
  const [sending, setSending]                 = useState(false);
  const [draftingEmail, setDraftingEmail]     = useState(false);
  const [streamText, setStreamText]     = useState("");
  const [analyzingThis, setAnalyzingThis] = useState(false);

  // Writing style templates
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");

  // Draft response textarea state
  const [draftText, setDraftText]       = useState("");
  // Current draft version loaded from the conversation (takes precedence over analysis.suggested_response)
  const [savedDraftText, setSavedDraftText]     = useState<string | null>(null);
  const [savedDraftMsgId, setSavedDraftMsgId]   = useState<number | null>(null);
  const [draftVersionInfo, setDraftVersionInfo] = useState<{ version: number; total: number } | null>(null);
  const [hasUnsavedEdits, setHasUnsavedEdits]   = useState(false);
  const [hasDraftSession, setHasDraftSession]   = useState(false);

  // Topbar
  const [topbarExpanded, setTopbarExpanded] = useState(false);
  const [search, setSearch]                 = useState("");
  const [page, setPage]                     = useState(1);
  const [analysisStats, setAnalysisStats]   = useState<AnalysisStats | null>(null);
  const [lastSyncedAt, setLastSyncedAt]     = useState<Date | null>(null);
  const [, setTick]                         = useState(0);

  // Filters (in expanded panel)
  const [sortDir, setSortDir]               = useState<SortDir>("desc");
  const [filterPriority, setFilterPriority] = useState<FilterPriority>("all");
  const [completionFilter, setCompletionFilter] = useState<"all" | "uncompleted" | "completed">("all");

  const [debugMode, setDebugMode]   = useState(false);
  const [debugData, setDebugData]   = useState<Record<string, Array<{ attempt: number; raw: string }>>>({});
  const [debugOpen, setDebugOpen]   = useState(false);

  // Analysis panel UI state (session-level)
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(true);
  const [reasoningOpen, setReasoningOpen]         = useState(false);

  const streamRef    = useRef<HTMLDivElement>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);

  async function loadEmails(f: Folder) {
    const rows = await invoke<EmailRow[]>("list_emails_by_folder", { folder: f });
    setEmails(rows);
    setSelected(null);
    setBody(null);
    setAnalysis(undefined);
    setPage(1);
  }

  async function loadCounts() {
    const inbox = await invoke<EmailRow[]>("list_emails_by_folder", { folder: "inbox" });
    setCounts({ inbox: inbox.filter(e => !e.is_read).length, sent: 0 });
  }

  async function loadStats() {
    const stats = await invoke<AnalysisStats>("get_analysis_stats").catch(() => null);
    if (stats) setAnalysisStats(stats);
  }

  async function loadLastSynced() {
    const settings = await invoke<Record<string, string>>("get_settings").catch(() => ({} as Record<string, string>));
    const raw = settings["last_synced_at"];
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) setLastSyncedAt(d);
    }
  }

  useEffect(() => {
    loadEmails(folder);
    loadCounts();
    loadStats();
    loadLastSynced();
    invoke<boolean>("is_analyzing").then(v => setAnalyzing(v)).catch(() => {});
    invoke<Record<string, string>>("get_settings")
      .then(s => {
        setDebugMode(s.debug_mode === "true");
        setActiveTemplateId(s.active_template_id ?? "");
      })
      .catch(() => {});
    invoke<{ id: string; name: string; instructions: string; created_at: string }[]>("list_writing_templates")
      .then(ts => setTemplates(ts.map(t => ({ id: t.id, name: t.name }))))
      .catch(() => {});

    const ticker = setInterval(() => setTick(t => t + 1), 30000);

    const unlistenProgress = listen<AnalysisProgress>("analysis_progress", (e) => {
      const p = e.payload;
      if (p.done) {
        setAnalyzing(false);
        setAnalyzeMsg(null);
        setAnalyzingEmailId(null);
        setAnalyzeProgress(null);
        loadStats();
        loadEmails(folder).catch(() => {});
        if (p.stopped) {
          showToast("Analysis stopped", "info");
        } else if (p.error) {
          showToast(p.error, "error", 8000);
        } else if (p.total === 0) {
          showToast(p.current_subject ?? "All emails already analyzed", "info");
        } else {
          showToast(`Analyzed ${p.processed} of ${p.total} emails`, "success");
          if (selected) {
            invoke<AnalysisRow | null>("get_email_analysis", { emailId: selected.id })
              .then(a => { setAnalysis(a); })
              .catch(() => {});
          }
        }
      } else {
        setAnalyzing(true);
        setAnalyzingEmailId(p.current_email_id);
        setAnalyzeMsg(`${p.processed}/${p.total}: ${p.current_subject ?? "…"}`);
        setAnalyzeProgress({ processed: p.processed, total: p.total, subject: p.current_subject });
        if (p.current_email_id !== analyzingEmailId) setStreamText("");
      }
    });

    const unlistenStream = listen<StreamEvent>("analysis_stream", (e) => {
      setStreamText(e.payload.text);
    });

    const unlistenError = listen<AnalysisErrorEvent>("analysis_error", (e) => {
      const { email_id, subject, error } = e.payload;
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setAnalyzeErrors(prev => [...prev, { emailId: email_id, subject, error, time }]);
    });

    const unlistenDebug = listen<AnalysisDebugEvent>("analysis_debug", (e) => {
      const { email_id, attempt, raw_output } = e.payload;
      setDebugData(prev => ({
        ...prev,
        [email_id]: [...(prev[email_id] ?? []), { attempt, raw: raw_output }],
      }));
    });

    return () => {
      clearInterval(ticker);
      unlistenProgress.then(fn => fn());
      unlistenStream.then(fn => fn());
      unlistenError.then(fn => fn());
      unlistenDebug.then(fn => fn());
    };
  }, []);

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [streamText]);

  // Reset draft state when analysis or savedDraftText changes.
  // savedDraftText (the conversation's current_draft_message) takes precedence so the
  // textarea always shows the version the user last selected in the draft editor.
  useEffect(() => {
    if (analysis) {
      setDraftText(savedDraftText ?? analysis.suggested_response);
    } else {
      setDraftText(savedDraftText ?? "");
    }
  }, [analysis, savedDraftText]);

  // Auto-size draft textarea to content whenever text changes or panel re-opens
  useEffect(() => {
    if (!analysisPanelOpen) return;
    const el = draftTextareaRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    });
  }, [draftText, analysisPanelOpen]);

  async function switchFolder(f: Folder) {
    setFolder(f);
    setSearch("");
    await loadEmails(f);
  }

  async function selectEmail(email: EmailRow) {
    setSelected(email);
    setBody(null);
    setAnalysis(undefined);
    setAnalysisError(undefined);

    if (!email.is_read) {
      await invoke("mark_email_read", { id: email.id });
      setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: true } : e));
      setCounts(prev => ({ ...prev, inbox: Math.max(0, (prev.inbox ?? 0) - 1) }));
    }

    setHasDraftSession(false);
    setSavedDraftText(null);
    setSavedDraftMsgId(null);
    setDraftVersionInfo(null);
    setHasUnsavedEdits(false);
    const [b, a, err, hasDraft] = await Promise.all([
      invoke<string | null>("get_email_body", { id: email.id }),
      invoke<AnalysisRow | null>("get_email_analysis", { emailId: email.id }),
      invoke<{ error: string; occurred_at: string } | null>("get_email_analysis_error", { emailId: email.id }),
      invoke<boolean>("check_draft_session_exists", { emailId: email.id }),
    ]);
    setBody(b);
    setAnalysis(a);
    setAnalysisError(err);
    setHasDraftSession(hasDraft);

    // Load draft info so the textarea shows the right version (not always analysis.suggested_response).
    if (hasDraft) {
      const info = await invoke<{ message_id: number; text: string; version: number; total: number } | null>(
        "get_draft_info", { emailId: email.id }
      ).catch(() => null);
      if (info) {
        setSavedDraftText(info.text);
        setSavedDraftMsgId(info.message_id);
        setDraftVersionInfo({ version: info.version, total: info.total });
      }
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const r = await invoke<SyncResult>("sync_emails");
      setLastSyncedAt(new Date());
      await loadEmails(folder);
      await loadCounts();
      showToast(`Synced ${r.emails_synced} emails`, "success");
    } catch (e) {
      showToast(String(e), "error", 8000);
    } finally {
      setSyncing(false);
    }
  }

  async function handleSetActiveTemplate(id: string) {
    const newId = id === activeTemplateId ? "" : id;
    setActiveTemplateId(newId);
    await invoke("set_setting", { key: "active_template_id", value: newId }).catch(() => {});
  }

  async function handleAnalyze() {
    try {
      await invoke("start_analysis");
      setAnalyzing(true);
      setAnalyzeErrors([]);
    } catch (e) {
      showToast(String(e), "error", 8000);
      setAnalyzing(false);
    }
  }

  async function handleStop() {
    await invoke("stop_analysis").catch(console.error);
  }

  async function handleAnalyzeThis() {
    if (!selected || analyzingThis || analyzing) return;
    setAnalyzingThis(true);
    setAnalysis(undefined);
    setDebugData(prev => { const next = { ...prev }; delete next[selected.id]; return next; });
    setDebugOpen(false);
    setAnalysisError(undefined);
    try {
      const result = await invoke<AnalysisRow>("analyze_email_now", { emailId: selected.id });
      setAnalysis(result);
      setAnalysisError(null);
      setEmails(prev => prev.map(e =>
        e.id === selected.id ? { ...e, analysis_priority: result.priority } : e
      ));
      await loadStats();
      showToast("Analysis complete", "success");
    } catch (e) {
      showToast(String(e), "error", 8000);
      setAnalysis(null);
      const err = await invoke<{ error: string; occurred_at: string } | null>(
        "get_email_analysis_error", { emailId: selected.id }
      ).catch(() => null);
      setAnalysisError(err);
    } finally {
      setAnalyzingThis(false);
    }
  }

  async function handleToggleComplete() {
    if (!selected) return;
    const next = !selected.is_completed;
    await invoke("mark_email_completed", { id: selected.id, completed: next }).catch(console.error);
    setEmails(prev => prev.map(e => e.id === selected.id ? { ...e, is_completed: next } : e));
    setSelected(prev => prev ? { ...prev, is_completed: next } : null);
  }

  async function handleOpenDraftSession() {
    if (!selected) return;
    try {
      const result = await invoke<DraftSessionResult>("get_draft_session", {
        emailId: selected.id,
        subject: selected.subject ?? "(no subject)",
        initialDraft: draftText || (analysis?.suggested_response ?? ""),
      });
      setHasDraftSession(true);
      onOpenDraftSession({
        convId: result.conv.id,
        emailId: selected.id,
        emailRow: {
          subject: selected.subject,
          from_name: selected.from_name,
          from_address: selected.from_address,
          received_at: selected.received_at,
        },
        onApplyDraft: handleApplyDraft,
      });
    } catch (e) {
      showToast(String(e), "error", 8000);
    }
  }

  function handleApplyDraft(text: string) {
    setSavedDraftText(text);
    setHasUnsavedEdits(false);
    setAnalysisPanelOpen(true);
    if (selected) {
      const emailId = selected.id;
      invoke<{ message_id: number; text: string; version: number; total: number } | null>("get_draft_info", { emailId })
        .then(info => {
          if (info) {
            setSavedDraftMsgId(info.message_id);
            setDraftVersionInfo({ version: info.version, total: info.total });
          }
        })
        .catch(() => {});
    }
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraftText(e.target.value);
    setHasUnsavedEdits(true);
    e.target.style.height = "auto";
    e.target.style.height = e.target.scrollHeight + "px";
  }

  async function handleSaveDraft() {
    if (!selected || !draftText.trim()) return;
    try {
      if (savedDraftMsgId !== null) {
        // Update the existing draft version in place — don't create a new one
        await invoke("update_draft_message", { messageId: savedDraftMsgId, text: draftText });
        setSavedDraftText(draftText);
        setHasUnsavedEdits(false);
      } else {
        // No draft exists yet — create the first one
        const info = await invoke<{ message_id: number; text: string; version: number; total: number }>(
          "save_inline_draft", {
            emailId: selected.id,
            subject: selected.subject ?? "(no subject)",
            text: draftText,
          }
        );
        setSavedDraftText(info.text);
        setSavedDraftMsgId(info.message_id);
        setDraftVersionInfo({ version: info.version, total: info.total });
        setHasUnsavedEdits(false);
        setHasDraftSession(true);
      }
    } catch (e) {
      showToast(String(e), "error", 6000);
    }
  }

  async function handleDraftEmail() {
    if (!selected || !draftText.trim() || draftingEmail) return;
    setDraftingEmail(true);
    try {
      await invoke("graph_create_reply_draft", { emailId: selected.id, body: draftText });
      // Persist locally too so it shows up in Conversations
      await invoke("save_inline_draft", {
        emailId: selected.id,
        subject: selected.subject ?? "(no subject)",
        text: draftText,
      }).catch(() => {});
      showToast("Draft saved to Outlook", "success");
    } catch (e) {
      showToast(String(e), "error", 8000);
    } finally {
      setDraftingEmail(false);
    }
  }

  async function handleSendReply() {
    if (!selected || !draftText.trim() || sending) return;
    setSending(true);
    try {
      await invoke("graph_send_reply", { emailId: selected.id, body: draftText });
      showToast("Reply sent", "success");
      // Mark completed once sent
      await invoke("mark_email_completed", { id: selected.id, completed: true }).catch(() => {});
      setEmails(prev => prev.map(e => e.id === selected.id ? { ...e, is_completed: true } : e));
      setSelected(prev => prev ? { ...prev, is_completed: true } : null);
    } catch (e) {
      showToast(String(e), "error", 8000);
    } finally {
      setSending(false);
    }
  }

  // ── Thread count map (conversation_id → number of emails in that thread) ──
  const threadCounts = emails.reduce<Record<string, number>>((acc, e) => {
    if (e.conversation_id) acc[e.conversation_id] = (acc[e.conversation_id] ?? 0) + 1;
    return acc;
  }, {});

  // ── Filtering / sorting / pagination pipeline ──
  const q = search.toLowerCase();
  const searched = q
    ? emails.filter(e =>
        (e.subject ?? "").toLowerCase().includes(q) ||
        (e.from_name ?? "").toLowerCase().includes(q) ||
        e.from_address.toLowerCase().includes(q)
      )
    : emails;

  const priorityFiltered = filterPriority === "all"
    ? searched
    : searched.filter(e => e.analysis_priority === filterPriority);

  const completionFiltered =
    completionFilter === "uncompleted" ? priorityFiltered.filter(e => !e.is_completed) :
    completionFilter === "completed"   ? priorityFiltered.filter(e =>  e.is_completed) :
    priorityFiltered;

  const sorted = [...completionFiltered].sort((a, b) => {
    const diff = new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
    return sortDir === "desc" ? diff : -diff;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const pageStart  = (safePage - 1) * PER_PAGE;
  const paginated  = sorted.slice(pageStart, pageStart + PER_PAGE);

  const selectedIsAnalyzing = analyzingEmailId !== null && selected?.id === analyzingEmailId;

  // Active filter count (for indicator on expand button)
  const activeFilters = (filterPriority !== "all" ? 1 : 0) + (completionFilter !== "all" ? 1 : 0) + (sortDir !== "desc" ? 1 : 0);

  return (
    <div className="inbox-layout page-enter">

      {/* ── Top action bar ── */}
      <div className="inbox-topbar">
        <div className="inbox-topbar-row">

          <div className="inbox-topbar-left">
            <button
              className={`inbox-expand-btn ${topbarExpanded ? "expanded" : ""}`}
              onClick={() => setTopbarExpanded(v => !v)}
              title={topbarExpanded ? "Collapse panel" : "Expand panel"}
            >
              <ChevronDownIcon />
              {analyzeErrors.length > 0 && !topbarExpanded && (
                <span className="inbox-filter-badge inbox-error-badge">{analyzeErrors.length}</span>
              )}
              {activeFilters > 0 && analyzeErrors.length === 0 && !topbarExpanded && (
                <span className="inbox-filter-badge">{activeFilters}</span>
              )}
            </button>
          </div>

          <div className="inbox-search-wrap">
            <span className="inbox-search-icon"><SearchIcon /></span>
            <input
              type="text"
              className="inbox-search-input"
              placeholder="Search by subject, sender…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
            {search && (
              <button className="inbox-search-clear" onClick={() => { setSearch(""); setPage(1); }}>×</button>
            )}
          </div>

          <div className="inbox-topbar-right">
            <span className="inbox-page-info">
              {sorted.length === 0
                ? "0 emails"
                : `${pageStart + 1}–${Math.min(pageStart + PER_PAGE, sorted.length)} of ${sorted.length}`}
            </span>
            <button className="inbox-page-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)} title="Previous page">
              <ChevronLeftIcon />
            </button>
            <button className="inbox-page-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)} title="Next page">
              <ChevronRightIcon />
            </button>
          </div>
        </div>

        {/* Expanded panel */}
        {topbarExpanded && (
          <div className="inbox-actions-expanded">

            {/* Sync */}
            <div className="inbox-action-cell">
              <span className="inbox-action-icon"><RefreshIcon /></span>
              <div className="inbox-action-body">
                <span className="inbox-action-label">Sync</span>
                <span className="inbox-action-meta">
                  {lastSyncedAt ? `Last synced ${relativeTime(lastSyncedAt)}` : "Last sync unknown"}
                </span>
              </div>
              <button className="btn btn-sm" onClick={handleSync} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            </div>

            {/* Analyze */}
            <div className={`inbox-action-cell ${analyzing && analyzeProgress ? "inbox-action-cell--analyzing" : ""}`}>
              <span className="inbox-action-icon"><LightbulbIcon /></span>
              <div className="inbox-action-body">
                <div className="inbox-action-header-row">
                  <span className="inbox-action-label">Analyze</span>
                  {analyzing && analyzeProgress ? (
                    <span className="inbox-action-meta">
                      {analyzeProgress.processed} of {analyzeProgress.total}
                    </span>
                  ) : (
                    <span className="inbox-action-meta">
                      {analysisStats ? `${analysisStats.analyzed} / ${analysisStats.total} analyzed` : "Loading…"}
                    </span>
                  )}
                </div>
                {analyzing && analyzeProgress && (
                  <>
                    <div className="inbox-progress-bar">
                      <div
                        className="inbox-progress-fill"
                        style={{ width: `${analyzeProgress.total > 0 ? Math.round((analyzeProgress.processed / analyzeProgress.total) * 100) : 0}%` }}
                      />
                    </div>
                    {analyzeProgress.subject && (
                      <span className="inbox-action-meta inbox-progress-subject" title={analyzeProgress.subject}>
                        {analyzeProgress.subject}
                      </span>
                    )}
                  </>
                )}
              </div>
              {analyzing ? (
                <button className="btn btn-sm" onClick={handleStop}>
                  <span className="analysis-live-dot" style={{ width: 6, height: 6, marginRight: "0.3rem" }} />
                  Stop
                </button>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={handleAnalyze}>Analyze all</button>
              )}
            </div>

            {/* Filters row — spans both columns */}
            <div className="inbox-filter-row">
              <span className="inbox-filter-section-label">Sort</span>
              <button
                className={`inbox-filter-chip ${sortDir === "desc" ? "active" : ""}`}
                onClick={() => { setSortDir("desc"); setPage(1); }}
              >
                Newest first
              </button>
              <button
                className={`inbox-filter-chip ${sortDir === "asc" ? "active" : ""}`}
                onClick={() => { setSortDir("asc"); setPage(1); }}
              >
                Oldest first
              </button>

              <span className="inbox-filter-sep" />

              <span className="inbox-filter-section-label">Priority</span>
              {(["all", "high", "medium", "low"] as FilterPriority[]).map(p => (
                <button
                  key={p}
                  className={`inbox-filter-chip ${filterPriority === p ? "active" : ""} ${p !== "all" ? `priority-chip-${p}` : ""}`}
                  onClick={() => { setFilterPriority(p); setPage(1); }}
                >
                  {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}

              <span className="inbox-filter-sep" />

              <span className="inbox-filter-section-label">Status</span>
              {(["all", "uncompleted", "completed"] as const).map(s => (
                <button
                  key={s}
                  className={`inbox-filter-chip ${completionFilter === s ? "active" : ""}`}
                  onClick={() => { setCompletionFilter(s); setPage(1); }}
                >
                  {s === "all" ? "All" : s === "uncompleted" ? "Uncompleted" : "Completed"}
                </button>
              ))}

              {activeFilters > 0 && (
                <button
                  className="inbox-filter-chip inbox-filter-reset"
                  onClick={() => { setSortDir("desc"); setFilterPriority("all"); setCompletionFilter("all"); setPage(1); }}
                >
                  Reset
                </button>
              )}
            </div>

            {/* Error log — only shown when there are failures */}
            {analyzeErrors.length > 0 && (
              <div className="inbox-error-log">
                <div className="inbox-error-log-header">
                  <span className="inbox-error-log-title">
                    Analysis errors ({analyzeErrors.length})
                  </span>
                  <button
                    className="inbox-error-log-clear"
                    onClick={() => setAnalyzeErrors([])}
                  >
                    Clear
                  </button>
                </div>
                <div className="inbox-error-log-rows">
                  {analyzeErrors.map((err, i) => (
                    <div key={i} className="inbox-error-row">
                      <span className="inbox-error-time">{err.time}</span>
                      <span className="inbox-error-subject" title={err.subject}>{err.subject}</span>
                      <span className="inbox-error-msg" title={err.error}>{err.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {analyzeMsg && (
        <div className="inbox-analyze-progress">
          <span className="analysis-live-dot" style={{ width: 6, height: 6, flexShrink: 0 }} />
          {analyzeMsg}
        </div>
      )}

      {/* ── Content ── */}
      <div className="inbox-body">

        {/* Folder sidebar */}
        <aside className="folder-sidebar">
          <span className="folder-label">Folders</span>
          {FOLDERS.map(f => (
            <button key={f.id} className={`folder-btn ${folder === f.id ? "active" : ""}`} onClick={() => switchFolder(f.id)}>
              <f.Icon />
              <span>{f.label}</span>
              {counts[f.id] > 0 && <span className="folder-count">{counts[f.id]}</span>}
            </button>
          ))}
          <button className="folder-btn disabled-folder">
            <FilePenIcon />
            <span>Drafts</span>
          </button>
          <div className="folder-divider" />
          <span className="folder-label">People</span>
          <button className="folder-btn disabled-folder" title="Coming soon">
            <UsersIcon />
            <span>Contacts</span>
          </button>
        </aside>

        {/* Email list */}
        <div className="email-list-panel">
          <div className="email-list-scroll">
            {paginated.length === 0 ? (
              <p className="list-empty">
                {search || filterPriority !== "all" || completionFilter !== "all"
                  ? "No emails match the current filters."
                  : folder === "inbox"
                    ? "No emails — expand the panel above and hit Sync."
                    : folder === "sent"
                      ? "No sent emails."
                      : "No drafts."}
              </p>
            ) : (
              paginated.map(email => (
                <div
                  key={email.id}
                  className={[
                    "email-item",
                    email.is_read ? "read" : "unread",
                    email.is_completed ? "completed" : "",
                    selected?.id === email.id ? "selected" : "",
                    analyzingEmailId === email.id ? "analyzing" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectEmail(email)}
                >
                  <div className="email-item-row1">
                    <span className={`email-priority-dot priority-dot-${email.analysis_priority ?? "none"}`} />
                    <span className="email-item-from">{email.from_name || email.from_address}</span>
                    {email.conversation_id && (threadCounts[email.conversation_id] ?? 0) > 1 && (
                      <span className="email-thread-count">{threadCounts[email.conversation_id]}</span>
                    )}
                    <span className="email-item-date">
                      {analyzingEmailId === email.id
                        ? <span style={{ color: "var(--accent)", fontSize: "0.68rem" }}>analyzing…</span>
                        : formatDate(email.received_at)}
                    </span>
                  </div>
                  <div className="email-item-subject">
                    {email.is_completed && <span className="email-completed-check"><CheckIcon /></span>}
                    {email.subject || "(no subject)"}
                    {email.has_attachments && " 📎"}
                  </div>
                  {email.body_preview && (
                    <div className="email-item-preview">{email.body_preview}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Email body */}
        <div className="email-body-panel">
          {!selected ? (
            <div className="email-body-empty">Select an email to read it</div>
          ) : (
            <>
              <div className="email-body-header">
                <div className="email-body-header-top">
                  <div className="email-body-subject">{selected.subject || "(no subject)"}</div>
                  <button
                    className={`email-complete-btn ${selected.is_completed ? "is-completed" : ""}`}
                    onClick={handleToggleComplete}
                    title={selected.is_completed ? "Mark as incomplete" : "Mark as complete"}
                  >
                    <CheckIcon />
                    <span>{selected.is_completed ? "Completed" : "Mark complete"}</span>
                  </button>
                </div>
                <div className="email-body-meta">
                  <div className="email-meta-row">
                    <span className="email-meta-key">From</span>
                    <span className="email-meta-val">
                      {selected.from_name ? `${selected.from_name} <${selected.from_address}>` : selected.from_address}
                    </span>
                  </div>
                  <div className="email-meta-row">
                    <span className="email-meta-key">Date</span>
                    <span className="email-meta-val">{new Date(selected.received_at).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              <div className="email-body-content">
                {(() => {
                  const raw = body ?? selected.body_preview ?? "";
                  const segments = parseEmailThread(raw);
                  if (segments.length <= 1) {
                    return <div className="email-msg-body">{raw}</div>;
                  }
                  return segments.map((seg, idx) => (
                    <div
                      key={idx}
                      className={`email-msg-block ${idx === 0 ? "email-msg-latest" : "email-msg-quoted"}`}
                    >
                      {idx > 0 && (
                        <div className="email-msg-divider">
                          <span className="email-msg-divider-label">
                            Earlier message{seg.headers.find(h => h.key === "From")
                              ? ` · ${seg.headers.find(h => h.key === "From")!.value}`
                              : ""}
                          </span>
                        </div>
                      )}
                      {seg.headers.length > 0 && (
                        <div className="email-msg-headers">
                          {seg.headers.map(h => (
                            <div key={h.key} className="email-msg-header-row">
                              <span className="email-msg-header-key">{h.key}</span>
                              <span className="email-msg-header-val">{h.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="email-msg-body">{seg.body}</div>
                    </div>
                  ));
                })()}
              </div>

              {selectedIsAnalyzing && (
                <div className="analysis-stream-panel">
                  <div className="analysis-stream-header">
                    <span className="analysis-live-dot" style={{ width: 7, height: 7 }} />
                    Analyzing with AI…
                    {!streamText && (
                      <span style={{ fontSize: "0.72rem", color: "var(--muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
                        model is processing
                      </span>
                    )}
                  </div>
                  {streamText ? (
                    <div className="analysis-stream-tokens" ref={streamRef}>{streamText}</div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0" }}>
                      <div className="analysis-live-dot" />
                      <div className="analysis-live-dot" style={{ animationDelay: "0.4s" }} />
                      <div className="analysis-live-dot" style={{ animationDelay: "0.8s" }} />
                    </div>
                  )}
                </div>
              )}

              {/* ── New Analysis panel v2 ── */}
              {!selectedIsAnalyzing && analysis && (
                <div className="analysis-panel-v2">
                  {/* Header */}
                  <div className="analysis-panel-header">
                    <button
                      className={`analysis-collapse-btn ${analysisPanelOpen ? "open" : ""}`}
                      onClick={() => setAnalysisPanelOpen(v => !v)}
                      title={analysisPanelOpen ? "Collapse" : "Expand"}
                    >
                      <ChevronDownIcon />
                    </button>
                    <span className={`analysis-priority-chip analysis-priority-chip--${analysis.priority}`}>
                      {analysis.priority}
                    </span>
                    <span className="analysis-priority-label">Priority</span>
                    <div style={{ flex: 1 }} />
                    {analyzingThis ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <div className="analysis-live-dot" />
                        <div className="analysis-live-dot" style={{ animationDelay: "0.4s" }} />
                        <div className="analysis-live-dot" style={{ animationDelay: "0.8s" }} />
                      </div>
                    ) : (
                      <button
                        className="btn btn-sm analysis-reanalyze-btn"
                        onClick={handleAnalyzeThis}
                        disabled={analyzing}
                        title="Re-analyze this email"
                      >
                        <LightbulbIcon />
                        Re-analyze
                      </button>
                    )}
                  </div>

                  {analysisPanelOpen && (
                    <>
                      {/* Reasoning text — shown when toggled from bottom row */}
                      {reasoningOpen && (
                        <div className="analysis-reasoning-text">{analysis.reasoning}</div>
                      )}

                      {/* Suggested response section */}
                      <div className="analysis-response-section">
                        <div className="analysis-section-header">
                          <span className="analysis-section-label">Suggested Response</span>
                          {draftVersionInfo && !hasUnsavedEdits && (
                            <span className="draft-version-chip">
                              v{draftVersionInfo.version}{draftVersionInfo.total > 1 ? ` of ${draftVersionInfo.total}` : ""}
                            </span>
                          )}
                          <button
                            className="analysis-edit-ai-btn"
                            onClick={handleOpenDraftSession}
                          >
                            <BotIcon />
                            {hasDraftSession ? "Resume editing" : "Edit with AI"}
                          </button>
                        </div>
                        <textarea
                          ref={draftTextareaRef}
                          className="analysis-response-textarea"
                          value={draftText}
                          onChange={handleDraftChange}
                          rows={1}
                        />
                      </div>

                      {/* Bottom action row */}
                      <div className="analysis-action-row">
                        <button
                          className="analysis-reasoning-toggle"
                          onClick={() => setReasoningOpen(v => !v)}
                        >
                          {reasoningOpen ? "Hide reasoning" : "Show reasoning"}
                        </button>
                        {hasUnsavedEdits && (
                          <button
                            className="analysis-save-draft-btn"
                            onClick={handleSaveDraft}
                          >
                            Save draft
                          </button>
                        )}
                        <div className="analysis-action-row-right">
                          <button
                            className="btn btn-sm"
                            onClick={handleDraftEmail}
                            disabled={draftingEmail || sending || !draftText.trim()}
                            title="Save this reply as a draft in Outlook"
                          >
                            <FilePenIcon />
                            {draftingEmail ? "Saving…" : "Draft email"}
                          </button>
                          <button
                            className="btn btn-sm btn-primary analysis-send-btn"
                            onClick={handleSendReply}
                            disabled={sending || draftingEmail || !draftText.trim()}
                            title="Send this reply via Outlook"
                          >
                            <PaperPlaneIcon />
                            {sending ? "Sending…" : "Send reply"}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Analyze bar — shown when no analysis yet (not when analyzingThis, handled in panel header) */}
              {!selectedIsAnalyzing && !analysis && (
                <div className="email-analyze-bar">
                  {hasDraftSession && !analyzingThis && (
                    <button
                      className="btn btn-sm"
                      onClick={handleOpenDraftSession}
                    >
                      <BotIcon />
                      Resume editing
                    </button>
                  )}
                  {analyzingThis ? (
                    <div className="email-analyze-running">
                      <div className="analysis-live-dot" />
                      <div className="analysis-live-dot" style={{ animationDelay: "0.4s" }} />
                      <div className="analysis-live-dot" style={{ animationDelay: "0.8s" }} />
                      <span>Analyzing…</span>
                    </div>
                  ) : (
                    <button
                      className={`btn btn-sm ${analysisError ? "btn-danger" : "btn-primary"}`}
                      onClick={handleAnalyzeThis}
                      disabled={analyzing}
                    >
                      <LightbulbIcon />
                      {analysisError ? "Retry analysis" : "Analyze this email"}
                    </button>
                  )}
                  {templates.length > 0 && !analyzingThis && (
                    <div className="analyze-bar-style-picker">
                      <StylePicker
                        styles={templates}
                        value={activeTemplateId}
                        onChange={handleSetActiveTemplate}
                        nav
                      />
                    </div>
                  )}
                </div>
              )}

              {!selectedIsAnalyzing && debugMode && (debugData[selected.id]?.length > 0 || analysisError) && (
                <div className="analysis-debug-panel">
                  <button
                    className="analysis-debug-header"
                    onClick={() => setDebugOpen(v => !v)}
                  >
                    <span className="analysis-debug-toggle">{debugOpen ? "▾" : "▸"}</span>
                    <span>Debug output</span>
                    {analysisError && <span className="analysis-debug-error-pill">error</span>}
                    {(debugData[selected.id]?.length ?? 0) > 1 && (
                      <span className="analysis-debug-retry-pill">
                        {debugData[selected.id].length - 1} retr{debugData[selected.id].length > 2 ? "ies" : "y"}
                      </span>
                    )}
                    <span className="analysis-debug-badge">
                      {debugData[selected.id]?.length ?? 0} attempt{(debugData[selected.id]?.length ?? 0) !== 1 ? "s" : ""}
                    </span>
                  </button>
                  {debugOpen && (
                    <div className="analysis-debug-body">
                      <p className="analysis-debug-note">
                        Raw model output per attempt. JSON mode constrains structure but not string content — literal newlines or invalid escapes in the response will cause parse errors and trigger a retry with the error fed back to the model.
                      </p>
                      {analysisError && (
                        <div className="analysis-debug-error-block">
                          <div className="analysis-debug-attempt-label analysis-debug-attempt-label--error">
                            Final error
                          </div>
                          <pre className="analysis-debug-raw analysis-debug-raw--error">{analysisError.error}</pre>
                        </div>
                      )}
                      {(debugData[selected.id] ?? []).map(({ attempt, raw }) => (
                        <div key={attempt} className="analysis-debug-attempt">
                          <div className="analysis-debug-attempt-label">Attempt {attempt}</div>
                          <pre className="analysis-debug-raw">{raw}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!selectedIsAnalyzing && !analysis && analysisError && (
                <div className="email-analysis-error-panel">
                  <div className="email-analysis-error-header">
                    <span className="email-analysis-error-icon">&#x26A0;</span>
                    Analysis failed
                    <span className="email-analysis-error-time">
                      {new Date(analysisError.occurred_at).toLocaleString()}
                    </span>
                  </div>
                  <pre className="email-analysis-error-body">{analysisError.error}</pre>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
