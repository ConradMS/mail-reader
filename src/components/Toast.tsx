import { useState, useCallback } from "react";

type ToastType = "error" | "success" | "info";
interface ToastItem { id: number; message: string; type: ToastType }

let _nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, type: ToastType = "info", duration = 5000) => {
    const id = _nextId++;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, show, dismiss };
}

interface Props {
  toasts: ReturnType<typeof useToast>["toasts"];
  dismiss: (id: number) => void;
}

const ICON: Record<string, string> = { error: "✕", success: "✓", info: "ℹ" };

export function ToastContainer({ toasts, dismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismiss(t.id)}>
          <span style={{ flexShrink: 0 }}>{ICON[t.type]}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
