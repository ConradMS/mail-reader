import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Types ─────────────────────────────────────────────────────────────
interface HomeStats {
  total: number;
  unread: number;
  uncompleted: number;
  high_priority: number;
  normal_priority: number;
  low_priority: number;
}

interface AnalysisStats {
  total: number;
  analyzed: number;
  pending: number;
}

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

interface StreamEvent { email_id: string; text: string; }

interface AnalyzedCard {
  id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string;
  received_at: string;
  is_read: boolean;
  is_completed: boolean;
  priority: string;
  suggested_response: string;
  conversation_id: string | null;
}

type OpenDraftSession = (p: {
  convId: string; emailId: string;
  emailRow: { subject: string | null; from_name: string | null; from_address: string; received_at: string };
}) => void;

type ShowToast = (msg: string, type?: "error" | "success" | "info", duration?: number) => void;

// ── Icons ─────────────────────────────────────────────────────────────
function SyncIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
      style={spinning ? { animation: "spin 0.85s linear infinite" } : undefined}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
      <path d="M21 3v5h-5"/>
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
      <path d="M8 16H3v5"/>
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
    </svg>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round">
      {dir === "left" ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────
function relTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function priColor(p: string) {
  if (p === "high")                   return "var(--high)";
  if (p === "medium" || p === "normal") return "var(--normal)";
  return "var(--low)";
}

// ── Component ─────────────────────────────────────────────────────────
export function Home({ showToast, openDraftSession }: {
  showToast: ShowToast;
  openDraftSession: OpenDraftSession;
}) {
  const [stats, setStats]                 = useState<HomeStats | null>(null);
  const [analysisStats, setAnalysisStats] = useState<AnalysisStats | null>(null);
  const [cards, setCards]                 = useState<AnalyzedCard[]>([]);
  const [cardIdx, setCardIdx]             = useState(0);
  const [progress, setProgress]           = useState<AnalysisProgress | null>(null);
  const [lastSync, setLastSync]           = useState<string | null>(null);
  const [syncing, setSyncing]             = useState(false);
  const [analyzing, setAnalyzing]         = useState(false);
  const [streamText, setStreamText]       = useState("");
  const [editingId, setEditingId]         = useState<string | null>(null);
  const [savingId, setSavingId]           = useState<string | null>(null);
  const [sendingId, setSendingId]         = useState<string | null>(null);
  const [editText, setEditText]           = useState("");
  const streamBoxRef                      = useRef<HTMLDivElement>(null);

  function loadAll() {
    invoke<HomeStats>("get_home_stats").then(setStats).catch(console.error);
    invoke<AnalysisStats>("get_analysis_stats").then(setAnalysisStats).catch(console.error);
    invoke<AnalyzedCard[]>("list_analyzed_emails").then(cs => { setCards(cs); setCardIdx(0); }).catch(console.error);
    invoke<Record<string, string>>("get_settings").then(s => setLastSync(s.last_synced_at ?? null)).catch(() => {});
  }

  useEffect(() => {
    loadAll();
    const unP = listen<AnalysisProgress>("analysis_progress", e => {
      const p = e.payload;
      // When backend says nothing was queued, suppress the banner silently
      if (p.done && p.total === 0) {
        setAnalyzing(false);
        setProgress(null);
        return;
      }
      setProgress(p);
      setAnalyzing(!p.done);
      if (p.done) { loadAll(); setTimeout(() => setProgress(null), 5000); }
      if (!p.done && p.current_email_id) setStreamText("");
    });
    const unS = listen<StreamEvent>("analysis_stream", e => setStreamText(e.payload.text));
    return () => { unP.then(f => f()); unS.then(f => f()); };
  }, []);

  useEffect(() => {
    if (streamBoxRef.current) streamBoxRef.current.scrollTop = streamBoxRef.current.scrollHeight;
  }, [streamText]);

  async function handleSync() {
    setSyncing(true);
    try { await invoke("sync_emails"); loadAll(); } catch {} finally { setSyncing(false); }
  }

  async function handleAnalyze() {
    if (analysisStats && analysisStats.pending === 0) {
      showToast("All emails already analyzed", "info");
      return;
    }
    setAnalyzing(true);
    try { await invoke("start_analysis"); } catch { setAnalyzing(false); }
  }

  async function handleEditDraft(card: AnalyzedCard) {
    setEditingId(card.id);
    try {
      const result = await invoke<{ conv: { id: string }; is_new: boolean }>("get_draft_session", {
        emailId: card.id,
        subject: card.subject ?? "(no subject)",
        initialDraft: editText,
      });
      openDraftSession({
        convId: result.conv.id,
        emailId: card.id,
        emailRow: {
          subject: card.subject,
          from_name: card.from_name,
          from_address: card.from_address,
          received_at: card.received_at,
        },
      });
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setEditingId(null);
    }
  }

  async function handleSaveDraft(card: AnalyzedCard) {
    setSavingId(card.id);
    try {
      await invoke("graph_create_reply_draft", { emailId: card.id, body: editText });
      // Also persist locally so it appears in Conversations
      await invoke("save_inline_draft", {
        emailId: card.id,
        subject: card.subject || "",
        text: editText,
      });
      showToast("Draft saved to Outlook", "success");
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSavingId(null);
    }
  }

  async function handleSendReply(card: AnalyzedCard) {
    setSendingId(card.id);
    try {
      await invoke("graph_send_reply", { emailId: card.id, body: editText });
      showToast("Reply sent", "success");
      // Mark completed and remove from list after sending
      await invoke("mark_email_completed", { id: card.id, completed: true }).catch(() => {});
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, is_completed: true } : c));
      invoke<HomeStats>("get_home_stats").then(setStats).catch(console.error);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSendingId(null);
    }
  }

  function navCard(dir: "left" | "right") {
    setCardIdx(i => dir === "left" ? Math.max(0, i - 1) : Math.min(cards.length - 1, i + 1));
  }

  async function handleMarkDone(card: AnalyzedCard) {
    await invoke("mark_email_completed", { id: card.id, completed: true }).catch(() => {});
    // Keep card visible this session; only show it as completed until next load
    setCards(prev => prev.map(c => c.id === card.id ? { ...c, is_completed: true } : c));
    // Refresh stats so priority counts update immediately
    invoke<HomeStats>("get_home_stats").then(setStats).catch(console.error);
    invoke<AnalysisStats>("get_analysis_stats").then(setAnalysisStats).catch(console.error);
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const isRunning = !!progress && !progress.done;
  const progPct = progress?.total ? Math.round((progress.processed / progress.total) * 100) : 0;

  const total       = stats?.total ?? 0;
  const unread      = stats?.unread ?? 0;
  const uncompleted = stats?.uncompleted ?? 0;
  const high        = stats?.high_priority ?? 0;
  const normal      = stats?.normal_priority ?? 0;
  const low         = stats?.low_priority ?? 0;

  const analyzed    = analysisStats?.analyzed ?? 0;
  const pending     = analysisStats?.pending ?? 0;
  const aTotal      = analysisStats?.total ?? 0;
  const analyzedPct = aTotal > 0 ? Math.round((analyzed / aTotal) * 100) : 0;

  const highPct   = uncompleted > 0 ? (high / uncompleted) * 100 : 0;
  const normalPct = uncompleted > 0 ? (normal / uncompleted) * 100 : 0;
  const lowPct    = uncompleted > 0 ? (low / uncompleted) * 100 : 0;

  const card = cards[cardIdx] ?? null;

  // Reset editable text whenever the visible card changes
  useEffect(() => {
    setEditText(card?.suggested_response ?? "");
  }, [cardIdx, cards]);

  return (
    <div className="home-page page-enter">

      {/* ── Greeting + inline progress ── */}
      <div className="home-top">
        <div className="home-top-left">
          <h1 className="home-greeting">{greeting}</h1>
          <p className="home-date">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>

        {progress && (
          <div className={`home-inline-progress ${progress.done ? "home-inline-done" : ""}`}>
            <div className="home-inline-row">
              {isRunning && <span className="home-banner-pulse" />}
              <span className="home-inline-label">
                {progress.done
                  ? progress.stopped ? "Stopped"
                  : progress.error   ? "Error"
                  : "Done"
                  : (progress.current_subject
                      ? progress.current_subject.length > 40
                        ? progress.current_subject.slice(0, 40) + "…"
                        : progress.current_subject
                      : "Preparing…")}
              </span>
              {progress.total > 0 && (
                <span className="home-inline-count">{progress.processed}/{progress.total}</span>
              )}
              {isRunning && (
                <button className="btn btn-sm home-stop-btn" onClick={() => invoke("stop_analysis").catch(()=>{})}>
                  <StopIcon /> Stop
                </button>
              )}
            </div>
            {progress.total > 0 && (
              <div className="home-prog-track">
                <div className="home-prog-fill" style={{ width: `${progPct}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Stat cards ── */}
      <div className="home-cards-row">

        {/* Inbox */}
        <div className="home-card">
          <div className="home-card-head">
            <div className="home-card-title">
              <span className="home-card-icon home-icon-inbox">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
                </svg>
              </span>
              <span className="home-card-label">Inbox</span>
            </div>
            <button className="btn btn-sm home-action-btn" onClick={handleSync} disabled={syncing || isRunning}>
              <SyncIcon spinning={syncing} />{syncing ? "Syncing…" : "Sync"}
            </button>
          </div>
          <div className="home-card-stats">
            <div className="home-stat-cell">
              <span className="home-stat-num">{total}</span>
              <span className="home-stat-lbl">Total</span>
            </div>
            <div className="home-stat-sep" />
            <div className="home-stat-cell">
              <span className="home-stat-num home-col-accent">{unread}</span>
              <span className="home-stat-lbl">Unread</span>
            </div>
            <div className="home-stat-sep" />
            <div className="home-stat-cell">
              <span className="home-stat-num">{total - unread}</span>
              <span className="home-stat-lbl">Read</span>
            </div>
          </div>
          <span className="home-card-footer-note">
            {lastSync ? `Last synced ${relTime(lastSync)}` : "Never synced"}
          </span>
        </div>

        {/* Priority */}
        <div className="home-card">
          <div className="home-card-head">
            <div className="home-card-title">
              <span className="home-card-icon home-icon-priority">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
                </svg>
              </span>
              <span className="home-card-label">Priority</span>
            </div>
            <span className="home-card-badge">{uncompleted} uncompleted</span>
          </div>
          <div className="home-card-stats">
            <div className="home-stat-cell">
              <span className="home-stat-num home-col-high">{high}</span>
              <span className="home-stat-lbl">High</span>
            </div>
            <div className="home-stat-sep" />
            <div className="home-stat-cell">
              <span className="home-stat-num home-col-normal">{normal}</span>
              <span className="home-stat-lbl">Medium</span>
            </div>
            <div className="home-stat-sep" />
            <div className="home-stat-cell">
              <span className="home-stat-num home-col-low">{low}</span>
              <span className="home-stat-lbl">Low</span>
            </div>
          </div>
          <div className="home-pri-bar">
            <div className="home-pri-seg home-seg-high"   style={{ width: `${highPct}%` }} />
            <div className="home-pri-seg home-seg-normal" style={{ width: `${normalPct}%` }} />
            <div className="home-pri-seg home-seg-low"    style={{ width: `${lowPct}%` }} />
          </div>
        </div>

        {/* Analysis */}
        <div className="home-card">
          <div className="home-card-head">
            <div className="home-card-title">
              <span className="home-card-icon home-icon-analysis">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                </svg>
              </span>
              <span className="home-card-label">Analysis</span>
            </div>
            <button
              className="btn btn-sm btn-primary home-action-btn"
              onClick={handleAnalyze}
              disabled={analyzing || syncing}
            >
              <SparkleIcon />{analyzing ? "Analyzing…" : "Analyze all"}
            </button>
          </div>
          <div className="home-card-stats">
            <div className="home-stat-cell">
              <span className="home-stat-num home-col-accent">{analyzed}</span>
              <span className="home-stat-lbl">Analyzed</span>
            </div>
            <div className="home-stat-sep" />
            <div className="home-stat-cell">
              <span className="home-stat-num">{pending}</span>
              <span className="home-stat-lbl">Pending</span>
            </div>
          </div>
          {aTotal > 0 && (
            <span className="home-analysis-pct">{analyzedPct}% complete</span>
          )}
        </div>

      </div>

      {/* ── Analyzed email slideshow ── */}
      {cards.length > 0 && (
        <div className="home-slideshow">
          <div className="home-slideshow-header">
            <span className="home-slideshow-title">Analyzed emails</span>
          </div>

          {card && (
            <div className="home-email-card" key={card.id}>
              {/* Top row: meta left, mark completed right */}
              <div className="home-email-card-top">
                <div className="home-email-meta">
                  <span className="home-pri-badge" style={{ background: priColor(card.priority) + "22", color: priColor(card.priority) }}>
                    {card.priority}
                  </span>
                  <span className="home-email-from">{card.from_name || card.from_address}</span>
                  <span className="home-email-time">{relTime(card.received_at)}</span>
                </div>
                {card.is_completed ? (
                  <span className="home-completed-badge">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    Completed
                  </span>
                ) : (
                  <button className="btn btn-sm home-action-btn home-mark-btn" onClick={() => handleMarkDone(card)}>
                    <CheckIcon />Mark completed
                  </button>
                )}
              </div>

              <h3 className="home-email-subject">{card.subject || "(no subject)"}</h3>

              <div className="home-email-response">
                <div className="home-response-header">
                  <span className="home-response-label">Suggested response</span>
                  {editText !== card.suggested_response && (
                    <button
                      className="analysis-save-draft-btn"
                      onClick={() => handleSaveDraft(card)}
                      disabled={savingId === card.id}
                    >
                      {savingId === card.id ? "Saving…" : "Save draft"}
                    </button>
                  )}
                </div>
                <textarea
                  className="home-response-text"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  spellCheck={false}
                />
              </div>

              {/* Bottom: Edit with AI left | nav center | create draft + send right */}
              <div className="home-email-footer">
                <button
                  className="btn btn-primary home-action-btn"
                  onClick={() => handleEditDraft(card)}
                  disabled={editingId === card.id}
                >
                  <EditIcon />{editingId === card.id ? "Opening…" : "Edit with AI"}
                </button>

                {cards.length > 1 && (
                  <div className="home-card-nav">
                    <button
                      className="home-nav-btn"
                      onClick={() => navCard("left")}
                      disabled={cardIdx === 0}
                    ><ChevronIcon dir="left" /></button>
                    <span className="home-nav-count">{cardIdx + 1} / {cards.length}</span>
                    <button
                      className="home-nav-btn"
                      onClick={() => navCard("right")}
                      disabled={cardIdx === cards.length - 1}
                    ><ChevronIcon dir="right" /></button>
                  </div>
                )}

                <div className="home-footer-actions">
                  <button
                    className="btn btn-sm"
                    onClick={() => handleSaveDraft(card)}
                    disabled={savingId === card.id}
                  >
                    <EditIcon />{savingId === card.id ? "Saving…" : "Create draft"}
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handleSendReply(card)}
                    disabled={sendingId === card.id}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/>
                    </svg>
                    {sendingId === card.id ? "Sending…" : "Send reply"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {total === 0 && !progress && (
        <div className="home-empty-state">
          <p>No emails yet — hit <strong>Sync</strong> to get started.</p>
        </div>
      )}

    </div>
  );
}
