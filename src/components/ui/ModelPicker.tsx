import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, CheckIcon, RefreshIcon, BotIcon } from "./icons";

interface ModelPickerProps {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  status?: "idle" | "loading" | "error";
  onRetry?: () => void;
  disabled?: boolean;
  compact?: boolean;
  nav?: boolean; // header-nav style: shows bot icon, no border, pill bg
}

function shortName(model: string) {
  return model.replace(/:latest$/, "");
}

function modelTag(model: string) {
  const parts = model.split(":");
  return parts.length > 1 ? parts[1] : "latest";
}

export function ModelPicker({
  models,
  value,
  onChange,
  status = "idle",
  onRetry,
  disabled,
  compact = false,
  nav = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status === "loading") {
    return <span className="ui-model-loading">Loading models…</span>;
  }

  if (status === "error") {
    return (
      <div className="ui-model-error">
        <span>Ollama offline</span>
        {onRetry && (
          <button type="button" className="ui-model-retry" onClick={onRetry}>
            <RefreshIcon /> Retry
          </button>
        )}
      </div>
    );
  }

  const variantClass = nav ? "nav" : compact ? "compact" : "";

  return (
    <div className={`ui-model-picker ${variantClass}`} ref={wrapRef}>
      <button
        type="button"
        className={`ui-model-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={value}
      >
        {nav && <span className="ui-model-trigger-icon"><BotIcon /></span>}
        <span className="ui-model-trigger-name">{value ? shortName(value) : "Select model"}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="ui-model-dropdown">
          <div className="ui-model-dropdown-header">
            <span>Available models</span>
          </div>
          <div className="ui-model-dropdown-list">
            {models.length === 0 && (
              <p className="ui-model-empty">No models found</p>
            )}
            {models.map(m => {
              const selected = m === value;
              return (
                <button
                  key={m}
                  type="button"
                  className={`ui-model-option ${selected ? "selected" : ""}`}
                  onClick={() => { onChange(m); setOpen(false); }}
                >
                  <span className="ui-model-option-check">
                    {selected && <CheckIcon />}
                  </span>
                  <span className="ui-model-option-info">
                    <span className="ui-model-option-name">{shortName(m)}</span>
                    <span className="ui-model-option-tag">{modelTag(m)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
