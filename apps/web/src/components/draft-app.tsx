"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Boxes,
  Check,
  ChevronRight,
  ClipboardList,
  Factory,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Truck,
  X,
  AlertTriangle,
  Download,
  ScanLine,
  LoaderCircle,
} from "lucide-react";
import { ProductionWorkspace } from "./production-workspace";
import { AwbIntake } from "./awb-intake";
import { channels } from "@/lib/awb-import";
import { PersonBadge } from "./person-profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ActionForm,
  Empty,
  Metric,
  Panel,
  ProductName,
  OrderProducts,
  OrderQuantities,
  Status,
  fmt,
  units,
  type Field,
  type FormSpec,
} from "./draft-primitives";
import {
  available,
  batchReceived,
  batchComplete,
  batchTransferred,
  adypocideReceipts,
  stockCartons,
  type AdypocideReceipt,
  batchUnit,
  orderIssued,
  orderLines,
  people,
  product,
  products,
  roles,
  stepNames,
  today,
  tr,
  variance,
  type Carton,
  type Draft,
  type Lang,
  type Order,
  type Role,
} from "@/lib/draft";

type View =
  | "overview"
  | "production"
  | "warehouse"
  | "outbound"
  | "orders"
  | "packing"
  | "trace"
  | "reports"
  | "feedback";
const navigation: {
  id: View;
  en: string;
  ms: string;
  icon: typeof Factory;
  roles: Role[];
}[] = [
  {
    id: "overview",
    en: "Overview",
    ms: "Gambaran",
    icon: LayoutDashboard,
    roles: ["production", "intake", "outbound", "admin", "management"],
  },
  {
    id: "production",
    en: "Production",
    ms: "Pengeluaran",
    icon: Factory,
    roles: ["production"],
  },
  {
    id: "warehouse",
    en: "Stock in & inventory",
    ms: "Stok masuk & inventori",
    icon: Boxes,
    roles: ["intake"],
  },
  {
    id: "orders",
    en: "Orders & AWBs",
    ms: "Pesanan & AWB",
    icon: FileText,
    roles: ["admin", "outbound"],
  },
  {
    id: "outbound",
    en: "Stock out & dispatch",
    ms: "Stok keluar & serahan",
    icon: Truck,
    roles: ["outbound"],
  },
  {
    id: "packing",
    en: "Packing station",
    ms: "Stesen pembungkusan",
    icon: PackageCheck,
    roles: ["packer", "outbound"],
  },
  {
    id: "trace",
    en: "Traceability",
    ms: "Jejak rekod",
    icon: ScanLine,
    roles: ["production", "intake", "outbound", "management"],
  },
  {
    id: "reports",
    en: "Reports & people",
    ms: "Laporan & pasukan",
    icon: Activity,
    roles: ["management"],
  },
  {
    id: "feedback",
    en: "Testing & feedback",
    ms: "Ujian & maklum balas",
    icon: MessageSquare,
    roles: [
      "production",
      "intake",
      "outbound",
      "admin",
      "packer",
      "management",
    ],
  },
];
const copy: Record<View, [string, string, string, string]> = {
  overview: [
    "Your operations, at a glance",
    "Operasi anda, sekali pandang",
    "A clear view of what's moving — and what needs attention.",
    "Lihat pergerakan operasi dan perkara yang memerlukan perhatian.",
  ],
  production: [
    "From plan to finished batch",
    "Dari pelan ke kelompok siap",
    "Record batches, machine responsibilities and bottle output.",
    "Rekod kelompok, tanggungjawab mesin dan hasil botol.",
  ],
  warehouse: [
    "A place for every unit",
    "Setiap unit ada tempatnya",
    "Receive factory output, box sachets and keep carton balances visible.",
    "Terima hasil kilang, kotakkan sachet dan pantau baki karton.",
  ],
  orders: [
    "Start with the order",
    "Bermula dengan pesanan",
    "Record the AWB and expected contents. Keep sending PDFs through WhatsApp.",
    "Rekod AWB dan kandungan dijangka. Teruskan menghantar PDF melalui WhatsApp.",
  ],
  outbound: [
    "From rack to customer",
    "Dari rak ke pelanggan",
    "Stock issue and courier handover are separate records.",
    "Pengeluaran stok dan serahan kurier ialah rekod berasingan.",
  ],
  packing: [
    "One parcel. An honest count.",
    "Satu bungkusan. Kiraan sebenar.",
    "Enter what you actually packed and who attached the AWB.",
    "Masukkan jumlah sebenar dibungkus dan siapa yang melekatkan AWB.",
  ],
  trace: [
    "Follow the record",
    "Jejaki rekod",
    "Search a batch, carton or AWB to see the recorded chain of responsibility.",
    "Cari kelompok, karton atau AWB untuk melihat rantaian tanggungjawab.",
  ],
  reports: [
    "The whole picture",
    "Gambaran keseluruhan",
    "Review stock movements, parcel counts and staff assignments.",
    "Semak pergerakan stok, jumlah bungkusan dan tugasan kakitangan.",
  ],
  feedback: [
    "Build it with the team",
    "Bina bersama pasukan",
    "Try the daily workflow. Tell us what helps and what gets in the way.",
    "Cuba aliran kerja harian. Beritahu perkara yang membantu atau menyukarkan.",
  ],
};

