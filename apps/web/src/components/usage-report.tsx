"use client";

import { useEffect, useState } from "react";
import { Empty, fmt, Panel } from "./draft-primitives";
import { roles, tr, type Lang, type StaffProfile } from "@/lib/draft";
import type { Capability } from "@/lib/capabilities";
import type { View } from "@/lib/landing";
import {
  summarizeUsage,
  USAGE_PERIODS,
  type RoleUsage,
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
 * Reports → Feature usage: per role, the screens and actions the role is meant to use
 * against what was opened and saved in the period. Management and HR only (the server and
 * database refuse everyone else).
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
  const [days, setDays] = useState<number>(30),
    [loaded, setLoaded] = useState<{ key: string; rows?: UsageRow[]; error?: string }>();
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
            ? { key, rows: data.rows }
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
  const when = (at: string | null) =>
    at
      ? new Date(at).toLocaleDateString(lang === "ms" ? "ms-MY" : "en-MY", {
          timeZone: "Asia/Kuala_Lumpur",
          day: "numeric",
          month: "short",
        })
      : t("Never", "Tiada");
  const roleName = (id: string) =>
    roles.find((r) => r.id === id)?.[lang === "ms" ? "ms" : "en"] ?? id;
  const personName = (p: UsagePerson, shared: boolean) =>
    p.profileId
      ? (staffProfiles.find((s) => s.id === p.profileId)?.name ??
        t("Removed packer profile", "Profil pembungkus dibuang"))
      : (p.name || t("Former member", "Bekas ahli")) +
        (shared ? " · " + t("no packer unlocked", "tiada pembungkus dibuka") : "");
  const section = (r: RoleUsage) => {
    const shared = r.people.some((p) => p.profileId);
    const unusedViews = r.views.filter((v) => !v.uses),
      unusedCommands = r.capabilities.flatMap((c) => c.commands).filter((c) => !c.uses);
    return (
      <details key={r.role} className="usage-role">
        <summary>
          <strong>{roleName(r.role)}</strong>
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
        </summary>
        {(unusedViews.length > 0 || unusedCommands.length > 0) && (
          <p className="usage-gap">
            {t("Not used in this period:", "Tidak digunakan dalam tempoh ini:")}{" "}
            {[
              ...unusedViews.map((v) => viewNames[v.view][lang === "ms" ? "ms" : "en"]),
              ...unusedCommands.map((c) => c.command),
            ].join(", ")}
          </p>
        )}
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
                  <td>{viewNames[v.view][lang === "ms" ? "ms" : "en"]}</td>
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
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Person", "Orang")}</th>
                <th className="num">{t("Days active", "Hari aktif")}</th>
                <th className="num">{t("Screens opened", "Skrin dibuka")}</th>
                <th className="num">{t("Actions saved", "Tindakan disimpan")}</th>
                <th className="num">{t("Refused", "Ditolak")}</th>
                <th>{t("Last active", "Kali terakhir aktif")}</th>
              </tr>
            </thead>
            <tbody>
              {r.people.map((p) => (
                <tr key={p.key} className={p.lastAt ? "" : "usage-unused"}>
                  <td>{personName(p, shared)}</td>
                  <td className="num">{p.activeDays}</td>
                  <td className="num">{fmt(p.views)}</td>
                  <td className="num">{fmt(p.commands)}</td>
                  <td className="num">{p.failed ? fmt(p.failed) : ""}</td>
                  <td>{when(p.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    );
  };
  return (
    <Panel
      title={t("Feature usage by role", "Penggunaan ciri mengikut peranan")}
      detail={t(
        "What each role is meant to use against what was opened and saved. Some actions (corrections, cancellations) are rightly rare. Usage statistics only, not a performance ranking.",
        "Apa yang setiap peranan patut gunakan berbanding apa yang dibuka dan disimpan. Sesetengah tindakan (pembetulan, pembatalan) memang jarang. Statistik penggunaan sahaja, bukan kedudukan prestasi.",
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
      ) : (
        <div className="usage-roles">{usage.map(section)}</div>
      )}
    </Panel>
  );
}
