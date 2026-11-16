"use client";

import { useEffect, useState } from "react";
import { Empty, fmt, Panel } from "./draft-primitives";
import { roles, tr, type Lang, type StaffProfile } from "@/lib/draft";
import type { Capability } from "@/lib/capabilities";
import type { View } from "@/lib/landing";
import {
  personUsage,
  summarizeUsage,
  USAGE_PERIODS,
  type PersonUsage,
  type RoleUsage,
  type UsageDay,
  type UsagePerson,
  type UsageRow,
} from "@/lib/usage";

const capabilityNames: Record<Capability, [string, string]> = {
  "production.plan": ["Plan and run batches", "Rancang dan jalankan kelompok"],
  "stage.record": ["Record machine stages", "Rekod peringkat mesin"],
  "stage.correct": ["Correct stages and PICs", "Betulkan peringkat dan PIC"],
  "machines.manage": ["Manage machines", "Urus mesin"],
  "stock.receive": ["Receive and count stock", "Terima dan kira stok"],
  "stock.adjust": ["Adjust and recount stock", "Laras dan kira semula stok"],
  "orders.enter": ["Enter and review orders", "Masukkan dan semak pesanan"],
  "orders.import": ["Upload AWB PDFs and SKUs", "Muat naik PDF AWB dan SKU"],
  "outbound.fulfil": ["Issue stock, assign and pack", "Keluarkan stok, tugaskan dan bungkus"],
  "outbound.correct": ["Correct packed counts", "Betulkan kiraan bungkusan"],
  "sources.read": ["Open source PDFs", "Buka PDF sumber"],
  "review.comment": ["Request follow-up", "Minta susulan"],
  "feedback.post": ["Post feedback", "Hantar maklum balas"],
  "day.close": ["Close the day", "Tutup hari"],
  "members.manage": ["Manage team profiles", "Urus profil pasukan"],
  "trips.log": ["Log trips", "Rekod perjalanan"],
  "trips.read": ["Review trips", "Semak perjalanan"],
  "packing.record": ["Record own packing", "Rekod bungkusan sendiri"],
};
const tone = (used: number, total: number) =>
  !total ? "tone-muted" : used === 0 ? "tone-danger" : used < total ? "tone-warning" : "tone-success";

/**
 * Reports → Feature usage: one role at a time. For the role, the screens and actions it is
 * meant to use against what was opened and saved; for each person, the days they were
 * active, how far through the role's process they got each day and where they stopped.
 * Management and HR only (the server and database refuse everyone else).
 */
