"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Panel,
  Empty,
  OrderProducts,
  OrderQuantities,
  Status,
  units,
  type FormSpec,
  type Field,
} from "./draft-primitives";
import { channels } from "@/lib/awb-import";
import {
  dailyTally,
  packageGroups,
  singleProductOrder,
  orderIssued,
  orderLines,
  orderReady,
  people,
  products,
  stockCartons,
  available,
  today,
  tr,
  type Draft,
  type Lang,
  type Order,
  type Role,
} from "@/lib/draft";

type Props = {
  state: Draft;
  lang: Lang;
  role: Role;
  busy: boolean;
  mode: "management" | "tally";
  show: (form: FormSpec) => void;
  pic: () => Field;
  trace: (id: string) => void;
  correct: (o: Order) => void;
  dispatch: (o: Order) => void;
};
export function OrderWorkspace({
  state,
  lang,
  role,
  busy,
  mode,
  show,
  pic,
  trace,
  correct,
  dispatch,
}: Props) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [date, setDate] = useState(today);
  const [productId, setProduct] = useState("");
  const [packageName, setPackage] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const dayOrders = state.orders.filter((o) => o.date === date);
  const visible = dayOrders.filter(
    (o) =>
      (!productId || orderLines(o).some((l) => l.product === productId)) &&
      (!packageName || o.package === packageName) &&
      `${o.awb} ${o.orderRef ?? ""} ${o.channel}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const chosen = visible.filter(
    (o) => selected.includes(o.id) && orderReady(o) && !o.dispatched,
  );
  const ids = chosen.map((o) => o.id);
  const tally = dailyTally(state, date);
  const supervisor = role === "outbound";
  const eligible = visible.filter((o) => orderReady(o) && !o.dispatched);
  // Search selects matching groups; assignments always describe the whole package group.
  const visibleIds = new Set(visible.map((o) => o.id));
  const groups = packageGroups(dayOrders).filter((g) =>
    g.orders.some((o) => visibleIds.has(o.id)),
  );
  const packers = state.staffProfiles
    ? state.staffProfiles
        .filter((p) => p.role === "packer")
        .map((p) => ({ value: p.id, label: p.name }))
    : people
        .filter((p) => p.includes("Packer"))
        .map((p) => ({ value: p, label: p }));
  const staffName = (id: string) =>
    state.staffProfiles?.find((p) => p.id === id)?.name ?? id;
  function bulk(type: string, title: string, fields: Field[]) {
    show({
      type,
      title,
      description:
        `${chosen.length} AWBs · ${date}` +
        (type === "issue-orders"
          ? t(
              " · Stock is allocated across the selected AWBs in the displayed order, up to their remaining demand. Repeat for another carton if needed.",
              " · Stok diagihkan kepada AWB dipilih mengikut susunan paparan, sehingga baki permintaan. Ulang untuk karton lain jika perlu.",
            )
          : ""),
      hidden: { ids },
      fields,
    });
  }
  const reason: Field = {
    name: "reason",
    label: t("Reason", "Sebab"),
    type: "textarea",
  };
  return (
    <>
      <div className="order-filters">
        <label>
          {t("Fulfilment day (Malaysia)", "Hari pemenuhan (Malaysia)")}
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setSelected([]);
            }}
          />
        </label>
        <label>
          {t("Product / brand", "Produk / jenama")}
          <select
            className="form-select"
            value={productId}
            onChange={(e) => {
              setProduct(e.target.value);
              setPackage("");
              setSelected([]);
            }}
          >
            <option value="">{t("All products", "Semua produk")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Package", "Pakej")}
          <select
            className="form-select"
            value={packageName}
            onChange={(e) => {
              setPackage(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">{t("All packages", "Semua pakej")}</option>
            {[
              ...new Set(
                dayOrders
                  .filter(
                    (o) =>
                      !productId ||
                      orderLines(o).some((l) => l.product === productId),
                  )
                  .map((o) => o.package),
              ),
            ]
              .sort()
              .map((p) => (
                <option key={p}>{p}</option>
              ))}
          </select>
        </label>
        <label>
          {t("Find AWB / order / channel", "Cari AWB / pesanan / saluran")}
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected([]);
            }}
          />
        </label>
      </div>
      <div className="inline-note">
        {dayOrders.length} AWBs ·{" "}
        {dayOrders.filter((o) => !orderReady(o)).length}{" "}
        {t(
          "awaiting review (excluded from demand)",
          "menunggu semakan (tidak termasuk permintaan)",
        )}{" "}
        ·{" "}
        {t(
          "Midnight cutoff. Package rows show the full group, including when searching for an AWB. Carry over unfinished parcels below.",
          "Pertukaran hari pada tengah malam. Baris pakej memaparkan seluruh kumpulan walaupun mencari AWB. Pindahkan bungkusan tertunggak di bawah.",
        )}
      </div>
      {mode === "tally" && (
        <>
          <Panel
            title={t(
              mode === "tally" ? "Daily tally" : "Incoming orders for the day",
              mode === "tally" ? "Jumlah akhir hari" : "Pesanan masuk hari ini",
            )}
            detail={t(
              "Whole-day totals by product. The supervisor count is independent of order demand. Missing packing records remain visible.",
              "Jumlah seluruh hari mengikut produk. Kiraan penyelia berasingan daripada permintaan. Rekod pembungkusan belum diisi kekal kelihatan.",
            )}
          >
            <div className="table-scroll">
              <table className="daily-tally">
                <thead>
                  <tr>
                    {[
                      t("Product", "Produk"),
                      t("Required", "Diperlukan"),
                      t("Supervisor count", "Kiraan penyelia"),
                      t("Issued", "Dikeluarkan"),
                      t("Packed so far", "Dibungkus setakat ini"),
                      t("Review", "Semakan"),
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tally
                    .filter((r) => r.awbs || r.count)
                    .map((r) => {
                      const p = products.find((p) => p.id === r.product)!;
                      return (
                        <tr key={r.product}>
                          <td>
                            {p.name}
                            <small>
                              {r.awbs} AWBs · {units(lang, p.unit)}
                            </small>
                          </td>
                          <td>{r.expected}</td>
                          <td>
                            {r.count?.counted ?? "—"}
                            {r.count && (
                              <small>
                                {staffName(r.count.pic)} ·{" "}
                                {new Date(r.count.at).toLocaleTimeString(
                                  "en-MY",
                                  {
                                    timeZone: "Asia/Kuala_Lumpur",
                                  },
                                )}
                                <br />
                                {t("At count", "Semasa kiraan")}:{" "}
                                {r.count.expected} · Δ{" "}
                                {r.count.counted - r.count.expected}
                                {r.stale
                                  ? ` · ${t("Orders changed — recount", "Pesanan berubah — kira semula")}`
                                  : ""}
                              </small>
                            )}
                            {supervisor && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy || !r.awbs}
                                onClick={() =>
                                  show({
                                    type: "sort-count",
                                    title: t(
                                      "Record supervisor count",
                                      "Rekod kiraan penyelia",
                                    ),
                                    description: `${p.name} · ${date} · ${r.expected} ${units(lang, p.unit)} ${t("required by reviewed orders. Enter your independent total after sorting.", "diperlukan. Masukkan kiraan sendiri selepas pengasingan.")}`,
                                    hidden: { date, product: p.id },
                                    fields: [
                                      {
                                        name: "counted",
                                        type: "number",
                                        min: 0,
                                        label: t(
                                          "Units calculated from your sorted labels",
                                          "Unit dikira daripada label yang diasingkan",
                                        ),
                                      },
                                      pic(),
                                      {
                                        name: "note",
                                        type: "textarea",
                                        label: t(
                                          "Explain any difference or recount",
                                          "Terangkan perbezaan atau kiraan semula",
                                        ),
                                        required: false,
                                      },
                                    ],
                                  })
                                }
                              >
                                {t("Record count", "Rekod kiraan")}
                              </Button>
                            )}
                          </td>
                          <td>
                            {r.issued}
                            <small>Δ {r.issued - r.expected}</small>
                          </td>
                          <td>
                            {r.packed}
                            <small>Δ {r.packed - r.expected}</small>
                          </td>
                          <td>
                            {r.missing} {t("unrecorded", "belum direkod")}
                            <br />
                            {r.mismatched}{" "}
                            {t("AWBs with a mismatch", "AWB dengan perbezaan")}
                            {!r.missing && !r.mismatched && (
                              <small>
                                {t(
                                  "All parcel counts match",
                                  "Semua kiraan bungkusan sepadan",
                                )}
                              </small>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {!tally.some((r) => r.awbs || r.count) && (
              <Empty>
                {t(
                  "No reviewed demand for this day.",
                  "Tiada permintaan disemak pada hari ini.",
                )}
              </Empty>
            )}
          </Panel>
        </>
      )}
      {mode !== "tally" &&
        products
          .filter(
            (p) =>
              (!productId || p.id === productId) &&
              groups.some((g) => g.product === p.id),
          )
          .map((p) => {
            const rows = groups.filter((g) => g.product === p.id);
            const r = tally.find((r) => r.product === p.id)!;
            const productOrders = rows.flatMap((g) => g.orders);
            const issueOrders = productOrders.filter(
              (o) => !o.dispatched && o.actual === null,
            );
            const remaining = issueOrders.reduce(
              (n, o) =>
                n +
                Math.max(
                  0,
                  orderLines(o).reduce((n, l) => n + l.expected, 0) -
                    orderIssued(state, o, p.id),
                ),
              0,
            );
            return (
              <Panel
                key={p.id}
                title={p.name}
                detail={`${productOrders.length} ${t("parcels", "bungkusan")} · ${productOrders.reduce((n, o) => n + o.expected, 0)} ${units(lang, p.unit)} · ${date}`}
              >
                <div className="product-count-bar">
                  <div>
                    <span>
                      {t("Whole-day requirement", "Keperluan seluruh hari")}
                    </span>
                    <strong>
                      {r.expected} <small>{units(lang, p.unit)}</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t("Supervisor count", "Kiraan penyelia")}</span>
                    <strong>
                      {r.count?.counted ?? "—"}{" "}
                      <small>{units(lang, p.unit)}</small>
                    </strong>
                    {r.count && (
                      <small
                        className={
                          r.stale || r.count.counted !== r.expected
                            ? "count-warning"
                            : ""
                        }
                      >
                        {r.stale
                          ? t(
                              "Orders changed — recount",
                              "Pesanan berubah — kira semula",
                            )
                          : `${t("Difference", "Perbezaan")}: ${r.count.counted - r.expected}`}{" "}
                        · {staffName(r.count.pic)}
                      </small>
                    )}
                  </div>
                  <div>
                    <span>
                      {t("Issued / packed", "Dikeluarkan / dibungkus")}
                    </span>
                    <strong>
                      {r.issued} / {r.packed}
                    </strong>
                    <small>{units(lang, p.unit)}</small>
                  </div>
                  {supervisor && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        show({
                          type: "sort-count",
                          title: t(
                            "Record supervisor count",
                            "Rekod kiraan penyelia",
                          ),
                          description: `${p.name} · ${date} · ${t("Count the bottles or boxes needed from all sorted orders for this product today.", "Kira botol atau kotak diperlukan daripada semua pesanan produk yang diasingkan hari ini.")}`,
                          summary: [
                            {
                              label: t(
                                "System requirement",
                                "Keperluan sistem",
                              ),
                              value: `${r.expected} ${units(lang, p.unit)}`,
                            },
                            {
                              label: t("Parcels today", "Bungkusan hari ini"),
                              value: String(r.awbs),
                            },
                          ],
                          hidden: { date, product: p.id },
                          fields: [
                            {
                              name: "counted",
                              type: "number",
                              min: 0,
                              label: `${t("Your count", "Kiraan anda")} · ${units(lang, p.unit)}`,
                              hint: t(
                                "Enter your independent count. A difference will stay visible for review.",
                                "Masukkan kiraan sendiri. Perbezaan kekal kelihatan untuk semakan.",
                              ),
                            },
                            { ...pic(), type: "select" },
                            {
                              name: "note",
                              type: "textarea",
                              label: t(
                                "Reason for a difference or recount",
                                "Sebab perbezaan atau kiraan semula",
                              ),
                              required: !!r.count,
                            },
                          ],
                        })
                      }
                    >
                      {t(
                        r.count ? "Update count" : "Record count",
                        r.count ? "Kemas kini kiraan" : "Rekod kiraan",
                      )}
                    </Button>
                  )}
                </div>
                <div className="table-scroll">
                  <table className="package-table">
                    <thead>
                      <tr>
                        <th>{t("Package", "Pakej")}</th>
                        <th>{t("Per parcel", "Setiap bungkusan")}</th>
                        <th>{t("Parcels", "Bungkusan")}</th>
                        <th>
                          {t("Total", "Jumlah")} {units(lang, p.unit)}
                        </th>
                        <th>{t("Packers", "Pembungkus")}</th>
                        <th>{t("Progress", "Kemajuan")}</th>
                        {supervisor && <th>{t("Assignment", "Tugasan")}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((g) => {
                        const pending = g.orders.filter(
                          (o) => !o.dispatched && o.actual === null,
                        );
                        const names = [
                          ...new Set(
                            g.orders
                              .map((o) => o.assignedPacker)
                              .filter(Boolean),
                          ),
                        ] as string[];
                        const unassigned = pending.filter(
                          (o) => !o.assignedPacker,
                        ).length;
                        return (
                          <tr key={g.key}>
                            <td>
                              <strong>{g.package}</strong>
                            </td>
                            <td>
                              {g.perParcel} {units(lang, p.unit)}
                            </td>
                            <td>{g.orders.length}</td>
                            <td>
                              <strong>{g.perParcel * g.orders.length}</strong>
                            </td>
                            <td>
                              <div className="package-assignments">
                                {names.map((name) => (
                                  <span key={name}>
                                    {staffName(name)}{" "}
                                    <b>
                                      {
                                        g.orders.filter(
                                          (o) => o.assignedPacker === name,
                                        ).length
                                      }
                                    </b>
                                  </span>
                                ))}
                                {unassigned > 0 && (
                                  <small>
                                    {unassigned}{" "}
                                    {t("unassigned", "belum ditugaskan")}
                                  </small>
                                )}
                                {!names.length && !unassigned && "—"}
                              </div>
                            </td>
                            <td>
                              {g.orders.filter((o) => o.actual !== null).length}{" "}
                              / {g.orders.length} {t("recorded", "direkod")}
                            </td>
                            {supervisor && (
                              <td>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    busy || !pending.length || !packers.length
                                  }
                                  onClick={() =>
                                    show({
                                      type: "assign-package",
                                      title: t(
                                        "Assign package to packers",
                                        "Tugaskan pakej kepada pembungkus",
                                      ),
                                      description: `${p.name} · ${g.package} · ${g.perParcel} ${units(lang, p.unit)} ${t("per parcel", "setiap bungkusan")} · ${date}`,
                                      summary: [
                                        {
                                          label: t(
                                            "Remaining parcels",
                                            "Baki bungkusan",
                                          ),
                                          value: String(pending.length),
                                        },
                                        {
                                          label: t(
                                            "Unassigned",
                                            "Belum ditugaskan",
                                          ),
                                          value: String(unassigned),
                                        },
                                      ],
                                      hidden: {
                                        date,
                                        group: g.key,
                                        packers: packers.map((p) => p.value),
                                      },
                                      fields: [
                                        ...packers.map(
                                          (person, i): Field => ({
                                            name: "allocation_" + i,
                                            label:
                                              person.label +
                                              " · " +
                                              t("parcels", "bungkusan"),
                                            type: "number",
                                            min: 0,
                                            hint:
                                              i === 0
                                                ? t(
                                                    "Enter each packer's share of the remaining parcels. AWBs are assigned automatically; completed parcels stay unchanged.",
                                                    "Masukkan bahagian baki bungkusan setiap pembungkus. AWB ditugaskan secara automatik; bungkusan siap kekal.",
                                                  )
                                                : undefined,
                                            value: pending.filter(
                                              (o) =>
                                                o.assignedPacker ===
                                                person.value,
                                            ).length,
                                          }),
                                        ),
                                        { ...pic(), type: "select" },
                                        {
                                          name: "reason",
                                          type: "textarea",
                                          label: t(
                                            "Reason if changing existing assignments",
                                            "Sebab jika mengubah tugasan sedia ada",
                                          ),
                                          required: false,
                                        },
                                      ],
                                      submit: t(
                                        "Save assignments",
                                        "Simpan tugasan",
                                      ),
                                    })
                                  }
                                >
                                  {t("Assign packers", "Tugaskan pembungkus")}
                                </Button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>{t("Total shown", "Jumlah dipaparkan")}</th>
                        <td></td>
                        <td>{productOrders.length}</td>
                        <td>
                          {productOrders.reduce((n, o) => n + o.expected, 0)}
                        </td>
                        <td colSpan={supervisor ? 3 : 2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {supervisor && (
                  <div className="product-package-footer">
                    <p>
                      {remaining} {units(lang, p.unit)}{" "}
                      {t(
                        "still to issue for the packages shown",
                        "masih perlu dikeluarkan untuk pakej dipaparkan",
                      )}
                    </p>
                    <Button
                      disabled={busy || !remaining}
                      variant="outline"
                      onClick={() =>
                        show({
                          type: "issue-orders",
                          title: t(
                            "Take stock from racks",
                            "Ambil stok dari rak",
                          ),
                          description: `${p.name} · ${date} · ${remaining} ${units(lang, p.unit)} ${t("remaining", "berbaki")}`,
                          hidden: { ids: issueOrders.map((o) => o.id) },
                          fields: [
                            {
                              name: "cartonId",
                              label: t("Batch / rack", "Kelompok / rak"),
                              type: "select",
                              options: stockCartons(state)
                                .filter(
                                  (c) =>
                                    c.product === p.id &&
                                    available(state, c) > 0,
                                )
                                .map((c) => ({
                                  value: c.id,
                                  label: `${c.ref} · ${c.rack} · ${available(state, c)} ${units(lang, c.unit)}`,
                                })),
                            },
                            {
                              name: "qty",
                              type: "number",
                              min: 1,
                              label: t(
                                "Units physically taken",
                                "Unit sebenar diambil",
                              ),
                              value: remaining,
                            },
                            { ...pic(), type: "select" },
                          ],
                        })
                      }
                    >
                      {t("Issue stock", "Keluarkan stok")}
                    </Button>
                  </div>
                )}
              </Panel>
            );
          })}
      {mode !== "tally" && !groups.length && (
        <Empty>
          {t(
            "No reviewed packages match these filters.",
            "Tiada pakej disemak sepadan dengan penapis.",
          )}
        </Empty>
      )}
      <details
        className="parcel-details"
        open={
          visible.some((o) => !orderReady(o) || !singleProductOrder(o)) ||
          mode === "tally"
        }
      >
        <summary>
          {t("Parcel records & review", "Rekod bungkusan & semakan")} ·{" "}
          {visible.length}
        </summary>
        {supervisor && mode !== "tally" && (
          <div className="order-bulk">
            <strong>
              {ids.length} {t("selected parcels", "bungkusan dipilih")}
            </strong>
            <Button
              disabled={busy || !ids.length}
              variant="outline"
              onClick={() =>
                bulk(
                  "move-orders",
                  t(
                    "Carry over unfinished parcels",
                    "Pindahkan bungkusan tertunggak",
                  ),
                  [
                    {
                      name: "date",
                      type: "date",
                      label: t("New fulfilment day", "Hari pemenuhan baharu"),
                    },
                    pic(),
                    reason,
                  ],
                )
              }
            >
              {t("Carry over", "Pindah hari")}
            </Button>
          </div>
        )}
        <Panel
          title={t("Parcel records", "Rekod bungkusan")}
          detail={t(
            "Review each AWB, its required contents and its assigned packer. Differences are investigation prompts, not proof of fault.",
            "Semak setiap AWB, kandungan diperlukan dan pembungkus ditugaskan. Perbezaan memerlukan siasatan dan bukan bukti kesalahan.",
          )}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {supervisor && (
                    <th>
                      <input
                        type="checkbox"
                        aria-label={t(
                          "Select all eligible visible AWBs",
                          "Pilih semua AWB yang layak",
                        )}
                        checked={
                          !!eligible.length &&
                          eligible.every((o) => selected.includes(o.id))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? eligible.map((o) => o.id) : [],
                          )
                        }
                      />
                    </th>
                  )}
                  <th>AWB</th>
                  <th>{t("Product / package", "Produk / pakej")}</th>
                  <th>{t("Required", "Diperlukan")}</th>
                  <th>{t("Assigned packer", "Pembungkus ditugaskan")}</th>
                  <th>{t("Packed", "Dibungkus")}</th>
                  <th>{t("Status / actions", "Status / tindakan")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id}>
                    {supervisor && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${o.awb}`}
                          disabled={!orderReady(o) || o.dispatched}
                          checked={selected.includes(o.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, o.id]
                                : selected.filter((id) => id !== o.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td>
                      <button
                        className="record-link mono"
                        onClick={() => trace(o.id)}
                      >
                        {o.awb}
                      </button>
                      <small>{o.channel}</small>
                    </td>
                    <td>
                      <OrderProducts order={o} />
                      <small>{o.package}</small>
                    </td>
                    <td>
                      <OrderQuantities order={o} lang={lang} field="expected" />
                    </td>
                    <td>{staffName(o.assignedPacker ?? "") || "—"}</td>
                    <td>
                      <OrderQuantities order={o} lang={lang} field="actual" />
                    </td>
                    <td>
                      <div className="order-row-actions">
                        {!singleProductOrder(o) ? (
                          <>
                            <span>
                              {t(
                                "Separate brand parcels",
                                "Asingkan bungkusan jenama",
                              )}
                            </span>
                            {(role === "admin" || supervisor) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  show({
                                    type: "split-order",
                                    title: t(
                                      "Separate brands into parcels",
                                      "Asingkan jenama kepada bungkusan",
                                    ),
                                    description: t(
                                      "Enter the actual AWB and package for each brand. Existing stock or packing records must be reconciled separately.",
                                      "Masukkan AWB sebenar dan pakej untuk setiap jenama. Rekod stok atau pembungkusan sedia ada perlu diselaraskan berasingan.",
                                    ),
                                    hidden: { id: o.id },
                                    fields: [
                                      ...[
                                        ...new Set(
                                          orderLines(o).map((l) => l.product),
                                        ),
                                      ].flatMap((id): Field[] => [
                                        {
                                          name: "awb_" + id,
                                          label:
                                            products.find((p) => p.id === id)!
                                              .name + " · AWB",
                                        },
                                        {
                                          name: "package_" + id,
                                          label:
                                            products.find((p) => p.id === id)!
                                              .name +
                                            " · " +
                                            t("Package", "Pakej"),
                                        },
                                      ]),
                                      pic(),
                                      reason,
                                    ],
                                  })
                                }
                              >
                                {t("Separate parcels", "Asingkan bungkusan")}
                              </Button>
                            )}
                          </>
                        ) : !orderReady(o) ? (
                          <>
                            <span>
                              {t("Awaiting review", "Menunggu semakan")}
                            </span>
                            {(role === "admin" || supervisor) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  show({
                                    type: "edit-order",
                                    title: t(
                                      "Edit pending order",
                                      "Sunting pesanan belum disahkan",
                                    ),
                                    description: o.awb,
                                    hidden: { id: o.id },
                                    fields: [
                                      {
                                        name: "awb",
                                        label: "AWB",
                                        value: o.awb,
                                      },
                                      {
                                        name: "channel",
                                        label: t("Source", "Sumber"),
                                        type: "select",
                                        value: o.channel,
                                        options: channels.map((c) => ({
                                          value: c,
                                          label: c,
                                        })),
                                      },
                                      {
                                        name: "product",
                                        label: t("Product", "Produk"),
                                        type: "select",
                                        value: o.product,
                                        options: products.map((p) => ({
                                          value: p.id,
                                          label: p.name,
                                        })),
                                      },
                                      {
                                        name: "package",
                                        label: t(
                                          "Package / SKU",
                                          "Pakej / SKU",
                                        ),
                                        value: o.package,
                                      },
                                      {
                                        name: "expected",
                                        label: t(
                                          "Required units",
                                          "Unit diperlukan",
                                        ),
                                        type: "number",
                                        min: 1,
                                        value: o.expected,
                                      },
                                      {
                                        name: "date",
                                        label: t(
                                          "Fulfilment day",
                                          "Hari pemenuhan",
                                        ),
                                        type: "date",
                                        value: o.date,
                                      },
                                    ],
                                  })
                                }
                              >
                                {t("Edit", "Sunting")}
                              </Button>
                            )}
                            {(role === "admin" || supervisor) && (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  show({
                                    type: "review-order",
                                    title: t(
                                      "Confirm order contents",
                                      "Sahkan kandungan pesanan",
                                    ),
                                    description: `${o.awb} · ${o.package} · ${orderLines(
                                      o,
                                    )
                                      .map(
                                        (l) =>
                                          `${products.find((p) => p.id === l.product)?.name}: ${l.expected}`,
                                      )
                                      .join(" · ")}`,
                                    hidden: { id: o.id },
                                    fields: [pic()],
                                  })
                                }
                              >
                                {t("Review & confirm", "Semak & sahkan")}
                              </Button>
                            )}
                          </>
                        ) : (
                          <Status order={o} lang={lang} />
                        )}{" "}
                        {supervisor && orderReady(o) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => correct(o)}
                          >
                            {t("Correct", "Betulkan")}
                          </Button>
                        )}
                        {supervisor && !o.dispatched && o.actual !== null && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => dispatch(o)}
                          >
                            {t("Handover", "Serahan")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visible.length && (
            <Empty>
              {t(
                "No matching AWBs for this day.",
                "Tiada AWB sepadan untuk hari ini.",
              )}
            </Empty>
          )}
        </Panel>
      </details>
      {mode === "tally" && (
        <Panel
          title={t(
            "Tally by assigned packer",
            "Jumlah mengikut pembungkus ditugaskan",
          )}
          detail={t(
            "Each product is counted separately. Unassigned AWBs and missing declarations remain outstanding.",
            "Setiap produk dikira berasingan. AWB belum ditugaskan dan rekod belum diisi kekal tertunggak.",
          )}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t("Packer", "Pembungkus"),
                    t("Product", "Produk"),
                    "AWBs",
                    t("Required", "Diperlukan"),
                    t("Packed", "Dibungkus"),
                    t("Unrecorded", "Belum direkod"),
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ...new Set(
                    dayOrders
                      .filter(orderReady)
                      .map((o) => o.assignedPacker ?? o.packer),
                  ),
                ].flatMap((packer) =>
                  products.map((p) => {
                    const orders = dayOrders.filter(
                      (o) =>
                        orderReady(o) &&
                        (o.assignedPacker ?? o.packer) === packer &&
                        orderLines(o).some((l) => l.product === p.id),
                    );
                    if (!orders.length) return null;
                    const lines = orders.flatMap((o) =>
                      orderLines(o).filter((l) => l.product === p.id),
                    );
                    return (
                      <tr key={JSON.stringify([packer, p.id])}>
                        <td>
                          {staffName(packer) ||
                            t("Unassigned", "Belum ditugaskan")}
                        </td>
                        <td>
                          {p.name}
                          <small>{units(lang, p.unit)}</small>
                        </td>
                        <td>{orders.length}</td>
                        <td>{lines.reduce((n, l) => n + l.expected, 0)}</td>
                        <td>
                          {lines.reduce((n, l) => n + (l.actual ?? 0), 0)}
                        </td>
                        <td>{lines.filter((l) => l.actual === null).length}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {(state.sortCounts ?? []).some((c) => c.date === date) && (
        <details className="inline-note">
          <summary>
            {t("Supervisor count history", "Sejarah kiraan penyelia")}
          </summary>
          {state.sortCounts
            ?.filter((c) => c.date === date)
            .map((c) => (
              <p key={c.id}>
                {products.find((p) => p.id === c.product)?.name} · {c.expected}{" "}
                → {c.counted} · {staffName(c.pic)} ·{" "}
                {new Date(c.at).toLocaleString("en-MY", {
                  timeZone: "Asia/Kuala_Lumpur",
                })}{" "}
                · {c.note}
              </p>
            ))}
        </details>
      )}
    </>
  );
}

export function PackerPackageSummary({
  orders,
  lang,
  onSelect,
}: {
  orders: Order[];
  lang: Lang;
  onSelect: (ids: string[]) => void;
}) {
  const groups = packageGroups(orders),
    t = (en: string, ms: string) => tr(lang, en, ms);
  return (
    <>
      {products
        .filter((p) => groups.some((g) => g.product === p.id))
        .map((p) => (
          <Panel
            key={p.id}
            title={p.name}
            detail={t("Your assigned packages", "Pakej ditugaskan kepada anda")}
          >
            <div className="table-scroll">
              <table className="package-table">
                <thead>
                  <tr>
                    <th>{t("Package", "Pakej")}</th>
                    <th>{t("Parcels", "Bungkusan")}</th>
                    <th>
                      {t("Total", "Jumlah")} {units(lang, p.unit)}
                    </th>
                    <th>{t("Recorded", "Direkod")}</th>
                    <th>{t("Action", "Tindakan")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups
                    .filter((g) => g.product === p.id)
                    .map((g) => (
                      <tr key={g.key}>
                        <td>
                          {g.package}
                          <small>
                            {g.perParcel} {units(lang, p.unit)}{" "}
                            {t("per parcel", "setiap bungkusan")}
                          </small>
                        </td>
                        <td>{g.orders.length}</td>
                        <td>{g.orders.length * g.perParcel}</td>
                        <td>
                          {g.orders.filter((o) => o.actual !== null).length} /{" "}
                          {g.orders.length}
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onSelect(g.orders.map((o) => o.id))}
                          >
                            {t("View parcels", "Lihat bungkusan")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
    </>
  );
}
