"use client";
import { PersonPicker, PersonBadge } from "./person-profile";
import { TripPhotoInput } from "./trip-photo";
import { FormError } from "./form-error";
export { FormError } from "./form-error";
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Inbox, X } from "lucide-react";
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
  orderLines,
  orderIssued,
  type Draft,
} from "@/lib/draft";

export function OrderProducts({ order }: { order: Order }) {
  return (
    <span className="order-line-values">
      {orderLines(order).map((l) => (
        <ProductName key={l.product} id={l.product} />
      ))}
    </span>
  );
}
export function OrderQuantities({
  order,
  lang,
  field,
  state,
}: {
  order: Order;
  lang: Lang;
  field: "expected" | "actual" | "issued" | "variance";
  state?: Draft;
}) {
  return (
    <span className="order-line-values">
      {orderLines(order).map((l) => (
        <span key={l.product}>
          {field === "issued"
            ? orderIssued(state!, order, l.product)
            : field === "variance"
              ? l.actual === null
                ? "—"
                : l.actual - l.expected
              : (l[field] ?? "—")}{" "}
          <small>
            {orderLines(order).length > 1
              ? product(l.product).short + " · "
              : ""}
            {units(lang, product(l.product).unit)}
          </small>
        </span>
      ))}
    </span>
  );
}

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
            : order.reviewState === "pending"
              ? tr(lang, "Awaiting review", "Menunggu semakan")
              : order.assignedPacker
                ? tr(lang, "Assigned to packer", "Ditugaskan kepada pembungkus")
                : tr(lang, "Awaiting assignment", "Menunggu tugasan")}
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
/**
 * Page-level errors also float at the bottom of the screen, so they are seen whatever the
 * scroll position. Hides after 8 seconds unless the pointer or focus is on it.
 */
