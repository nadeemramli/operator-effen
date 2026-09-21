"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  Factory,
  History,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonBadge } from "./person-profile";
import {
  Empty,
  Panel,
  ProductName,
  fmt,
  units,
  type Field,
  type FormSpec,
} from "./draft-primitives";
import {
  batchUnit,
  products,
  product,
  stepNames,
  today,
  tr,
  type Batch,
  type Draft,
  type Lang,
} from "@/lib/draft";

type ProductionView = "log" | "plan" | "history";
const qcLabel = (value: string, lang: Lang) =>
  value === "pass"
    ? tr(lang, "Checked — passed", "Diperiksa — lulus")
    : value === "issue"
      ? tr(lang, "Issue recorded", "Isu direkodkan")
      : tr(
          lang,
          "Not recorded / not checked",
          "Tidak direkod / tidak diperiksa",
        );
function BatchStatus({ batch, lang }: { batch: Batch; lang: Lang }) {
  const complete = batch.steps.every((s) => s.done),
    started = batch.steps.some((s) => s.done);
  return (
    <span
      className={
        "status-pill " +
        (complete ? "tone-success" : started ? "tone-info" : "tone-muted")
      }
    >
      {complete
        ? tr(lang, "Recorded", "Direkodkan")
        : started
          ? tr(lang, "In progress", "Dalam proses")
          : tr(lang, "Planned", "Dirancang")}
    </span>
  );
}

