"use client";

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleSlash,
  Plus,
  Search,
  Settings,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { PersonBadge } from "./person-profile";
import { Empty, Panel, ProductName, type Field, type FormSpec } from "./draft-primitives";
import {
  adypocideReceipts,
  batchBoxTotal,
  batchComplete,
  batchRoute,
  batchTransferred,
  isFactoryStage,
  isOptionalStage,
  isSachet,
  lastWarehouseStage,
  product,
  recorderLabel,
  routeStages,
  sachetProcesses,
  sachetRoutes,
  sachetStage,
  stageSatisfied,
  stageSkipped,
  stageStep,
  stepNames,
  toMyt,
  tr,
  warehouseStages,
  warehouseStagesDone,
  type Batch,
  type Draft,
  type Lang,
  type Machine,
  type Role,
  type SachetStage,
  type Step,
} from "@/lib/draft";

type Show = (spec: FormSpec) => void;
type Pic = (name?: string, label?: string) => Field;
export const when = (iso: string | undefined, lang: Lang) =>
  iso
    ? new Date(iso).toLocaleString(lang === "ms" ? "ms-MY" : "en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " MYT"
    : "—";
const occurredField = (lang: Lang, required = false, value?: string): Field => ({
  name: "occurredAt",
  label: tr(
    lang,
    "When the work actually happened (Malaysia time)",
    "Masa kerja sebenar dilakukan (waktu Malaysia)",
  ),
  type: "datetime-local",
  required,
  value,
  hint: required
    ? undefined
    : tr(
        lang,
        "Leave blank if the work just finished. For late entry, enter the actual time; screen order does not matter.",
        "Biarkan kosong jika kerja baru selesai. Untuk rekod lewat, masukkan masa sebenar; susunan skrin tidak penting.",
      ),
});
const reasonField = (lang: Lang, label?: string, required = true): Field => ({
  name: "reason",
  label: label ?? tr(lang, "Reason", "Sebab"),
  type: "textarea",
  required,
});
export const machineOptions = (
  state: Draft,
  stage: string,
  lang: Lang,
  includeInactive = false,
) =>
  (state.machines ?? [])
    .filter((m) => m.stage === stage && (m.active || includeInactive))
    .map((m) => ({
      value: m.id,
      label:
        m.name +
        (m.code ? ` (${m.code})` : "") +
        (m.active ? "" : " · " + tr(lang, "inactive", "tidak aktif")),
    }));

function PanelSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="panel-search">
      <Search size={14} aria-hidden />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
}

export function ProcessPicHistory({ step, lang }: { step: Step; lang: Lang }) {
  const changes = step.picHistory ?? [],
    corrections = step.corrections ?? [];
  if (!changes.length && !corrections.length && !step.recordedBy) return null;
  const kindLabel = (kind: string) =>
    kind === "handover"
      ? tr(lang, "Shift handover", "Serahan syif")
      : kind === "correction"
        ? tr(lang, "Selection corrected", "Pilihan dibetulkan")
        : kind === "reassignment"
          ? tr(lang, "Reassigned before work", "Ditugaskan semula")
          : tr(lang, "Planned assignment", "Tugasan dirancang");
  return (
    <details className="pic-history">
      <summary>
        {tr(lang, "History", "Sejarah")} (
        {changes.length + corrections.length + (step.recordedBy ? 1 : 0)})
      </summary>
      {changes.map((change, index) => (
        <p key={"p" + index}>
          <strong>{kindLabel(change.kind)}</strong>
          <br />
          {change.from || "—"} → {change.to}
          <br />
          {when(change.effectiveAt ?? change.at, lang)}
          <br />
          {change.reason}
          {change.recordedBy && (
            <>
              <br />
              <small>
                {tr(lang, "Entered by", "Direkod oleh")}{" "}
                {recorderLabel(change.recordedBy)}
              </small>
            </>
          )}
        </p>
      ))}
      {step.recordedBy && (
        <p>
          <strong>{tr(lang, "Completion recorded", "Penyiapan direkodkan")}</strong>
          <br />
          {tr(lang, "Performed by", "Dilakukan oleh")} {step.pic} ·{" "}
          {when(step.occurredAt, lang)}
          <br />
          <small>
            {tr(lang, "Entered by", "Direkod oleh")}{" "}
            {recorderLabel(step.recordedBy)} · {when(step.recordedAt, lang)}
          </small>
        </p>
      )}
      {corrections.map((c) => (
        <p key={c.id}>
          <strong>
            {c.field === "machine"
              ? tr(lang, "Machine corrected", "Mesin dibetulkan")
              : tr(lang, "Completion time corrected", "Masa siap dibetulkan")}
          </strong>
          <br />
          {c.field === "occurredAt"
            ? `${when(c.from, lang)} → ${when(c.to, lang)}`
            : `${c.from || "—"} → ${c.to}`}
          <br />
          {c.reason}
          <br />
          <small>
            {tr(lang, "Entered by", "Direkod oleh")} {recorderLabel(c.recordedBy)}{" "}
            · {when(c.at, lang)}
          </small>
        </p>
      ))}
    </details>
  );
}