export function ErrorToast({
  message,
  lang,
  onDismiss,
}: {
  message: string;
  lang: Lang;
  onDismiss: () => void;
}) {
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (!message || hold) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [message, hold, onDismiss]);
  if (!message) return null;
  return (
    <div
      className="toast-error"
      role="alert"
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={() => setHold(false)}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <p>{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={tr(lang, "Dismiss error", "Tutup ralat")}
      >
        <X size={16} />
      </button>
    </div>
  );
}
/** Server messages name a field by key ("Please complete pic."); show its label instead. */
export function fieldMessage(
  message: string,
  spec: FormSpec | null,
  lang: Lang,
): { message: string; field?: string } {
  const match = /Please (complete|enter) ([a-zA-Z_]+)\./.exec(message);
  const field = match && spec?.fields.find((f) => f.name === match[2]);
  if (!match || !field) return { message };
  return {
    message: message.replace(
      match[0],
      tr(lang, `${field.label} is required.`, `${field.label} diperlukan.`),
    ),
    field: field.name,
  };
}
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "date"
    | "datetime-local"
    | "time"
    | "textarea"
    | "select"
    | "person"
    | "photo";
  options?: { value: string; label: string }[];
  value?: string | number;
  required?: boolean;
  min?: number;
  hint?: string;
  profile?: { name: string; caption?: string };
  /** Photo fields: the operational workspace the photo is stored under. */
  workspace?: string;
};
export type FormSpec = {
  type: string;
  title: string;
  description: string;
  fields: Field[];
  hidden?: Record<string, string | number | string[]>;
  submit?: string;
  summary?: { label: string; value: string }[];
};
export function ActionForm({
  spec,
  lang,
  busy,
  error,
  invalidField,
  errorAction,
  onClose,
  onSubmit,
}: {
  spec: FormSpec | null;
  lang: Lang;
  busy: boolean;
  error: string;
  /** Field named by the last server error; marked invalid until the next submit. */
  invalidField?: string;
  /** Extra control shown in the error, for example "Try again". */
  errorAction?: ReactNode;
  onClose: () => void;
  onSubmit: (type: string, values: Record<string, unknown>) => Promise<unknown>;
}) {
  // Required fields the browser refused on the last submit attempt.
  const formKey = spec ? spec.title + JSON.stringify(spec.hidden) : "";
  const [refused, setRefused] = useState({ form: "", names: [] as string[] });
  const missing = refused.form === formKey ? refused.names : [];
  const setMissing = (update: (names: string[]) => string[]) =>
    setRefused((r) => ({
      form: formKey,
      names: update(r.form === formKey ? r.names : []),
    }));
  // The submit button is outlined red for 3 seconds after an error, to tie the two together.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!error) return;
    const on = setTimeout(() => setFlash(true), 0);
    const off = setTimeout(() => setFlash(false), 3000);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [error]);
  const errorId = "action-form-error";
  const invalid = (name: string) =>
    invalidField === name || missing.includes(name) ? true : undefined;
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
            key={formKey}
            className="space-y-4"
            onInvalidCapture={(event) => {
              const name = (event.target as HTMLInputElement).name;
              if (name)
                setMissing((m) => (m.includes(name) ? m : [...m, name]));
            }}
            onInputCapture={(event) => {
              const name = (event.target as HTMLInputElement).name;
              if (name && missing.includes(name))
                setMissing((m) => m.filter((x) => x !== name));
            }}
            onSubmit={(event) => {
              event.preventDefault();
              // Scrolls to the first invalid field when native validation was bypassed.
              if (!event.currentTarget.reportValidity()) return;
              setMissing(() => []);
              void onSubmit(spec.type, {
                ...spec.hidden,
                ...Object.fromEntries(new FormData(event.currentTarget)),
              });
            }}
          >
            {spec.summary && (
              <div className="action-summary">
                {spec.summary.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            )}
            {spec.fields.map((field) => (
              <div
                className={field.profile ? "profile-number-field" : "space-y-2"}
                key={field.name}
              >
                <Label htmlFor={"field-" + field.name}>
                  {field.profile ? (
                    <>
                      <PersonBadge
                        name={field.profile.name}
                        lang={lang}
                        caption={field.profile.caption}
                      />
                      <span className="sr-only">{field.label}</span>
                    </>
                  ) : (
                    field.label
                  )}
                  {field.required === false ? (
                    <small className="text-muted-foreground">
                      ({tr(lang, "optional", "pilihan")})
                    </small>
                  ) : null}
                </Label>
                {field.type === "photo" ? (
                  <TripPhotoInput
                    name={field.name}
                    lang={lang}
                    workspace={field.workspace}
                  />
                ) : field.type === "person" ? (
                  <PersonPicker
                    name={field.name}
                    label={field.label}
                    options={field.options ?? []}
                    value={field.value}
                    required={field.required !== false}
                    lang={lang}
                  />
                ) : field.type === "select" ? (
                  <select
                    id={"field-" + field.name}
                    aria-invalid={invalid(field.name)}
                    name={field.name}
                    className="form-select"
                    defaultValue={field.value ?? ""}
                    required={field.required !== false}
                  >
                    <option value="" disabled={field.required !== false}>
                      {field.required === false
                        ? tr(lang, "Not specified", "Tidak dinyatakan")
                        : tr(lang, "Select…", "Pilih…")}
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
                    aria-invalid={invalid(field.name)}
                    name={field.name}
                    defaultValue={field.value ?? ""}
                    required={field.required !== false}
                    maxLength={2000}
                  />
                ) : field.profile ? (
                  <div className="profile-quantity">
                    <span aria-hidden="true">
                      {tr(lang, "Parcels", "Bungkusan")}
                    </span>
                    <Input
                      id={"field-" + field.name}
                      aria-invalid={invalid(field.name)}
                      name={field.name}
                      type="number"
                      aria-label={field.label}
                      defaultValue={field.value ?? 0}
                      required={field.required !== false}
                      min={field.min ?? 0}
                      max={1000000}
                      step={1}
                    />
                  </div>
                ) : (
                  <Input
                    id={"field-" + field.name}
                    aria-invalid={invalid(field.name)}
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
                {(missing.includes(field.name) ||
                  invalidField === field.name) && (
                  <p className="field-missing">
                    {tr(
                      lang,
                      `${field.label} is required.`,
                      `${field.label} diperlukan.`,
                    )}
                  </p>
                )}
              </div>
            ))}
            <FormError id={errorId} message={error} action={errorAction} />
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                {tr(lang, "Cancel", "Batal")}
              </Button>
              <Button
                type="submit"
                className={"action-primary " + (flash ? "submit-invalid" : "")}
                disabled={busy}
                aria-describedby={error ? errorId : undefined}
              >
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
