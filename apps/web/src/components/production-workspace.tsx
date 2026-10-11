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
  Wrench,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonBadge } from "./person-profile";
import {
  MachineRegistry,
  ProcessPicHistory,
  ProcessPicTools,
  StageRecords,
} from "./sachet-records";
export { ProcessPicHistory } from "./sachet-records";
import {
  Empty,
  FormError,
  Panel,
  ProductName,
  fmt,
  units,
  type Field,
  type FormSpec,
} from "./draft-primitives";
import {
  batchUnit,
  batchFactory,
  batchComplete,
  batchTransferred,
  batchRoute,
  factoryStagesDone,
  isFactoryStage,
  routeStages,
  stageDone,
  stageStep,
  warehouseStages,
  isQcStep,
  products,
  product,
  stepNames,
  currentSachetRoute,
  sachetRoutes,
  sachetStage,
  isSachet,
  today,
  tr,
  type Batch,
  type Draft,
  type Lang,
  type Role,
} from "@/lib/draft";

type ProductionView = "log" | "plan" | "history" | "machines";
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
  const complete = batchComplete(batch),
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
  role,
  factoryScope,
}: {
  role: Role;
  /** The signed-in supervisor's factory; the view and planning stay inside it. */
  factoryScope?: "bottle" | "sachet";
  state: Draft;
  lang: Lang;
  busy: boolean;
  command: (
    type: string,
    input: Record<string, unknown>,
    options?: { onError?: (message: string) => void },
  ) => Promise<Draft | null>;
  show: (spec: FormSpec) => void;
  pic: (name?: string, label?: string) => Field;
  number: (name: string, label: string, value?: number, min?: number) => Field;
  closeDay: () => void;
}) {
  const router = useRouter(),
    params = useSearchParams();
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const qcField: Field = {
    name: "qc",
    label: t("QC result", "Keputusan QC"),
    type: "select",
    value: "not-recorded",
    options: [
      {
        value: "not-recorded",
        label: t("Not recorded / not checked", "Tidak direkod / tidak diperiksa"),
      },
      { value: "pass", label: t("Checked — passed", "Diperiksa — lulus") },
      {
        value: "issue",
        label: t("Checked — issue found", "Diperiksa — isu ditemui"),
      },
    ],
  };
  const mode = params.get("production");
  const tab: ProductionView =
    mode === "plan" || mode === "history" || mode === "machines"
      ? mode
      : "log";
  const rawFactory = params.get("factory");
  const factory =
    factoryScope ??
    (rawFactory === "bottle" || rawFactory === "sachet" ? rawFactory : "all");
  const factoryLabel =
    factory === "sachet"
      ? t("Sachet factory", "Kilang sachet")
      : t("Bottle factory", "Kilang botol");
  const selectedId = params.get("batch");
  const selected = state.batches.find((b) => b.id === selectedId);
  const workDate = selected?.date ?? params.get("date") ?? today();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  function href(next: ProductionView, batch?: string, date?: string) {
    const q = new URLSearchParams({ view: "production", production: next });
    if (factory !== "all") q.set("factory", factory);
    if (batch) q.set("batch", batch);
    if (next === "log")
      q.set(
        "date",
        date ?? state.batches.find((b) => b.id === batch)?.date ?? workDate,
      );
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
      (factory === "all" || batchFactory(b) === factory) &&
      b.date === workDate &&
      (!selectedId || b.id === selectedId),
  );
  const historyBatches = state.batches
    .filter(
      (b) =>
        (factory === "all" || batchFactory(b) === factory) &&
        (b.code + " " + product(b.product).name + " " + b.date)
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (status === "all" ||
          (status === "recorded" ? batchComplete(b) : !batchComplete(b))),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const productionLog = (
    <>
      <section className="production-date-banner">
        <div>
          <span>{t("PRODUCTION WORK DATE", "TARIKH KERJA PENGELUARAN")}</span>
          <strong>
            {new Date(workDate + "T12:00:00+08:00").toLocaleDateString(
              lang === "ms" ? "ms-MY" : "en-MY",
              {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "Asia/Kuala_Lumpur",
              },
            )}
          </strong>
        </div>
        <label>
          {t("Change date", "Tukar tarikh")}
          <Input
            type="date"
            value={workDate}
            onChange={(e) => {
              if (e.target.value)
                router.replace(href("log", undefined, e.target.value), {
                  scroll: false,
                });
            }}
          />
        </label>
      </section>
      {selectedId && (
        <div className="batch-context">
          <Button asChild variant="outline">
            <Link href={href("log")}>
              <ArrowLeft size={15} />
              {t("All batches for this day", "Semua kelompok hari ini")}
            </Link>
          </Button>
          <span>{selected?.code}</span>
        </div>
      )}
      <div className="toolbar">
        {factoryScope ? (
          <div className="inline-label">
            <Factory size={15} />
            {factoryLabel}
          </div>
        ) : (
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
        )}
        <Button className="action-primary" onClick={newBatch}>
          <Plus size={16} />
          {t("Plan batch", "Rancang kelompok")}
        </Button>
      </div>
      {factory !== "bottle" && (
        <div className="inline-note">
          <AlertTriangle size={17} />
          {t(
            "Sachet production records each machine and its PIC. The warehouse confirms finished boxes during stock-in.",
            "Pengeluaran sachet merekod setiap mesin dan PIC. Gudang mengesahkan kotak siap semasa stok masuk.",
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
        {visibleBatches.map((b) =>
          isSachet(b.product) ? (
            <AdypocideProductionCard
              key={b.id}
              batch={b}
              state={state}
              role={role}
              lang={lang}
              show={show}
              pic={pic}
              onOpenRecord={() => router.push(href("history", b.id))}
            />
          ) : (
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
                  <div className="process-row" key={i}>
                    <button
                      disabled={step.done}
                      onClick={() =>
                        show({
                          type: "step",
                          title: isQcStep(b, i)
                            ? stepNames(b)[i][lang === "ms" ? 1 : 0] +
                              " · " +
                              t(
                                "QC count (finished bottles)",
                                "Kiraan QC (botol siap)",
                              )
                            : stepNames(b)[i][lang === "ms" ? 1 : 0],
                          description:
                            b.code +
                            " · " +
                            (isQcStep(b, i)
                              ? t(
                                  "Enter the QC count of finished bottles at the end of the line. It becomes the batch's finished quantity.",
                                  "Masukkan kiraan QC botol siap di hujung barisan. Ia menjadi kuantiti siap kelompok.",
                                )
                              : t(
                                  "Record who ran this machine. No output count is needed; QC counts the finished bottles on the last step.",
                                  "Rekod siapa yang menjalankan mesin ini. Tiada kiraan hasil diperlukan; QC mengira botol siap pada langkah terakhir.",
                                )),
                          hidden: { id: b.id, step: i },
                          fields: [
                            { ...pic(), value: step.pic || undefined },
                            ...(isQcStep(b, i)
                              ? [
                                  number(
                                    "qty",
                                    t(
                                      "QC count (finished bottles)",
                                      "Kiraan QC (botol siap)",
                                    ),
                                  ),
                                ]
                              : []),
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
                            ...(isQcStep(b, i)
                              ? [qcField]
                              : []),
                          ],
                        })
                      }
                    >
                      <span
                        className={"step-number " + (step.done ? "done" : "")}
                      >
                        {step.done ? <Check size={13} /> : i + 1}
                      </span>
                      <span className="process-copy">
                        <strong>
                          {stepNames(b)[i][lang === "ms" ? 1 : 0]}
                        </strong>
                        {step.pic ? (
                          <PersonBadge
                            name={step.pic}
                            lang={lang}
                            compact
                            caption={t(
                              step.done
                                ? "Current / latest PIC"
                                : "Planned PIC",
                              step.done
                                ? "PIC semasa / terkini"
                                : "PIC dirancang",
                            )}
                          />
                        ) : (
                          <small className="process-pending">
                            {t(
                              "Awaiting supervisor entry",
                              "Menunggu rekod penyelia",
                            )}
                          </small>
                        )}
                      </span>
                      {step.done &&
                      (isQcStep(b, i) || step.qty !== null) ? (
                        <span className="process-output">
                          <span>{fmt(step.qty ?? 0)}</span>
                          <small>
                            {isQcStep(b, i)
                              ? t("QC count", "Kiraan QC")
                              : units(lang, batchUnit(b))}
                          </small>
                        </span>
                      ) : step.done ? (
                        <Check size={14} className="process-add" />
                      ) : (
                        <Plus size={14} className="process-add" />
                      )}
                    </button>
                    <ProcessPicTools
                      batch={b}
                      index={i}
                      lang={lang}
                      show={show}
                      pic={pic}
                    />
                  </div>
                ))}
              </div>
              <div className="batch-footer">
                <small>
                  {b.date} · {units(lang, batchUnit(b))}
                </small>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!batchComplete(b) || b.actual <= b.sent}
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
            </section>
          ),
        )}
      </div>
      <p className="transfer-help">
        {t(
          "Send to fulfilment records the factory handoff. Sachet quantities are finalized by stock-in after warehouse boxing.",
          "Hantar ke pemenuhan merekod serahan kilang. Kuantiti Adypocide dimuktamadkan oleh stok masuk selepas pengkotakan di gudang.",
        )}
      </p>
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
            [
              "machines",
              Wrench,
              t("Machines", "Mesin"),
              t("Find, add or retire machines", "Cari, tambah atau tamatkan mesin"),
            ],
          ] as const
        )
          // The machine register is sachet-route equipment.
          .filter(([id]) => id !== "machines" || factoryScope !== "bottle")
          .map(([id, Icon, title, detail]) => (
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
      {tab === "machines" && factoryScope !== "bottle" ? (
        <MachineRegistry state={state} lang={lang} show={show} />
      ) : tab === "plan" ? (
        <BatchPlanForm
          lang={lang}
          busy={busy}
          defaultProduct={factory === "sachet" ? "ady" : "cav"}
          productIds={products
            .filter((p) => !factoryScope || p.factory === factoryScope)
            .map((p) => p.id)}
          backHref={href("log")}
          defaultDate={workDate}
          peopleOptions={pic().options ?? []}
          onSave={async (input) => {
            let error = "";
            const result = await command("batch", input, {
              onError: (message) => (error = message),
            });
            if (result)
              router.push(
                href(
                  "log",
                  result.batches[0].id,
                  result.batches[0].date,
                ).replace(/&factory=[^&]+/, ""),
              );
            return error;
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
              <BatchRecord batch={selected} state={state} lang={lang} />
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
              {!factoryScope && (
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
              )}
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
                          {isSachet(b.product) ? (
                            t("Machine / PIC records", "Rekod mesin / PIC")
                          ) : (
                            <>
                              {fmt(b.target)} / {fmt(b.actual)}
                              <small>{units(lang, batchUnit(b))}</small>
                            </>
                          )}
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

function AdypocideProductionCard({
  batch: b,
  state,
  role,
  lang,
  show,
  pic,
  onOpenRecord,
}: {
  batch: Batch;
  state: Draft;
  role: Role;
  lang: Lang;
  show: (spec: FormSpec) => void;
  pic: (name?: string, label?: string) => Field;
  onOpenRecord: () => void;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const sent = batchTransferred(b);
  const needsReview = batchRoute(b).status === "needs-review";
  return (
    <section className="batch-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <ProductName id={b.product} />
          <button
            onClick={onOpenRecord}
            className="record-link mono block mt-2"
          >
            {b.code}
          </button>
        </div>
        <span
          className={
            "status-pill " +
            (sent ? "tone-success" : needsReview ? "tone-warning" : "tone-info")
          }
        >
          {sent
            ? t("Sent to warehouse", "Dihantar ke gudang")
            : needsReview
              ? t("Route review needed", "Semakan laluan diperlukan")
              : t("Machine records", "Rekod mesin")}
        </span>
      </div>
      <p className="field-hint mt-4">
        {t(
          "Record the mixing and filling PICs, then send the batch to the warehouse. Batching, hologram and wrapping are recorded by stock-in before the box count.",
          "Rekod PIC pengadunan dan pengisian, kemudian hantar kelompok ke gudang. Nombor kelompok, hologram dan balutan direkod oleh stok masuk sebelum kiraan kotak.",
        )}
      </p>
      <StageRecords
        batch={b}
        state={state}
        lang={lang}
        show={show}
        pic={pic}
        role={role}
        stageFilter="factory"
      />
      {warehouseStages(b).length > 0 && (
        <div className="warehouse-stage-list">
          <small className="text-muted-foreground">
            {t("Recorded at stock-in", "Direkod semasa stok masuk")}
          </small>
          <ul>
            {routeStages(b)
              .filter((stage) => !isFactoryStage(stage.id))
              .map((stage) => {
                const step = stageStep(b, stage.id);
                return (
                  <li key={stage.id}>
                    <span>{t(stage.en, stage.ms)}</span>
                    <span
                      className={
                        "status-pill " +
                        (stageDone(b, stage.id) ? "tone-success" : "tone-muted")
                      }
                    >
                      {stageDone(b, stage.id)
                        ? step!.pic
                        : t("Not yet", "Belum")}
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
      <div className="batch-footer">
        <small>{b.date}</small>
        <Button
          size="sm"
          variant="outline"
          disabled={sent || needsReview || !factoryStagesDone(b)}
          onClick={() =>
            show({
              type: "transfer",
              title: t("Send batch to warehouse", "Hantar kelompok ke gudang"),
              description: t(
                "Confirm that mixing and filling have an actual PIC. Stock-in records batching, hologram and wrapping, then counts finished boxes.",
                "Sahkan pengadunan dan pengisian mempunyai PIC sebenar. Stok masuk merekod nombor kelompok, hologram dan balutan, kemudian mengira kotak siap.",
              ),
              hidden: { id: b.id },
              fields: [pic()],
            })
          }
        >
          {t("Send to warehouse", "Hantar ke gudang")}
          <ArrowRight size={14} />
        </Button>
      </div>
    </section>
  );
}

function BatchPlanForm({
  lang,
  busy,
  defaultProduct,
  productIds,
  defaultDate,
  peopleOptions,
  backHref,
  onSave,
}: {
  lang: Lang;
  busy: boolean;
  defaultProduct: string;
  /** Products this supervisor may plan. */
  productIds: string[];
  defaultDate: string;
  peopleOptions: { value: string; label: string }[];
  backHref: string;
  /** Resolves to an error message, or "" once saved. */
  onSave: (input: Record<string, unknown>) => Promise<string>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [productId, setProductId] = useState(defaultProduct);
  const [error, setError] = useState("");
  const route = isSachet(productId)
    ? sachetRoutes[currentSachetRoute].stages.map((key) => {
        const stage = sachetStage(key)!;
        return [stage.en, stage.ms];
      })
    : stepNames({ product: productId } as Batch);
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
          setError("");
          void onSave(Object.fromEntries(new FormData(e.currentTarget))).then(
            setError,
          );
        }}
      >
        {isSachet(productId) && (
          <input type="hidden" name="route" value={currentSachetRoute} />
        )}
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
                {products
                  .filter((p) => productIds.includes(p.id))
                  .map((p) => (
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
                defaultValue={defaultDate}
              />
            </div>
            {!isSachet(productId) && (
              <div>
                <Label htmlFor="plan-target">
                  {t("Planned quantity", "Kuantiti dirancang")} ·{" "}
                  {units(lang, "bottle")}
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
            )}
          </div>
          <div className="plan-section-title">
            <span>02</span>
            <div>
              <h3>{t("Production process", "Proses pengeluaran")}</h3>
              <p>
                {isSachet(productId)
                  ? t(
                      "Five fixed stages. Production records mixing and filling; the warehouse records batching, hologram and wrapping during stock-in. Planning does not mark a stage complete. No sachet quantity is required.",
                      "Lima peringkat tetap. Pengeluaran merekod pengadunan dan pengisian; gudang merekod nombor kelompok, hologram dan balutan semasa stok masuk. Perancangan tidak menandakan peringkat siap. Kuantiti sachet tidak diperlukan.",
                    )
                  : t(
                      "Assign PICs now or later. The QC count is recorded on the last step.",
                      "Tetapkan PIC sekarang atau kemudian. Kiraan QC direkod pada langkah terakhir.",
                    )}
              </p>
            </div>
          </div>
          <div className="plan-route">
            {route.map(([en, ms], i) => (
              <div key={productId + en}>
                <span className="step-number">{i + 1}</span>
                <strong>{t(en, ms)}</strong>
                <label className="plan-pic-field">
                  {t("Planned PIC", "PIC dirancang")}
                  <select
                    name={"pic_" + i}
                    className="form-select"
                    defaultValue=""
                  >
                    <option value="">
                      {t(
                        "Assign now or later",
                        "Tetapkan sekarang atau kemudian",
                      )}
                    </option>
                    {peopleOptions.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
          {isSachet(productId) && (
            <p className="inline-note">
              <AlertTriangle size={16} />
              {t(
                "The stock-in supervisor confirms the actual finished box count after warehouse boxing. One finished box is one inventory unit.",
                "Penyelia stok masuk mengesahkan jumlah kotak siap selepas pengkotakan di gudang. Satu kotak siap ialah satu unit inventori.",
              )}
            </p>
          )}
          <p className="field-hint">
            {isSachet(productId)
              ? t(
                  "Save the batch, record the mixing and filling machines and PICs, then send the batch to the warehouse.",
                  "Simpan kelompok, rekod mesin dan PIC pengadunan dan pengisian, kemudian hantar kelompok ke gudang.",
                )
              : t(
                  "Planning does not create finished stock. Actual output and sending stock to fulfilment are recorded after the work takes place.",
                  "Perancangan tidak mewujudkan stok siap. Hasil sebenar dan penghantaran ke pemenuhan direkod selepas kerja dilakukan.",
                )}
          </p>
        </fieldset>
        <FormError message={error} className="mt-4" />
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

function BatchRecord({
  batch: b,
  state,
  lang,
}: {
  batch: Batch;
  state: Draft;
  lang: Lang;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  if (isSachet(b.product))
    return (
      <Panel
        className="batch-record"
        title={b.code}
        detail={
          b.date +
          " · " +
          t("Adypocide machine responsibility", "Tanggungjawab mesin Adypocide")
        }
      >
        <div className="batch-record-heading">
          <ProductName id={b.product} />
          <span>
            {batchTransferred(b)
              ? t("Sent to warehouse", "Dihantar ke gudang")
              : t("Awaiting warehouse handoff", "Menunggu serahan ke gudang")}
          </span>
        </div>
        <StageRecords batch={b} state={state} lang={lang} />
        <p className="record-footnote">
          {t(
            "The stock-in supervisor records inventory after counting finished boxes in the warehouse.",
            "Penyelia stok masuk merekod inventori selepas mengira kotak siap di gudang.",
          )}
        </p>
      </Panel>
    );
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
          {isSachet(b.product)
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
                t("QC count", "Kiraan QC"),
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
                  {s.pic ? (
                    <PersonBadge
                      name={s.pic}
                      lang={lang}
                      caption={t("Recorded performer", "Pelaksana direkodkan")}
                    />
                  ) : (
                    t("Awaiting supervisor entry", "Menunggu rekod penyelia")
                  )}
                  <ProcessPicHistory step={s} lang={lang} />
                </td>
                <td data-label={t("QC count", "Kiraan QC")}>
                  {/* Machine steps have no output; older records may still carry one. */}
                  {s.qty ?? "—"}
                  {s.qty !== null && <small>{units(lang, batchUnit(b))}</small>}
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
          "PIC identifies who performed the process; the supervisor who entered it is shown in its history. A recorded process does not imply a QC pass.",
          "PIC mengenal pasti pelaksana proses; penyelia yang merekod dipaparkan dalam sejarahnya. Proses yang direkod tidak bermaksud QC lulus.",
        )}
      </p>
    </Panel>
  );
}
