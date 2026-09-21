"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  FileText,
  LoaderCircle,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Panel, units } from "./draft-primitives";
import {
  products,
  today,
  tr,
  type Draft,
  type Lang,
  type Role,
} from "@/lib/draft";
import {
  channels,
  couriers,
  defaultFor,
  parsePages,
  rowProblems,
  rowStatus,
  type AwbImport,
  type ImportRow,
  type ParsedPage,
  type ImportFile,
} from "@/lib/awb-import";

type Props = {
  state: Draft;
  lang: Lang;
  role: Role;
  busy: boolean;
  onCommand: (
    type: string,
    input: Record<string, unknown>,
  ) => Promise<Draft | null>;
  children: ReactNode;
};
export function AwbIntake({
  state,
  lang,
  role,
  busy,
  onCommand,
  children,
}: Props) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [screen, setScreen] = useState("register"),
    [working, setWorking] = useState<AwbImport | null>(null),
    [selected, setSelected] = useState("");
  const [files, setFiles] = useState<File[]>([]),
    [store, setStore] = useState(""),
    [channel, setChannel] = useState("Luxana"),
    [date, setDate] = useState(today);
  const [processing, setProcessing] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [forceOcr, setForceOcr] = useState(false);
  const [filter, setFilter] = useState("all"),
    [preview, setPreview] = useState<{ file: ImportFile; page: number } | null>(
      null,
    );
  const abort = useRef<AbortController | null>(null);
  const batch = working;
  const row = batch?.rows.find((r) => r.id === selected);
  const statuses =
    batch?.rows.map((r) => ({ row: r, status: rowStatus(r, batch, state) })) ??
    [];
  const canEdit = role === "admin" && !batch?.confirmedAt && !busy;
  useEffect(() => {
    if (!processing && !dirty) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [processing, dirty]);
  useEffect(() => () => abort.current?.abort(), []);
  function open(b: AwbImport) {
    setWorking(structuredClone(b));
    setScreen("review");
    setSelected(b.rows[0]?.id ?? "");
    setDirty(false);
    setError("");
    setPreview(null);
  }
  async function upload() {
    setError("");
    if (!files.length || files.length > 10 || !store.trim() || !date) {
      setError(
        t(
          "Choose up to 10 PDFs, a store and work date.",
          "Pilih sehingga 10 PDF, kedai dan tarikh kerja.",
        ),
      );
      return;
    }
    if (
      files.some(
        (f) =>
          f.size > 20 * 1024 * 1024 || !f.name.toLowerCase().endsWith(".pdf"),
      ) ||
      files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024
    ) {
      setError(
        t(
          "PDFs only: 20 MB per file, 50 MB per batch.",
          "PDF sahaja: 20 MB setiap fail, 50 MB setiap kelompok.",
        ),
      );
      return;
    }
    setProcessing(true);
    abort.current = new AbortController();
    const sourceFiles: ImportFile[] = [],
      pages: ParsedPage[] = [];
    try {
      const { readAwbPdf } = await import("@/lib/read-awb-pdf");
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-"))
          throw new Error(
            t("This file is not a PDF: ", "Fail ini bukan PDF: ") + file.name,
          );
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (sourceFiles.some((f) => f.id === hash)) continue;
        const read = await readAwbPdf(
          file,
          hash,
          (page, total, ocr) =>
            setProgress(
              `${file.name} · ${page}/${total} · ${ocr ? "OCR" : t("Reading", "Membaca")}`,
            ),
          abort.current.signal,
          forceOcr,
        );
        if (pages.length + read.pages.length > 200)
          throw new Error(
            t(
              "Use up to 200 PDF pages per batch.",
              "Gunakan sehingga 200 halaman setiap kelompok.",
            ),
          );
        const res = await fetch("/api/awb-files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash, size: file.size }),
          signal: abort.current.signal,
        });
        const signed = await res.json();
        if (!res.ok) throw new Error(signed.error);
        if (!signed.exists) {
          setProgress(file.name + " · " + t("Saving PDF", "Menyimpan PDF"));
          const sent = await fetch(signed.url, {
            method: "PUT",
            headers: { "Content-Type": "application/pdf" },
            body: file,
            signal: abort.current.signal,
          });
          if (!sent.ok)
            throw new Error(
              t(
                "PDF upload failed. You can retry safely.",
                "Muat naik gagal. Anda boleh cuba semula.",
              ),
            );
        }
        sourceFiles.push({
          id: hash,
          name: file.name.slice(0, 200),
          path: signed.path,
          pages: read.pageCount,
          size: file.size,
        });
        pages.push(...read.pages);
      }
      const b: AwbImport = {
        id: crypto.randomUUID(),
        date,
        name: `${store.trim()} · ${date}`,
        files: sourceFiles,
        rows: parsePages(pages, channel, store.trim()),
        createdAt: "",
        updatedAt: "",
      };
      if (b.rows.length > 200)
        throw new Error(
          t(
            "Use up to 200 label records per batch. Split this PDF into smaller files.",
            "Gunakan sehingga 200 rekod label. Pecahkan PDF kepada fail lebih kecil.",
          ),
        );
      setWorking(b);
      setScreen("review");
      setSelected(b.rows[0]?.id ?? "");
      setDirty(true);
      const saved = await onCommand("import-save", { batch: b });
      if (saved) open(saved.awbImports!.find((x) => x.id === b.id)!);
    } catch (e) {
      setError(
        e instanceof Error && e.name !== "AbortError"
          ? e.message
          : t(
              "Stopped. Upload again to retry; existing PDFs are reused.",
              "Dihentikan. Muat naik semula untuk mencuba; PDF sedia ada digunakan semula.",
            ),
      );
    } finally {
      setProcessing(false);
      setProgress("");
    }
  }
  function change(patch: Partial<ImportRow>) {
    if (!batch || !row) return;
    setWorking({
      ...batch,
      rows: batch.rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r)),
    });
    setDirty(true);
  }
  async function save(release = false) {
    if (!batch) return;
    setError("");
    const saved = await onCommand("import-save", { batch });
    if (!saved) return;
    open(saved.awbImports!.find((b) => b.id === batch.id)!);
    if (release) {
      const released = await onCommand("import-release", { id: batch.id });
      if (released) open(released.awbImports!.find((b) => b.id === batch.id)!);
    }
  }
  const ready = statuses.filter((x) => x.status === "ready").length,
    attention = statuses.filter(
      (x) => x.status === "review" || x.status === "conflict",
    ).length;
  const statusText = (s: string) =>
    ({
      ready: t("Ready", "Sedia"),
      review: t("Needs review", "Perlu semakan"),
      duplicate: t("Duplicate · skipped", "Pendua · dilangkau"),
      conflict: t("Conflict", "Konflik"),
      excluded: t("Excluded", "Dikecualikan"),
      released: t("Released", "Diserahkan"),
    })[s] ?? s;
  const totals = products
    .map((p) => ({
      p,
      qty: statuses
        .filter((x) => x.status === "ready" || x.status === "released")
        .reduce(
          (n, { row: r }) =>
            n +
            r.lines
              .filter((l) => l.product === p.id)
              .reduce((m, l) => m + Number(l.packages) * Number(l.units), 0),
          0,
        ),
    }))
    .filter((x) => x.qty);
  return (
    <>
      <nav
        className="awb-tabs"
        aria-label={t("Order workspace", "Ruang pesanan")}
      >
        {[
          ["register", t("Order register", "Daftar pesanan")],
          ...(role === "admin"
            ? [["upload", t("Upload AWB batch", "Muat naik kelompok AWB")]]
            : []),
          ["batches", t("Handoff batches", "Kelompok serahan")],
        ].map(([key, label]) => (
          <Button
            key={key}
            variant={screen === key ? "secondary" : "ghost"}
            disabled={processing || dirty || busy}
            onClick={() => {
              setScreen(key);
              setError("");
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {screen === "register" ? children : null}
      {screen === "upload" && (
        <Panel
          title={t(
            "One upload. One clear handoff.",
            "Satu muat naik. Serahan yang jelas.",
          )}
          detail={t(
            "Send your PDFs through WhatsApp as usual, then upload the same files here.",
            "Hantar PDF melalui WhatsApp seperti biasa, kemudian muat naik fail yang sama di sini.",
          )}
        >
          <div className="awb-upload-body">
            <div className="awb-fields">
              <label>
                {t("Order source", "Sumber pesanan")}
                <select
                  className="form-select"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  disabled={processing}
                >
                  {channels.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("Store / seller account", "Kedai / akaun penjual")}
                <Input
                  value={store}
                  maxLength={120}
                  onChange={(e) => setStore(e.target.value)}
                  placeholder="e.g. Nuvital HQ MY"
                  disabled={processing}
                />
              </label>
              <label>
                {t("Work date", "Tarikh kerja")}
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={processing}
                />
              </label>
            </div>
            <label
              className="awb-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!processing) setFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <Upload size={25} />
              <strong>
                {t("Drop bulk AWB PDFs here", "Letakkan PDF AWB pukal di sini")}
              </strong>
              <span>
                {t(
                  "or choose files · up to 10 PDFs, 20 MB each, 200 pages in total",
                  "atau pilih fail · sehingga 10 PDF, 20 MB setiap satu, 200 halaman keseluruhan",
                )}
              </span>
              <input
                aria-label={t("Choose AWB PDFs", "Pilih PDF AWB")}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                disabled={processing}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            {files.length > 0 && (
              <ul className="awb-file-list">
                {files.map((f, i) => (
                  <li key={i}>
                    <FileText size={15} />
                    <span>{f.name}</span>
                    <small>{(f.size / 1024 / 1024).toFixed(1)} MB</small>
                  </li>
                ))}
              </ul>
            )}
            <label className="awb-check">
              <input
                type="checkbox"
                checked={forceOcr}
                onChange={(e) => setForceOcr(e.target.checked)}
                disabled={processing}
              />
              {t(
                "Use OCR on every page (for PDFs with missing or broken text)",
                "Gunakan OCR pada semua halaman (jika teks PDF hilang atau rosak)",
              )}
            </label>
            <p className="field-hint">
              {t(
                "Text is read first; image-only pages use OCR automatically. Keep this page open while processing. Extracted counts need Admin confirmation.",
                "Teks dibaca dahulu; halaman imej menggunakan OCR secara automatik. Biarkan halaman ini terbuka semasa pemprosesan. Jumlah diekstrak memerlukan pengesahan Admin.",
              )}
            </p>
            <div className="awb-actions">
              {processing ? (
                <>
                  <span role="status">
                    <LoaderCircle className="animate-spin" size={16} />
                    {progress}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => abort.current?.abort()}
                  >
                    {t("Stop", "Henti")}
                  </Button>
                </>
              ) : (
                <Button
                  className="action-primary"
                  disabled={!files.length || busy}
                  onClick={() => void upload()}
                >
                  <Upload size={16} />
                  {t("Read PDFs", "Baca PDF")}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}
      {screen === "batches" && (
        <Panel
          title={t("Handoff batches", "Kelompok serahan")}
          detail={t(
            "Saved reviews and confirmed Admin handoffs.",
            "Semakan disimpan dan serahan Admin disahkan.",
          )}
        >
          <div className="awb-batch-list">
            {!state.awbImports?.length && (
              <p>{t("No PDF batches yet.", "Belum ada kelompok PDF.")}</p>
            )}
            {state.awbImports?.map((b) => (
              <button
                key={b.id}
                className="awb-batch-link"
                onClick={() => open(b)}
              >
                <FileText size={18} />
                <span>
                  <strong>{b.name}</strong>
                  <small>
                    {b.files.length} PDF ·{" "}
                    {b.rows.filter((r) => r.releasedOrderId).length}{" "}
                    {t("released AWBs", "AWB diserahkan")}
                  </small>
                </span>
                <span className="status-pill tone-muted">
                  {b.receivedAt
                    ? t("Received", "Diterima")
                    : b.confirmedAt
                      ? t("Awaiting receipt", "Menunggu penerimaan")
                      : t("Draft review", "Semakan draf")}
                </span>
              </button>
            ))}
          </div>
        </Panel>
      )}
      {screen === "review" && batch && (
        <>
          <div className="toolbar">
            <Button
              variant="ghost"
              disabled={busy || dirty}
              onClick={() => setScreen("batches")}
            >
              <ArrowLeft size={16} />
              {t("Batches", "Kelompok")}
            </Button>
            <span>{batch.name}</span>
            <div className="awb-actions">
              {canEdit && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void save()}
                  >
                    {dirty
                      ? t("Save review *", "Simpan semakan *")
                      : t("Save review", "Simpan semakan")}
                  </Button>
                  <Button
                    className="action-primary"
                    disabled={busy || !ready || attention > 0}
                    onClick={() => void save(true)}
                  >
                    <Check size={16} />
                    {t("Confirm handoff", "Sahkan serahan")} · {ready}
                  </Button>
                </>
              )}
            </div>
          </div>
          {batch.confirmedAt ? (
            <div className="inline-note">
              <Check size={17} />
              {t(
                "Admin handoff confirmed. Printing, packing and dispatch are recorded separately.",
                "Serahan Admin disahkan. Cetakan, pembungkusan dan penghantaran direkod berasingan.",
              )}
            </div>
          ) : (
            <div className="inline-note">
              {t(
                "Review the summary once. Resolve or exclude flagged labels; duplicates are skipped. No stock changes until operational movements are recorded.",
                "Semak ringkasan sekali. Selesaikan atau kecualikan label bermasalah; pendua dilangkau. Stok tidak berubah sehingga pergerakan operasi direkod.",
              )}
            </div>
          )}
          <div className="awb-summary">
            <span>
              <strong>
                {
                  new Set(
                    batch.rows
                      .filter((r) => r.awb && !r.excluded)
                      .map((r) => r.awb),
                  ).size
                }
              </strong>{" "}
              AWB
            </span>
            <span>
              <strong>
                {
                  new Set(
                    batch.rows
                      .filter((r) => !r.excluded && r.orderRef)
                      .map((r) =>
                        JSON.stringify([r.channel, r.store, r.orderRef]),
                      ),
                  ).size
                }
              </strong>{" "}
              {t("orders", "pesanan")}
            </span>
            <span>
              <strong>{attention}</strong> {t("need review", "perlu semakan")}
            </span>
            <span>
              <strong>
                {statuses.filter((x) => x.status === "duplicate").length}
              </strong>{" "}
              {t("duplicates", "pendua")}
            </span>
            {totals.map(({ p, qty }) => (
              <span key={p.id}>
                <strong>{qty}</strong>
                {p.name} · {units(lang, p.unit)}
              </span>
            ))}
          </div>
          {role === "outbound" && batch.confirmedAt && !batch.receivedAt && (
            <form
              className="awb-receive"
              onSubmit={async (e) => {
                e.preventDefault();
                const pic = String(new FormData(e.currentTarget).get("pic"));
                const saved = await onCommand("import-receive", {
                  id: batch.id,
                  pic,
                });
                if (saved)
                  open(saved.awbImports!.find((b) => b.id === batch.id)!);
              }}
            >
              <label>
                {t("Received by", "Diterima oleh")}
                <Input name="pic" required maxLength={100} />
              </label>
              <Button type="submit" disabled={busy}>
                {t("Acknowledge receipt", "Sahkan penerimaan")}
              </Button>
            </form>
          )}
          {batch.receivedAt && (
            <p className="field-hint">
              {t("Received by", "Diterima oleh")}: {batch.receivedBy} ·{" "}
              {new Date(batch.receivedAt).toLocaleString(
                lang === "ms" ? "ms-MY" : "en-MY",
              )}
            </p>
          )}
          <div className="awb-review-grid">
            <section className="panel awb-review-list">
              <div className="panel-heading">
                <h2>{t("Labels", "Label")}</h2>
                <select
                  className="compact-select"
                  aria-label={t("Label filter", "Penapis label")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{t("All labels", "Semua label")}</option>
                  <option value="attention">
                    {t("Needs attention", "Perlu perhatian")}
                  </option>
                </select>
              </div>
              {statuses
                .filter(
                  (x) =>
                    filter === "all" ||
                    ["review", "conflict"].includes(x.status),
                )
                .map(({ row: r, status }) => (
                  <button
                    className={
                      "awb-label-row " + (r.id === selected ? "selected" : "")
                    }
                    key={r.id}
                    onClick={() => {
                      setSelected(r.id);
                      setPreview(null);
                    }}
                  >
                    <span className="mono">
                      {r.awb ||
                        (r.reviewNote === "Linked packing list"
                          ? t(
                              "Linked packing list",
                              "Senarai pembungkusan dipautkan",
                            )
                          : t(
                              "Unidentified label",
                              "Label belum dikenal pasti",
                            ))}
                    </span>
                    <small>
                      {r.orderRef || "—"} · {r.channel}
                    </small>
                    <span
                      className={
                        "status-pill " +
                        (["review", "conflict"].includes(status)
                          ? "tone-warning"
                          : "tone-muted")
                      }
                    >
                      {statusText(status)}
                    </span>
                  </button>
                ))}
              {canEdit && (
                <Button
                  variant="ghost"
                  className="m-3"
                  onClick={() => {
                    const first = batch.files[0];
                    if (!first) return;
                    const r: ImportRow = {
                      id: crypto.randomUUID(),
                      awb: "",
                      orderRef: "",
                      channel,
                      store,
                      courier: "",
                      lines: [],
                      sources: [{ file: first.id, page: 1, method: "manual" }],
                      warnings: [
                        "Manually added label: confirm its source page",
                      ],
                      reviewed: false,
                      reviewNote: "",
                      excluded: false,
                      original: "{}",
                    };
                    setWorking({ ...batch, rows: [...batch.rows, r] });
                    setSelected(r.id);
                    setDirty(true);
                  }}
                >
                  <Plus size={15} />
                  {t("Add missed label", "Tambah label tertinggal")}
                </Button>
              )}
            </section>
            <section className="panel awb-editor">
              {row ? (
                <>
                  <div className="panel-heading">
                    <h2>{t("Label details", "Butiran label")}</h2>
                    <span className="status-pill tone-muted">
                      {statusText(rowStatus(row, batch, state))}
                    </span>
                  </div>
                  <div className="awb-editor-body">
                    <div className="awb-fields">
                      <label>
                        AWB
                        <Input
                          value={row.awb}
                          disabled={!canEdit}
                          onChange={(e) =>
                            change({
                              awb: e.target.value.toUpperCase(),
                              reviewed: false,
                            })
                          }
                        />
                      </label>
                      <label>
                        {t("Order reference", "Rujukan pesanan")}
                        <Input
                          value={row.orderRef}
                          disabled={!canEdit}
                          onChange={(e) =>
                            change({
                              orderRef: e.target.value,
                              reviewed: false,
                            })
                          }
                        />
                      </label>
                      <label>
                        {t("Store", "Kedai")}
                        <Input
                          value={row.store}
                          disabled={!canEdit}
                          onChange={(e) =>
                            change({ store: e.target.value, reviewed: false })
                          }
                        />
                      </label>
                      <label>
                        {t("Source", "Sumber")}
                        <select
                          className="form-select"
                          value={row.channel}
                          disabled={!canEdit}
                          onChange={(e) => change({ channel: e.target.value })}
                        >
                          {channels.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t("Courier", "Kurier")}
                        <select
                          className="form-select"
                          value={row.courier}
                          disabled={!canEdit}
                          onChange={(e) => change({ courier: e.target.value })}
                        >
                          <option value="">
                            {t("Select courier", "Pilih kurier")}
                          </option>
                          {couriers.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <h3 className="section-label">
                      {t(
                        "EXPECTED CONTENTS · EDITABLE FULLKIT DEFAULTS",
                        "KANDUNGAN DIJANGKA · NILAI ASAS FULLKIT BOLEH DIEDIT",
                      )}
                    </h3>
                    {row.lines.map((line, i) => {
                      const update = (patch: Partial<typeof line>) =>
                        change({
                          lines: row.lines.map((l, j) =>
                            i === j ? { ...l, ...patch } : l,
                          ),
                          reviewed: false,
                        });
                      return (
                        <div className="awb-line" key={i}>
                          <label>
                            SKU
                            <Input
                              value={line.sku}
                              disabled={!canEdit}
                              onChange={(e) => {
                                const d = defaultFor(e.target.value);
                                update({
                                  sku: e.target.value,
                                  ...(d
                                    ? {
                                        product: d.product,
                                        units: d.units,
                                        originalUnits: d.units,
                                        canonical: d.canonical,
                                      }
                                    : {}),
                                });
                              }}
                            />
                          </label>
                          <label>
                            {t("Product", "Produk")}
                            <select
                              className="form-select"
                              value={line.product}
                              disabled={!canEdit}
                              onChange={(e) =>
                                update({ product: e.target.value })
                              }
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
                            {t("Packages", "Pakej")}
                            <Input
                              type="number"
                              min={1}
                              value={line.packages ?? ""}
                              disabled={!canEdit}
                              onChange={(e) =>
                                update({
                                  packages:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("Units / package", "Unit / pakej")}
                            <Input
                              type="number"
                              min={1}
                              value={line.units ?? ""}
                              disabled={!canEdit}
                              onChange={(e) =>
                                update({
                                  units:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                })
                              }
                            />
                          </label>
                          <small>
                            {line.packages && line.units
                              ? `${line.packages * line.units} ${units(lang, products.find((p) => p.id === line.product)?.unit ?? "bottle")}`
                              : "—"}
                          </small>
                          {canEdit && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={
                                t("Remove line", "Padam baris") + ` ${i + 1}`
                              }
                              onClick={() =>
                                change({
                                  lines: row.lines.filter((_, j) => j !== i),
                                  reviewed: false,
                                })
                              }
                            >
                              <X size={14} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                    {canEdit && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          change({
                            lines: [
                              ...row.lines,
                              {
                                sku: "",
                                product: "",
                                packages: null,
                                units: null,
                                originalUnits: null,
                                canonical: "Manual mapping",
                              },
                            ],
                            reviewed: false,
                          })
                        }
                      >
                        <Plus size={15} />
                        {t("Add product line", "Tambah baris produk")}
                      </Button>
                    )}
                    {(rowProblems(row).length > 0 ||
                      ["review", "conflict"].includes(
                        rowStatus(row, batch, state),
                      )) && (
                      <div className="awb-problems">
                        <strong>
                          {t(
                            "Check before confirming",
                            "Semak sebelum mengesahkan",
                          )}
                        </strong>
                        <ul>
                          {rowProblems(row).map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                          {rowStatus(row, batch, state) === "conflict" && (
                            <li>
                              {t(
                                "This AWB has different details elsewhere. Resolve the conflicting draft or exclude it; a released order requires supervisor correction.",
                                "AWB ini mempunyai butiran berbeza. Selesaikan konflik atau kecualikan; pesanan diserahkan memerlukan pembetulan penyelia.",
                              )}
                            </li>
                          )}
                          {rowStatus(row, batch, state) === "review" &&
                            !rowProblems(row).length && (
                              <li>
                                {t(
                                  "This order has multiple AWBs. Confirm the allocation for this parcel.",
                                  "Pesanan ini mempunyai beberapa AWB. Sahkan kandungan untuk bungkusan ini.",
                                )}
                              </li>
                            )}
                        </ul>
                      </div>
                    )}
                    <label>
                      {t(
                        "Review / exclusion note",
                        "Catatan semakan / pengecualian",
                      )}
                      <Input
                        maxLength={1000}
                        value={row.reviewNote}
                        disabled={!canEdit}
                        onChange={(e) => change({ reviewNote: e.target.value })}
                      />
                    </label>
                    {canEdit && (
                      <div className="awb-review-checks">
                        <label className="awb-check">
                          <input
                            type="checkbox"
                            checked={row.reviewed}
                            onChange={(e) =>
                              change({ reviewed: e.target.checked })
                            }
                          />
                          {t(
                            "I checked the flagged fields and parcel allocation",
                            "Saya telah menyemak butiran dan kandungan bungkusan",
                          )}
                        </label>
                        <label className="awb-check">
                          <input
                            type="checkbox"
                            checked={row.excluded}
                            onChange={(e) =>
                              change({ excluded: e.target.checked })
                            }
                          />
                          {t(
                            "Exclude from this handoff (reason required)",
                            "Kecualikan daripada serahan ini (sebab diperlukan)",
                          )}
                        </label>
                      </div>
                    )}
                    {row.sources.some((s) => s.method === "manual") && (
                      <div className="awb-fields">
                        <label>
                          {t("Source PDF", "PDF sumber")}
                          <select
                            className="form-select"
                            disabled={!canEdit}
                            value={row.sources[0].file}
                            onChange={(e) => {
                              change({
                                sources: [
                                  {
                                    file: e.target.value,
                                    page: 1,
                                    method: "manual",
                                  },
                                ],
                                reviewed: false,
                              });
                              setPreview(null);
                            }}
                          >
                            {batch.files.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Source page", "Halaman sumber")}
                          <Input
                            type="number"
                            min={1}
                            max={
                              batch.files.find(
                                (f) => f.id === row.sources[0].file,
                              )?.pages
                            }
                            disabled={!canEdit}
                            value={row.sources[0].page}
                            onChange={(e) => {
                              change({
                                sources: [
                                  {
                                    ...row.sources[0],
                                    page: Number(e.target.value),
                                  },
                                ],
                                reviewed: false,
                              });
                              setPreview(null);
                            }}
                          />
                        </label>
                      </div>
                    )}
                    <div className="awb-source-links">
                      {row.sources.map((s, i) => {
                        const f = batch.files.find((f) => f.id === s.file)!;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            key={i}
                            onClick={() =>
                              setPreview({ file: f, page: s.page })
                            }
                          >
                            <FileText size={14} />
                            {f.name} · {t("page", "halaman")} {s.page} ·{" "}
                            {s.method}
                          </Button>
                        );
                      })}
                    </div>
                    {preview && (
                      <PdfSource
                        file={preview.file}
                        page={preview.page}
                        lang={lang}
                      />
                    )}
                    <details className="field-hint">
                      <summary>
                        {t("Original extraction", "Hasil asal")}
                      </summary>
                      <pre className="awb-original">{row.original}</pre>
                    </details>
                  </div>
                </>
              ) : (
                <p className="p-5">
                  {t("Select a label to review.", "Pilih label untuk semakan.")}
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function PdfSource({
  file,
  page,
  lang,
}: {
  file: ImportFile;
  page: number;
  lang: Lang;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let cleanup: (() => Promise<void>) | undefined;
    async function render() {
      try {
        const res = await fetch(
          "/api/awb-files?path=" + encodeURIComponent(file.path),
        );
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
        const task = pdfjs.getDocument({ url: result.url });
        cleanup = () => task.destroy();
        const doc = await task.promise;
        if (!active) {
          await task.destroy();
          return;
        }
        const p = await doc.getPage(page);
        if (!canvas.current) return;
        const viewport = p.getViewport({ scale: 1.5 });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        await p.render({ canvas: canvas.current, viewport }).promise;
      } catch {
        if (active)
          setError(
            tr(
              lang,
              "Unable to preview this PDF. Try opening it again.",
              "Pratonton PDF gagal. Cuba buka semula.",
            ),
          );
      }
    }
    void render();
    return () => {
      active = false;
      void cleanup?.();
    };
  }, [file.path, page, lang]);
  return (
    <div className="awb-pdf-preview">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <canvas ref={canvas} aria-label={`${file.name}, ${page}`} />
      )}
    </div>
  );
}