export function DraftApp() {
  const revisionRef = useRef(0);
  const router = useRouter(),
    params = useSearchParams();
  const [lang, setLang] = useState<Lang>("en"),
    [role, setRole] = useState<Role>("management"),
    [state, setState] = useState<Draft | null>(null),
    [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [form, setForm] = useState<FormSpec | null>(null),
    [formError, setFormError] = useState("");
  const [mobile, setMobile] = useState(false),
    [light, setLight] = useState(false),
    [reset, setReset] = useState(false),
    [query, setQuery] = useState(""),
    [channel, setChannel] = useState("all"),
    [trace, setTrace] = useState<string | null>(null);
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const allowed = navigation.filter((n) => n.roles.includes(role));
  const requested = params.get("view") as View;
  const view = allowed.some((n) => n.id === requested)
    ? requested
    : allowed[0].id;
  const go = (next: View) => {
    router.push("/?view=" + next);
    setQuery("");
    setMobile(false);
  };
  const changeRole = (next: Role) => {
    setRole(next);
    localStorage.setItem("operator-role", next);
    setQuery("");
    setTrace(null);
    setForm(null);
  };
  const changeLang = () => {
    setNotice("");
    const next = lang === "en" ? "ms" : "en";
    setLang(next);
    localStorage.setItem("operator-language", next);
    document.documentElement.lang = next;
  };
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/draft", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok)
        throw new Error("Workspace could not be loaded. Please refresh.");
      const data = await res.json();
      setState(data.state);
      setRevision(data.revision);
      revisionRef.current = data.revision;
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection error.");
    }
  }, [router]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      const savedRole = localStorage.getItem("operator-role");
      if (roles.some((r) => r.id === savedRole)) setRole(savedRole as Role);
      const savedLang = localStorage.getItem("operator-language");
      if (savedLang === "ms") {
        setLang("ms");
        document.documentElement.lang = "ms";
      }
      void load();
    });
  }, [load]);
  async function command(type: string, input: Record<string, unknown>) {
    setBusy(true);
    setFormError("");
    setError("");
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: { type, role, input },
          revision: revisionRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error ?? "Unable to save. Please refresh.");
      setState(data.state);
      setRevision(data.revision);
      revisionRef.current = data.revision;
      setForm(null);
      setReset(false);
      setNotice(
        t(
          "Saved to the shared test workspace.",
          "Disimpan ke ruang ujian bersama.",
        ),
      );
      return data.state as Draft;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unable to save.";
      if (form) setFormError(message);
      else setError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function show(spec: FormSpec) {
    setFormError("");
    setNotice("");
    setForm(spec);
  }
  const pic = (
    name = "pic",
    label = t("Person responsible (PIC)", "Orang bertanggungjawab (PIC)"),
  ): Field => ({
    name,
    label,
    type: "person",
    options: people.map((p) => ({ value: p, label: p })),
    hint: t(
      "Sample people for this draft. Real staff will be added later.",
      "Nama contoh untuk draf. Kakitangan sebenar akan ditambah kemudian.",
    ),
  });
  const number = (
    name: string,
    label: string,
    value?: number,
    min = 0,
  ): Field => ({ name, label, type: "number", value, min });
  const dateField: Field = {
    name: "date",
    label: t("Work date", "Tarikh kerja"),
    type: "date",
    value: today(),
  };
  const productField: Field = {
    name: "product",
    label: t("Product", "Produk"),
    type: "select",
    options: products.map((p) => ({ value: p.id, label: p.name })),
  };
  const noteField = (name = "note", required = false): Field => ({
    name,
    label: t("Notes / exception details", "Catatan / butiran pengecualian"),
    type: "textarea",
    required,
  });
  const newOrder = () =>
    show({
      type: "order",
      title: t("Record an AWB", "Rekod AWB"),
      description: t(
        "Manual entry for the draft. Use a test reference, not a customer's personal data.",
        "Entri manual untuk draf. Gunakan rujukan ujian, bukan data peribadi pelanggan.",
      ),
      fields: [
        { name: "awb", label: t("AWB reference", "Rujukan AWB") },
        {
          name: "channel",
          label: t("Order source", "Sumber pesanan"),
          type: "select",
          options: channels.map((x) => ({
            value: x,
            label: x,
          })),
        },
        productField,
        {
          name: "package",
          label: t("Package name / SKU", "Nama pakej / SKU"),
          hint: t(
            "Sample packages only; real catalog mapping awaits verification.",
            "Pakej contoh sahaja; pemetaan katalog sebenar menunggu pengesahan.",
          ),
        },
        number(
          "expected",
          t(
            "Expected product units in this parcel",
            "Unit produk dijangka dalam bungkusan ini",
          ),
          undefined,
          1,
        ),
        dateField,
        noteField(),
      ],
    });
  const receive = () =>
    show({
      type: "receive",
      title: t("Receive a carton", "Terima karton"),
      description: t(
        "Record the units inside this carton, then assign its rack.",
        "Rekod unit dalam karton ini, kemudian tetapkan rak.",
      ),
      fields: [
        {
          name: "batchId",
          label: t(
            "Factory batch / outstanding transfer",
            "Kelompok kilang / pindahan belum diterima",
          ),
          type: "select",
          options: state?.batches
            .filter(
              (b) => b.product !== "ady" && b.sent > batchReceived(state, b),
            )
            .map((b) => ({
              value: b.id,
              label:
                b.code +
                " · " +
                (b.sent - batchReceived(state, b)) +
                " " +
                units(lang, batchUnit(b)),
            })),
        },
        { name: "ref", label: t("Unique carton number", "Nombor karton unik") },
        number(
          "qty",
          t("Units received in this carton", "Unit diterima dalam karton ini"),
          undefined,
          1,
        ),
        { name: "rack", label: t("Rack / location", "Rak / lokasi") },
        pic(),
      ],
    });
  const receiveAdypocide = () =>
    show({
      type: "receive-ady",
      title: t(
        "Receive Adypocide for boxing",
        "Terima Adypocide untuk pengkotakan",
      ),
      description: t(
        "Record the arriving carton and its batch. Finished boxes will be counted after boxing.",
        "Rekod karton yang tiba dan kelompoknya. Kotak siap akan dikira selepas pengkotakan.",
      ),
      fields: [
        {
          name: "batchId",
          label: t("Factory batch", "Kelompok kilang"),
          type: "select",
          options: state?.batches
            .filter((b) => b.product === "ady" && batchTransferred(b))
            .map((b) => ({ value: b.id, label: b.code })),
        },
        {
          name: "ref",
          label: t(
            "Unique receipt carton number",
            "Nombor karton penerimaan unik",
          ),
        },
        pic(),
      ],
    });
  const finalizeAdypocide = (receipt: AdypocideReceipt) =>
    show({
      type: "stock-in-ady",
      title: t(
        "Finalize Adypocide stock-in",
        "Muktamadkan stok masuk Adypocide",
      ),
      description:
        receipt.ref +
        " · " +
        t(
          "Finish boxing this receipt, then confirm the actual finished box count. Count only boxes not already stocked in. One box is one stock unit.",
          "Selesaikan pengkotakan penerimaan ini, kemudian sahkan jumlah kotak siap sebenar. Kira hanya kotak yang belum direkod sebagai stok. Satu kotak ialah satu unit stok.",
        ),
      hidden: { receiptId: receipt.id },
      fields: [
        number(
          "boxes",
          t("Finished boxes counted", "Kotak siap dikira"),
          undefined,
          0,
        ),
        {
          name: "ref",
          label: t("Stock carton reference", "Rujukan karton stok"),
          value: receipt.ref + "-BOX",
        },
        { name: "rack", label: t("Rack / location", "Rak / lokasi") },
        pic("pic", t("Stock-in supervisor", "Penyelia stok masuk")),
      ],
      submit: t("Confirm box stock-in", "Sahkan stok masuk kotak"),
    });
  const count = (c: Carton) =>
    show({
      type: "count",
      title: t("Record a stock count", "Rekod kiraan stok"),
      description:
        c.ref +
        " · " +
        t(
          "Counting does not change stock until a supervisor records an adjustment.",
          "Kiraan tidak mengubah stok sehingga penyelia merekod pelarasan.",
        ),
      hidden: { cartonId: c.id },
      fields: [
        number(
          "actual",
          t("Physical count", "Kiraan fizikal") +
            " (" +
            units(lang, c.unit) +
            ")",
        ),
        pic(),
      ],
    });
  const issue = (o: Order) =>
    show({
      type: "issue",
      title: t("Issue stock to packing", "Keluarkan stok untuk pembungkusan"),
      description:
        o.awb +
        " · " +
        t(
          "This deducts stock from the rack. Courier handover is recorded separately.",
          "Ini menolak stok dari rak. Serahan kurier direkodkan berasingan.",
        ),
      hidden: { orderId: o.id },
      fields: [
        {
          name: "cartonId",
          label: t("Carton / available units", "Karton / unit tersedia"),
          type: "select",
          options: state?.cartons
            .filter(
              (c) =>
                orderLines(o).some((l) => l.product === c.product) &&
                c.unit === product(c.product).unit &&
                available(state, c) > 0,
            )
            .map((c) => ({
              value: c.id,
              label:
                c.ref + " · " + available(state, c) + " " + units(lang, c.unit),
            })),
        },
        number(
          "qty",
          t("Units taken from carton", "Unit diambil dari karton"),
          undefined,
          1,
        ),
        pic(),
      ],
    });
  const pack = (o: Order) =>
    show({
      type: "pack",
      title: t("Record parcel contents", "Rekod kandungan bungkusan"),
      description:
        o.awb +
        " · " +
        orderLines(o)
          .map(
            (l) =>
              `${product(l.product).name}: ${l.expected} ${units(lang, product(l.product).unit)}`,
          )
          .join(" · "),
      hidden: { id: o.id },
      fields: [
        ...orderLines(o).map((l) =>
          number(
            o.lines ? "actual_" + l.product : "actual",
            product(l.product).name +
              " · " +
              t("Actual packed", "Jumlah dibungkus") +
              " (" +
              units(lang, product(l.product).unit) +
              ")",
          ),
        ),
        pic("pic", t("Packed by", "Dibungkus oleh")),
        pic("labelPic", t("AWB attached by", "AWB dilekatkan oleh")),
      ],
      submit: t("Save actual count", "Simpan kiraan sebenar"),
    });
  const correct = (o: Order) =>
    show({
      type: "correct",
      title: t("Supervisor correction", "Pembetulan penyelia"),
      description:
        o.awb +
        " · " +
        t(
          "The previous value and your reason remain in the activity log.",
          "Nilai sebelumnya dan sebab anda kekal dalam log aktiviti.",
        ),
      hidden: { id: o.id },
      fields: [
        ...(o.lines
          ? [
              {
                name: "product",
                label: t("Product to correct", "Produk untuk dibetulkan"),
                type: "select" as const,
                options: o.lines.map((l) => ({
                  value: l.product,
                  label: product(l.product).name,
                })),
              },
            ]
          : []),
        {
          name: "field",
          label: t("Quantity to correct", "Jumlah untuk dibetulkan"),
          type: "select",
          options: [
            { value: "expected", label: t("Expected units", "Unit dijangka") },
            ...(o.actual !== null
              ? [
                  {
                    value: "actual",
                    label: t("Packed units", "Unit dibungkus"),
                  },
                ]
              : []),
          ],
        },
        number("qty", t("Corrected quantity", "Jumlah dibetulkan")),
        {
          name: "reason",
          label: t("Reason for correction", "Sebab pembetulan"),
          type: "textarea",
        },
      ],
    });
  const dispatch = (o: Order) =>
    show({
      type: "dispatch",
      title: t("Record courier handover", "Rekod serahan kurier"),
      description:
        o.awb +
        " · " +
        t(
          "Record the physical courier handover.",
          "Rekod serahan fizikal kepada kurier.",
        ),
      hidden: { id: o.id },
      fields: [
        {
          name: "reference",
          label: t(
            "Handover / manifest reference",
            "Rujukan serahan / manifes",
          ),
        },
        pic(),
        {
          ...noteField("note", variance(o) !== 0),
          hint:
            variance(o) !== 0
              ? t(
                  "Count mismatch: explain the exception before recording handover.",
                  "Jumlah berbeza: jelaskan pengecualian sebelum merekod serahan.",
                )
              : undefined,
        },
      ],
    });
  const closeDay = () =>
    show({
      type: "close",
      title: t("Record end-of-day review", "Rekod semakan akhir hari"),
      description: t(
        "Records a supervisor's review. It does not mark batches as QC-passed or lock later corrections.",
        "Merekod semakan penyelia. Ini tidak meluluskan QC atau mengunci pembetulan kemudian.",
      ),
      fields: [
        dateField,
        {
          ...noteField("note", true),
          label: t(
            "Review notes and outstanding issues",
            "Catatan semakan dan isu tertunggak",
          ),
        },
      ],
    });
  const feedback = (review = false) =>
    show({
      type: review ? "review" : "feedback",
      title: review
        ? t("Request a follow-up", "Minta tindakan susulan")
        : t("Share testing feedback", "Kongsi maklum balas ujian"),
      description: review
        ? t(
            "Your comment is visible in the shared review log.",
            "Komen anda boleh dilihat dalam log semakan bersama.",
          )
        : t(
            "Mention the screen, the task and what you expected to happen.",
            "Nyatakan skrin, tugas dan perkara yang anda jangkakan.",
          ),
      fields: [
        {
          name: "text",
          label: t("Your note", "Catatan anda"),
          type: "textarea",
        },
      ],
    });
  const search = (value: string) =>
    value.toLowerCase().includes(query.toLowerCase());
  const filteredOrders =
    state?.orders.filter(
      (o) =>
        (channel === "all" || o.channel === channel) &&
        search(
          o.awb +
            " " +
            orderLines(o)
              .map((l) => product(l.product).name)
              .join(" ") +
            " " +
            o.package,
        ),
    ) ?? [];
  const receipts = state ? adypocideReceipts(state) : [];
  const pendingBoxing = receipts.filter((r) => !r.stockedAt);
  const inventoryCartons = state ? stockCartons(state) : [];
  const stockCounts =
    state?.counts.filter((count) =>
      inventoryCartons.some((c) => c.id === count.cartonId),
    ) ?? [];
  const pending = state?.orders.filter((o) => !o.dispatched) ?? [];
  const mismatches =
    state?.orders.filter((o) => variance(o) !== null && variance(o) !== 0) ??
    [];
  const selectedBatch = state?.batches.find((b) => b.id === trace);
  const selectedOrder = state?.orders.find((o) => o.id === trace);
  const selectedCarton = state?.cartons.find((c) => c.id === trace);
  const linkedBatch =
    selectedBatch ??
    (selectedCarton
      ? state?.batches.find((b) => b.id === selectedCarton.batchId)
      : undefined);
  const traceIds = new Set([
    trace,
    linkedBatch?.id,
    ...(selectedOrder
      ? (state?.issues
          .filter((i) => i.orderId === selectedOrder.id)
          .map(
            (i) => state.cartons.find((c) => c.id === i.cartonId)?.batchId,
          ) ?? [])
      : []),
  ]);
  const events = state?.events.filter((e) => traceIds.has(e.entity)) ?? [];

  function orderTable(actions: boolean) {
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("AWB / source", "AWB / sumber")}</th>
              <th>{t("Product / package", "Produk / pakej")}</th>
              <th className="num">{t("Expected", "Dijangka")}</th>
              <th className="num">{t("Issued", "Dikeluarkan")}</th>
              <th className="num">{t("Packed", "Dibungkus")}</th>
              <th>{t("Status", "Status")}</th>
              <th>
                <span className="sr-only">{t("Actions", "Tindakan")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((o) => (
              <tr key={o.id}>
                <td>
                  <button
                    className="record-link mono"
                    onClick={() => setTrace(o.id)}
                  >
                    {o.awb}
                  </button>
                  <small>
                    {[o.channel, o.store, o.courier]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </td>
                <td>
                  <OrderProducts order={o} />
                  <small>{o.package}</small>
                </td>
                <td className="num">
                  <OrderQuantities order={o} lang={lang} field="expected" />
                </td>
                <td className="num">
                  <OrderQuantities
                    order={o}
                    lang={lang}
                    field="issued"
                    state={state!}
                  />
                </td>
                <td
                  className={
                    "num " +
                    (variance(o) !== null && variance(o) !== 0
                      ? "text-warning"
                      : "")
                  }
                >
                  <OrderQuantities order={o} lang={lang} field="actual" />
                </td>
                <td>
                  <Status order={o} lang={lang} />
                </td>
                <td>
                  {actions && role === "outbound" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => correct(o)}
                    >
                      {t("Correct", "Betulkan")}
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("View record", "Lihat rekod") + " " + o.awb}
                      onClick={() => setTrace(o.id)}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredOrders.length && (
          <Empty>{t("No matching orders.", "Tiada pesanan sepadan.")}</Empty>
        )}
      </div>
    );
  }
  function stockTable() {
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("Product", "Produk")}</th>
              <th className="num">{t("Stocked in", "Stok masuk")}</th>
              <th className="num">
                {t("Available on rack", "Tersedia di rak")}
              </th>
              <th className="num">
                {t("Issued to packing", "Untuk pembungkusan")}
              </th>
              <th>{t("Unit", "Unit")}</th>
            </tr>
          </thead>
          <tbody>
            {products.flatMap((p) =>
              [p.unit].map((unit) => (
                <tr key={p.id + unit}>
                  <td>
                    <ProductName id={p.id} />
                  </td>
                  <td className="num">
                    {fmt(
                      inventoryCartons
                        .filter((c) => c.product === p.id)
                        .reduce((n, c) => n + c.qty, 0),
                    )}
                  </td>
                  <td className="num font-medium">
                    {fmt(
                      state!.cartons
                        .filter((c) => c.product === p.id && c.unit === unit)
                        .reduce((n, c) => n + available(state!, c), 0),
                    )}
                  </td>
                  <td className="num">
                    {fmt(
                      state!.issues
                        .filter((i) =>
                          state!.cartons.some(
                            (c) =>
                              c.id === i.cartonId &&
                              c.product === p.id &&
                              c.unit === unit,
                          ),
                        )
                        .reduce((n, i) => n + i.qty, 0),
                    )}
                  </td>
                  <td className="text-muted-foreground">{units(lang, unit)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    );
  }
  function exportReport() {
    if (!state) return;
    const rows: (string | number)[][] = [
      [
        "AWB",
        "Source",
        "Date",
        "Product",
        "Unit",
        "Package",
        "Expected",
        "Issued",
        "Packed",
        "Variance",
        "Packer",
        "AWB attached by",
        "Handed over",
        "Manifest",
      ],
    ];
    state.orders.forEach((o) =>
      orderLines(o).forEach((line) =>
        rows.push([
          o.awb,
          o.channel,
          o.date,
          product(line.product).name,
          product(line.product).unit,
          o.package,
          line.expected,
          orderIssued(state, o, line.product),
          line.actual ?? "",
          line.actual === null ? "" : line.actual - line.expected,
          o.packer,
          o.labelPic,
          o.dispatched ? "Yes" : "No",
          o.handoverRef,
        ]),
      ),
    );
    const csv = rows
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
    a.download = "operator-test-parcels-" + today() + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  function content(): ReactNode {
    if (!state)
      return (
        <div className="loading-state">
          <LoaderCircle className="animate-spin" />
          <p>{t("Opening your workspace…", "Membuka ruang kerja anda…")}</p>
        </div>
      );
    if (view === "overview")
      return (
        <>
          <div className="metrics-grid">
            <Metric
              label={t("Production batches", "Kelompok pengeluaran")}
              value={state.batches.length}
              detail={
                state.batches.filter((b) => !batchComplete(b)).length +
                " " +
                t("in progress", "sedang diproses")
              }
              onClick={
                role === "production" ? () => go("production") : undefined
              }
            />
            <Metric
              label={t("AWBs to fulfil", "AWB untuk dipenuhi")}
              value={pending.length}
              detail={
                state.orders.length +
                " " +
                t("orders recorded in this workspace", "pesanan direkodkan")
              }
            />
            <Metric
              label={t("Courier handovers", "Serahan kurier")}
              value={state.orders.filter((o) => o.dispatched).length}
              detail={t(
                "Parcels physically handed over",
                "Bungkusan diserahkan secara fizikal",
              )}
              color="var(--success)"
            />
            <Metric
              label={t("Count exceptions", "Pengecualian kiraan")}
              value={mismatches.length}
              detail={t(
                "Expected vs declared parcel contents",
                "Kandungan dijangka berbanding direkodkan",
              )}
              color="var(--warning)"
            />
          </div>
          <div className="overview-grid">
            <Panel
              title={t("The operations pipeline", "Aliran operasi")}
              detail={t(
                "All test records · each stage counts its own records",
                "Semua rekod ujian · setiap peringkat mengira rekodnya sendiri",
              )}
            >
              <div className="pipeline">
                {[
                  {
                    icon: Factory,
                    title: t("Production", "Pengeluaran"),
                    count: state.batches.filter((b) => batchComplete(b)).length,
                    unit: t("finished batches", "kelompok siap"),
                    color: "var(--info)",
                  },
                  {
                    icon: ArrowDownToLine,
                    title: t("Stock in", "Stok masuk"),
                    count: inventoryCartons.length,
                    unit: t("cartons recorded", "karton direkodkan"),
                    color: "var(--ai)",
                  },
                  {
                    icon: PackageCheck,
                    title: t("Packing", "Pembungkusan"),
                    count: state.orders.filter((o) => o.actual !== null).length,
                    unit: t("parcels counted", "bungkusan dikira"),
                    color: "var(--warning)",
                  },
                  {
                    icon: Truck,
                    title: t("Handover", "Serahan"),
                    count: state.orders.filter((o) => o.dispatched).length,
                    unit: t("parcels dispatched", "bungkusan diserah"),
                    color: "var(--success)",
                  },
                ].map((x, i) => (
                  <div className="pipeline-stage" key={x.title}>
                    <div className="pipeline-icon" style={{ color: x.color }}>
                      <x.icon size={20} />
                    </div>
                    <span className="pipeline-label">
                      0{i + 1} · {x.title}
                    </span>
                    <strong>{x.count}</strong>
                    <small>{x.unit}</small>
                    {i < 3 && (
                      <ArrowRight className="pipeline-arrow" size={15} />
                    )}
                  </div>
                ))}
              </div>
              <div className="panel-foot">
                <ShieldCheck size={15} />
                {t(
                  "A recorded process is not automatically a QC pass.",
                  "Proses direkodkan tidak bermaksud lulus QC secara automatik.",
                )}
              </div>
            </Panel>
            <Panel
              title={t("Needs a closer look", "Perlu perhatian")}
              detail={t(
                "Start with the exceptions",
                "Mulakan dengan pengecualian",
              )}
            >
              <div className="attention-list">
                {mismatches.slice(0, 2).map((o) => (
                  <button key={o.id} onClick={() => setTrace(o.id)}>
                    <span className="attention-icon">
                      <AlertTriangle size={17} />
                    </span>
                    <span className="attention-copy">
                      <strong>{o.awb}</strong>
                      <small>
                        <OrderQuantities
                          order={o}
                          lang={lang}
                          field="expected"
                        />{" "}
                        {t("expected", "dijangka")} ·{" "}
                        <OrderQuantities order={o} lang={lang} field="actual" />{" "}
                        {t("packed", "dibungkus")}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
                {pendingBoxing.length > 0 && (
                  <div className="attention-item">
                    <span className="attention-icon">
                      <Boxes size={17} />
                    </span>
                    <span className="attention-copy">
                      <strong>
                        {t("Adypocide boxing", "Pengkotakan Adypocide")}
                      </strong>
                      <small>
                        {t(
                          "Finalize finished box counts in stock-in.",
                          "Muktamadkan jumlah kotak siap di stok masuk.",
                        )}
                      </small>
                    </span>
                  </div>
                )}
                {!mismatches.length && (
                  <p className="p-5 text-sm text-success">
                    {t(
                      "No parcel count mismatches.",
                      "Tiada perbezaan jumlah bungkusan.",
                    )}
                  </p>
                )}
              </div>
            </Panel>
          </div>
          <Panel
            title={t("Inventory position", "Kedudukan inventori")}
            detail={t(
              "Bottles and finished Adypocide boxes are counted separately.",
              "Botol dan kotak siap Adypocide dikira berasingan.",
            )}
            action={
              <span className="status-pill tone-muted">
                {products.length} {t("active products", "produk aktif")}
              </span>
            }
          >
            {stockTable()}
          </Panel>
          <Panel
            title={t("Latest activity", "Aktiviti terkini")}
            detail={t(
              "Shared across everyone using the test login",
              "Dikongsi dengan semua pengguna log masuk ujian",
            )}
          >
            <div className="activity-list">
              {state.events.slice(0, 4).map((e) => (
                <div key={e.id}>
                  <span className="activity-dot" />
                  <div>
                    <strong>{e.action}</strong>
                    <p>{e.detail}</p>
                    <small>
                      {e.actor} ·{" "}
                      {new Date(e.at).toLocaleString(
                        lang === "ms" ? "ms-MY" : "en-MY",
                        {
                          timeZone: "Asia/Kuala_Lumpur",
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "numeric",
                          month: "short",
                        },
                      )}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </>
      );
    if (view === "production")
      return (
        <ProductionWorkspace
          state={state}
          lang={lang}
          busy={busy}
          command={command}
          show={show}
          pic={pic}
          number={number}
          closeDay={closeDay}
        />
      );
    if (view === "warehouse")
      return (
        <>
          <div className="toolbar">
            <div className="inline-label">
              <span className="live-dot" />
              {t("Carton-level balances", "Baki setiap karton")}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={receiveAdypocide}>
                <Boxes size={16} />
                {t(
                  "Receive Adypocide for boxing",
                  "Terima Adypocide untuk pengkotakan",
                )}
              </Button>
              <Button className="action-primary" onClick={receive}>
                <Plus size={16} />
                {t("Receive bottle carton", "Terima karton botol")}
              </Button>
            </div>
          </div>
          <Panel
            title={t(
              "Adypocide · warehouse boxing",
              "Adypocide · pengkotakan gudang",
            )}
            detail={t(
              "Received cartons await boxing. The stock-in supervisor confirms finished boxes before they become inventory.",
              "Karton diterima menunggu pengkotakan. Penyelia stok masuk mengesahkan kotak siap sebelum menjadi inventori.",
            )}
          >
            {receipts.length ? (
              <div className="table-scroll">
                <table className="ady-receipts">
                  <thead>
                    <tr>
                      <th>
                        {t(
                          "Receipt carton / batch",
                          "Karton penerimaan / kelompok",
                        )}
                      </th>
                      <th>{t("Received by", "Diterima oleh")}</th>
                      <th>{t("Status", "Status")}</th>
                      <th>{t("Action", "Tindakan")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((receipt) => (
                      <tr key={receipt.id}>
                        <td
                          data-label={t(
                            "Receipt carton / batch",
                            "Karton penerimaan / kelompok",
                          )}
                        >
                          <span className="mono">{receipt.ref}</span>
                          <small>
                            <button
                              className="record-link"
                              onClick={() => setTrace(receipt.batchId)}
                            >
                              {
                                state.batches.find(
                                  (b) => b.id === receipt.batchId,
                                )?.code
                              }
                            </button>
                          </small>
                        </td>
                        <td data-label={t("Received by", "Diterima oleh")}>
                          <PersonBadge
                            name={receipt.pic}
                            lang={lang}
                            caption={t("Received by", "Diterima oleh")}
                          />
                        </td>
                        <td data-label={t("Status", "Status")}>
                          <span
                            className={
                              "status-pill " +
                              (receipt.stockedAt
                                ? "tone-success"
                                : "tone-warning")
                            }
                          >
                            {receipt.stockedAt
                              ? t("Stocked in", "Stok direkodkan")
                              : t(
                                  "Awaiting box count",
                                  "Menunggu kiraan kotak",
                                )}
                          </span>
                        </td>
                        <td data-label={t("Action", "Tindakan")}>
                          {receipt.stockedAt ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setTrace(receipt.stockCartonId!)}
                            >
                              {t("View stock", "Lihat stok")}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => finalizeAdypocide(receipt)}
                            >
                              {t(
                                "Finalize box count",
                                "Muktamadkan kiraan kotak",
                              )}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {t(
                  "No Adypocide receipts yet. Receive a factory carton to begin boxing.",
                  "Belum ada penerimaan Adypocide. Terima karton kilang untuk mula pengkotakan.",
                )}
              </Empty>
            )}
          </Panel>
          <Panel
            title={t("On the racks", "Di rak")}
            detail={t(
              "Stock is deducted when issued to packing, not at courier handover.",
              "Stok ditolak apabila dikeluarkan untuk pembungkusan, bukan semasa serahan kurier.",
            )}
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Carton / batch", "Karton / kelompok")}</th>
                    <th>{t("Product", "Produk")}</th>
                    <th>{t("Rack", "Rak")}</th>
                    <th className="num">{t("Received", "Diterima")}</th>
                    <th className="num">{t("Available", "Tersedia")}</th>
                    <th>{t("Unit", "Unit")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inventoryCartons.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <button
                          onClick={() => setTrace(c.id)}
                          className="record-link mono"
                        >
                          {c.ref}
                        </button>
                        <small>
                          {state.batches.find((b) => b.id === c.batchId)?.code}
                        </small>
                      </td>
                      <td>
                        <ProductName id={c.product} />
                      </td>
                      <td className="mono text-muted-foreground">{c.rack}</td>
                      <td className="num">{fmt(c.qty)}</td>
                      <td className="num font-semibold">
                        {fmt(available(state, c))}
                      </td>
                      <td>{units(lang, c.unit)}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => count(c)}
                        >
                          {t("Count stock", "Kira stok")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title={t("Monthly stock take", "Kiraan stok bulanan")}
            detail={t(
              "Record a physical count first. Apply a reasoned adjustment separately.",
              "Rekod kiraan fizikal dahulu. Buat pelarasan dengan sebab secara berasingan.",
            )}
          >
            {stockCounts.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Carton", "Karton")}</th>
                      <th className="num">{t("Book balance", "Baki rekod")}</th>
                      <th className="num">{t("Counted", "Dikira")}</th>
                      <th>{t("Counted by", "Dikira oleh")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {stockCounts.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">
                          {state.cartons.find((x) => x.id === c.cartonId)?.ref}
                        </td>
                        <td className="num">{c.book}</td>
                        <td
                          className={
                            "num " + (c.actual !== c.book ? "text-warning" : "")
                          }
                        >
                          {c.actual}
                        </td>
                        <td>
                          <PersonBadge
                            name={c.pic}
                            lang={lang}
                            caption={t("Received by", "Diterima oleh")}
                          />
                        </td>
                        <td>
                          {c.adjusted ? (
                            <span className="status-pill tone-success">
                              {t("Adjusted", "Dilaras")}
                            </span>
                          ) : c.actual === c.book ? (
                            <span className="status-pill tone-muted">
                              {t("Balanced", "Seimbang")}
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                show({
                                  type: "adjust",
                                  title: t(
                                    "Adjust carton balance",
                                    "Laraskan baki karton",
                                  ),
                                  description: t(
                                    "The count remains in history. Record why the book balance should change.",
                                    "Kiraan kekal dalam sejarah. Rekod sebab baki perlu diubah.",
                                  ),
                                  hidden: { id: c.id },
                                  fields: [
                                    {
                                      name: "reason",
                                      label: t(
                                        "Adjustment reason",
                                        "Sebab pelarasan",
                                      ),
                                      type: "textarea",
                                    },
                                  ],
                                })
                              }
                            >
                              {t("Review adjustment", "Semak pelarasan")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {t(
                  "No physical counts yet. Choose “Count stock” on a carton above.",
                  "Belum ada kiraan fizikal. Pilih “Kira stok” pada karton di atas.",
                )}
              </Empty>
            )}
          </Panel>
          <Button variant="outline" onClick={closeDay}>
            <ClipboardList size={16} />
            {t("End-of-day review", "Semakan akhir hari")}
          </Button>
        </>
      );
    if (view === "orders")
      return (
        <AwbIntake
          state={state}
          lang={lang}
          role={role}
          busy={busy}
          onCommand={command}
        >
          <div className="toolbar">
            <SearchBox
              query={query}
              setQuery={setQuery}
              placeholder={t(
                "Search AWB, product or package…",
                "Cari AWB, produk atau pakej…",
              )}
            />
            {role === "admin" && (
              <Button className="action-primary" onClick={newOrder}>
                <Plus size={16} />
                {t("Record AWB", "Rekod AWB")}
              </Button>
            )}
          </div>
          <div className="inline-note">
            <MessageSquare size={17} />
            {t(
              "Send PDFs through WhatsApp as usual. Upload a batch to prepare the expected counts, or record one AWB manually.",
              "Hantar PDF melalui WhatsApp seperti biasa. Muat naik kelompok untuk menyediakan jumlah dijangka, atau rekod satu AWB secara manual.",
            )}
          </div>
          <Panel
            title={t("Order register", "Daftar pesanan")}
            action={
              <select
                className="compact-select"
                aria-label={t("Order source filter", "Penapis sumber pesanan")}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                <option value="all">{t("All sources", "Semua sumber")}</option>
                {channels.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            }
          >
            {orderTable(true)}
          </Panel>
        </AwbIntake>
      );
    if (view === "outbound")
      return (
        <>
          <div className="metrics-grid three">
            <Metric
              label={t("AWBs awaiting print", "AWB menunggu cetakan")}
              value={pending.filter((o) => !o.printed).length}
              detail={t("Record the physical print", "Rekod cetakan sebenar")}
            />
            <Metric
              label={t("Awaiting parcel count", "Menunggu kiraan bungkusan")}
              value={pending.filter((o) => o.actual === null).length}
              detail={t(
                "Packer enters actual contents",
                "Pembungkus merekod kandungan sebenar",
              )}
            />
            <Metric
              label={t(
                "Packed, awaiting handover",
                "Dibungkus, menunggu serahan",
              )}
              value={pending.filter((o) => o.actual !== null).length}
              detail={t(
                "Includes unresolved count exceptions",
                "Termasuk pengecualian kiraan",
              )}
              color="var(--warning)"
            />
          </div>
          <SearchBox
            query={query}
            setQuery={setQuery}
            placeholder={t("Find an AWB or product…", "Cari AWB atau produk…")}
          />
          <div className="outbound-list">
            {pending
              .filter((o) =>
                search(
                  o.awb +
                    " " +
                    orderLines(o)
                      .map((l) => product(l.product).name)
                      .join(" "),
                ),
              )
              .map((o) => (
                <section className="outbound-card" key={o.id}>
                  <div className="outbound-summary">
                    <div>
                      <button
                        className="record-link mono"
                        onClick={() => setTrace(o.id)}
                      >
                        {o.awb}
                      </button>
                      <div className="mt-2">
                        <OrderProducts order={o} />
                        <small className="ml-2 text-muted-foreground">
                          {[o.channel, o.courier].filter(Boolean).join(" · ")}
                        </small>
                      </div>
                    </div>
                    <Status order={o} lang={lang} />
                  </div>
                  <div className="outbound-numbers">
                    <span>
                      {t("Expected", "Dijangka")}
                      <strong>
                        <OrderQuantities
                          order={o}
                          lang={lang}
                          field="expected"
                        />
                      </strong>
                    </span>
                    <span>
                      {t("Issued", "Dikeluarkan")}
                      <strong>
                        <OrderQuantities
                          order={o}
                          lang={lang}
                          field="issued"
                          state={state}
                        />
                      </strong>
                    </span>
                    <span>
                      {t("Packed", "Dibungkus")}
                      <strong
                        className={
                          variance(o) !== null && variance(o) !== 0
                            ? "text-warning"
                            : ""
                        }
                      >
                        <OrderQuantities order={o} lang={lang} field="actual" />
                      </strong>
                    </span>
                  </div>
                  <div className="outbound-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={o.printed}
                      onClick={() =>
                        show({
                          type: "print",
                          title: t("Record AWB print", "Rekod cetakan AWB"),
                          description:
                            o.awb +
                            " · " +
                            t(
                              "Confirm the label has been printed.",
                              "Sahkan label telah dicetak.",
                            ),
                          hidden: { id: o.id },
                          fields: [pic()],
                        })
                      }
                    >
                      {o.printed ? <Check size={14} /> : <FileText size={14} />}{" "}
                      {o.printed
                        ? t("Printed", "Dicetak")
                        : t("Record print", "Rekod cetakan")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => issue(o)}
                    >
                      <ArrowUpFromLine size={14} />
                      {t("Issue stock", "Keluarkan stok")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => correct(o)}
                    >
                      {t("Correct", "Betulkan")}
                    </Button>
                    <Button
                      size="sm"
                      className="action-primary"
                      disabled={o.actual === null}
                      onClick={() => dispatch(o)}
                    >
                      {t("Handover", "Serahan")}
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                </section>
              ))}
          </div>
          {!pending.length && (
            <Empty>
              {t(
                "All recorded parcels have been handed over.",
                "Semua bungkusan telah diserahkan.",
              )}
            </Empty>
          )}
          <Button variant="outline" onClick={closeDay}>
            <ClipboardList size={16} />
            {t("End-of-day review", "Semakan akhir hari")}
          </Button>
        </>
      );
    if (view === "packing")
      return (
        <>
          <div className="inline-note">
            <PackageCheck size={18} />
            {t(
              "Enter the actual quantity once. A supervisor handles saved-count corrections. No second QC check is required.",
              "Masukkan jumlah sebenar sekali. Penyelia mengendalikan pembetulan selepas simpan. Tiada semakan QC kedua diperlukan.",
            )}
          </div>
          <SearchBox
            query={query}
            setQuery={setQuery}
            placeholder={t(
              "Search the AWB in front of you…",
              "Cari AWB di hadapan anda…",
            )}
          />
          <div className="packing-grid">
            {filteredOrders
              .filter((o) => !o.dispatched)
              .map((o) => (
                <section className="packing-card" key={o.id}>
                  <div className="flex justify-between items-start gap-3">
                    <span className="channel-label">{o.channel}</span>
                    <Status order={o} lang={lang} />
                  </div>
                  <button
                    className="record-link mono mt-4"
                    onClick={() => setTrace(o.id)}
                  >
                    {o.awb}
                  </button>
                  <h2>
                    <OrderProducts order={o} />
                  </h2>
                  <p className="text-sm text-muted-foreground">{o.package}</p>
                  <div className="packing-counts">
                    <div>
                      <small>
                        {t("Expected contents", "Kandungan dijangka")}
                      </small>
                      <strong>
                        <OrderQuantities
                          order={o}
                          lang={lang}
                          field="expected"
                        />
                      </strong>
                    </div>
                    <div>
                      <small>{t("Your recorded count", "Kiraan anda")}</small>
                      <strong
                        className={
                          variance(o) !== null && variance(o) !== 0
                            ? "text-warning"
                            : ""
                        }
                      >
                        <OrderQuantities order={o} lang={lang} field="actual" />
                      </strong>
                    </div>
                  </div>
                  {o.actual !== null ? (
                    <p className="text-xs text-muted-foreground mb-4">
                      {o.packer} · {t("AWB", "AWB")}: {o.labelPic}
                    </p>
                  ) : null}
                  {role === "packer" ? (
                    <Button
                      className={
                        o.actual === null ? "action-primary w-full" : "w-full"
                      }
                      variant={o.actual === null ? "default" : "outline"}
                      onClick={() => (o.actual === null ? pack(o) : feedback())}
                    >
                      {o.actual === null
                        ? t("Enter actual quantity", "Masukkan jumlah sebenar")
                        : t(
                            "Report a correction needed",
                            "Laporkan pembetulan diperlukan",
                          )}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => correct(o)}
                    >
                      {t("Supervisor correction", "Pembetulan penyelia")}
                    </Button>
                  )}
                </section>
              ))}
          </div>
        </>
      );
    if (view === "trace")
      return (
        <>
          <SearchBox
            query={query}
            setQuery={setQuery}
            placeholder={t(
              "Search batch number, carton or AWB…",
              "Cari nombor kelompok, karton atau AWB…",
            )}
          />
          <div className="inline-note">
            <ScanLine size={18} />
            {t(
              "Traceability follows recorded allocations. Declared parcel counts are not physical proof of every unit packed.",
              "Jejak mengikut peruntukan direkodkan. Kiraan bungkusan bukan bukti fizikal setiap unit dibungkus.",
            )}
          </div>
          <Panel title={t("Batches & cartons", "Kelompok & karton")}>
            <div className="trace-grid">
              {state.batches
                .filter(
                  (b) =>
                    search(b.code + " " + product(b.product).name) ||
                    state.cartons.some(
                      (c) => c.batchId === b.id && search(c.ref),
                    ) ||
                    receipts.some((r) => r.batchId === b.id && search(r.ref)),
                )
                .map((b) => (
                  <div className="trace-batch" key={b.id}>
                    <button
                      className="record-link mono"
                      onClick={() => setTrace(b.id)}
                    >
                      {b.code}
                      <ChevronRight size={15} />
                    </button>
                    <ProductName id={b.product} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      {inventoryCartons
                        .filter((c) => c.batchId === b.id)
                        .map((c) => (
                          <button
                            className="carton-tag mono"
                            key={c.id}
                            onClick={() => setTrace(c.id)}
                          >
                            <Boxes size={12} />
                            {c.ref}
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          </Panel>
          <Panel title={t("AWB records", "Rekod AWB")}>
            {orderTable(false)}
          </Panel>
        </>
      );
    if (view === "reports")
      return (
        <>
          <div className="toolbar">
            <span className="inline-label">
              {t(
                "All test records · Kuala Lumpur time",
                "Semua rekod ujian · waktu Kuala Lumpur",
              )}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={exportReport}>
                <Download size={16} />
                {t("Export parcels", "Eksport bungkusan")}
              </Button>
              <Button className="action-primary" onClick={() => feedback(true)}>
                <MessageSquare size={16} />
                {t("Request follow-up", "Minta susulan")}
              </Button>
            </div>
          </div>
          <Panel
            title={t("Stock movement review", "Semakan pergerakan stok")}
            detail={t(
              "Warehouse receipt and rack issue, by product and unit. Boxing output appears in available boxes.",
              "Penerimaan gudang dan pengeluaran rak mengikut produk dan unit. Hasil pengkotakan muncul dalam kotak tersedia.",
            )}
          >
            {stockTable()}
          </Panel>
          <Panel
            title={t("Parcel reconciliation", "Penyesuaian bungkusan")}
            detail={t(
              "Expected, issued and declared quantities remain independently visible.",
              "Jumlah dijangka, dikeluarkan dan direkodkan dipaparkan secara berasingan.",
            )}
          >
            {orderTable(false)}
          </Panel>
          <Panel
            title={t("People & assignments", "Pasukan & tugasan")}
            detail={t(
              "Recorded work only. Counts show assignments, not an individual performance ranking.",
              "Kerja direkodkan sahaja. Kiraan menunjukkan tugasan, bukan kedudukan prestasi individu.",
            )}
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Team member", "Ahli pasukan")}</th>
                    <th className="num">
                      {t("Processes recorded", "Proses direkodkan")}
                    </th>
                    <th className="num">
                      {t("Parcels packed", "Bungkusan dibungkus")}
                    </th>
                    <th className="num">
                      {t("AWBs attached", "AWB dilekatkan")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p}>
                      <td>
                        <PersonBadge name={p} lang={lang} />
                      </td>
                      <td className="num">
                        {
                          state.batches
                            .flatMap((b) => b.steps)
                            .filter((s) => s.done && s.pic === p).length
                        }
                      </td>
                      <td className="num">
                        {state.orders.filter((o) => o.packer === p).length}
                      </td>
                      <td className="num">
                        {state.orders.filter((o) => o.labelPic === p).length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title={t("Management review log", "Log semakan pengurusan")}
            detail={t(
              "Review, comment and request follow-up. Operational changes remain with supervisors.",
              "Semak, komen dan minta susulan. Perubahan operasi kekal dengan penyelia.",
            )}
          >
            {state.notes.filter((n) => n.kind === "review").length ? (
              <div className="note-list">
                {state.notes
                  .filter((n) => n.kind === "review")
                  .map((n) => (
                    <article key={n.id}>
                      <span className="status-pill tone-info">
                        {t("Follow-up requested", "Susulan diminta")}
                      </span>
                      <p>{n.text}</p>
                      <small>
                        {new Date(n.at).toLocaleString("en-MY", {
                          timeZone: "Asia/Kuala_Lumpur",
                        })}
                      </small>
                    </article>
                  ))}
              </div>
            ) : (
              <Empty>
                {t("No review notes yet.", "Belum ada catatan semakan.")}
              </Empty>
            )}
          </Panel>
        </>
      );
    return (
      <>
        <div className="test-intro">
          <span className="test-intro-icon">
            <MessageSquare size={26} />
          </span>
          <div>
            <h2>
              {t(
                "Try a role. Follow a real day's work.",
                "Cuba satu peranan. Ikuti kerja harian.",
              )}
            </h2>
            <p>
              {t(
                "Use the role switcher to move between stations. Saved changes are shared with everyone using this login.",
                "Gunakan penukar peranan untuk beralih stesen. Perubahan disimpan dikongsi dengan semua pengguna log masuk ini.",
              )}
            </p>
          </div>
          <Button className="action-primary" onClick={() => feedback()}>
            {t("Leave feedback", "Beri maklum balas")}
          </Button>
        </div>
        <Panel
          title={t("Suggested team walkthrough", "Cadangan ujian pasukan")}
        >
          <div className="walkthrough">
            {[
              [
                t("Production supervisor", "Penyelia pengeluaran"),
                t(
                  "Plan a batch, record each process and send finished output.",
                  "Rancang kelompok, rekod setiap proses dan hantar hasil siap.",
                ),
              ],
              [
                t("Stock-in supervisor", "Penyelia stok masuk"),
                t(
                  "Receive cartons. Finalize Adypocide box counts after boxing, or record a monthly stock count.",
                  "Terima karton. Muktamadkan kiraan kotak Adypocide selepas pengkotakan, atau rekod kiraan stok bulanan.",
                ),
              ],
              [
                t("Office admin", "Admin pejabat"),
                t(
                  "Add a test AWB with a package and expected quantity.",
                  "Tambah AWB ujian dengan pakej dan jumlah dijangka.",
                ),
              ],
              [
                t("Stock-out supervisor", "Penyelia stok keluar"),
                t(
                  "Record the print and issue matching carton stock to an AWB.",
                  "Rekod cetakan dan keluarkan stok karton sepadan untuk AWB.",
                ),
              ],
              [
                t("Packer", "Pembungkus"),
                t(
                  "Enter the actual quantity and the two handlers for that parcel.",
                  "Masukkan jumlah sebenar dan dua pengendali bungkusan itu.",
                ),
              ],
              [
                t(
                  "Stock-out supervisor / Management",
                  "Penyelia stok keluar / Pengurusan",
                ),
                t(
                  "Review any difference, record handover, then trace and comment.",
                  "Semak perbezaan, rekod serahan, kemudian jejaki dan komen.",
                ),
              ],
            ].map(([title, body], i) => (
              <div key={title}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <div className="inline-note">
          <ShieldCheck size={18} />
          {t(
            "This is a shared team test workspace. Role switching does not create separate staff identities. PDF imports use editable Fullkit starting quantities. Adypocide stock begins with supervisor-confirmed warehouse box counts. No order-platform, WhatsApp or Fullkit sync runs here.",
            "Ini draf UI berfungsi. Penukar peranan memaparkan akses; ia tidak mencipta identiti kakitangan berasingan. Stok Adypocide bermula dengan kiraan kotak gudang yang disahkan penyelia. Tiada pesanan sebenar, mesej atau penyegerakan Fullkit dijalankan.",
          )}
        </div>
        <Panel
          title={t("Team feedback", "Maklum balas pasukan")}
          detail={t(
            "Shared notes for the next iteration",
            "Catatan bersama untuk penambahbaikan seterusnya",
          )}
        >
          {state.notes.filter((n) => n.kind === "feedback").length ? (
            <div className="note-list">
              {state.notes
                .filter((n) => n.kind === "feedback")
                .map((n) => (
                  <article key={n.id}>
                    <small>
                      {
                        roles.find((r) => r.id === n.role)?.[
                          lang === "ms" ? "ms" : "en"
                        ]
                      }
                    </small>
                    <p>{n.text}</p>
                    <small>
                      {new Date(n.at).toLocaleString("en-MY", {
                        timeZone: "Asia/Kuala_Lumpur",
                      })}
                    </small>
                  </article>
                ))}
            </div>
          ) : (
            <Empty>
              {t(
                "Your team's feedback will appear here.",
                "Maklum balas pasukan akan muncul di sini.",
              )}
            </Empty>
          )}
        </Panel>
        <div className="reset-section">
          <div>
            <strong>
              {t("Start the shared test again", "Mulakan semula ujian bersama")}
            </strong>
            <p>
              {t(
                "Reset all sample records and feedback for everyone using this login.",
                "Tetapkan semula semua rekod contoh dan maklum balas untuk semua pengguna.",
              )}
            </p>
          </div>
          <Button variant="outline" onClick={() => setReset(true)}>
            {t("Reset sample data", "Tetap semula data contoh")}
          </Button>
        </div>
      </>
    );
  }
  const sidebar = (
    <>
      <div className="brand">
        <span className="brand-mark">e.</span>
        <span>
          operator<span className="brand-company">EFFEN GROUP</span>
        </span>
      </div>
      <div className="workspace-label">
        {t("OPERATIONS WORKSPACE", "RUANG KERJA OPERASI")}
      </div>
      <nav aria-label={t("Main navigation", "Navigasi utama")}>
        {allowed
          .filter((n) => n.id !== "feedback")
          .map((n) => (
            <button
              key={n.id}
              className={"nav-item " + (view === n.id ? "active" : "")}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              {n[lang === "ms" ? "ms" : "en"]}
              {view === n.id && <span className="nav-active-dot" />}
            </button>
          ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={"nav-item " + (view === "feedback" ? "active" : "")}
          onClick={() => go("feedback")}
        >
          <MessageSquare size={18} />
          {t("Testing & feedback", "Ujian & maklum balas")}
        </button>
        <div className="test-account">
          <span className="avatar">EF</span>
          <div>
            <strong>{t("EFFEN test team", "Pasukan ujian EFFEN")}</strong>
            <small>{t("Shared test account", "Akaun ujian bersama")}</small>
          </div>
          <button
            aria-label={t("Sign out", "Log keluar")}
            onClick={async () => {
              const res = await fetch("/api/logout", { method: "POST" });
              if (res.ok) {
                router.replace("/login");
                router.refresh();
              } else setError("Unable to sign out. Please retry.");
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </>
  );
  return (
    <div className="app-layout">
      <aside className="sidebar desktop-sidebar">{sidebar}</aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="p-0 w-72">
          <SheetHeader className="sr-only">
            <SheetTitle>{t("Navigation", "Navigasi")}</SheetTitle>
            <SheetDescription>
              {t("Choose a workspace screen.", "Pilih skrin ruang kerja.")}
            </SheetDescription>
          </SheetHeader>
          <aside className="sidebar mobile-sidebar">{sidebar}</aside>
        </SheetContent>
      </Sheet>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-title">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              onClick={() => setMobile(true)}
              aria-label={t("Open navigation", "Buka navigasi")}
            >
              <Menu size={20} />
            </Button>
            <span>{t("Workspace", "Ruang kerja")}</span>
            <ChevronRight size={13} />
            <strong>
              {
                navigation.find((n) => n.id === view)?.[
                  lang === "ms" ? "ms" : "en"
                ]
              }
            </strong>
          </div>
          <div className="topbar-controls">
            <Button
              variant="ghost"
              size="sm"
              onClick={changeLang}
              aria-label={t("Switch to Bahasa Melayu", "Tukar ke English")}
            >
              {lang === "en" ? "EN / BM" : "BM / EN"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(
                "Toggle light / dark theme",
                "Tukar tema cerah / gelap",
              )}
              onClick={() => {
                document.documentElement.classList.toggle("dark", light);
                setLight(!light);
              }}
            >
              {light ? <Moon size={17} /> : <Sun size={17} />}
            </Button>
            <span className="topbar-divider" />
            <span className="status-pill tone-success">
              <span className="live-dot" />
              {t("Test workspace", "Ruang ujian")}
            </span>
          </div>
        </header>
        <div className="draft-strip">
          <span>
            <span className="test-dot" />
            {t("TEAM TESTING", "UJIAN PASUKAN")}
            <span className="strip-detail">
              {t(
                "Fictional data · shared with your team",
                "Data rekaan · dikongsi dengan pasukan",
              )}
            </span>
          </span>
          <label htmlFor="role-switch">
            {t("Preview role", "Pratonton peranan")}
            <select
              id="role-switch"
              value={role}
              onChange={(e) => changeRole(e.target.value as Role)}
            >
              {roles.map((r) => (
                <option value={r.id} key={r.id}>
                  {r[lang === "ms" ? "ms" : "en"]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <main className="workspace-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {t("EFFEN OPERATIONS", "OPERASI EFFEN")} <span>/</span>{" "}
                {new Date().toLocaleDateString(
                  lang === "ms" ? "ms-MY" : "en-MY",
                  {
                    timeZone: "Asia/Kuala_Lumpur",
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  },
                )}
              </div>
              <h1>{copy[view][lang === "ms" ? 1 : 0]}</h1>
              <p>{copy[view][lang === "ms" ? 3 : 2]}</p>
            </div>
            <Button
              variant="outline"
              className="refresh-button"
              aria-label={t(
                "Refresh shared records",
                "Muat semula rekod bersama",
              )}
              disabled={busy}
              onClick={() => {
                setNotice("");
                void load();
              }}
            >
              <RefreshCw size={15} />
              <span>{t("Refresh", "Muat semula")}</span>
            </Button>
          </div>
          {error && (
            <div className="form-error mb-5" role="alert">
              {error}{" "}
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                {t("Refresh records", "Muat semula rekod")}
              </Button>
            </div>
          )}
          {notice && (
            <div className="save-notice" role="status">
              <Check size={16} />
              {notice}
              <button
                onClick={() => setNotice("")}
                aria-label={t("Dismiss", "Tutup")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="view-content">{content()}</div>
          <footer className="workspace-footer">
            <span>Operator by EFFEN Group</span>
            <span>
              {t(
                "UI draft · all dates in MYT",
                "Draf UI · semua tarikh dalam MYT",
              )}{" "}
              · r{revision}
            </span>
          </footer>
        </main>
      </div>
      <ActionForm
        spec={form}
        lang={lang}
        busy={busy}
        error={formError}
        onClose={() => setForm(null)}
        onSubmit={command}
      />
      <AlertDialog open={reset} onOpenChange={setReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                "Reset the shared workspace?",
                "Tetapkan semula ruang bersama?",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "This removes every test entry and feedback note for all teammates, then restores the original fictional examples. This cannot be undone.",
                "Ini memadam setiap entri ujian dan maklum balas semua ahli pasukan, kemudian memulihkan contoh asal. Tindakan ini tidak boleh dibatalkan.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("Keep records", "Kekalkan rekod")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void command("reset", {});
              }}
            >
              {busy
                ? t("Resetting…", "Menetap semula…")
                : t("Reset all test records", "Tetap semula semua rekod ujian")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet
        open={!!trace}
        onOpenChange={(open) => {
          if (!open) setTrace(null);
        }}
      >
        <SheetContent className="trace-sheet w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <div className="eyebrow">{t("RECORD DETAIL", "BUTIRAN REKOD")}</div>
            <SheetTitle className="mono mt-2">
              {selectedOrder?.awb ?? selectedCarton?.ref ?? selectedBatch?.code}
            </SheetTitle>
            <SheetDescription>
              {t(
                "Recorded history and linked responsibilities.",
                "Sejarah direkodkan dan tanggungjawab berkaitan.",
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 pb-8 space-y-6">
            {selectedOrder && state && (
              <>
                <OrderProducts order={selectedOrder} />
                <Status order={selectedOrder} lang={lang} />
                <div className="detail-grid">
                  <Detail
                    label={t("Expected", "Dijangka")}
                    value={
                      <OrderQuantities
                        order={selectedOrder}
                        lang={lang}
                        field="expected"
                      />
                    }
                  />
                  <Detail
                    label={t("Issued", "Dikeluarkan")}
                    value={
                      <OrderQuantities
                        order={selectedOrder}
                        lang={lang}
                        field="issued"
                        state={state}
                      />
                    }
                  />
                  <Detail
                    label={t("Packed", "Dibungkus")}
                    value={
                      <OrderQuantities
                        order={selectedOrder}
                        lang={lang}
                        field="actual"
                      />
                    }
                  />
                  <Detail
                    label={t("Difference", "Perbezaan")}
                    value={
                      <OrderQuantities
                        order={selectedOrder}
                        lang={lang}
                        field="variance"
                      />
                    }
                  />
                  <Detail
                    label={t("Packer", "Pembungkus")}
                    value={
                      <PersonBadge
                        name={selectedOrder.packer}
                        lang={lang}
                        caption={t("Packed by", "Dibungkus oleh")}
                      />
                    }
                  />
                  <Detail
                    label={t("AWB attached by", "AWB dilekatkan oleh")}
                    value={
                      <PersonBadge
                        name={selectedOrder.labelPic}
                        lang={lang}
                        caption={t("AWB attached by", "AWB dilekatkan oleh")}
                      />
                    }
                  />
                </div>
                {selectedOrder.actual !== null &&
                  orderLines(selectedOrder).some(
                    (l) =>
                      orderIssued(state, selectedOrder, l.product) !== l.actual,
                  ) && (
                    <div className="inline-note">
                      <AlertTriangle size={16} />
                      {t(
                        "Issued units and the declared parcel count differ. Review the allocations.",
                        "Unit dikeluarkan dan kiraan bungkusan berbeza. Semak peruntukan.",
                      )}
                    </div>
                  )}
                <h3 className="section-label">
                  {t("SOURCE CARTONS", "KARTON SUMBER")}
                </h3>
                {state.issues.filter((i) => i.orderId === selectedOrder.id)
                  .length ? (
                  state.issues
                    .filter((i) => i.orderId === selectedOrder.id)
                    .map((i) => (
                      <button
                        key={i.id}
                        className="linked-record"
                        onClick={() => setTrace(i.cartonId)}
                      >
                        <Boxes size={16} />
                        <span>
                          {state.cartons.find((c) => c.id === i.cartonId)?.ref}
                          <small>
                            {i.qty}{" "}
                            {units(
                              lang,
                              state.cartons.find((c) => c.id === i.cartonId)!
                                .unit,
                            )}{" "}
                            · {i.pic}
                          </small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "No carton allocation recorded yet.",
                      "Belum ada peruntukan karton direkodkan.",
                    )}
                  </p>
                )}
                {selectedOrder.note && (
                  <p className="detail-note">{selectedOrder.note}</p>
                )}
              </>
            )}
            {selectedCarton && state && (
              <>
                <ProductName id={selectedCarton.product} />
                <div className="detail-grid">
                  <Detail
                    label={t("Rack", "Rak")}
                    value={selectedCarton.rack}
                  />
                  <Detail
                    label={t("Available", "Tersedia")}
                    value={
                      available(state, selectedCarton) +
                      " " +
                      units(lang, selectedCarton.unit)
                    }
                  />
                  <Detail
                    label={t("Received by", "Diterima oleh")}
                    value={
                      <PersonBadge
                        name={selectedCarton.pic}
                        lang={lang}
                        caption={t("Received by", "Diterima oleh")}
                      />
                    }
                  />
                </div>
              </>
            )}
            {linkedBatch && (
              <>
                <h3 className="section-label">
                  {linkedBatch.code} ·{" "}
                  {t("PROCESS RESPONSIBILITY", "TANGGUNGJAWAB PROSES")}
                </h3>
                <div className="trace-processes">
                  {linkedBatch.steps.map((st, i) => (
                    <div key={i}>
                      <span
                        className={"step-number " + (st.done ? "done" : "")}
                      >
                        {st.done ? <Check size={13} /> : i + 1}
                      </span>
                      <div>
                        <strong>
                          {stepNames(linkedBatch)[i][lang === "ms" ? 1 : 0]}
                        </strong>
                        <p>
                          <PersonBadge
                            name={st.pic}
                            lang={lang}
                            caption={t(
                              "Recorded performer",
                              "Pelaksana direkodkan",
                            )}
                          />
                          {linkedBatch.product !== "ady" && (
                            <>
                              {st.qty ?? "—"}{" "}
                              {units(lang, batchUnit(linkedBatch))}
                            </>
                          )}
                        </p>
                        {linkedBatch.product !== "ady" && (
                          <small>
                            {st.start || "—"} – {st.end || "—"} · QC:{" "}
                            {st.qc === "not-recorded"
                              ? t("not recorded", "tidak direkod")
                              : st.qc}
                          </small>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {state && (
                  <>
                    <h3 className="section-label">
                      {t("LINKED PARCELS", "BUNGKUSAN BERKAITAN")}
                    </h3>
                    {state.orders
                      .filter((o) =>
                        state.issues.some(
                          (i) =>
                            i.orderId === o.id &&
                            state.cartons.some(
                              (c) =>
                                c.id === i.cartonId &&
                                c.batchId === linkedBatch.id,
                            ),
                        ),
                      )
                      .map((o) => (
                        <button
                          key={o.id}
                          className="linked-record"
                          onClick={() => setTrace(o.id)}
                        >
                          <PackageCheck size={16} />
                          <span className="mono">{o.awb}</span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                  </>
                )}
              </>
            )}
            <h3 className="section-label">
              {t("ACTIVITY LOG", "LOG AKTIVITI")}
            </h3>
            {events.length ? (
              <div className="activity-list compact">
                {events.map((e) => (
                  <div key={e.id}>
                    <span className="activity-dot" />
                    <div>
                      <strong>{e.action}</strong>
                      <p>{e.detail}</p>
                      <small>
                        {e.actor} ·{" "}
                        {new Date(e.at).toLocaleString("en-MY", {
                          timeZone: "Asia/Kuala_Lumpur",
                        })}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(
                  "This is an initial sample record. New actions will appear here.",
                  "Ini rekod contoh asal. Tindakan baharu akan muncul di sini.",
                )}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
function SearchBox({
  query,
  setQuery,
  placeholder,
}: {
  query: string;
  setQuery: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-box">
      <Search size={17} />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}
function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
