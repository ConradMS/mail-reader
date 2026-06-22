import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, CheckIcon } from "./icons";

interface WritingStyle {
  id: string;
  name: string;
}

interface StylePickerProps {
  styles: WritingStyle[];
  value: string; // active template id, "" = none
  onChange: (id: string) => void;
  disabled?: boolean;
  nav?: boolean; // compact nav-bar variant
}

const PenLineIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export function StylePicker({ styles, value, onChange, disabled, nav = false }: StylePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = styles.find(s => s.id === value);

  return (
    <div className={`style-picker ${nav ? "nav" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`style-picker-trigger ${open ? "open" : ""} ${active ? "has-value" : ""}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={active ? `Writing style: ${active.name}` : "Writing style"}
      >
        <span className="style-picker-icon"><PenLineIcon /></span>
        <span className="style-picker-label">{active ? active.name : "Style"}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="style-picker-dropdown">
          <div className="style-picker-header">Writing style</div>
          <div className="style-picker-list">
            <button
              type="button"
              className={`style-picker-option ${!value ? "selected" : ""}`}
              onClick={() => { onChange(""); setOpen(false); }}
            >
              <span className="style-picker-check">{!value && <CheckIcon />}</span>
              <span className="style-picker-option-name">None</span>
            </button>
            {styles.map(s => {
              const sel = s.id === value;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`style-picker-option ${sel ? "selected" : ""}`}
                  onClick={() => { onChange(s.id); setOpen(false); }}
                >
                  <span className="style-picker-check">{sel && <CheckIcon />}</span>
                  <span className="style-picker-option-name">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