/**
 * PIC change tools shared by bottle steps and sachet stages: one row of small actions
 * (any `children` first, then the PIC ones) with the step's history underneath.
 */
export function ProcessPicTools({
  batch: b,
  index,
  lang,
  show,
  pic,
  children,
}: {
  batch: Batch;
  index: number;
  lang: Lang;
  show: Show;
  pic: Pic;
  children?: ReactNode;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms),
    step = b.steps[index];
  function change(kind: "correction" | "handover" | "reassignment") {
    show({
      type: "change-step-pic",
      title:
        kind === "handover"
          ? t("Record shift handover", "Rekod serahan syif")
          : kind === "reassignment"
            ? t("Reassign planned PIC", "Tugaskan semula PIC dirancang")
            : t("Correct PIC selection", "Betulkan pilihan PIC"),
      description: `${b.code} · ${stepNames(b)[index][lang === "ms" ? 1 : 0]} · ${step.pic || t("Unassigned", "Belum ditugaskan")}`,
      hidden: {
        id: b.id,
        ...(step.sachetStage ? { stage: step.sachetStage } : { step: index }),
        kind,
        expectedVersion: step.version ?? 0,
      },
      fields: [
        { ...pic(), value: step.pic || undefined },
        ...(kind === "handover"
          ? [
              {
                name: "effectiveAt",
                label: t(
                  "Takeover date and time (Malaysia)",
                  "Tarikh dan masa pengambilalihan (Malaysia)",
                ),
                type: "datetime-local" as const,
              },
            ]
          : []),
        reasonField(
          lang,
          kind === "handover"
            ? t("Handover reason", "Sebab serahan")
            : kind === "reassignment"
              ? t("Reassignment reason", "Sebab tugasan semula")
              : t("Correction reason", "Sebab pembetulan"),
        ),
      ],
    });
  }
  return (
    <div className="process-pic-tools">
      <div className="process-pic-actions">
        {children}
        {step.pic && !step.done ? (
          <Button size="sm" variant="ghost" onClick={() => change("reassignment")}>
            {t("Reassign", "Tugaskan semula")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => change("correction")}>
          {step.pic
            ? t("Correct PIC", "Betulkan PIC")
            : t("Assign PIC", "Tetapkan PIC")}
        </Button>
        {step.pic && !batchTransferred(b) && (
          <Button size="sm" variant="ghost" onClick={() => change("handover")}>
            {t("Shift handover", "Serahan syif")}
          </Button>
        )}
      </div>
      <ProcessPicHistory step={step} lang={lang} />
    </div>
  );
}

export function RouteReview({
  batch: b,
  lang,
  show,
  role,
}: {
  batch: Batch;
  lang: Lang;
  show?: Show;
  role?: Role;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const route = batchRoute(b);
  const definition = sachetRoutes[route.id];
  const revisions = b.revisions ?? [];
  return (
    <>
      <p className="field-hint">
        {t("Route", "Laluan")}:{" "}
        {definition
          ? t(definition.en, definition.ms)
          : t(
              "Historical free-form machine records",
              "Rekod mesin bebas terdahulu",
            )}
        {b.route?.review &&
          ` · ${t("reviewed", "disemak")}: ${b.route.review.reason}`}
      </p>
      {route.status === "needs-review" && (
        <div className="inline-note tone-warning-note" role="status">
          <AlertTriangle size={16} />
          <span>
            {t(
              "Started before the Hologram stage was added. Choose the route this batch actually follows before sending it to the warehouse. No Hologram record is created automatically.",
              "Dimulakan sebelum peringkat Hologram ditambah. Pilih laluan sebenar kelompok ini sebelum dihantar ke gudang. Tiada rekod Hologram dicipta secara automatik.",
            )}
          </span>
          {show && role === "production" && (
            <span className="flex flex-wrap gap-2">
              {(["upgrade", "keep-legacy"] as const).map((decision) => (
                <Button
                  key={decision}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    show({
                      type: "route-review",
                      title:
                        decision === "upgrade"
                          ? t("Upgrade to five stages", "Naik taraf ke lima peringkat")
                          : t("Keep four-stage route", "Kekalkan laluan empat peringkat"),
                      description:
                        b.code +
                        " · " +
                        (decision === "upgrade"
                          ? t(
                              "Adds an open Hologram stage. Record it when the work is actually done.",
                              "Menambah peringkat Hologram terbuka. Rekod apabila kerja sebenar dilakukan.",
                            )
                          : t(
                              "Confirms this batch did not go through the Hologram machine.",
                              "Mengesahkan kelompok ini tidak melalui mesin Hologram.",
                            )),
                      hidden: { id: b.id, decision, expectedVersion: b.version ?? 0 },
                      fields: [reasonField(lang, t("Review note", "Catatan semakan"))],
                    })
                  }
                >
                  {decision === "upgrade"
                    ? t("Upgrade to five stages", "Naik taraf ke lima peringkat")
                    : t("Keep four stages", "Kekalkan empat peringkat")}
                </Button>
              ))}
            </span>
          )}
        </div>
      )}
      {!!revisions.length && (
        <details className="pic-history revised-flag">
          <summary>
            {t("Revised after transfer", "Disemak semula selepas pemindahan")} (
            {revisions.length})
          </summary>
          {revisions.map((r) => (
            <p key={r.id}>
              <strong>
                {sachetStage(r.stage)?.[lang === "ms" ? "ms" : "en"] ?? r.stage} ·{" "}
                {r.field}
              </strong>
              <br />
              {r.field === "occurredAt"
                ? `${when(r.from, lang)} → ${when(r.to, lang)}`
                : `${r.from || "—"} → ${r.to}`}
              <br />
              {r.reason} · {recorderLabel(r.recordedBy)} · {when(r.at, lang)}
            </p>
          ))}
          <p>
            {t(
              "Transfer, receipts and stock are unchanged. Reports for this batch show it as revised.",
              "Pemindahan, penerimaan dan stok tidak berubah. Laporan kelompok ini menunjukkan ia telah disemak.",
            )}
          </p>
        </details>
      )}
    </>
  );
}

/** One source of truth for sachet stage records, opened from Production or Stock-in. */
export function StageRecords({
  batch: b,
  state,
  lang,
  show,
  pic,
  role,
  stageFilter,
  onBoxCount,
  canCountBoxes,
}: {
  batch: Batch;
  state: Draft;
  lang: Lang;
  show?: Show;
  pic?: Pic;
  role?: Role;
  /** Show only the factory stages (production) or only the warehouse stages (stock-in). */
  stageFilter?: "factory" | "warehouse";
  /** Present when the viewer may enter the batch's finished box count (stock.receive). */
  onBoxCount?: (batch: Batch) => void;
  /**
   * The viewer may enter the box count (stock.receive): the Shrink machine completion then
   * takes the finished box count in the same entry. Defaults to the presence of onBoxCount.
   */
  canCountBoxes?: boolean;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const editable = !!show && !!pic;
  const counts = canCountBoxes ?? !!onBoxCount;
  const sent = batchTransferred(b);
  const boxed = adypocideReceipts(state).some(
    (r) => r.batchId === b.id && !!r.stockedAt,
  );
  // Factory stages close at transfer; warehouse stages stay open until the box count.
  const closed = (key: string) => sent && (isFactoryStage(key) || boxed);
  // Changes after transfer are revisions, except warehouse stages before the box count.
  const revised = (key: string) => closed(key);
  const route = routeStages(b);
  const stages = route.filter(
    (stage) =>
      !stageFilter ||
      (stageFilter === "factory") === isFactoryStage(stage.id),
  );
  const legacy = b.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !step.sachetStage && step.done);
  // Stock-in records the warehouse stages only; the factory stages are production's.
  const readOnly = (key: string) =>
    isFactoryStage(key) && (role === "intake" || stageFilter === "warehouse");
  // The batch's finished box total belongs to its last warehouse stage (the Shrink machine).
  const totalStage = lastWarehouseStage(b);
  const total = batchBoxTotal(state, b);
  // Batches planned with a route need their warehouse stages before the box count.
  const boxReady = !b.route || warehouseStagesDone(b);
  // The first stage still open, in route order: the one to do next.
  const nextStage = route.find(
    (stage) => !stageSatisfied(b, stage.id) && !closed(stage.id),
  )?.id;
  const stageName = (stage: SachetStage) => t(stage.en, stage.ms);
  const stageFields = (stage: SachetStage, step?: Step): Field[] => [
    {
      ...pic!("pic", t("Performed by (PIC)", "Dilakukan oleh (PIC)")),
      value: step?.pic || undefined,
    },
    {
      name: "machineId",
      label: t("Machine used", "Mesin digunakan"),
      type: "select",
      required: false,
      options: machineOptions(state, stage.id, lang),
    },
    occurredField(lang),
  ];
  const record = (stage: SachetStage, step?: Step) =>
    show!({
      type: "machine",
      title: t("Record stage completion", "Rekod penyiapan peringkat"),
      description: `${b.code} · ${stageName(stage)} · ${t(
        "Enter the person who actually did the work.",
        "Masukkan orang yang sebenarnya melakukan kerja.",
      )}`,
      hidden: { id: b.id, stage: stage.id, expectedVersion: step?.version ?? 0 },
      fields: stageFields(stage, step),
      submit: t("Save completion", "Simpan penyiapan"),
    });
  // The Shrink machine and the finished box count, saved together (wrapping-count).
  const recordWithCount = (stage: SachetStage, step?: Step) =>
    show!({
      type: "wrapping-count",
      title: t(
        "Record Shrink machine and box count",
        "Rekod mesin shrink dan kiraan kotak",
      ),
      description: `${b.code} · ${stageName(stage)} · ${t(
        "Enter who ran the machine, then the finished boxes counted after wrapping. One box is one stock unit.",
        "Masukkan siapa yang mengendalikan mesin, kemudian kotak siap yang dikira selepas balutan. Satu kotak ialah satu unit stok.",
      )}`,
      hidden: { id: b.id, stage: stage.id, expectedVersion: step?.version ?? 0 },
      fields: [
        ...stageFields(stage, step),
        {
          name: "boxes",
          label: t("Finished boxes counted", "Kotak siap dikira"),
          type: "number",
          min: 0,
        },
        { name: "rack", label: t("Rack / location", "Rak / lokasi") },
      ],
      submit: t("Save stage and box count", "Simpan peringkat dan kiraan kotak"),
    });
  const skip = (stage: SachetStage, step?: Step) =>
    show!({
      type: "stage-skip",
      title: t("Skip this stage", "Langkau peringkat ini"),
      description: `${b.code} · ${stageName(stage)} · ${t(
        "Only for a batch that does not need this stage. No PIC is recorded; the batch can still be boxed and counted. If the work is done after all, record it later.",
        "Hanya untuk kelompok yang tidak memerlukan peringkat ini. Tiada PIC direkodkan; kelompok masih boleh dikotakkan dan dikira. Jika kerja dilakukan juga, rekodkan kemudian.",
      )}`,
      hidden: { id: b.id, stage: stage.id, expectedVersion: step?.version ?? 0 },
      fields: [
        reasonField(
          lang,
          t("Why is this stage not needed?", "Mengapa peringkat ini tidak diperlukan?"),
        ),
      ],
      submit: t("Skip stage", "Langkau peringkat"),
    });
  const rework = (stage: SachetStage, step: Step) =>
    show!({
      type: "stage-rework",
      title: t("Record rework / repeat run", "Rekod kerja semula"),
      description: `${b.code} · ${stageName(stage)}`,
      hidden: { id: b.id, stage: stage.id, expectedVersion: step.version ?? 0 },
      fields: [
        pic!("pic", t("Performed by (PIC)", "Dilakukan oleh (PIC)")),
        {
          name: "machineId",
          label: t("Machine used", "Mesin digunakan"),
          type: "select",
          required: false,
          options: machineOptions(state, stage.id, lang),
        },
        occurredField(lang),
        reasonField(lang, t("Why was this stage repeated?", "Mengapa peringkat ini diulang?")),
      ],
    });
  const correct = (
    stage: SachetStage,
    step: Step,
    field: "machine" | "occurredAt",
  ) =>
    show!({
      type: "stage-correct",
      title:
        field === "machine"
          ? t("Correct machine used", "Betulkan mesin digunakan")
          : t("Correct completion time", "Betulkan masa siap"),
      description:
        `${b.code} · ${stageName(stage)}` +
        (revised(stage.id)
          ? " · " +
            t(
              "This batch is already transferred. The correction is flagged as a revision; stock and transfer records are not changed.",
              "Kelompok ini sudah dipindahkan. Pembetulan ditanda sebagai semakan; rekod stok dan pemindahan tidak berubah.",
            )
          : ""),
      hidden: { id: b.id, stage: stage.id, field, expectedVersion: step.version ?? 0 },
      fields: [
        field === "machine"
          ? {
              name: "machineId",
              label: t("Machine actually used", "Mesin sebenar digunakan"),
              type: "select",
              value: step.machineId,
              options: machineOptions(state, stage.id, lang, true),
            }
          : occurredField(lang, true, step.occurredAt ? toMyt(step.occurredAt) : undefined),
        reasonField(lang, t("Correction reason", "Sebab pembetulan")),
      ],
    });
  // Warehouse stages still open besides the Shrink machine, for the box-count hints.
  const openBefore = warehouseStages(b)
    .filter((key) => key !== totalStage && !stageSatisfied(b, key))
    .map((key) => stageName(sachetStage(key)!));
  const openBeforeHint =
    openBefore.length === 0
      ? ""
      : t(
          `Record ${openBefore.join(" and ")} first` +
            (openBefore.some((name) => name === stageName(sachetStage("hologram")!))
              ? " (Hologram can be skipped)."
              : "."),
          `Rekod ${openBefore.join(" dan ")} dahulu` +
            (openBefore.some((name) => name === stageName(sachetStage("hologram")!))
              ? " (Hologram boleh dilangkau)."
              : "."),
        );
  return (
    <div className="table-scroll my-4">
      <table className="machine-records">
        <thead>
          <tr>
            <th>{t("Stage / machine", "Peringkat / mesin")}</th>
            <th>{t("Status / PIC", "Status / PIC")}</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => {
            const step = stageStep(b, stage.id);
            const index = step ? b.steps.indexOf(step) : -1;
            const canEdit = editable && !readOnly(stage.id);
            const done = !!step?.done;
            const skipped = stageSkipped(b, stage.id);
            const open = !done && !skipped && !closed(stage.id);
            // The Shrink machine takes the box count with it once every other warehouse
            // stage is completed or skipped and no boxes are counted yet.
            const withCount =
              stage.id === totalStage &&
              counts &&
              sent &&
              total === null &&
              openBefore.length === 0;
            const [tone, label] = done
              ? ["tone-success", t("Completed", "Selesai")]
              : skipped
                ? ["tone-info", t("Skipped", "Dilangkau")]
                : closed(stage.id)
                  ? ["tone-muted", t("Not recorded", "Tidak direkod")]
                  : stage.id === nextStage
                    ? ["tone-warning", t("Next", "Seterusnya")]
                    : ["tone-muted", t("Open", "Belum")];
            return (
              <tr key={stage.id} className={stage.id === nextStage ? "stage-next" : undefined}>
                <td data-label={t("Stage / machine", "Peringkat / mesin")}>
                  <span className="stage-name">
                    {route.indexOf(stage) + 1}. {stageName(stage)}
                  </span>
                  {done && (
                    <small>
                      {step!.machineName ??
                        t("Machine not specified", "Mesin tidak dinyatakan")}
                      {" · "}
                      {when(step!.occurredAt, lang)}
                    </small>
                  )}
                  {skipped && (
                    <small className="stage-skip-note">
                      {t("Skipped", "Dilangkau")}: {step!.skipped!.reason} ·{" "}
                      {when(step!.skipped!.at, lang)} ·{" "}
                      {t("entered by", "direkod oleh")}{" "}
                      {recorderLabel(step!.skipped!.recordedBy)}
                    </small>
                  )}
                  {readOnly(stage.id) && (
                    <small>{t("Recorded by production", "Direkod oleh pengeluaran")}</small>
                  )}
                  {stage.id === totalStage && (
                    <span className="stage-box-total">
                      {t("Total boxes", "Jumlah kotak")}:{" "}
                      {total === null ? (
                        <>
                          — <small>{t("not yet counted", "belum dikira")}</small>
                        </>
                      ) : (
                        <strong>{total}</strong>
                      )}
                    </span>
                  )}
                </td>
                <td data-label={t("Status / PIC", "Status / PIC")}>
                  <div className="stage-status">
                    <span className={"status-pill " + tone}>
                      {done && <Check size={12} />}
                      {skipped && <CircleSlash size={12} />}
                      {label}
                    </span>
                    {step?.pic && (
                      <PersonBadge
                        name={step.pic}
                        lang={lang}
                        caption={
                          done
                            ? t("Performed the work", "Melakukan kerja")
                            : t("Planned PIC (not done)", "PIC dirancang (belum selesai)")
                        }
                      />
                    )}
                  </div>
                  {done && step?.recordedBy && (
                    <small className="block text-muted-foreground">
                      {t("Entered by", "Direkod oleh")}{" "}
                      {recorderLabel(step.recordedBy)}
                    </small>
                  )}
                  {step?.occurrences?.map((o) => (
                    <small key={o.id} className="block">
                      <Wrench size={11} className="inline" />{" "}
                      {t("Rework", "Kerja semula")}: {o.pic} ·{" "}
                      {o.machineName ? o.machineName + " · " : ""}
                      {when(o.occurredAt, lang)} · {o.reason} ·{" "}
                      {t("entered by", "direkod oleh")} {recorderLabel(o.recordedBy)}
                    </small>
                  ))}
                  <div className="stage-actions">
                    {canEdit && open && (
                      <>
                        <Button
                          className="stage-record-button action-primary"
                          onClick={() =>
                            withCount ? recordWithCount(stage, step) : record(stage, step)
                          }
                        >
                          <Check size={16} />
                          {withCount
                            ? t("Record completion + box count", "Rekod penyiapan + kiraan kotak")
                            : step?.pic
                              ? t("Confirm completion", "Sahkan penyiapan")
                              : t("Record completion", "Rekod penyiapan")}
                        </Button>
                        {isOptionalStage(stage.id) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => skip(stage, step)}
                          >
                            <CircleSlash size={14} />
                            {t("Not needed – skip", "Tidak perlu – langkau")}
                          </Button>
                        )}
                      </>
                    )}
                    {canEdit && skipped && !closed(stage.id) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => record(stage, step)}
                      >
                        {t("Record it after all", "Rekodkan juga")}
                      </Button>
                    )}
                    {!canEdit && !done && !skipped && (
                      <span className="text-muted-foreground">
                        {t("Not completed", "Belum selesai")}
                      </span>
                    )}
                  </div>
                  {step && canEdit ? (
                    <details className="stage-more">
                      <summary>
                        {done
                          ? t("Corrections & history", "Pembetulan & sejarah")
                          : t("Planned PIC & history", "PIC dirancang & sejarah")}
                      </summary>
                      <div className="stage-more-body">
                        <ProcessPicTools
                          batch={b}
                          index={index}
                          lang={lang}
                          show={show!}
                          pic={pic!}
                        >
                          {done && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => correct(stage, step, "machine")}
                              >
                                {t("Correct machine", "Betulkan mesin")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => correct(stage, step, "occurredAt")}
                              >
                                {t("Correct time", "Betulkan masa")}
                              </Button>
                              {!closed(stage.id) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => rework(stage, step)}
                                >
                                  {t("Rework", "Kerja semula")}
                                </Button>
                              )}
                            </>
                          )}
                        </ProcessPicTools>
                      </div>
                    </details>
                  ) : (
                    step && <ProcessPicHistory step={step} lang={lang} />
                  )}
                  {stage.id === totalStage && onBoxCount && !b.cancelled && (
                    <div className="stage-box-count">
                      {!sent ? (
                        <p className="field-hint">
                          {t(
                            "Total boxes are entered after production sends the batch.",
                            "Jumlah kotak dimasukkan selepas pengeluaran menghantar kelompok.",
                          )}
                        </p>
                      ) : !done ? (
                        canEdit && !withCount && openBefore.length > 0 ? (
                          <p className="field-hint">
                            {openBeforeHint}{" "}
                            {t(
                              "The box count is then entered with this stage.",
                              "Kiraan kotak kemudian dimasukkan bersama peringkat ini.",
                            )}
                          </p>
                        ) : null
                      ) : !boxReady ? (
                        <p className="field-hint">{openBeforeHint}</p>
                      ) : (
                        <Button
                          size="sm"
                          variant={total === null ? "default" : "outline"}
                          className={total === null ? "action-primary" : undefined}
                          onClick={() => onBoxCount(b)}
                        >
                          {total === null
                            ? t("Enter total boxes", "Masukkan jumlah kotak")
                            : t("Add boxes to the total", "Tambah kotak pada jumlah")}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {stageFilter !== "warehouse" && legacy.map(({ step, index }) => (
            <tr key={`legacy-${index}`}>
              <td data-label={t("Historical record", "Rekod terdahulu")}>
                {stepNames(b)[index][lang === "ms" ? 1 : 0]}
                <small>
                  {t("Historical machine record", "Rekod mesin terdahulu")}
                </small>
              </td>
              <td data-label="PIC">
                <PersonBadge
                  name={step.pic}
                  lang={lang}
                  caption={t("Recorded performer", "Pelaksana direkodkan")}
                />
                <div className="stage-actions">
                  {editable ? (
                    <ProcessPicTools
                      batch={b}
                      index={index}
                      lang={lang}
                      show={show!}
                      pic={pic!}
                    />
                  ) : (
                    <ProcessPicHistory step={step} lang={lang} />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stageFilter !== "warehouse" && (
        <RouteReview batch={b} lang={lang} show={show} role={role} />
      )}
    </div>
  );
}

export function MachineRegistry({
  state,
  lang,
  show,
  embedded = false,
}: {
  state: Draft;
  lang: Lang;
  show?: Show;
  /** Render without the panel frame, for the Stock-in settings sheet. */
  embedded?: boolean;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [query, setQuery] = useState("");
  const machines = (state.machines ?? []).filter((m) =>
    (m.name + " " + (m.code ?? "")).toLowerCase().includes(query.toLowerCase()),
  );
  const stageOptions = sachetProcesses.map((stage) => ({
    value: stage.id,
    label: t(stage.en, stage.ms),
  }));
  const edit = (m: Machine) =>
    show!({
      type: "machine-update",
      title: t("Edit machine details", "Sunting butiran mesin"),
      description: t(
        "Past stage records keep the machine name they were saved with.",
        "Rekod peringkat lalu mengekalkan nama mesin semasa disimpan.",
      ),
      hidden: { id: m.id, expectedVersion: m.version },
      fields: [
        { name: "name", label: t("Machine name", "Nama mesin"), value: m.name },
        {
          name: "code",
          label: t("Asset code / label", "Kod aset / label"),
          value: m.code ?? "",
          required: false,
        },
        reasonField(lang, t("Note", "Catatan"), false),
      ],
    });
  const toggle = (m: Machine) =>
    show!({
      type: m.active ? "machine-deactivate" : "machine-reactivate",
      title: m.active
        ? t("Deactivate machine", "Nyahaktif mesin")
        : t("Reactivate machine", "Aktifkan semula mesin"),
      description: m.active
        ? t(
            "It will no longer be offered for new work. Historical records still show it.",
            "Ia tidak lagi ditawarkan untuk kerja baharu. Rekod lama masih memaparkannya.",
          )
        : m.name,
      hidden: { id: m.id, expectedVersion: m.version },
      fields: [reasonField(lang)],
    });
  const add = show && (
    <Button
      variant="outline"
      onClick={() =>
        show({
          type: "machine-create",
          title: t("Add a machine", "Tambah mesin"),
          description: t(
            "A name is enough. Search the list first to avoid duplicates.",
            "Nama sudah memadai. Cari senarai dahulu untuk elak pendua.",
          ),
          fields: [
            {
              name: "stage",
              label: t("Stage it performs", "Peringkat"),
              type: "select",
              options: stageOptions,
            },
            { name: "name", label: t("Machine name", "Nama mesin") },
            {
              name: "code",
              label: t("Asset code / label", "Kod aset / label"),
              required: false,
            },
          ],
        })
      }
    >
      <Plus size={15} />
      {t("Add machine", "Tambah mesin")}
    </Button>
  );
  const search = (
    <PanelSearch
      value={query}
      onChange={setQuery}
      placeholder={t("Find a machine…", "Cari mesin…")}
      label={t("Find a machine", "Cari mesin")}
    />
  );
  const list = (
    <>
      {machines.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Machine", "Mesin")}</th>
                <th>{t("Stage", "Peringkat")}</th>
                <th>{t("Status", "Status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const stage = sachetStage(m.stage);
                return (
                  <tr key={m.id}>
                    <td>
                      {m.name}
                      {m.code && <small>{m.code}</small>}
                    </td>
                    <td>{stage ? t(stage.en, stage.ms) : m.stage}</td>
                    <td>
                      <span
                        className={
                          "status-pill " + (m.active ? "tone-success" : "tone-muted")
                        }
                      >
                        {m.active ? t("Active", "Aktif") : t("Inactive", "Tidak aktif")}
                      </span>
                    </td>
                    <td>
                      {show && (
                        <span className="flex flex-wrap gap-1">
                          <Button size="sm" variant="ghost" onClick={() => edit(m)}>
                            {t("Edit", "Sunting")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => toggle(m)}>
                            {m.active
                              ? t("Deactivate", "Nyahaktif")
                              : t("Reactivate", "Aktifkan")}
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          {t(
            "No machines registered yet. Stage records can be saved without one.",
            "Belum ada mesin didaftarkan. Rekod peringkat boleh disimpan tanpanya.",
          )}
        </Empty>
      )}
    </>
  );
  if (embedded)
    return (
      <>
        <div className="machine-sheet-toolbar">
          {search}
          {add}
        </div>
        {list}
      </>
    );
  return (
    <Panel
      title={t("Sachet machines", "Mesin sachet")}
      detail={t(
        "Physical machines at this site, by the stage they perform. Production and Stock-in share this list.",
        "Mesin fizikal di tapak ini, mengikut peringkat. Pengeluaran dan Stok masuk berkongsi senarai ini.",
      )}
      action={add}
    >
      {search}
      {list}
    </Panel>
  );
}

/** Compact entry point to the shared machine list, for pages where it is secondary. */
export function MachineSettings({
  state,
  lang,
  show,
}: {
  state: Draft;
  lang: Lang;
  show?: Show;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [open, setOpen] = useState(false);
  const label = t("Sachet machines", "Mesin sachet");
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={label} title={label}>
          <Settings />
        </Button>
      </SheetTrigger>
      <SheetContent className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b px-[23px] py-5 pr-12">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription className="text-xs">
            {t(
              "Physical machines at this site, by the stage they perform. Production and Stock-in share this list.",
              "Mesin fizikal di tapak ini, mengikut peringkat. Pengeluaran dan Stok masuk berkongsi senarai ini.",
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MachineRegistry
            embedded
            state={state}
            lang={lang}
            show={
              show &&
              ((spec) => {
                // The form dialog opens outside this sheet, so close it first.
                setOpen(false);
                show(spec);
              })
            }
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Stock-in view of the same batch/stage records Production edits. */
export function SachetProductionRecords({
  state,
  lang,
  show,
  pic,
  role,
  onTrace,
  machineShow,
  onBoxCount,
}: {
  state: Draft;
  lang: Lang;
  show?: Show;
  pic?: Pic;
  role?: Role;
  onTrace: (id: string) => void;
  /** Present when the viewer may add or change machines. */
  machineShow?: Show;
  /** Present when the viewer may enter a batch's finished box count. */
  onBoxCount?: (batch: Batch) => void;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [query, setQuery] = useState("");
  const batches = state.batches
    .filter(
      (b) =>
        !b.cancelled &&
        isSachet(b.product) &&
        (b.code + " " + b.date).toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);
  return (
    <Panel
      title={t("Sachet production records", "Rekod pengeluaran sachet")}
      detail={t(
        "The same machine and PIC records Production sees. Changes here are saved once, to the shared batch record, and never create stock.",
        "Rekod mesin dan PIC yang sama seperti Pengeluaran. Perubahan disimpan sekali pada rekod kelompok bersama dan tidak mencipta stok.",
      )}
      action={<MachineSettings state={state} lang={lang} show={machineShow} />}
    >
      <PanelSearch
        value={query}
        onChange={setQuery}
        placeholder={t("Batch number or date…", "Nombor kelompok atau tarikh…")}
        label={t("Find a sachet batch", "Cari kelompok sachet")}
      />
      {!!batches.length && (
        <div className="sachet-record-list">
          {batches.map((b) => {
            // Stock-in counts the warehouse stages it records; others see the whole route.
            const warehouseView = role === "intake";
            const stages = warehouseView
              ? warehouseStages(b)
              : routeStages(b).map((stage) => stage.id);
            const done = stages.filter((key) => stageSatisfied(b, key)).length;
            const total = batchBoxTotal(state, b);
            const [tone, status] = warehouseView
              ? !batchTransferred(b)
                ? ["tone-muted", t("In production", "Dalam pengeluaran")]
                : total !== null
                  ? ["tone-success", t("Boxes counted", "Kotak dikira")]
                  : !b.route || warehouseStagesDone(b)
                    ? ["tone-info", t("Ready for box count", "Sedia untuk kiraan kotak")]
                    : ["tone-warning", t("Warehouse stages open", "Peringkat gudang belum selesai")]
              : batchTransferred(b)
                ? ["tone-success", t("Sent to warehouse", "Dihantar ke gudang")]
                : batchComplete(b)
                  ? ["tone-info", t("All stages recorded", "Semua peringkat direkodkan")]
                  : ["tone-muted", t("In production", "Dalam pengeluaran")];
            return (
              <details key={b.id} className="sachet-record">
                <summary>
                  <ChevronRight size={15} className="sachet-record-chevron" />
                  <span className="sachet-record-id">
                    <ProductName id={b.product} />
                    <span className="mono">{b.code}</span>
                  </span>
                  <span className="sachet-record-meta">
                    {b.date} · {done}/{stages.length}{" "}
                    {warehouseView
                      ? t("warehouse stages", "peringkat gudang")
                      : t("stages", "peringkat")}
                    {" · "}
                    {t("Total boxes", "Jumlah kotak")}: {total ?? "—"}
                  </span>
                  <span className="sachet-record-status">
                    {!!b.revisions?.length && (
                      <span className="status-pill tone-warning">
                        {t("Revised", "Disemak semula")}
                      </span>
                    )}
                    <span className={"status-pill " + tone}>{status}</span>
                  </span>
                </summary>
                <div className="sachet-record-body">
                  <StageRecords
                    batch={b}
                    state={state}
                    lang={lang}
                    show={show}
                    pic={pic}
                    role={role}
                    onBoxCount={onBoxCount}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onTrace(b.id)}
                  >
                    {t("Open trace", "Buka jejak")} · {product(b.product).name}
                    <ArrowUpRight />
                  </Button>
                </div>
              </details>
            );
          })}
        </div>
      )}
      {!batches.length && (
        <Empty>{t("No sachet batches match.", "Tiada kelompok sachet sepadan.")}</Empty>
      )}
    </Panel>
  );
}