export function UsageReport({
  lang,
  workspaceId,
  staffProfiles,
  viewNames,
}: {
  lang: Lang;
  workspaceId: string;
  staffProfiles: StaffProfile[];
  viewNames: Record<View, { en: string; ms: string }>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const L = lang === "ms" ? "ms" : "en";
  const [days, setDays] = useState<number>(30),
    [picked, setPicked] = useState(""),
    [loaded, setLoaded] = useState<{
      key: string;
      rows?: UsageRow[];
      detail?: UsageDay[] | null;
      error?: string;
    }>();
  const key = workspaceId + "|" + days;
  useEffect(() => {
    let current = true;
    fetch(
      "/api/usage?workspace=" + encodeURIComponent(workspaceId) + "&days=" + days,
      { cache: "no-store" },
    )
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!current) return;
        setLoaded(
          res.ok && Array.isArray(data?.rows)
            ? { key, rows: data.rows, detail: Array.isArray(data.detail) ? data.detail : null }
            : { key, error: data?.code === "not-set-up" ? "not-set-up" : "failed" },
        );
      })
      .catch(() => current && setLoaded({ key, error: "failed" }));
    return () => {
      current = false;
    };
  }, [workspaceId, days, key]);
  const result = loaded?.key === key ? loaded : undefined;
  const usage = result?.rows ? summarizeUsage(result.rows) : [];
  const role = usage.find((u) => u.role === picked) ?? usage[0];
  const locale = lang === "ms" ? "ms-MY" : "en-MY";
  const when = (at: string | null) =>
    at
      ? new Date(at).toLocaleDateString(locale, {
          timeZone: "Asia/Kuala_Lumpur",
          day: "numeric",
          month: "short",
        })
      : t("Never", "Tiada");
  const clock = (at: string) =>
    new Date(at).toLocaleTimeString(locale, {
      timeZone: "Asia/Kuala_Lumpur",
      hour: "2-digit",
      minute: "2-digit",
    });
  const dayName = (day: string) =>
    new Date(day + "T00:00:00+08:00").toLocaleDateString(locale, {
      timeZone: "Asia/Kuala_Lumpur",
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  const roleName = (id: string) => roles.find((r) => r.id === id)?.[L] ?? id;
  const personName = (p: UsagePerson, shared: boolean) =>
    p.profileId
      ? (staffProfiles.find((s) => s.id === p.profileId)?.name ??
        t("Removed packer profile", "Profil pembungkus dibuang"))
      : (p.name || t("Former member", "Bekas ahli")) +
        (shared ? " · " + t("no packer unlocked", "tiada pembungkus dibuka") : "");
  const person = (p: UsagePerson, shared: boolean, d: PersonUsage | null) => {
    const features = d ? d.usedViews.length + d.usedCommands.length : 0,
      allFeatures = d ? features + d.unusedViews.length + d.unusedCommands.length : 0;
    return (
      <details key={p.key} className={"usage-person" + (p.lastAt ? "" : " usage-unused")}>
        <summary>
          <strong>{personName(p, shared)}</strong>
          <span className={"status-pill " + (p.lastAt ? "tone-muted" : "tone-danger")}>
            {p.lastAt
              ? `${p.activeDays} ${t("days active", "hari aktif")} · ${t("last", "terakhir")} ${when(p.lastAt)}`
              : t("No activity in this period", "Tiada aktiviti dalam tempoh ini")}
          </span>
          {d && p.lastAt && (
            <span className={"status-pill " + tone(features, allFeatures)}>
              {features}/{allFeatures} {t("features used", "ciri digunakan")}
            </span>
          )}
          {d && p.lastAt && d.steps.length > 0 && (
            <span className={"status-pill " + tone(d.fullDays, d.days.length)}>
              {d.fullDays}/{d.days.length} {t("days with every step", "hari dengan semua langkah")}
            </span>
          )}
          {d?.stoppedAt && (
            <span className="status-pill tone-warning">
              {t("Usually stops before:", "Biasanya berhenti sebelum:")} {d.stoppedAt[L]}
            </span>
          )}
          {p.failed > 0 && (
            <span className="status-pill tone-info">
              {fmt(p.failed)} {t("refused saves", "simpanan ditolak")}
            </span>
          )}
        </summary>
        {!d ? (
          <p className="usage-gap">
            {t(
              "Day-by-day detail needs migration 20261117090000.",
              "Butiran harian memerlukan migrasi 20261117090000.",
            )}
          </p>
        ) : !d.days.length ? (
          <p className="usage-gap">
            {t(
              "Has access but did not sign in, open a screen or save anything in this period.",
              "Mempunyai akses tetapi tidak log masuk, membuka skrin atau menyimpan apa-apa dalam tempoh ini.",
            )}
          </p>
        ) : (
          <>
            {(d.unusedViews.length > 0 || d.unusedCommands.length > 0) && (
              <p className="usage-gap">
                {t("Never used in this period:", "Tidak pernah digunakan dalam tempoh ini:")}{" "}
                {[...d.unusedViews.map((v) => viewNames[v][L]), ...d.unusedCommands].join(", ")}
              </p>
            )}
            {d.steps.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Day", "Hari")}</th>
                      <th>{t("First to last activity", "Aktiviti pertama hingga terakhir")}</th>
                      {d.steps.map(({ step, days: done }) => (
                        <th key={step.id} className="num">
                          {step[L]}
                          <br />
                          <small>
                            {done}/{d.days.length} {t("days", "hari")}
                          </small>
                        </th>
                      ))}
                      <th className="num">{t("Refused", "Ditolak")}</th>
                      <th>{t("Opened, not saved", "Dibuka, tidak disimpan")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.days.map((day) => (
                      <tr key={day.day}>
                        <td>{dayName(day.day)}</td>
                        <td>
                          {clock(day.firstAt)}–{clock(day.lastAt)}
                          {day.signIns > 0 &&
                            ` · ${day.signIns} ${t("sign-in", "log masuk")}`}
                        </td>
                        {day.done.map((done, i) => (
                          <td key={d.steps[i].step.id} className="num">
                            <span
                              className={"status-pill " + (done ? "tone-success" : "tone-danger")}
                            >
                              {done ? t("Done", "Selesai") : t("Not done", "Tidak dibuat")}
                            </span>
                          </td>
                        ))}
                        <td className="num">{day.failed ? fmt(day.failed) : ""}</td>
                        <td>
                          <code>{day.unsaved.join(", ")}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.forms.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Entry form", "Borang kemasukan")}</th>
                      <th className="num">{t("Opened", "Dibuka")}</th>
                      <th className="num">{t("Saved", "Disimpan")}</th>
                      <th className="num">{t("Refused", "Ditolak")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.forms.map((f) => (
                      <tr key={f.command}>
                        <td>
                          <code>{f.command}</code>
                        </td>
                        <td className="num">{fmt(f.opened)}</td>
                        <td className="num">{fmt(f.saved)}</td>
                        <td className="num">{f.failed ? fmt(f.failed) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </details>
    );
  };
  const section = (r: RoleUsage) => {
    const shared = r.people.some((p) => p.profileId);
    const detail = result?.detail ?? null;
    return (
      <div className="usage-role">
        <div className="usage-summary">
          <span className={"status-pill " + tone(r.activePeople, r.people.length)}>
            {r.activePeople}/{r.people.length} {t("people active", "orang aktif")}
          </span>
          <span className={"status-pill " + tone(r.usedViews, r.views.length)}>
            {r.usedViews}/{r.views.length} {t("screens opened", "skrin dibuka")}
          </span>
          <span className={"status-pill " + tone(r.usedCommands, r.totalCommands)}>
            {r.usedCommands}/{r.totalCommands} {t("actions used", "tindakan digunakan")}
          </span>
          {r.failed > 0 && (
            <span className="status-pill tone-info">
              {fmt(r.failed)} {t("refused saves", "simpanan ditolak")}
            </span>
          )}
        </div>
        <h3>{t("People", "Orang")}</h3>
        <p className="usage-gap">
          {t(
            "Open a person to see each day: when they were active, which steps of the role's process they did, refused saves and forms opened without saving.",
            "Buka seseorang untuk melihat setiap hari: bila mereka aktif, langkah proses peranan yang dibuat, simpanan ditolak dan borang dibuka tanpa disimpan.",
          )}
        </p>
        <div className="usage-people">
          {r.people.map((p) =>
            person(p, shared, detail ? personUsage(r.role, p, detail) : null),
          )}
        </div>
        <details className="usage-features">
          <summary>
            {t("Every screen and action of this role", "Semua skrin dan tindakan peranan ini")}
          </summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Screen", "Skrin")}</th>
                  <th className="num">{t("Times opened", "Kali dibuka")}</th>
                  <th className="num">{t("People", "Orang")}</th>
                  <th>{t("Last opened", "Kali terakhir dibuka")}</th>
                </tr>
              </thead>
              <tbody>
                {r.views.map((v) => (
                  <tr key={v.view} className={v.uses ? "" : "usage-unused"}>
                    <td>{viewNames[v.view][L]}</td>
                    <td className="num">{fmt(v.uses)}</td>
                    <td className="num">{v.people}</td>
                    <td>{when(v.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.totalCommands > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Permitted action", "Tindakan dibenarkan")}</th>
                    <th className="num">{t("Times saved", "Kali disimpan")}</th>
                    <th className="num">{t("People", "Orang")}</th>
                    <th className="num">{t("Refused", "Ditolak")}</th>
                    <th>{t("Last saved", "Kali terakhir disimpan")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.capabilities
                    .filter((c) => c.commands.length)
                    .flatMap((c) => [
                      <tr key={c.capability} className="usage-group">
                        <td colSpan={5}>
                          {capabilityNames[c.capability][lang === "ms" ? 1 : 0]} ·{" "}
                          {c.commands.filter((x) => x.uses).length}/{c.commands.length}
                        </td>
                      </tr>,
                      ...c.commands.map((x) => (
                        <tr
                          key={c.capability + x.command}
                          className={x.uses ? "" : "usage-unused"}
                        >
                          <td>
                            <code>{x.command}</code>
                          </td>
                          <td className="num">{fmt(x.uses)}</td>
                          <td className="num">{x.people}</td>
                          <td className="num">{x.failed ? fmt(x.failed) : ""}</td>
                          <td>{when(x.lastAt)}</td>
                        </tr>
                      )),
                    ])}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </div>
    );
  };
  return (
    <Panel
      title={t("Feature usage by role", "Penggunaan ciri mengikut peranan")}
      detail={t(
        "Who was active, what they used and how far through the role's process they got each day. Steps follow saved records and opened screens; a step done by a teammate shows as not done for this person, so ask before concluding.",
        "Siapa yang aktif, apa yang digunakan dan sejauh mana proses peranan dibuat setiap hari. Langkah mengikut rekod disimpan dan skrin dibuka; langkah yang dibuat rakan sepasukan dipaparkan sebagai tidak dibuat bagi orang ini, jadi tanya dahulu sebelum membuat kesimpulan.",
      )}
      action={
        <label className="inline-label">
          {t("Period", "Tempoh")}{" "}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label={t("Period", "Tempoh")}
          >
            {USAGE_PERIODS.map((d) => (
              <option key={d} value={d}>
                {t(`Last ${d} days`, `${d} hari lepas`)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {!result ? (
        <Empty>{t("Loading usage…", "Memuatkan penggunaan…")}</Empty>
      ) : result.error ? (
        <Empty>
          {result.error === "not-set-up"
            ? t(
                "Usage tracking is not set up on this backend yet (migration 20261116090000).",
                "Penjejakan penggunaan belum disediakan pada backend ini (migrasi 20261116090000).",
              )
            : t(
                "The usage report could not be loaded. Refresh to try again.",
                "Laporan penggunaan tidak dapat dimuatkan. Muat semula untuk cuba lagi.",
              )}
        </Empty>
      ) : !role ? (
        <Empty>{t("No members at this site yet.", "Belum ada ahli di tapak ini.")}</Empty>
      ) : (
        <div className="usage-body">
          <div className="usage-tabs" role="tablist">
            {usage.map((u) => (
              <button
                key={u.role}
                type="button"
                role="tab"
                aria-selected={u.role === role.role}
                className={u.role === role.role ? "active" : ""}
                onClick={() => setPicked(u.role)}
              >
                {roleName(u.role)}
                <small>
                  {u.activePeople}/{u.people.length}
                </small>
              </button>
            ))}
          </div>
          {section(role)}
        </div>
      )}
    </Panel>
  );
}
