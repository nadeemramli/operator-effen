"use client";
import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { FormError, Panel } from "./draft-primitives";
import {
  products,
  recorderLabel,
  tr,
  type Draft,
  type Lang,
} from "@/lib/draft";
import {
  catalogSections,
  defaultPackageName,
  marketFor,
  packageCatalog,
  skuMarkets,
  type CatalogEntry,
  type SkuMarket,
} from "@/lib/awb-import";

type Command = (
  type: string,
  input: Record<string, unknown>,
  options?: { onError?: (message: string) => void },
) => Promise<Draft | null>;
type Form = {
  sku: string;
  name: string;
  product: string;
  market: SkuMarket | "";
  units: string;
  canonical: string;
  reason: string;
};
/** What the form is doing: adding (optionally into a section) or editing one entry. */
type Editor =
  | { mode: "add"; section?: string; form: Form }
  | { mode: "edit"; entry: CatalogEntry; form: Form };
const blank: Form = {
  sku: "",
  name: "",
  product: "",
  market: "",
  units: "",
  canonical: "",
  reason: "",
};
const when = (iso: string | undefined, lang: Lang) =>
  iso
    ? new Date(iso).toLocaleString(lang === "ms" ? "ms-MY" : "en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " MYT"
    : "—";

/**
 * Package SKUs (office admin): the package SKU catalogue, grouped by product and market.
 * Built-in SKUs are the starting values; the admin edits, retires or reactivates any SKU
 * and adds new ones. Every later AWB import resolves SKUs through this catalogue. Nothing
 * is deleted: a SKU no longer in use is retired, with its history kept.
 */
export function SkuAliasPanel({
  state,
  lang,
  busy,
  command,
}: {
  state: Draft;
  lang: Lang;
  busy: boolean;
  command: Command;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [editor, setEditor] = useState<Editor | null>(null),
    [status, setStatus] = useState<{ entry: CatalogEntry; reason: string } | null>(
      null,
    ),
    [open, setOpen] = useState<string | null>(null),
    [collapsed, setCollapsed] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [showRetired, setShowRetired] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const catalog = packageCatalog(state.skuAliases);
  const retiredCount = catalog.filter((e) => !e.active).length;
  const q = query.trim().toLowerCase();
  const visible = catalog.filter(
    (e) =>
      (showRetired || e.active) &&
      (!q ||
        e.name.toLowerCase().includes(q) ||
        e.sku.includes(q) ||
        e.canonical.toLowerCase().includes(q)),
  );
  // Sections come from the whole catalogue, so a section emptied by the filters still
  // keeps its place and its "Add SKU" button when nothing is being searched.
  const sections = catalogSections(catalog)
    .map((s) => ({
      ...s,
      shown: s.entries.filter((e) => visible.includes(e)),
    }))
    .filter((s) => s.shown.length || (!q && editor?.mode === "add" && editor.section === s.key));
  const productName = (id: string) =>
    products.find((p) => p.id === id)?.name ?? id;
  const unitsText = (n: number) =>
    t(
      `${n} ${n === 1 ? "unit" : "units"} per package`,
      `${n} unit setiap pakej`,
    );
  const clear = () => {
    setError("");
    setNotice("");
  };
  async function run(
    type: string,
    input: Record<string, unknown>,
    done: string,
  ) {
    clear();
    const saved = await command(type, input, { onError: setError });
    if (saved) setNotice(done);
    return !!saved;
  }
  function startAdd(section?: { key: string; product: string; market: SkuMarket }) {
    clear();
    setStatus(null);
    setEditor({
      mode: "add",
      section: section?.key,
      form: {
        ...blank,
        product: section?.product ?? "",
        market: section?.market ?? "",
      },
    });
    if (section) setCollapsed((c) => c.filter((k) => k !== section.key));
  }
  function startEdit(entry: CatalogEntry) {
    clear();
    setStatus(null);
    setOpen(null);
    setEditor({
      mode: "edit",
      entry,
      form: {
        sku: entry.sku,
        name: entry.name,
        product: entry.product,
        market: entry.market,
        units: String(entry.units),
        canonical: entry.canonical,
        reason: "",
      },
    });
  }
  function startStatus(entry: CatalogEntry) {
    clear();
    setEditor(null);
    setStatus({ entry, reason: "" });
  }
  /** The entry's record, or the built-in SKU itself when nobody has changed it yet. */
  const target = (e: CatalogEntry) =>
    e.id
      ? { id: e.id, expectedVersion: e.version }
      : { sku: e.sku, expectedVersion: 0 };
  async function save() {
    if (!editor) return;
    const { form } = editor;
    const sku = form.sku.trim().toLowerCase();
    const editing = editor.mode === "edit" ? editor.entry : null;
    const ok = await run(
      "sku-alias-save",
      {
        ...(editing ? target(editing) : {}),
        sku,
        name: form.name,
        product: form.product,
        market: form.market,
        units: form.units,
        canonical: form.canonical,
        ...(editing ? { reason: form.reason } : {}),
      },
      editing
        ? t(
            `${sku} updated. Labels read from now on use the new details.`,
            `${sku} dikemas kini. Label yang dibaca selepas ini menggunakan butiran baharu.`,
          )
        : t(
            `${sku} added. Every later import recognises it.`,
            `${sku} ditambah. Setiap import selepas ini mengenalinya.`,
          ),
    );
    if (ok) setEditor(null);
  }
  async function changeStatus() {
    if (!status) return;
    const { entry, reason } = status;
    const ok = await run(
      entry.active ? "sku-alias-retire" : "sku-alias-reactivate",
      { ...target(entry), reason },
      entry.active
        ? t(
            `${entry.sku} retired. Labels with it go to review as an unknown SKU.`,
            `${entry.sku} dihentikan. Label dengannya masuk semakan sebagai SKU tidak dikenali.`,
          )
        : t(
            `${entry.sku} is recognised again.`,
            `${entry.sku} dikenali semula.`,
          ),
    );
    if (ok) setStatus(null);
  }

  const formView = (current: Editor) => {
    const { form } = current;
    const editing = current.mode === "edit" ? current.entry : null;
    const set = (patch: Partial<Form>) =>
      setEditor({ ...current, form: { ...form, ...patch } } as Editor);
    const units = Number(form.units);
    const suggested =
      form.sku.trim() && form.product
        ? defaultPackageName({
            sku: form.sku,
            product: form.product,
            units: Number.isFinite(units) ? units : 0,
            canonical: form.canonical || form.sku,
            market: form.market || marketFor(form.sku, form.canonical),
          })
        : "";
    return (
      <form
        className="sku-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <strong className="sku-form-title">
          {editing
            ? t(`Edit ${editing.sku}`, `Sunting ${editing.sku}`)
            : t("Add a package SKU", "Tambah SKU pakej")}
        </strong>
        <div className="awb-fields">
          <label>
            SKU
            <Input
              value={form.sku}
              maxLength={40}
              required
              autoComplete="off"
              disabled={editing?.origin === "built-in"}
              placeholder={t("As printed on the label", "Seperti pada label")}
              onChange={(e) => set({ sku: e.target.value })}
            />
            {editing?.origin === "built-in" && (
              <small className="sku-field-note">
                {t(
                  "A built-in SKU keeps its SKU. If the shop renamed it, add the new SKU and retire this one.",
                  "SKU terbina dalam mengekalkan SKU-nya. Jika kedai menukar namanya, tambah SKU baharu dan hentikan yang ini.",
                )}
              </small>
            )}
          </label>
          <label>
            {t("Display name (optional)", "Nama paparan (pilihan)")}
            <Input
              value={form.name}
              maxLength={80}
              autoComplete="off"
              placeholder={suggested || t("For example Cavernosil Pakej 8", "Contoh Cavernosil Pakej 8")}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label>
            {t("Product", "Produk")}
            <select
              className="form-select"
              value={form.product}
              required
              onChange={(e) => set({ product: e.target.value })}
            >
              <option value="">{t("Select", "Pilih")}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Market", "Pasaran")}
            <select
              className="form-select"
              value={form.market}
              onChange={(e) => set({ market: e.target.value as SkuMarket | "" })}
            >
              <option value="">
                {t("From the SKU", "Ikut SKU")} (
                {marketFor(form.sku, form.canonical)})
              </option>
              {skuMarkets.map((m) => (
                <option key={m} value={m}>
                  {m === "MY" ? t("Malaysia (MY)", "Malaysia (MY)") : t("Singapore (SG)", "Singapura (SG)")}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Units per package", "Unit setiap pakej")}
            <Input
              type="number"
              min={1}
              max={1000}
              required
              value={form.units}
              onChange={(e) => set({ units: e.target.value })}
            />
          </label>
          <label>
            {t("Package code (optional)", "Kod pakej (pilihan)")}
            <Input
              value={form.canonical}
              maxLength={60}
              autoComplete="off"
              placeholder={t("For example SYN-SG-PK8", "Contoh SYN-SG-PK8")}
              onChange={(e) => set({ canonical: e.target.value })}
            />
          </label>
          {editing && (
            <label>
              {t("Reason for the change", "Sebab perubahan")}
              <Input
                value={form.reason}
                maxLength={500}
                required
                onChange={(e) => set({ reason: e.target.value })}
              />
            </label>
          )}
        </div>
        <FormError message={error} />
        <div className="awb-actions">
          <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
            {t("Cancel", "Batal")}
          </Button>
          <Button className="action-primary" disabled={busy}>
            {editing ? null : <Plus size={16} />}
            {editing
              ? t("Save changes", "Simpan perubahan")
              : t("Add SKU", "Tambah SKU")}
          </Button>
        </div>
      </form>
    );
  };

  const statusView = (s: { entry: CatalogEntry; reason: string }) => (
    <form
      className="awb-receive sku-status-form"
      onSubmit={(e) => {
        e.preventDefault();
        void changeStatus();
      }}
    >
      <label>
        {s.entry.active
          ? t(
              `Why retire ${s.entry.sku}? Labels with it will go to review.`,
              `Mengapa hentikan ${s.entry.sku}? Label dengannya akan masuk semakan.`,
            )
          : t(
              `Why reactivate ${s.entry.sku}?`,
              `Mengapa aktifkan semula ${s.entry.sku}?`,
            )}
        <Input
          value={s.reason}
          maxLength={500}
          required
          autoFocus
          onChange={(e) => setStatus({ ...s, reason: e.target.value })}
        />
      </label>
      <Button type="submit" variant="outline" disabled={busy}>
        {s.entry.active ? t("Retire", "Hentikan") : t("Reactivate", "Aktifkan semula")}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setStatus(null)}>
        {t("Cancel", "Batal")}
      </Button>
      <FormError className="sku-status-error" message={error} />
    </form>
  );

  const detail = (e: CatalogEntry) => {
    const rows: [string, ReactNode][] = [
      [t("Package code", "Kod pakej"), <span className="mono" key="c">{e.canonical}</span>],
      [t("Product", "Produk"), productName(e.product)],
      [t("Market", "Pasaran"), e.market],
      [
        t("Origin", "Asal"),
        e.origin === "built-in"
          ? e.id
            ? t("Built-in, changed here", "Terbina dalam, diubah di sini")
            : t("Built-in", "Terbina dalam")
          : t("Added here", "Ditambah di sini"),
      ],
    ];
    if (e.seed && e.id)
      rows.push([
        t("Built-in values", "Nilai terbina dalam"),
        `${productName(e.seed.product)} · ${unitsText(e.seed.units)} · ${e.seed.canonical}`,
      ]);
    if (e.createdAt) rows.push([t("Record created", "Rekod dicipta"), when(e.createdAt, lang)]);
    if (e.updatedAt) rows.push([t("Last updated", "Kemas kini terakhir"), when(e.updatedAt, lang)]);
    const kind = (k: string) =>
      ({
        created: t("Added", "Ditambah"),
        edited: t("Edited", "Disunting"),
        retired: t("Retired", "Dihentikan"),
        reactivated: t("Reactivated", "Diaktifkan semula"),
      })[k] ?? k;
    return (
      <div className="sku-detail">
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {e.history.length ? (
          <ol className="sku-history">
            {[...e.history].reverse().map((h, i) => (
              <li key={i}>
                <span>
                  <strong>{kind(h.kind)}</strong> · {when(h.at, lang)}
                  {h.recordedBy ? ` · ${recorderLabel(h.recordedBy)}` : ""}
                </span>
                {Object.keys(h.changes).length > 0 && h.kind !== "retired" && h.kind !== "reactivated" && (
                  <small>
                    {Object.entries(h.changes)
                      .map(([k, [a, b]]) => (a ? `${k}: ${a} → ${b}` : `${k}: ${b}`))
                      .join(" · ")}
                  </small>
                )}
                {h.reason && <small>“{h.reason}”</small>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t(
              "Unchanged since it was built in.",
              "Tidak berubah sejak terbina dalam.",
            )}
          </p>
        )}
      </div>
    );
  };

  const row = (e: CatalogEntry) => {
    const expanded = open === e.sku;
    const detailId = `sku-detail-${e.sku}`;
    const editingThis = editor?.mode === "edit" && editor.entry.sku === e.sku;
    return (
      <li key={e.sku} className={"sku-row" + (e.active ? "" : " retired")}>
        <div className="sku-row-main">
          <button
            type="button"
            className="sku-row-toggle"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setOpen(expanded ? null : e.sku)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span className="sku-row-text">
              <strong>{e.name}</strong>
              <small>
                SKU: <span className="mono">{e.sku}</span>
              </small>
            </span>
          </button>
          <span className="sku-row-units">{unitsText(e.units)}</span>
          <span className={"status-pill " + (e.active ? "tone-success" : "tone-warning")}>
            {e.active ? t("Active", "Aktif") : t("Retired", "Dihentikan")}
          </span>
          <span className="sku-row-actions">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              title={t(`Edit ${e.sku}`, `Sunting ${e.sku}`)}
              aria-label={t(`Edit ${e.sku}`, `Sunting ${e.sku}`)}
              onClick={() => startEdit(e)}
            >
              <Pencil size={15} />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              title={
                e.active
                  ? t(`Retire ${e.sku}`, `Hentikan ${e.sku}`)
                  : t(`Reactivate ${e.sku}`, `Aktifkan semula ${e.sku}`)
              }
              aria-label={
                e.active
                  ? t(`Retire ${e.sku}`, `Hentikan ${e.sku}`)
                  : t(`Reactivate ${e.sku}`, `Aktifkan semula ${e.sku}`)
              }
              onClick={() => startStatus(e)}
            >
              {e.active ? <Trash2 size={15} /> : <RotateCcw size={15} />}
            </Button>
          </span>
        </div>
        {editor && editingThis && formView(editor)}
        {status?.entry.sku === e.sku && statusView(status)}
        {expanded && (
          <div id={detailId}>{detail(e)}</div>
        )}
      </li>
    );
  };

  return (
    <Panel
      title={t("Package SKUs", "SKU pakej")}
      detail={t(
        "Every package SKU printed on AWB labels, by product and market. Edit, retire or add a SKU here: every later import follows this catalogue. Nothing is deleted; a retired SKU keeps its history.",
        "Setiap SKU pakej yang dicetak pada label AWB, mengikut produk dan pasaran. Sunting, hentikan atau tambah SKU di sini: setiap import selepas ini mengikut katalog ini. Tiada yang dipadam; SKU yang dihentikan mengekalkan sejarahnya.",
      )}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => startAdd()}
        >
          <Plus size={14} />
          {t("Add SKU", "Tambah SKU")}
        </Button>
      }
    >
      <div className="awb-upload-body sku-catalog">
        <div className="sku-toolbar">
          <label className="sku-search">
            <Search size={14} aria-hidden />
            <Input
              type="search"
              value={query}
              placeholder={t("Search name or SKU", "Cari nama atau SKU")}
              aria-label={t("Search name or SKU", "Cari nama atau SKU")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="awb-check">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
            />
            {t(`Show retired (${retiredCount})`, `Tunjuk yang dihentikan (${retiredCount})`)}
          </label>
        </div>
        {/* An open form shows its own error beside its fields. */}
        {!editor && !status && <FormError message={error} />}
        {notice && (
          <p className="text-sm text-success" role="status">
            {notice}
          </p>
        )}
        {editor?.mode === "add" && !editor.section && formView(editor)}
        {sections.length ? (
          <div className="sku-sections">
            {sections.map((s) => {
              const isCollapsed = collapsed.includes(s.key) && !q;
              const bodyId = `sku-section-${s.key.replace(":", "-")}`;
              const count = s.shown.length;
              return (
                <section key={s.key} className="sku-section">
                  <header className="sku-section-head">
                    <button
                      type="button"
                      className="sku-section-toggle"
                      aria-expanded={!isCollapsed}
                      aria-controls={bodyId}
                      onClick={() =>
                        setCollapsed((c) =>
                          c.includes(s.key) ? c.filter((k) => k !== s.key) : [...c, s.key],
                        )
                      }
                    >
                      {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      <strong>{s.title}</strong>
                      <small>
                        {t(
                          `${count} ${count === 1 ? "package" : "packages"}`,
                          `${count} pakej`,
                        )}
                      </small>
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={t(`Add SKU to ${s.title}`, `Tambah SKU ke ${s.title}`)}
                      onClick={() => startAdd(s)}
                    >
                      <Plus size={14} />
                      {t("Add SKU", "Tambah SKU")}
                    </Button>
                  </header>
                  {!isCollapsed && (
                    <div id={bodyId}>
                      {editor?.mode === "add" && editor.section === s.key && formView(editor)}
                      <ul className="sku-rows">{s.shown.map(row)}</ul>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {q
              ? t(
                  "No package SKU matches this search.",
                  "Tiada SKU pakej sepadan dengan carian ini.",
                )
              : t(
                  "No active package SKUs. Show retired ones, or add a SKU.",
                  "Tiada SKU pakej aktif. Tunjuk yang dihentikan, atau tambah SKU.",
                )}
          </p>
        )}
      </div>
    </Panel>
  );
}