export function ProductionWorkspace({
  state,
  lang,
  busy,
  command,
  show,
  pic,
  number,
  closeDay,
}: {
  state: Draft;
  lang: Lang;
  busy: boolean;
  command: (
    type: string,
    input: Record<string, unknown>,
  ) => Promise<Draft | null>;
  show: (spec: FormSpec) => void;
  pic: (name?: string, label?: string) => Field;
  number: (name: string, label: string, value?: number, min?: number) => Field;
  closeDay: () => void;
}) {
  const router = useRouter(),
    params = useSearchParams();
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const mode = params.get("production");
  const tab: ProductionView =
    mode === "plan" || mode === "history" ? mode : "log";
  const rawFactory = params.get("factory");
  const factory =
    rawFactory === "bottle" || rawFactory === "sachet" ? rawFactory : "all";
  const selectedId = params.get("batch");
  const selected = state.batches.find((b) => b.id === selectedId);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  function href(next: ProductionView, batch?: string) {
    const q = new URLSearchParams({ view: "production", production: next });
    if (factory !== "all") q.set("factory", factory);
    if (batch) q.set("batch", batch);
    return "/?" + q.toString();
  }
  function setFactory(next: string) {
    const q = new URLSearchParams(params.toString());
    q.set("view", "production");
    q.set("factory", next);
    q.delete("batch");
    router.replace("/?" + q.toString(), { scroll: false });
  }
  const newBatch = () => router.push(href("plan"));
  const visibleBatches = state.batches.filter(
    (b) =>
      (factory === "all" || batchUnit(b) === factory) &&
      (!selectedId || b.id === selectedId),
  );
  const historyBatches = state.batches
    .filter(
      (b) =>
        (factory === "all" || batchUnit(b) === factory) &&
        (b.code + " " + product(b.product).name + " " + b.date)
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (status === "all" ||
          (status === "recorded"
            ? b.steps.every((s) => s.done)
            : !b.steps.every((s) => s.done))),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const productionLog = (
    <>
      {selectedId && (
        <div className="batch-context">
          <Button asChild variant="outline">
            <Link href={href("log")}>
              <ArrowLeft size={15} />
              {t("All production batches", "Semua kelompok pengeluaran")}
            </Link>
          </Button>
          <span>{selected?.code}</span>
        </div>
      )}
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", t("All factories", "Semua kilang")],
            ["bottle", t("Bottle factory", "Kilang botol")],
            ["sachet", t("Sachet factory", "Kilang sachet")],
          ].map(([id, label]) => (
            <button
              key={id}
              className={factory === id ? "selected" : ""}
              onClick={() => setFactory(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button className="action-primary" onClick={newBatch}>
          <Plus size={16} />
          {t("Plan batch", "Rancang kelompok")}
        </Button>
      </div>
      {factory !== "bottle" && (
        <div className="inline-note">
          <AlertTriangle size={17} />
          {t(
            "Sachet steps are provisional until the factory form is supplied. Bottling follows the existing operator log.",
            "Langkah sachet masih cadangan sehingga borang kilang diterima. Pembotolan mengikut log operator sedia ada.",
          )}
        </div>
      )}
      {!visibleBatches.length && (
        <Empty>
          {t(
            "No batches in this view. Plan a batch or choose another factory.",
            "Tiada kelompok dalam paparan ini. Rancang kelompok atau pilih kilang lain.",
          )}
        </Empty>
      )}
      <div className="batch-grid">
        {state.batches
          .filter(
            (b) =>
              (factory === "all" || batchUnit(b) === factory) &&
              (!selectedId || b.id === selectedId),
          )
          .map((b) => (
            <section className="batch-card" key={b.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <ProductName id={b.product} />
                  <button
                    onClick={() => router.push(href("history", b.id))}
                    className="record-link mono block mt-2"
                  >
                    {b.code}
                  </button>
                </div>
                <BatchStatus batch={b} lang={lang} />
              </div>
              <div className="batch-stats">
                <span>
                  {t("Planned", "Dirancang")}
                  <strong>{fmt(b.target)}</strong>
                </span>
                <span>
                  {t("Finished", "Siap")}
                  <strong>{fmt(b.actual)}</strong>
                </span>
                <span>
                  {t("Sent to fulfilment", "Dihantar ke pemenuhan")}
                  <strong>{fmt(b.sent)}</strong>
                </span>
              </div>
              <div className="process-list">
                {b.steps.map((step, i) => (
                  <button
                    key={i}
                    disabled={step.done}
                    onClick={() =>
                      show({
                        type: "step",
                        title: stepNames(b)[i][lang === "ms" ? 1 : 0],
                        description:
                          b.code +
                          " · " +
                          t(
                            "Enter completed output and the actual performer.",
                            "Masukkan hasil siap dan pelaksana sebenar.",
                          ),
                        hidden: { id: b.id, step: i },
                        fields: [
                          pic(),
                          number(
                            "qty",
                            t("Output quantity", "Jumlah hasil") +
                              " (" +
                              units(lang, batchUnit(b)) +
                              ")",
                          ),
                          {
                            name: "start",
                            label: t("Start time", "Masa mula"),
                            type: "time",
                            required: false,
                          },
                          {
                            name: "end",
                            label: t("End time", "Masa tamat"),
                            type: "time",
                            required: false,
                          },
                          {
                            name: "qc",
                            label: t(
                              "QC result, if performed",
                              "Keputusan QC, jika dilakukan",
                            ),
                            type: "select",
                            value: "not-recorded",
                            options: [
                              {
                                value: "not-recorded",
                                label: t(
                                  "Not recorded / not checked",
                                  "Tidak direkod / tidak diperiksa",
                                ),
                              },
                              {
                                value: "pass",
                                label: t(
                                  "Checked — passed",
                                  "Diperiksa — lulus",
                                ),
                              },
                              {
                                value: "issue",
                                label: t(
                                  "Checked — issue found",
                                  "Diperiksa — isu ditemui",
                                ),
                              },
                            ],
                          },
                        ],
                      })
                    }
                  >
                    <span
                      className={"step-number " + (step.done ? "done" : "")}
                    >
                      {step.done ? <Check size={13} /> : i + 1}
                    </span>
                    <span>
                      <strong>{stepNames(b)[i][lang === "ms" ? 1 : 0]}</strong>
                      {step.done ? (
                        <>
                          <PersonBadge
                            name={step.pic}
                            lang={lang}
                            caption={t(
                              "Recorded performer",
                              "Pelaksana direkodkan",
                            )}
                          />
                          <small>
                            {fmt(step.qty ?? 0)} {units(lang, batchUnit(b))}
                          </small>
                        </>
                      ) : (
                        <small>
                          {t(
                            "Awaiting supervisor entry",
                            "Menunggu rekod penyelia",
                          )}
                        </small>
                      )}
                    </span>
                    {!step.done && <Plus size={15} />}
                  </button>
                ))}
              </div>
              <div className="batch-footer">
                <small>
                  {b.date} · {units(lang, batchUnit(b))}
                </small>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!b.steps.every((s) => s.done) || b.actual <= b.sent}
                  onClick={() =>
                    show({
                      type: "transfer",
                      title: t(
                        "Send to fulfilment",
                        "Hantar ke pusat pemenuhan",
                      ),
                      description:
                        b.code +
                        " · " +
                        (b.actual - b.sent) +
                        " " +
                        t("available at factory", "tersedia di kilang"),
                      hidden: { id: b.id },
                      fields: [
                        number(
                          "qty",
                          t("Units sent", "Unit dihantar"),
                          undefined,
                          1,
                        ),
                        pic(),
                      ],
                    })
                  }
                >
                  {t("Send to fulfilment", "Hantar ke pemenuhan")}
                  <ArrowRight size={14} />
                </Button>
              </div>
              <p className="transfer-help">
                {t(
                  "Record finished stock leaving the factory. The stock-in supervisor records its arrival separately.",
                  "Rekod stok siap yang meninggalkan kilang. Penyelia stok masuk merekod penerimaannya secara berasingan.",
                )}
              </p>
            </section>
          ))}
      </div>
      <Button variant="outline" onClick={closeDay}>
        <ClipboardList size={16} />
        {t("End-of-day review", "Semakan akhir hari")}
      </Button>
    </>
  );

  return (
    <>
      <nav
        className="production-nav"
        aria-label={t("Production sections", "Bahagian pengeluaran")}
      >
        {(
          [
            [
              "log",
              ClipboardList,
              t("Production log", "Log pengeluaran"),
              t("Record daily work", "Rekod kerja harian"),
            ],
            [
              "plan",
              Plus,
              t("Plan batch", "Rancang kelompok"),
              t("Prepare the next run", "Sediakan pengeluaran seterusnya"),
            ],
            [
              "history",
              History,
              t("Previous batches", "Kelompok terdahulu"),
              t("Find a saved record", "Cari rekod tersimpan"),
            ],
          ] as const
        ).map(([id, Icon, title, detail]) => (
          <Link
            key={id}
            href={href(id)}
            aria-current={tab === id ? "page" : undefined}
          >
            <Icon size={19} />
            <span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </span>
          </Link>
        ))}
      </nav>
      {tab === "plan" ? (
        <BatchPlanForm
          lang={lang}
          busy={busy}
          defaultProduct={factory === "sachet" ? "ady" : "cav"}
          backHref={href("log")}
          onSave={async (input) => {
            const result = await command("batch", input);
            if (result)
              router.push(
                href("log", result.batches[0].id).replace(/&factory=[^&]+/, ""),
              );
          }}
        />
      ) : tab === "history" ? (
        selectedId ? (
          selected ? (
            <>
              <div className="toolbar">
                <Button asChild variant="outline">
                  <Link href={href("history")}>
                    <ArrowLeft size={15} />
                    {t(
                      "Back to previous batches",
                      "Kembali ke kelompok terdahulu",
                    )}
                  </Link>
                </Button>
                <Button asChild className="action-primary">
                  <Link href={href("log", selected.id)}>
                    {t("Open production log", "Buka log pengeluaran")}
                    <ArrowRight size={15} />
                  </Link>
                </Button>
              </div>
              <BatchRecord batch={selected} lang={lang} />
            </>
          ) : (
            <Empty>
              <span>
                {t(
                  "This batch was not found.",
                  "Kelompok ini tidak ditemui.",
                )}{" "}
              </span>
              <Link href={href("history")}>
                {t("Back to previous batches", "Kembali ke kelompok terdahulu")}
              </Link>
            </Empty>
          )
        ) : (
          <Panel
            title={t("Previous batches", "Kelompok terdahulu")}
            detail={t(
              "All saved plans and production records, newest work date first. Open a batch to see its full record.",
              "Semua pelan dan rekod pengeluaran tersimpan, mengikut tarikh kerja terkini. Buka kelompok untuk melihat rekod penuh.",
            )}
          >
            <div className="history-filters">
              <label className="search-box">
                <span className="sr-only">
                  {t("Search batches", "Cari kelompok")}
                </span>
                <Search size={16} />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t(
                    "Batch number, product or date…",
                    "Nombor kelompok, produk atau tarikh…",
                  )}
                />
              </label>
              <select
                className="compact-select"
                aria-label={t("Factory filter", "Tapis kilang")}
                value={factory}
                onChange={(e) => setFactory(e.target.value)}
              >
                <option value="all">
                  {t("All factories", "Semua kilang")}
                </option>
                <option value="bottle">
                  {t("Bottle factory", "Kilang botol")}
                </option>
                <option value="sachet">
                  {t("Sachet factory", "Kilang sachet")}
                </option>
              </select>
              <select
                className="compact-select"
                aria-label={t("Batch status", "Status kelompok")}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">{t("All statuses", "Semua status")}</option>
                <option value="open">
                  {t("Planned / in progress", "Dirancang / dalam proses")}
                </option>
                <option value="recorded">{t("Recorded", "Direkodkan")}</option>
              </select>
            </div>
            {historyBatches.length ? (
              <div className="table-scroll">
                <table className="batch-history">
                  <thead>
                    <tr>
                      {[
                        t("Batch / product", "Kelompok / produk"),
                        t("Work date", "Tarikh kerja"),
                        t("Planned / finished", "Dirancang / siap"),
                        t("Recorded PICs", "PIC direkodkan"),
                        t("Status", "Status"),
                        t("Record", "Rekod"),
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyBatches.map((b) => (
                      <tr key={b.id}>
                        <td
                          data-label={t("Batch / product", "Kelompok / produk")}
                        >
                          <Link
                            className="record-link mono"
                            href={href("history", b.id)}
                          >
                            {b.code}
                          </Link>
                          <div className="mt-2">
                            <ProductName id={b.product} />
                          </div>
                        </td>
                        <td data-label={t("Work date", "Tarikh kerja")}>
                          {b.date}
                        </td>
                        <td
                          data-label={t(
                            "Planned / finished",
                            "Dirancang / siap",
                          )}
                        >
                          {fmt(b.target)} / {fmt(b.actual)}
                          <small>{units(lang, batchUnit(b))}</small>
                        </td>
                        <td data-label={t("Recorded PICs", "PIC direkodkan")}>
                          <div className="history-people">
                            {[
                              ...new Set(
                                b.steps
                                  .filter((s) => s.done && s.pic)
                                  .map((s) => s.pic),
                              ),
                            ].map((name) => (
                              <PersonBadge
                                key={name}
                                name={name}
                                lang={lang}
                                caption={t(
                                  "Recorded performer",
                                  "Pelaksana direkodkan",
                                )}
                              />
                            ))}
                            {!b.steps.some((s) => s.done) && (
                              <span className="text-muted-foreground">
                                {t(
                                  "No work recorded yet",
                                  "Belum ada kerja direkodkan",
                                )}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <BatchStatus batch={b} lang={lang} />
                        </td>
                        <td>
                          <Button asChild variant="outline" size="sm">
                            <Link
                              href={href("history", b.id)}
                              aria-label={
                                t("View batch ", "Lihat kelompok ") + b.code
                              }
                            >
                              {t("View record", "Lihat rekod")}
                              <ArrowRight size={14} />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {t(
                  "No batches match these filters.",
                  "Tiada kelompok sepadan dengan tapisan ini.",
                )}
              </Empty>
            )}
          </Panel>
        )
      ) : (
        productionLog
      )}
    </>
  );
}

function BatchPlanForm({
  lang,
  busy,
  defaultProduct,
  backHref,
  onSave,
}: {
  lang: Lang;
  busy: boolean;
  defaultProduct: string;
  backHref: string;
  onSave: (input: Record<string, unknown>) => Promise<void>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [productId, setProductId] = useState(defaultProduct);
  const route = stepNames({ product: productId } as Batch);
  return (
    <Panel
      className="batch-plan"
      title={t("Production batch plan", "Pelan kelompok pengeluaran")}
      detail={t(
        "Fill in the batch details, then save to begin recording production.",
        "Isi butiran kelompok, kemudian simpan untuk mula merekod pengeluaran.",
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(Object.fromEntries(new FormData(e.currentTarget)));
        }}
      >
        <fieldset disabled={busy} className="batch-plan-fields">
          <legend className="sr-only">
            {t("Batch details", "Butiran kelompok")}
          </legend>
          <div className="plan-section-title">
            <span>01</span>
            <div>
              <h3>{t("Batch details", "Butiran kelompok")}</h3>
              <p>
                {t(
                  "One product per batch. Use the batch number printed on the product.",
                  "Satu produk setiap kelompok. Gunakan nombor kelompok yang dicetak pada produk.",
                )}
              </p>
            </div>
          </div>
          <div className="plan-field-grid">
            <div>
              <Label htmlFor="plan-product">{t("Product", "Produk")}</Label>
              <select
                id="plan-product"
                name="product"
                className="form-select"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="plan-code">
                {t("Batch number", "Nombor kelompok")}
              </Label>
              <Input
                id="plan-code"
                name="code"
                required
                maxLength={100}
                placeholder={t(
                  "Enter batch number",
                  "Masukkan nombor kelompok",
                )}
              />
            </div>
            <div>
              <Label htmlFor="plan-date">
                {t("Work date", "Tarikh kerja")}
              </Label>
              <Input
                id="plan-date"
                name="date"
                type="date"
                required
                defaultValue={today()}
              />
            </div>
            <div>
              <Label htmlFor="plan-target">
                {t("Planned quantity", "Kuantiti dirancang")} ·{" "}
                {units(lang, productId === "ady" ? "sachet" : "bottle")}
              </Label>
              <Input
                id="plan-target"
                name="target"
                type="number"
                required
                min={1}
                max={1000000}
                step={1}
                placeholder="0"
              />
            </div>
          </div>
          <div className="plan-section-title">
            <span>02</span>
            <div>
              <h3>{t("Production process", "Proses pengeluaran")}</h3>
              <p>
                {t(
                  "Assign the actual PIC and enter output when each process is recorded in the production log.",
                  "Pilih PIC sebenar dan masukkan hasil apabila setiap proses direkodkan dalam log pengeluaran.",
                )}
              </p>
            </div>
          </div>
          <div className="plan-route">
            {route.map(([en, ms], i) => (
              <div key={en}>
                <span className="step-number">{i + 1}</span>
                <strong>{t(en, ms)}</strong>
                <small>
                  {t(
                    "PIC recorded during production",
                    "PIC direkod semasa pengeluaran",
                  )}
                </small>
              </div>
            ))}
          </div>
          {productId === "ady" && (
            <p className="inline-note">
              <AlertTriangle size={16} />
              {t(
                "Sachet steps are provisional. Plan in loose sachets, not retail boxes.",
                "Langkah sachet masih cadangan. Rancang dalam unit sachet longgar, bukan kotak jualan.",
              )}
            </p>
          )}
          <p className="field-hint">
            {t(
              "Planning does not create finished stock. Actual output and sending stock to fulfilment are recorded after the work takes place.",
              "Perancangan tidak mewujudkan stok siap. Hasil sebenar dan penghantaran ke pemenuhan direkod selepas kerja dilakukan.",
            )}
          </p>
        </fieldset>
        <div className="plan-actions">
          <Button asChild variant="outline">
            <Link href={backHref}>{t("Cancel", "Batal")}</Link>
          </Button>
          <Button type="submit" className="action-primary" disabled={busy}>
            {busy
              ? t("Saving…", "Menyimpan…")
              : t("Save batch plan", "Simpan pelan kelompok")}
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function BatchRecord({ batch: b, lang }: { batch: Batch; lang: Lang }) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  return (
    <Panel
      className="batch-record"
      title={b.code}
      detail={t(
        "Saved batch record · production accountability",
        "Rekod kelompok tersimpan · tanggungjawab pengeluaran",
      )}
      action={<BatchStatus batch={b} lang={lang} />}
    >
      <div className="batch-record-heading">
        <ProductName id={b.product} />
        <span>
          <Factory size={15} />
          {b.product === "ady"
            ? t("Sachet factory", "Kilang sachet")
            : t("Bottle factory", "Kilang botol")}
        </span>
      </div>
      <dl className="batch-record-summary">
        {[
          [t("Work date", "Tarikh kerja"), b.date],
          [t("Planned", "Dirancang"), fmt(b.target)],
          [t("Finished", "Siap"), fmt(b.actual)],
          [t("Sent to fulfilment", "Dihantar ke pemenuhan"), fmt(b.sent)],
        ].map(([label, value], i) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
            {i > 0 && <small>{units(lang, batchUnit(b))}</small>}
          </div>
        ))}
      </dl>
      <div className="table-scroll">
        <table className="batch-process-record">
          <caption className="sr-only">
            {t(
              "Process log and responsible people",
              "Log proses dan orang bertanggungjawab",
            )}
          </caption>
          <thead>
            <tr>
              {[
                t("Process", "Proses"),
                t("Person responsible (PIC)", "Orang bertanggungjawab (PIC)"),
                t("Output", "Hasil"),
                t("Time", "Masa"),
                t("QC record", "Rekod QC"),
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.steps.map((s, i) => (
              <tr key={i}>
                <td data-label={t("Process", "Proses")}>
                  <span className="record-process-name">
                    <span className={"step-number " + (s.done ? "done" : "")}>
                      {s.done ? <Check size={13} /> : i + 1}
                    </span>
                    {stepNames(b)[i][lang === "ms" ? 1 : 0]}
                  </span>
                </td>
                <td
                  data-label={t(
                    "Person responsible (PIC)",
                    "Orang bertanggungjawab (PIC)",
                  )}
                >
                  {s.done ? (
                    <PersonBadge
                      name={s.pic}
                      lang={lang}
                      caption={t("Recorded performer", "Pelaksana direkodkan")}
                    />
                  ) : (
                    t("Awaiting supervisor entry", "Menunggu rekod penyelia")
                  )}
                </td>
                <td data-label={t("Output", "Hasil")}>
                  {s.qty ?? "—"}
                  <small>{units(lang, batchUnit(b))}</small>
                </td>
                <td data-label={t("Time", "Masa")}>
                  {s.start || "—"} – {s.end || "—"}
                </td>
                <td data-label={t("QC record", "Rekod QC")}>
                  {qcLabel(s.qc, lang)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="record-footnote">
        {t(
          "PIC identifies who performed the process. Records are entered by the supervisor using the shared test account. A recorded process does not imply a QC pass.",
          "PIC mengenal pasti pelaksana proses. Rekod dimasukkan oleh penyelia melalui akaun ujian bersama. Proses yang direkod tidak bermaksud QC lulus.",
        )}
      </p>
    </Panel>
  );
}
