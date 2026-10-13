"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { PersonBadge } from "./person-profile";
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
  dailyInventory,
  packEntrySource,
  dailyTally,
  packageGroups,
  singleProductOrder,
  orderIssued,
  orderHasActivity,
  orderLines,
  orderReady,
  packerProfiles,
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
  // Only active packers can be assigned.
  const packers = packerProfiles(state).map((p) => ({ value: p.id, label: p.name }));
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
          <InventoryForDay state={state} lang={lang} date={date} tally={tally} />
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
            const unit = units(lang, p.unit);
            const assigned = productOrders.filter(
              (o) => o.assignedPacker,
            ).length;
            const packedParcels = productOrders.filter(
              (o) => o.actual !== null,
            ).length;
            // The day's work for a product, in the order it happens on the floor.
            const done = [
              !!r.count && !r.stale,
              assigned === productOrders.length,
              r.issued >= r.expected,
              packedParcels === productOrders.length,
            ];
            const current = done.indexOf(false);
            const step = (i: number) =>
              "fulfilment-step" +
              (done[i] ? " is-done" : i === current ? " is-current" : "");
            const mark = (i: number) => (
              <b className="fulfilment-step-mark" aria-hidden>
                {done[i] ? <Check size={14} strokeWidth={3} /> : i + 1}
              </b>
            );
            return (
              <Panel
                key={p.id}
                title={p.name}
                detail={`${productOrders.length} ${t("parcels", "bungkusan")} · ${productOrders.reduce((n, o) => n + o.expected, 0)} ${unit} · ${date}`}
              >
                <ol className="fulfilment-steps">
                  <li className={step(0)}>
                    <span>
                      {mark(0)}
                      {t("Count", "Kira")}
                    </span>
                    <strong>
                      {r.count?.counted ?? "—"}{" "}
                      <small>
                        / {r.expected} {unit}
                      </small>
                    </strong>
                    <small
                      className={
                        r.count &&
                        (r.stale || r.count.counted !== r.expected)
                          ? "count-warning"
                          : ""
                      }
                    >
                      {!r.count
                        ? t(
                            "Supervisor counts what today's orders need.",
                            "Penyelia mengira keperluan pesanan hari ini.",
                          )
                        : r.stale
                          ? t(
                              "Orders changed — count again.",
                              "Pesanan berubah — kira semula.",
                            )
                          : r.count.counted === r.expected
                            ? `${t("Matches", "Sepadan")} · ${staffName(r.count.pic)}`
                            : `${t("Off by", "Beza")} ${r.count.counted > r.expected ? "+" : ""}${r.count.counted - r.expected} · ${staffName(r.count.pic)}`}
                    </small>
                    {supervisor && (
                      <Button
                        size="sm"
                        variant={!done[0] ? "default" : "outline"}
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
                              { ...pic(), compact: true },
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
                  </li>
                  <li className={step(1)}>
                    <span>
                      {mark(1)}
                      {t("Assign packers", "Tugaskan pembungkus")}
                    </span>
                    <strong>
                      {assigned}{" "}
                      <small>
                        / {productOrders.length} {t("parcels", "bungkusan")}
                      </small>
                    </strong>
                    <small>
                      {done[1]
                        ? t(
                            "Every parcel has a packer.",
                            "Setiap bungkusan ada pembungkus.",
                          )
                        : t(
                            "Use Assign packers on each package below.",
                            "Guna Tugaskan pembungkus pada setiap pakej di bawah.",
                          )}
                    </small>
                  </li>
                  <li className={step(2)}>
                    <span>
                      {mark(2)}
                      {t("Take from racks", "Ambil dari rak")}
                    </span>
                    <strong>
                      {r.issued}{" "}
                      <small>
                        / {r.expected} {unit}
                      </small>
                    </strong>
                    <small>
                      {done[2]
                        ? t(
                            "All taken. Rack stock is updated.",
                            "Semua diambil. Stok rak dikemas kini.",
                          )
                        : t(
                            "Record what you pull off the rack and which batch it came from.",
                            "Rekod stok yang diambil dari rak dan kelompoknya.",
                          )}
                    </small>
                    {supervisor && !!remaining && (
                      <Button
                        size="sm"
                        variant={current === 2 ? "default" : "outline"}
                        disabled={busy}
                        onClick={() =>
                          show({
                            type: "issue-orders",
                            title: t(
                              "Take stock from racks",
                              "Ambil stok dari rak",
                            ),
                            description: `${p.name} · ${date} · ${remaining} ${unit} ${t("still to take", "masih perlu diambil")}`,
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
                                label: `${t("Physically taken", "Sebenar diambil")} · ${unit}`,
                                value: remaining,
                              },
                              { ...pic(), compact: true },
                            ],
                          })
                        }
                      >
                        {t("Take stock", "Ambil stok")}
                      </Button>
                    )}
                  </li>
                  <li className={step(3)}>
                    <span>
                      {mark(3)}
                      {t("Pack", "Bungkus")}
                    </span>
                    <strong>
                      {r.packed}{" "}
                      <small>
                        / {r.expected} {unit}
                      </small>
                    </strong>
                    <small>
                      {packedParcels} / {productOrders.length}{" "}
                      {t(
                        "parcels recorded. Packers record each parcel on the Packing page.",
                        "bungkusan direkod. Pembungkus merekod setiap bungkusan di halaman Pembungkusan.",
                      )}
                    </small>
                  </li>
                </ol>
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
                                  <div
                                    className="package-assignment"
                                    key={name}
                                  >
                                    <PersonBadge
                                      name={staffName(name)}
                                      lang={lang}
                                      caption={t("Packer", "Pembungkus")}
                                      compact
                                    />
                                    <b>
                                      {
                                        g.orders.filter(
                                          (o) => o.assignedPacker === name,
                                        ).length
                                      }
                                    </b>
                                  </div>
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
                                            profile: {
                                              name: person.label,
                                              caption: t(
                                                "Packer",
                                                "Pembungkus",
                                              ),
                                            },
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
                                        { ...pic(), compact: true },
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
                    <td>
                      <PersonBadge
                        name={staffName(o.assignedPacker ?? "")}
                        lang={lang}
                        caption={t("Assigned packer", "Pembungkus ditugaskan")}
                        compact
                      />
                    </td>
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
                        {(role === "admin" || supervisor) &&
                          !orderHasActivity(state, o) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                show({
                                  type: "remove-order",
                                  title: t("Remove AWB", "Buang AWB"),
                                  description:
                                    `${o.awb} · ${o.package} · ` +
                                    t(
                                      "Nothing has been issued, packed or handed over for this AWB. It is taken off the list and its PDF label is marked excluded; the audit log keeps the reason.",
                                      "Tiada stok dikeluarkan, dibungkus atau diserahkan untuk AWB ini. Ia dibuang dari senarai dan label PDF-nya ditanda dikecualikan; log audit menyimpan sebab.",
                                    ),
                                  hidden: { id: o.id },
                                  fields: [{ ...reason, required: true }],
                                  submit: t("Remove AWB", "Buang AWB"),
                                })
                              }
                            >
                              {t("Remove", "Buang")}
                            </Button>
                          )}
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
                    t("Entered by", "Direkod oleh"),
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
                          <PersonBadge
                            name={staffName(packer)}
                            lang={lang}
                            caption={t("Packer", "Pembungkus")}
                            compact
                          />
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
                        <td>
                          {(() => {
                            const by = (k: string) =>
                              orders.filter((o) => packEntrySource(o) === k).length;
                            const parts = [
                              [by("packer"), t("packer (PIN)", "pembungkus (PIN)")],
                              [by("supervisor"), t("supervisor", "penyelia")],
                              [by("unknown"), t("not recorded", "tidak direkod")],
                            ].filter(([n]) => n);
                            return parts.length
                              ? parts.map(([n, label]) => `${n} ${label}`).join(" · ")
                              : "—";
                          })()}
                        </td>
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

