"use client";

import { useState } from "react";
import { AlertTriangle, Plus, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonBadge } from "./person-profile";
import { Empty, Panel, ProductName, type Field, type FormSpec } from "./draft-primitives";
import {
  batchComplete,
  batchRoute,
  batchTransferred,
  isSachet,
  product,
  recorderLabel,
  routeStages,
  sachetProcesses,
  sachetRoutes,
  sachetStage,
  stageStep,
  stepNames,
  toMyt,
  tr,
  type Batch,
  type Draft,
  type Lang,
  type Machine,
  type Role,
  type Step,
} from "@/lib/draft";

type Show = (spec: FormSpec) => void;
type Pic = (name?: string, label?: string) => Field;
const when = (iso: string | undefined, lang: Lang) =>
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

/** PIC change tools shared by bottle steps and sachet stages. */
export function ProcessPicTools({
  batch: b,
  index,
  lang,
  show,
  pic,
}: {
  batch: Batch;
  index: number;
  lang: Lang;
  show: Show;
  pic: Pic;
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
        <details className="pic-more">
          <summary>{t("More", "Lagi")}</summary>
          <Button
            size="sm"
            variant="outline"
            onClick={() => change("handover")}
          >
            {t("Shift handover", "Serahan syif")}
          </Button>
        </details>
      )}
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
}: {
  batch: Batch;
  state: Draft;
  lang: Lang;
  show?: Show;
  pic?: Pic;
  role?: Role;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const editable = !!show && !!pic;
  const sent = batchTransferred(b);
  const stages = routeStages(b);
  const legacy = b.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !step.sachetStage && step.done);
  const record = (stage: (typeof sachetProcesses)[number], step?: Step) =>
    show!({
      type: "machine",
      title: t("Record stage completion", "Rekod penyiapan peringkat"),
      description: `${b.code} · ${t(stage.en, stage.ms)} · ${t(
        "Enter the person who actually did the work.",
        "Masukkan orang yang sebenarnya melakukan kerja.",
      )}`,
      hidden: { id: b.id, stage: stage.id, expectedVersion: step?.version ?? 0 },
      fields: [
        {
          ...pic!(
            "pic",
            t("Performed by (PIC)", "Dilakukan oleh (PIC)"),
          ),
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
      ],
    });
  const rework = (stage: (typeof sachetProcesses)[number], step: Step) =>
    show!({
      type: "stage-rework",
      title: t("Record rework / repeat run", "Rekod kerja semula"),
      description: `${b.code} · ${t(stage.en, stage.ms)}`,
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
    stage: (typeof sachetProcesses)[number],
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
        `${b.code} · ${t(stage.en, stage.ms)}` +
        (sent
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
  return (
    <div className="table-scroll my-4">
      <table className="machine-records">
        <thead>
          <tr>
            <th>{t("Stage / machine", "Peringkat / mesin")}</th>
            <th>{t("Performed by (PIC)", "Dilakukan oleh (PIC)")}</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage, position) => {
            const step = stageStep(b, stage.id);
            const index = step ? b.steps.indexOf(step) : -1;
            return (
              <tr key={stage.id}>
                <td data-label={t("Stage / machine", "Peringkat / mesin")}>
                  {position + 1}. {t(stage.en, stage.ms)}
                  {step?.done && (
                    <small>
                      {step.machineName ??
                        t("Machine not specified", "Mesin tidak dinyatakan")}
                      {" · "}
                      {when(step.occurredAt, lang)}
                    </small>
                  )}
                </td>
                <td data-label="PIC">
                  {step?.pic && (
                    <PersonBadge
                      name={step.pic}
                      lang={lang}
                      caption={
                        step.done
                          ? t("Performed the work", "Melakukan kerja")
                          : t("Planned PIC (not done)", "PIC dirancang (belum selesai)")
                      }
                    />
                  )}
                  {step?.recordedBy && (
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
                  {editable && !step?.done && !sent && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => record(stage, step)}
                    >
                      {step?.pic
                        ? t("Confirm completion", "Sahkan penyiapan")
                        : t("Record completion", "Rekod penyiapan")}
                    </Button>
                  )}
                  {!editable && !step?.done && (
                    <span className="text-muted-foreground">
                      {t("Not completed", "Belum selesai")}
                    </span>
                  )}
                  {editable && step?.done && (
                    <span className="flex flex-wrap gap-1">
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
                      {!sent && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => rework(stage, step)}
                        >
                          {t("Rework", "Kerja semula")}
                        </Button>
                      )}
                    </span>
                  )}
                  {step && editable ? (
                    <ProcessPicTools
                      batch={b}
                      index={index}
                      lang={lang}
                      show={show!}
                      pic={pic!}
                    />
                  ) : (
                    step && <ProcessPicHistory step={step} lang={lang} />
                  )}
                </td>
              </tr>
            );
          })}
          {legacy.map(({ step, index }) => (
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <RouteReview batch={b} lang={lang} show={show} role={role} />
    </div>
  );
}

export function MachineRegistry({
  state,
  lang,
  show,
}: {
  state: Draft;
  lang: Lang;
  show?: Show;
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
  return (
    <Panel
      title={t("Sachet machines", "Mesin sachet")}
      detail={t(
        "Physical machines at this site, by the stage they perform. Production and Stock-in share this list.",
        "Mesin fizikal di tapak ini, mengikut peringkat. Pengeluaran dan Stok masuk berkongsi senarai ini.",
      )}
      action={
        show && (
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
        )
      }
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("Find a machine…", "Cari mesin…")}
        aria-label={t("Find a machine", "Cari mesin")}
        className="mb-3 max-w-sm"
      />
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
    </Panel>
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
}: {
  state: Draft;
  lang: Lang;
  show?: Show;
  pic?: Pic;
  role?: Role;
  onTrace: (id: string) => void;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [query, setQuery] = useState("");
  const batches = state.batches
    .filter(
      (b) =>
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
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("Batch number or date…", "Nombor kelompok atau tarikh…")}
        aria-label={t("Find a sachet batch", "Cari kelompok sachet")}
        className="mb-3 max-w-sm"
      />
      {batches.map((b) => (
        <details key={b.id} className="sachet-record">
          <summary>
            <ProductName id={b.product} />{" "}
            <span className="mono">{b.code}</span> · {b.date} ·{" "}
            {batchTransferred(b)
              ? t("Sent to warehouse", "Dihantar ke gudang")
              : batchComplete(b)
                ? t("All stages recorded", "Semua peringkat direkodkan")
                : t("In production", "Dalam pengeluaran")}
            {!!b.revisions?.length && (
              <span className="status-pill tone-warning ml-2">
                {t("Revised", "Disemak semula")}
              </span>
            )}
          </summary>
          <StageRecords
            batch={b}
            state={state}
            lang={lang}
            show={show}
            pic={pic}
            role={role}
          />
          <Button size="sm" variant="ghost" onClick={() => onTrace(b.id)}>
            {t("Open trace", "Buka jejak")} · {product(b.product).name}
          </Button>
        </details>
      ))}
      {!batches.length && (
        <Empty>{t("No sachet batches match.", "Tiada kelompok sachet sepadan.")}</Empty>
      )}
    </Panel>
  );
}
