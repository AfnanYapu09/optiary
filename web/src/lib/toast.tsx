import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Toast = { id: number; text: string; tone: "ok" | "err" | "info" };

const ToastContext = createContext<((text: string, tone?: Toast["tone"]) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, text, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={t.tone === "info" ? "" : t.tone}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}