/**
 * Stock side of the daily tally: what left the racks that day (and came back, arrived or
 * was adjusted), next to what the tally says was issued to that day's orders. The two
 * "issued" figures should match; Δ shows any difference.
 */
function InventoryForDay({
  state,
  lang,
  date,
  tally,
}: {
  state: Draft;
  lang: Lang;
  date: string;
  tally: ReturnType<typeof dailyTally>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const isToday = date === today();
  const rows = dailyInventory(state, date).filter(
    (r) =>
      r.opening ||
      r.received ||
      r.issued ||
      r.returned ||
      r.adjusted ||
      r.closing ||
      tally.find((x) => x.product === r.product)?.issued,
  );
  const delta = (product: string, issued: number) =>
    (tally.find((x) => x.product === product)?.issued ?? 0) - issued;
  const headings = [
    t("Product", "Produk"),
    t("Opening on rack", "Baki awal di rak"),
    t("Received", "Diterima"),
    t("Issued that day", "Dikeluarkan hari itu"),
    t("Returned", "Dipulangkan"),
    t("Adjusted", "Dilaras"),
    isToday ? t("On rack now", "Di rak sekarang") : t("Closing", "Baki akhir"),
    t("Δ vs tally issued", "Δ berbanding tally dikeluarkan"),
  ];
  function exportCsv() {
    const lines = [
      ["Date", ...headings.slice(1, 7).map((h) => h), "Delta vs tally issued", "Product", "Unit"],
      ...rows.map((r) => {
        const p = products.find((x) => x.id === r.product)!;
        return [
          date,
          r.opening,
          r.received,
          r.issued,
          r.returned,
          r.adjusted,
          r.closing,
          delta(r.product, r.issued),
          p.name,
          p.unit,
        ];
      }),
    ];
    const csv = lines
      .map((row) =>
        row
          .map((value) => {
            let x = String(value);
            if (/^[=+@\-\t\r]/.test(x)) x = "'" + x;
            return '"' + x.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "operator-inventory-" + date + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Panel
      title={t("Inventory for the day", "Inventori untuk hari ini")}
      detail={t(
        "Stock on the racks for this Malaysia day: balance before the day, what came in and went out, and the balance after deduction. Issued here should equal Issued in the tally above.",
        "Stok di rak untuk hari Malaysia ini: baki sebelum hari itu, stok masuk dan keluar, dan baki selepas ditolak. Dikeluarkan di sini sepatutnya sama dengan Dikeluarkan dalam tally di atas.",
      )}
      action={
        <Button size="sm" variant="outline" onClick={exportCsv}>
          {t("Export inventory", "Eksport inventori")}
        </Button>
      }
    >
      <div className="table-scroll">
        <table className="daily-tally">
          <thead>
            <tr>
              {headings.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = products.find((x) => x.id === r.product)!;
              const d = delta(r.product, r.issued);
              return (
                <tr key={r.product}>
                  <td>
                    {p.name}
                    <small>{units(lang, p.unit)}</small>
                  </td>
                  <td>{r.opening}</td>
                  <td>{r.received}</td>
                  <td>{r.issued}</td>
                  <td>{r.returned}</td>
                  <td>{r.adjusted}</td>
                  <td>
                    <strong>{r.closing}</strong>
                  </td>
                  <td className={d ? "text-warning" : ""}>
                    {d > 0 ? "+" + d : d}
                    {!!d && (
                      <small>
                        {t(
                          "Issued to orders and stock leaving the racks differ",
                          "Stok untuk pesanan dan stok keluar rak berbeza",
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
      {!rows.length && (
        <Empty>
          {t("No stock on the racks for this day.", "Tiada stok di rak untuk hari ini.")}
        </Empty>
      )}
    </Panel>
  );
}
