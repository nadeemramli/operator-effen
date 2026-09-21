"use client";
import type { ReactNode } from "react";
import { ArrowUpRight, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type Lang,
  type Order,
  type Unit,
  product,
  tr,
  variance,
} from "@/lib/draft";

export const units = (lang: Lang, unit: Unit) =>
  tr(
    lang,
    unit === "bottle" ? "bottles" : unit === "box" ? "boxes" : "loose sachets",
    unit === "bottle" ? "botol" : unit === "box" ? "kotak" : "sachet longgar",
  );
export const fmt = (n: number) => n.toLocaleString("en-MY");
export function ProductName({ id }: { id: string }) {
  const p = product(id);
  return (
    <span className="product-name">
      <span className="product-dot" style={{ background: p.color }} />
      {p.name}
    </span>
  );
}
export function Status({ order, lang }: { order: Order; lang: Lang }) {
  const mismatch = variance(order) !== null && variance(order) !== 0;
  return (
    <span
      className={
        "status-pill " +
        (mismatch
          ? "tone-warning"
          : order.dispatched
            ? "tone-success"
            : order.actual !== null
              ? "tone-info"
              : "tone-muted")
      }
    >
      {mismatch
        ? tr(lang, "Count mismatch", "Jumlah berbeza")
        : order.dispatched
          ? tr(lang, "Handed over", "Diserah")
          : order.actual !== null
            ? tr(lang, "Packed", "Dibungkus")
            : order.printed
              ? tr(lang, "Ready to pack", "Sedia dibungkus")
              : tr(lang, "Awaiting print", "Menunggu cetakan")}
    </span>
  );
}
export function Panel({
  title,
  detail,
  action,
  children,
  className = "",
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {detail && <p>{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Metric({
  label,
  value,
  detail,
  color = "var(--foreground)",
  onClick,
}: {
  label: string;
  value: string | number;
  detail: string;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="metric"
      onClick={onClick}
      disabled={!onClick}
    >
      <span>
        {label}
        {onClick && <ArrowUpRight size={15} />}
      </span>
      <strong style={{ color }}>
        {typeof value === "number" ? fmt(value) : value}
      </strong>
      <small>{detail}</small>
    </button>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <p>{children}</p>
    </div>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "time" | "textarea" | "select";
  options?: { value: string; label: string }[];
  value?: string | number;
  required?: boolean;
  min?: number;
  hint?: string;
};
export type FormSpec = {
  type: string;
  title: string;
  description: string;
  fields: Field[];
  hidden?: Record<string, string | number>;
  submit?: string;
};
export function ActionForm({
  spec,
  lang,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  spec: FormSpec | null;
  lang: Lang;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (type: string, values: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <Dialog
      open={!!spec}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{spec?.title}</DialogTitle>
          <DialogDescription>{spec?.description}</DialogDescription>
        </DialogHeader>
        {spec && (
          <form
            key={spec.title + JSON.stringify(spec.hidden)}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onSubmit(spec.type, {
                ...spec.hidden,
                ...Object.fromEntries(new FormData(event.currentTarget)),
              });
            }}
          >
            {spec.fields.map((field) => (
              <div className="space-y-2" key={field.name}>
                <Label htmlFor={"field-" + field.name}>
                  {field.label}
                  {field.required === false ? (
                    <small className="text-muted-foreground">
                      ({tr(lang, "optional", "pilihan")})
                    </small>
                  ) : null}
                </Label>
                {field.type === "select" ? (
                  <select
                    id={"field-" + field.name}
                    name={field.name}
                    className="form-select"
                    defaultValue={field.value ?? ""}
                    required={field.required !== false}
                  >
                    <option value="" disabled>
                      {tr(lang, "Select…", "Pilih…")}
                    </option>
                    {field.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <Textarea
                    id={"field-" + field.name}
                    name={field.name}
                    defaultValue={field.value ?? ""}
                    required={field.required !== false}
                    maxLength={2000}
                  />
                ) : (
                  <Input
                    id={"field-" + field.name}
                    name={field.name}
                    type={field.type ?? "text"}
                    defaultValue={field.value ?? ""}
                    required={field.required !== false}
                    min={field.type === "number" ? (field.min ?? 0) : undefined}
                    max={field.type === "number" ? 1000000 : undefined}
                    step={field.type === "number" ? 1 : undefined}
                    maxLength={2000}
                  />
                )}{" "}
                {field.hint && <p className="field-hint">{field.hint}</p>}
              </div>
            ))}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                {tr(lang, "Cancel", "Batal")}
              </Button>
              <Button type="submit" className="action-primary" disabled={busy}>
                {busy
                  ? tr(lang, "Saving…", "Menyimpan…")
                  : (spec.submit ?? tr(lang, "Save record", "Simpan rekod"))}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
