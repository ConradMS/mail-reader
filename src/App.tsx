import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import type { AccountInfo } from "./types";
import { NavBar, type Page } from "./components/NavBar";
import { Home } from "./pages/Home";
import { InboxPage } from "./pages/InboxPage";
import { Conversations } from "./pages/Conversations";
import type { ConversationRow } from "./pages/Conversations";
import { DraftEditor } from "./pages/DraftEditor";
import { Settings } from "./pages/Settings";
import { useToast, ToastContainer } from "./components/Toast";
import "./App.css";

type AppMode = "setup" | "app";
type OllamaState = "checking" | "running" | "not_running";
type AuthState =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "connected"; account: AccountInfo }
  | { status: "error"; message: string };

type DraftSession = {
  convId: string;
  emailId: string;
  source: "inbox" | "conversations";
  emailRow: {
    subject: string | null;
    from_name: string | null;
    from_address: string;
    received_at: string;
  };
} | null;

function OutlookIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M30.9322 9.34307L7.97588 23.8943L6.00165 20.7797V18.0959C6.00165 17.1188 6.49634 16.2081 7.31603 15.6762L20.6606 7.01716C22.6937 5.69792 25.3125 5.69771 27.3458 7.01665L30.9322 9.34307Z" fill="url(#ol_a)"/>
      <path d="M27.1402 6.88928C27.2092 6.93033 27.2777 6.97284 27.3455 7.01682L37.76 13.7724L11.9375 30.1404L7.97498 23.8891L26.9262 11.8533C28.7213 10.7133 28.7999 8.14871 27.1402 6.88928Z" fill="url(#ol_b)"/>
      <path d="M27.1402 6.88928C27.2092 6.93033 27.2777 6.97284 27.3455 7.01682L37.76 13.7724L11.9375 30.1404L7.97498 23.8891L26.9262 11.8533C28.7213 10.7133 28.7999 8.14871 27.1402 6.88928Z" fill="url(#ol_c)" fillOpacity="0.2"/>
      <path d="M22.2402 33.2659L11.9377 30.1406L33.842 16.2557C35.6868 15.0864 35.682 12.3932 33.8331 11.2304L33.7344 11.1684L34.0185 11.3451L40.685 15.6695C41.5049 16.2014 41.9998 17.1122 41.9998 18.0895V20.687L22.2402 33.2659Z" fill="url(#ol_d)"/>
      <path d="M22.2402 33.2659L11.9377 30.1406L33.842 16.2557C35.6868 15.0864 35.682 12.3932 33.8331 11.2304L33.7344 11.1684L34.0185 11.3451L40.685 15.6695C41.5049 16.2014 41.9998 17.1122 41.9998 18.0895V20.687L22.2402 33.2659Z" fill="url(#ol_e)" fillOpacity="0.2"/>
      <path d="M27.3458 7.01665C25.3125 5.69771 22.6937 5.69792 20.6605 7.01716L7.31603 15.6762C6.49634 16.2081 6.00165 17.1188 6.00165 18.0959V18.2272C6.03382 19.208 6.55002 20.1121 7.38373 20.6378L23.9764 31.0985L40.6108 20.6537C41.4747 20.1112 41.999 19.1628 41.999 18.1427V20.6873L41.9994 18.0896C41.9994 17.1123 41.5045 16.2015 40.6846 15.6696L27.3458 7.01665Z" fill="url(#ol_f)"/>
      <path d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z" fill="url(#ol_g)"/>
      <path d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z" fill="url(#ol_h)" fillOpacity="0.4"/>
      <path d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z" fill="url(#ol_i)" fillOpacity="0.5"/>
      <path d="M27.0268 42.0023H12.2492C8.79745 42.0023 5.99923 39.2041 5.99923 35.7523V18.1297C5.99923 19.1478 6.52165 20.0948 7.38292 20.6377L29.2215 34.4058C30.4171 35.1595 31.1423 36.4741 31.1421 37.8874C31.1419 40.1601 29.2995 42.0023 27.0268 42.0023Z" fill="url(#ol_j)"/>
      <path d="M27.0268 42.0023H12.2492C8.79745 42.0023 5.99923 39.2041 5.99923 35.7523V18.1297C5.99923 19.1478 6.52165 20.0948 7.38292 20.6377L29.2215 34.4058C30.4171 35.1595 31.1423 36.4741 31.1421 37.8874C31.1419 40.1601 29.2995 42.0023 27.0268 42.0023Z" fill="url(#ol_k)"/>
      <rect x="4" y="23" width="16" height="16" rx="3.25" fill="url(#ol_l)"/>
      <rect x="4" y="23" width="16" height="16" rx="3.25" fill="url(#ol_m)" fillOpacity="0.5"/>
      <path d="M11.959 35.5999C10.636 35.5999 9.54994 35.186 8.70069 34.3583C7.85144 33.5306 7.42682 32.4505 7.42682 31.1179C7.42682 29.7107 7.85785 28.5726 8.7199 27.7035C9.58195 26.8345 10.7107 26.3999 12.1062 26.3999C13.4249 26.3999 14.4982 26.8158 15.3261 27.6477C16.1583 28.4795 16.5744 29.5762 16.5744 30.9378C16.5744 32.3367 16.1433 33.4644 15.2813 34.3211C14.4235 35.1736 13.3161 35.5999 11.959 35.5999ZM11.9974 33.8431C12.7186 33.8431 13.299 33.5968 13.7386 33.1044C14.1781 32.6119 14.3979 31.9269 14.3979 31.0496C14.3979 30.1349 14.1845 29.4231 13.7578 28.9141C13.331 28.405 12.7613 28.1505 12.0486 28.1505C11.3146 28.1505 10.7235 28.4133 10.2754 28.9389C9.82733 29.4604 9.60328 30.1515 9.60328 31.0123C9.60328 31.8856 9.82733 32.5767 10.2754 33.0857C10.7235 33.5906 11.2975 33.8431 11.9974 33.8431Z" fill="white"/>
      <defs>
        <linearGradient id="ol_a" x1="9.989" y1="22.365" x2="30.932" y2="9.375" gradientUnits="userSpaceOnUse"><stop stopColor="#20A7FA"/><stop offset=".4" stopColor="#3BD5FF"/><stop offset="1" stopColor="#C4B0FF"/></linearGradient>
        <linearGradient id="ol_b" x1="17.197" y1="26.795" x2="28.856" y2="8.126" gradientUnits="userSpaceOnUse"><stop stopColor="#165AD9"/><stop offset=".501" stopColor="#1880E5"/><stop offset="1" stopColor="#8587FF"/></linearGradient>
        <linearGradient id="ol_c" x1="25.7" y1="27.048" x2="12.756" y2="16.501" gradientUnits="userSpaceOnUse"><stop offset=".237" stopColor="#448AFF" stopOpacity="0"/><stop offset=".792" stopColor="#0032B1"/></linearGradient>
        <linearGradient id="ol_d" x1="24.053" y1="31.11" x2="44.51" y2="18.018" gradientUnits="userSpaceOnUse"><stop stopColor="#1A43A6"/><stop offset=".492" stopColor="#2052CB"/><stop offset="1" stopColor="#5F20CB"/></linearGradient>
        <linearGradient id="ol_e" x1="29.828" y1="30.327" x2="17.398" y2="19.571" gradientUnits="userSpaceOnUse"><stop stopColor="#0045B9" stopOpacity="0"/><stop offset=".67" stopColor="#0D1F69"/></linearGradient>
        <radialGradient id="ol_f" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(24.002 6.818) rotate(-90) scale(27.003 29.226)"><stop offset=".568" stopColor="#275FF0" stopOpacity="0"/><stop offset=".992" stopColor="#002177"/></radialGradient>
        <linearGradient id="ol_g" x1="41.998" y1="29.943" x2="23.852" y2="29.943" gradientUnits="userSpaceOnUse"><stop stopColor="#4DC4FF"/><stop offset=".196" stopColor="#0FAFFF"/></linearGradient>
        <radialGradient id="ol_h" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(28.093 37.912) rotate(-45) scale(11.572)"><stop offset=".259" stopColor="#0060D1"/><stop offset=".908" stopColor="#0383F1" stopOpacity="0"/></radialGradient>
        <radialGradient id="ol_i" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(10.631 46.472) rotate(-52.658) scale(39.281 35.52)"><stop offset=".732" stopColor="#F4A7F7" stopOpacity="0"/><stop offset="1" stopColor="#F4A7F7"/></radialGradient>
        <radialGradient id="ol_j" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(18.571 27.532) rotate(123.339) scale(20.726 53.786)"><stop stopColor="#49DEFF"/><stop offset=".724" stopColor="#29C3FF"/></radialGradient>
        <linearGradient id="ol_k" x1="3.458" y1="37.872" x2="20.929" y2="37.86" gradientUnits="userSpaceOnUse"><stop offset=".206" stopColor="#6CE0FF"/><stop offset=".535" stopColor="#50D5FF" stopOpacity="0"/></linearGradient>
        <radialGradient id="ol_l" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(3.943 23.615) rotate(46.924) scale(21.062)"><stop offset=".039" stopColor="#0091FF"/><stop offset=".919" stopColor="#183DAD"/></radialGradient>
        <radialGradient id="ol_m" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(12 32.744) rotate(90) scale(11.2 12.919)"><stop offset=".558" stopColor="#0FA5F7" stopOpacity="0"/><stop offset="1" stopColor="#74C6FF"/></radialGradient>
      </defs>
    </svg>
  );
}

function App() {
  const [mode, setMode]     = useState<AppMode>("setup");
  const [page, setPage]     = useState<Page>("home");
  const [theme, setTheme]   = useState("light");
  const [accent, setAccent] = useState("purple");
  const [ollama, setOllama] = useState<OllamaState>("checking");
  const [auth, setAuth]     = useState<AuthState>({ status: "idle" });
  const { toasts, show: showToast, dismiss } = useToast();
  const [draftSession, setDraftSession] = useState<DraftSession>(null);
  // Stored outside state so React never mis-interprets the function as a state updater
  const applyDraftRef = useRef<((text: string) => void) | undefined>(undefined);

  // Apply theme and accent to <html> element
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  // Load persisted theme/accent + pre-warm the selected model.
  // Re-runs when entering app mode because the per-account DB is swapped in
  // only after login, so the placeholder DB read at startup has no settings.
  useEffect(() => {
    invoke<Record<string, string>>("get_settings")
      .then(s => {
        if (s.theme)  setTheme(s.theme);
        if (s.accent) setAccent(s.accent);
        // Fire-and-forget: load the model into Ollama's memory so the first
        // inference request doesn't pay the cold-start penalty.
        if (s.ollama_model) invoke("warmup_model").catch(() => {});
      })
      .catch(() => {});
  }, [mode]);

  async function checkOllama() {
    setOllama("checking");
    try {
      // Check via the Rust backend (reqwest), NOT a frontend fetch: WebView2 on
      // Windows blocks plain-HTTP requests to localhost from the app's web
      // context, so a browser fetch always failed there even when Ollama was up.
      const running = await invoke<boolean>("check_ollama");
      setOllama(running ? "running" : "not_running");
    } catch {
      setOllama("not_running");
    }
  }

  useEffect(() => {
    checkOllama();

    const unlisten = onOpenUrl(async (urls) => {
      const url = urls[0];
      if (!url?.startsWith("mailreader://auth")) return;
      setAuth({ status: "waiting" });
      try {
        const account = await invoke<AccountInfo>("complete_microsoft_auth", { redirectUrl: url });
        setAuth({ status: "connected", account });
        setMode("app");
      } catch (e) {
        setAuth({ status: "error", message: String(e) });
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, []);

  async function handleSignIn() {
    setAuth({ status: "waiting" });
    try {
      await invoke("start_microsoft_auth");
    } catch (e) {
      setAuth({ status: "error", message: String(e) });
    }
  }

  async function handleThemeChange(next: string) {
    setTheme(next);
    await invoke("set_setting", { key: "theme", value: next }).catch(() => {});
  }

  async function handleAccentChange(next: string) {
    setAccent(next);
    await invoke("set_setting", { key: "accent", value: next }).catch(() => {});
  }

  async function handleSignOut() {
    await invoke("sign_out").catch(() => {});
    setAuth({ status: "idle" });
    setMode("setup");
  }

  function openDraftSession(s: NonNullable<DraftSession> & { onApplyDraft?: (text: string) => void }) {
    applyDraftRef.current = s.onApplyDraft;
    const { onApplyDraft: _cb, ...sessionState } = s;
    setDraftSession(sessionState);
  }

  function handlePageChange(p: Page) {
    setPage(p);
    if (draftSession !== null) {
      // DraftEditor's unmount cleanup will auto-apply the current draft to the inbox.
      setDraftSession(null);
      applyDraftRef.current = undefined;
    }
  }

  // ── Main app shell ──────────────────────────────────────────────
  if (mode === "app") {
    return (
      <div className="app-shell">
        <NavBar
          current={page}
          onChange={handlePageChange}
          theme={theme}
          onThemeChange={handleThemeChange}
          account={auth.status === "connected" ? auth.account : null}
          onSignOut={handleSignOut}
        />
        <div className="app-content" style={{ position: "relative" }}>
          <PageView
            page={page}
            showToast={showToast}
            openDraftSession={openDraftSession}
            accent={accent}
            onAccentChange={handleAccentChange}
          />
          {draftSession !== null && (
            <DraftEditor
              emailId={draftSession.emailId}
              convId={draftSession.convId}
              emailRow={draftSession.emailRow}
              showEmailByDefault={draftSession.source === "inbox"}
              onApplyDraft={applyDraftRef.current}
              onClose={() => { applyDraftRef.current = undefined; setDraftSession(null); }}
              showToast={showToast}
            />
          )}
        </div>
        <ToastContainer toasts={toasts} dismiss={dismiss} />
      </div>
    );
  }

  // ── Setup screen ────────────────────────────────────────────────
  const connected = auth.status === "connected";
  const canContinue = ollama === "running" && connected;

  return (
    <main className="landing">
      <div className="hero">
        <h1 className="app-title">Mail Reader</h1>
        <p className="app-subtitle">your local AI email assistant</p>
      </div>

      {/* Ollama */}
      <div className="setup-card">
        <div className="step-row">
          <div className="step-info">
            <span className="step-name">Ollama</span>
            <span className="step-desc">Required to run the local AI model</span>
          </div>
          <div className="step-status">
            {ollama === "checking"    && <span className="badge badge-checking">checking…</span>}
            {ollama === "running"     && <span className="badge badge-ok">✓ running</span>}
            {ollama === "not_running" && <span className="badge badge-error">not found</span>}
          </div>
        </div>
        {ollama === "not_running" && (
          <div className="hint">
            <p>Install Ollama from <strong>ollama.com</strong> then run:</p>
            <code>ollama serve</code>
            <button className="btn" onClick={checkOllama}>Retry</button>
          </div>
        )}
      </div>

      {/* Outlook */}
      <div className={`setup-card ${ollama !== "running" ? "step-disabled" : ""}`}>
        <div className="step-row">
          <div className="step-info">
            <span className="step-name">Outlook Account</span>
            <span className="step-desc">
              {auth.status === "connected"
                ? (auth.account.email ?? auth.account.name ?? "Connected")
                : "Connect your Microsoft account"}
            </span>
          </div>
          <div className="step-status">
            {auth.status === "idle"      && <span className="badge badge-idle">not connected</span>}
            {auth.status === "waiting"   && <span className="badge badge-checking">waiting…</span>}
            {auth.status === "connected" && <span className="badge badge-ok">✓ connected</span>}
            {auth.status === "error"     && <span className="badge badge-error">error</span>}
          </div>
        </div>

        {(auth.status === "idle" || auth.status === "error") && ollama === "running" && (
          <>
            {auth.status === "error" && <p className="hint-error">{auth.message}</p>}
            <button className="provider-btn" onClick={handleSignIn}>
              <OutlookIcon />
              <span>Sign in to Outlook</span>
            </button>
          </>
        )}
        {auth.status === "waiting" && <p className="hint-muted">Complete sign-in in your browser…</p>}
        {auth.status === "connected" && (
          <button className="btn btn-sm" onClick={() => setAuth({ status: "idle" })}>Disconnect</button>
        )}
      </div>

      <button
        className={`btn btn-primary btn-launch ${!canContinue ? "btn-disabled" : ""}`}
        disabled={!canContinue}
        onClick={() => setMode("app")}
      >
        Open Inbox
      </button>
    </main>
  );
}

// Separate component so the `key` prop triggers re-mount on navigation → animation fires
type ShowToast = (msg: string, type?: "error" | "success" | "info", duration?: number) => void;

function PageView({
  page,
  showToast,
  openDraftSession,
  accent,
  onAccentChange,
}: {
  page: Page;
  showToast: ShowToast;
  openDraftSession: (s: NonNullable<DraftSession>) => void;
  accent: string;
  onAccentChange: (a: string) => void;
}) {
  switch (page) {
    case "home":          return <Home key="home" showToast={showToast} openDraftSession={p => openDraftSession({ ...p, source: "inbox" })} />;
    case "inbox":         return (
      <InboxPage
        key="inbox"
        showToast={showToast}
        onOpenDraftSession={(params) => openDraftSession({ ...params, source: "inbox" })}
      />
    );
    case "conversations": return (
      <Conversations
        key="conversations"
        showToast={showToast}
        onOpenDraftSession={(conv: ConversationRow) => {
          if (conv.email_id) {
            openDraftSession({
              convId: conv.id,
              emailId: conv.email_id,
              source: "conversations",
              emailRow: {
                subject: conv.title.replace(/^Reply draft: /, "") || null,
                from_name: null,
                from_address: "",
                received_at: conv.created_at,
              },
            });
          }
        }}
      />
    );
    case "settings": return <Settings key="settings" showToast={showToast} accent={accent} onAccentChange={onAccentChange} />;
  }
}

export default App;
