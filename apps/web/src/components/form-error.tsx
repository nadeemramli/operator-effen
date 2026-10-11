"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * An error that cannot be missed: strong colours, an icon, announced to screen readers, and
 * scrolled into view and focused when it appears. Place it next to the button that caused it.
 */
export function FormError({
  message,
  action,
  id,
  className = "",
}: {
  message: string;
  action?: ReactNode;
  id?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !message) return;
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [message]);
  if (!message) return null;
  return (
    <div
      ref={ref}
      id={id}
      className={"form-error-strong " + className}
      role="alert"
      tabIndex={-1}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="form-error-body">
        <div>{message}</div>
        {action && <div className="form-error-action">{action}</div>}
      </div>
    </div>
  );
}
