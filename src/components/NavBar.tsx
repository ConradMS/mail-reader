import { useState, useRef, useEffect } from "react";
import { MoonIcon, SunIcon } from "./ui/icons";
import type { AccountInfo } from "../types";

export type Page = "home" | "inbox" | "conversations" | "settings";

interface Props {
  current: Page;
  onChange: (p: Page) => void;
  theme: string;
  onThemeChange: (t: string) => void;
  account: AccountInfo | null;
  onSignOut: () => void;
}

const ITEMS: { id: Page; label: string }[] = [
  { id: "home",          label: "Home" },
  { id: "inbox",         label: "Inbox" },
  { id: "conversations", label: "Conversations" },
  { id: "settings",      label: "Settings" },
];

export function NavBar({ current, onChange, theme, onThemeChange, account, onSignOut }: Props) {
  const isDark = theme === "dark";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggleTheme() {
    onThemeChange(isDark ? "light" : "dark");
  }

  // Close menu when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const initials = account?.name
    ? account.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase()
    : account?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <nav className="top-nav">
      <span className="nav-brand"><span className="nav-brand-icon">✉</span> Mail Reader</span>
      <div className="nav-items">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-btn ${current === item.id ? "active" : ""}`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="nav-right">
        <button
          className="nav-theme-btn"
          onClick={toggleTheme}
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>

        {account && (
          <div className="nav-profile" ref={menuRef}>
            <button
              className="nav-avatar"
              onClick={() => setMenuOpen(v => !v)}
              title={account.name ?? account.email ?? "Account"}
            >
              {initials}
            </button>

            {menuOpen && (
              <div className="nav-profile-menu">
                <div className="nav-profile-info">
                  {account.name && <span className="nav-profile-name">{account.name}</span>}
                  {account.email && <span className="nav-profile-email">{account.email}</span>}
                </div>
                <div className="nav-profile-divider" />
                <button
                  className="nav-profile-signout"
                  onClick={() => { setMenuOpen(false); onSignOut(); }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
