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
  mode: "management" | "incoming" | "tally";
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
  const groups = new Map<
    string,
    {
      product: string;
      package: string;
      awbs: number;
      units: number;
      unassigned: number;
    }
  >();
  for (const o of visible.filter(orderReady))
    for (const l of orderLines(o)) {
      if (productId && l.product !== productId) continue;
      const key = JSON.stringify([l.product, o.package]);
      const g = groups.get(key) ?? {
        product: l.product,
        package: o.package,
        awbs: 0,
        units: 0,
        unassigned: 0,
      };
      g.awbs++;
      g.units += l.expected;
      if (!o.assignedPacker) g.unassigned++;
      groups.set(key, g);
    }
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
          "Midnight cutoff. Carry over selected unfinished orders manually.",
          "Pertukaran hari pada tengah malam. Pindahkan pesanan tertunggak secara manual.",
        )}
      </div>
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
                            {new Date(r.count.at).toLocaleTimeString("en-MY", {
                              timeZone: "Asia/Kuala_Lumpur",
                            })}
                            <br />
                            {t("At count", "Semasa kiraan")}: {r.count.expected}{" "}
                            · Δ {r.count.counted - r.count.expected}
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
                                  "Count printed labels",
                                  "Kira label bercetak",
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
      {mode !== "tally" && (
        <Panel
          title={t(
            "Sort by product, then package",
            "Asingkan mengikut produk, kemudian pakej",
          )}
          detail={t(
            "Package totals follow the filters above. Mixed-product AWBs appear under each product; do not add their AWB counts together.",
            "Jumlah pakej mengikut penapis. AWB berbilang produk muncul di setiap produk; jangan tambah bilangan AWB tersebut.",
          )}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t("Product", "Produk"),
                    t("Package", "Pakej"),
                    "AWBs",
                    t("Units needed", "Unit diperlukan"),
                    t("Unassigned", "Belum ditugaskan"),
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...groups.values()]
                  .sort(
                    (a, b) =>
                      a.product.localeCompare(b.product) ||
                      a.package.localeCompare(b.package),
                  )
                  .map((g) => (
                    <tr key={JSON.stringify([g.product, g.package])}>
                      <td>{products.find((p) => p.id === g.product)?.name}</td>
                      <td>{g.package}</td>
                      <td>{g.awbs}</td>
                      <td>
                        {g.units}{" "}
                        {units(
                          lang,
                          products.find((p) => p.id === g.product)!.unit,
                        )}
                      </td>
                      <td>{g.unassigned}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {supervisor && mode !== "tally" && (
        <div className="order-bulk">
          <strong>
            {ids.length} {t("selected AWBs", "AWB dipilih")}
          </strong>
          <Button
            disabled={busy || !ids.length}
            variant="outline"
            onClick={() =>
              bulk(
                "print-orders",
                t(
                  "Confirm labels already printed",
                  "Sahkan label sudah dicetak",
                ),
                [pic()],
              )
            }
          >
            {t("Record printed", "Rekod cetakan")}
          </Button>
          <Button
            disabled={busy || !ids.length}
            variant="outline"
            onClick={() =>
              bulk(
                "issue-orders",
                t("Take stock from racks", "Ambil stok dari rak"),
                [
                  {
                    name: "cartonId",
                    label: t("Stock carton / rack", "Karton stok / rak"),
                    type: "select",
                    options: stockCartons(state)
                      .filter(
                        (c) =>
                          available(state, c) > 0 &&
                          chosen.some((o) =>
                            orderLines(o).some((l) => l.product === c.product),
                          ),
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
                    label: t("Units physically taken", "Unit sebenar diambil"),
                  },
                  pic(),
                ],
              )
            }
          >
            {t("Issue stock", "Keluarkan stok")}
          </Button>
          <Button
            disabled={busy || !ids.length}
            onClick={() =>
              bulk(
                "assign-orders",
                t("Assign selected AWBs", "Tugaskan AWB dipilih"),
                [
                  {
                    name: "packer",
                    label: t("Packer", "Pembungkus"),
                    type: "select",
                    options: state.staffProfiles
                      ? state.staffProfiles
                          .filter((p) => p.role === "packer")
                          .map((p) => ({ value: p.id, label: p.name }))
                      : people.map((p) => ({ value: p, label: p })),
                  },
                  pic(),
                  {
                    ...reason,
                    required: false,
                    label: t(
                      "Reason if reassigning",
                      "Sebab jika tukar tugasan",
                    ),
                  },
                ],
              )
            }
          >
            {t("Assign packer", "Tugaskan pembungkus")}
          </Button>
          <Button
            disabled={busy || !ids.length}
            variant="outline"
            onClick={() =>
              bulk(
                "move-orders",
                t("Carry over unfinished AWBs", "Pindahkan AWB tertunggak"),
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
        title={t("Order management", "Pengurusan pesanan")}
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
                      {!orderReady(o) ? (
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
                                    { name: "awb", label: "AWB", value: o.awb },
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
                                      label: t("Package / SKU", "Pakej / SKU"),
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
