import {
  commandRules,
  effectiveCapabilities,
  type Capability,
} from "./capabilities.ts";
import {
  applyImportCommand,
  channels,
  normalizeAwb,
  type AwbImport,
} from "./awb-import.ts";
export type Lang = "en" | "ms";
export const tr = (lang: Lang, en: string, ms: string) =>
  lang === "ms" ? ms : en;
export type Role =
  | "production"
  | "intake"
  | "outbound"
  | "admin"
  | "hr"
  | "packer"
  | "driver"
  | "management";
export const roles: { id: Role; en: string; ms: string }[] = [
  { id: "production", en: "Production supervisor", ms: "Penyelia pengeluaran" },
  { id: "intake", en: "Stock-in supervisor", ms: "Penyelia stok masuk" },
  { id: "outbound", en: "Stock-out supervisor", ms: "Penyelia stok keluar" },
  { id: "admin", en: "Office admin", ms: "Admin pejabat" },
  { id: "hr", en: "HR", ms: "Sumber manusia" },
  { id: "packer", en: "Packer", ms: "Pembungkus" },
  { id: "driver", en: "Driver", ms: "Pemandu" },
  { id: "management", en: "Management", ms: "Pengurusan" },
];
export type Unit = "bottle" | "sachet" | "box";
export const products = [
  {
    id: "cav",
    name: "Cavernosil",
    short: "CAV",
    unit: "bottle" as Unit,
    factory: "bottle" as const,
    color: "var(--info)",
  },
  {
    id: "gly",
    name: "Glycoxil",
    short: "GLY",
    unit: "bottle" as Unit,
    factory: "bottle" as const,
    color: "var(--success)",
  },
  {
    id: "lip",
    name: "Lipidri",
    short: "LIP",
    unit: "bottle" as Unit,
    factory: "bottle" as const,
    color: "var(--warning)",
  },
  {
    id: "syn",
    name: "Synovil",
    short: "SYN",
    unit: "bottle" as Unit,
    factory: "bottle" as const,
    color: "var(--ai)",
  },
  {
    id: "ady",
    name: "Adypocide",
    short: "ADY",
    unit: "box" as Unit,
    factory: "sachet" as const,
    color: "var(--chart-5)",
  },
];
export const people = [
  "Sample PIC A",
  "Sample PIC B",
  "Sample PIC C",
  "Sample PIC D",
  "Sample Packer A",
  "Sample Packer B",
];
export const product = (id: string) => products.find((p) => p.id === id)!;
export const isSachet = (productId: string) =>
  product(productId)?.factory === "sachet";
export const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(
    new Date(),
  );
export const bottleSteps = [
  ["Filling Machine", "Mesin pengisian"],
  ["Capsule Counter & Silica Gel", "Pengiraan kapsul & gel silika"],
  ["Bottle Cap & Capping Machine", "Penutup botol & mesin penutup"],
  ["Batching, Sticker & QC", "Nombor kelompok, pelekat & QC"],
];
// Stable stage keys. Labels are display text; records store keys plus label snapshots.
export const sachetProcesses = [
  {
    id: "mixing",
    machine: "Mixer machine",
    en: "Mixer machine (mixing)",
    ms: "Mesin pengadun (mengadun)",
  },
  {
    id: "filling",
    machine: "Sachet filling machine",
    en: "Sachet filling machine (filling)",
    ms: "Mesin pengisian sachet (mengisi)",
  },
  {
    id: "batching",
    machine: "Inkjet printer",
    en: "Inkjet printer (batching)",
    ms: "Pencetak inkjet (nombor kelompok)",
  },
  {
    id: "hologram",
    machine: "Hologram machine",
    en: "Hologram machine",
    ms: "Mesin hologram",
  },
  {
    id: "wrapping",
    machine: "Shrink machine",
    en: "Shrink machine (plastic wrapping)",
    ms: "Mesin shrink (balutan plastik)",
  },
];
export type SachetStage = (typeof sachetProcesses)[number];
export const sachetStage = (key: string) =>
  sachetProcesses.find((stage) => stage.id === key);
// Versioned routes. A batch keeps the route it was planned (or explicitly reviewed) under.
export const sachetRoutes: Record<
  string,
  { id: string; stages: string[]; en: string; ms: string }
> = {
  "sachet-v1": {
    id: "sachet-v1",
    stages: ["mixing", "filling", "batching", "wrapping"],
    en: "Four-stage sachet route (before Hologram)",
    ms: "Laluan sachet empat peringkat (sebelum Hologram)",
  },
  "sachet-v2": {
    id: "sachet-v2",
    stages: ["mixing", "filling", "batching", "hologram", "wrapping"],
    en: "Five-stage sachet route (with Hologram)",
    ms: "Laluan sachet lima peringkat (dengan Hologram)",
  },
};
export const currentSachetRoute = "sachet-v2";
const countWords = ["zero", "one", "two", "three", "four", "five", "six"];
// Labels for historical records created before the fixed sachet route.
export const sachetSteps = [
  ["Filling & sealing", "Pengisian & pengedapan"],
  ["Batch marking & checks", "Penandaan kelompok & semakan"],
  ["Count & bag", "Pengiraan & pembungkusan beg"],
];
// Who entered a record. Derived on the server; never accepted from the client.
export interface Recorder {
  kind: "member" | "preview";
  role: Role;
  name: string;
  userId?: string;
  staffProfileId?: string;
  siteId?: string;
}
/** The fictional preview grants a role's default capabilities inside the sandbox only. */
export const previewCapabilities = (role: Role) => effectiveCapabilities(role);
export interface PicChange {
  kind: "assignment" | "reassignment" | "correction" | "handover";
  from: string;
  to: string;
  at: string;
  effectiveAt?: string;
  reason: string;
  recordedBy?: Recorder;
}
export interface StageCorrection {
  id: string;
  field: "machine" | "occurredAt";
  from: string;
  to: string;
  reason: string;
  at: string;
  recordedBy?: Recorder;
}
export interface StageOccurrence {
  id: string;
  kind: "rework";
  pic: string;
  machineId?: string;
  machineName?: string;
  occurredAt: string;
  recordedAt: string;
  recordedBy?: Recorder;
  reason: string;
}
export interface Step {
  picHistory?: PicChange[];
  sachetStage?: string;
  machine?: string;
  machineId?: string;
  machineName?: string;
  occurredAt?: string;
  recordedAt?: string;
  recordedBy?: Recorder;
  version?: number;
  corrections?: StageCorrection[];
  occurrences?: StageOccurrence[];
  pic: string;
  qty: number | null;
  start: string;
  end: string;
  done: boolean;
  qc: "not-recorded" | "pass" | "issue";
}
export interface RouteSnapshot {
  id: string;
  stages: string[];
  at: string;
  review?: {
    decision: "upgrade" | "keep-legacy";
    from: string;
    reason: string;
    at: string;
    recordedBy?: Recorder;
  };
}
export interface BatchRevision {
  id: string;
  stage: string;
  field: string;
  from: string;
  to: string;
  reason: string;
  at: string;
  recordedBy?: Recorder;
}
export interface Machine {
  id: string;
  siteId?: string;
  stage: string;
  name: string;
  code?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: {
    kind: "created" | "edited" | "deactivated" | "reactivated";
    at: string;
    changes: Record<string, [string, string]>;
    reason?: string;
    recordedBy?: Recorder;
  }[];
}
export interface OperationRecord {
  id: string;
  type: string;
  fingerprint: string;
  userId?: string;
  at: string;
}
export interface Batch {
  siteId?: string;
  version?: number;
  route?: RouteSnapshot;
  revisions?: BatchRevision[];
  transferredAt?: string;
  transferPic?: string;
  id: string;
  code: string;
  product: string;
  date: string;
  target: number;
  actual: number;
  sent: number;
  steps: Step[];
}
export interface Carton {
  id: string;
  ref: string;
  legacyRef?: string;
  batchId: string;
  product: string;
  unit: Unit;
  qty: number;
  rack: string;
  pic: string;
  at: string;
}
export interface AdypocideReceipt {
  id: string;
  ref: string;
  legacyRef?: string;
  batchId: string;
  pic: string;
  at: string;
  stockedAt?: string;
  stockCartonId?: string;
  legacySourceId?: string;
}
export interface Order {
  reviewState?: "pending" | "confirmed";
  reviewedBy?: string;
  assignedPacker?: string;
  assignedAt?: string;
  packedAt?: string;
  packRecordedAt?: string;
  packRecordedBy?: Recorder;
  lines?: OrderLine[];
  store?: string;
  orderRef?: string;
  courier?: string;
  importId?: string;
  importRowId?: string;
  id: string;
  awb: string;
  channel: string;
  product: string;
  package: string;
  expected: number;
  originalExpected: number;
  actual: number | null;
  packer: string;
  labelPic: string;
  printed: boolean;
  dispatched: boolean;
  handoverRef: string;
  date: string;
  note: string;
}
export interface OrderLine {
  product: string;
  expected: number;
  originalExpected: number;
  actual: number | null;
}
export interface Issue {
  id: string;
  cartonId: string;
  orderId: string;
  qty: number;
  pic: string;
  at: string;
}
export interface Boxing {
  id: string;
  sourceId: string;
  cartonId: string;
  ratio: number;
  boxes: number;
  loss: number;
  pic: string;
  at: string;
}
export interface Count {
  id: string;
  cartonId: string;
  book: number;
  actual: number;
  pic: string;
  at: string;
  adjusted: boolean;
}
export interface Adjustment {
  id: string;
  cartonId: string;
  delta: number;
  reason: string;
  at: string;
}
export interface Event {
  id: string;
  entity: string;
  action: string;
  detail: string;
  actor: string;
  at: string;
  recorder?: Recorder;
  performer?: string;
  occurredAt?: string;
}
export interface Note {
  id: string;
  kind: "review" | "feedback";
  text: string;
  role: Role;
  at: string;
  /** Authenticated author, site and optional record the note refers to. */
  author?: Recorder;
  siteId?: string;
  entity?: string;
}
export interface SortCount {
  id: string;
  date: string;
  product: string;
  expected: number;
  counted: number;
  fingerprint: string;
  pic: string;
  note: string;
  at: string;
}
// A driver's own trip log. The driver is the signed-in recorder; the assistant (if any) is
// recorded by name and does not sign in. Recorded values are fixed: a later entry by the
// same driver may only add the arrival time or the photo when they are still missing.
export interface Trip {
  id: string;
  siteId?: string;
  /** Malaysia date of the pickup. */
  date: string;
  driver: string;
  /** Assistant driver's name; empty when driving alone. */
  assistant: string;
  pickupAt: string;
  arriveAt?: string;
  /** Storage path of the trip photo. */
  photo?: string;
  note?: string;
  recordedAt: string;
  recordedBy: Recorder;
  arrivalRecordedAt?: string;
  photoRecordedAt?: string;
}
export const tripPhotoPath = /^([0-9a-f-]{36}\/){1,2}[a-f0-9]{64}\.jpg$/;
// A performer profile. It never grants sign-in or write permission.
export interface StaffProfile {
  id: string;
  name: string;
  role: Role;
}
export interface Draft {
  staffProfiles?: StaffProfile[];
  trips?: Trip[];
  sortCounts?: SortCount[];
  adypocideReceipts?: AdypocideReceipt[];
  awbImports?: AwbImport[];
  machines?: Machine[];
  operations?: OperationRecord[];
  version: 1;
  batches: Batch[];
  cartons: Carton[];
  orders: Order[];
  issues: Issue[];
  boxing: Boxing[];
  counts: Count[];
  adjustments: Adjustment[];
  events: Event[];
  notes: Note[];
  closedDays: string[];
}
// Preserve record IDs and original references while displaying one batch number throughout stock flows.
export function withBatchReferences(current: Draft): Draft {
  const state = structuredClone(current);
  for (const record of [...state.cartons, ...(state.adypocideReceipts ?? [])]) {
    const batch = state.batches.find((b) => b.id === record.batchId);
    if (batch && record.ref !== batch.code) {
      record.legacyRef ??= record.ref;
      record.ref = batch.code;
    }
  }
  return state;
}
export const stepNames = (b: Batch) =>
  isSachet(b.product)
    ? b.steps.map((step, i) => {
        const stage = sachetStage(step.sachetStage ?? "");
        return stage
          ? [stage.en, stage.ms]
          : step.machine
            ? [step.machine, step.machine]
            : (sachetSteps[i] ?? ["Machine record", "Rekod mesin"]);
      })
    : bottleSteps;
export const batchFactory = (b: Batch) =>
  isSachet(b.product) ? "sachet" : "bottle";
export const batchUnit = (b: Batch): Unit => product(b.product).unit;
export const stageStep = (b: Batch, key: string) =>
  b.steps.find((step) => step.sachetStage === key);
export const stageDone = (b: Batch, key: string) => {
  const step = stageStep(b, key);
  return !!step?.done && !!step.pic;
};
/**
 * The route a sachet batch must satisfy. Planned batches carry a snapshot.
 * Transferred batches without one keep their actual historical route; an
 * unsnapshotted batch still in production needs an explicit, reviewed decision.
 */
export function batchRoute(b: Batch): {
  id: string;
  stages: string[];
  status: "snapshot" | "historical" | "needs-review";
} {
  if (b.route) return { id: b.route.id, stages: b.route.stages, status: "snapshot" };
  const fixed = b.steps.some((step) => step.sachetStage);
  if (batchTransferred(b))
    return fixed
      ? { ...sachetRoutes["sachet-v1"], status: "historical" }
      : { id: "legacy-freeform", stages: [], status: "historical" };
  return { ...sachetRoutes["sachet-v1"], status: "needs-review" };
}
export const routeStages = (b: Batch) =>
  batchRoute(b).stages.map((key) => sachetStage(key)!);
/**
 * Bottle (capsule) batches record one QC count at the end: the last step's quantity is the
 * finished bottles. Earlier steps record their PIC only (older records may carry a quantity).
 */
export const isQcStep = (b: Pick<Batch, "product" | "steps">, index: number) =>
  !isSachet(b.product) && index === b.steps.length - 1;
export const batchComplete = (b: Batch) => {
  if (!isSachet(b.product)) return b.steps.every((step) => step.done);
  const { stages } = batchRoute(b);
  return !!stages.length && stages.every((key) => stageDone(b, key));
};
export const batchRevised = (b: Batch) => !!b.revisions?.length;
export const batchTransferred = (b: Batch) => !!b.transferredAt || b.sent > 0;
export const stockCartons = (s: Draft) =>
  s.cartons.filter((c) => c.unit === product(c.product).unit);
// Old sachet counts stay in history; their remaining contents require a fresh box count.
export const adypocideReceipts = (s: Draft): AdypocideReceipt[] => [
  ...(s.adypocideReceipts ?? []),
  ...s.cartons
    .filter(
      (c) =>
        isSachet(c.product) &&
        c.unit === "sachet" &&
        available(s, c) > 0 &&
        !s.adypocideReceipts?.some((r) => r.legacySourceId === c.id),
    )
    .map((c) => ({
      id: c.id,
      ref: c.ref,
      batchId: c.batchId,
      pic: c.pic,
      at: c.at,
      legacySourceId: c.id,
    })),
];
export const available = (s: Draft, c: Carton) =>
  c.qty -
  s.issues.filter((i) => i.cartonId === c.id).reduce((n, i) => n + i.qty, 0) -
  s.boxing
    .filter((i) => i.sourceId === c.id)
    .reduce((n, i) => n + i.boxes * i.ratio + i.loss, 0) +
  s.adjustments
    .filter((i) => i.cartonId === c.id)
    .reduce((n, i) => n + i.delta, 0);
export const orderLines = (o: Order): OrderLine[] => o.lines ?? [o];
export const orderIssued = (s: Draft, o: Order, productId?: string) =>
  s.issues
    .filter(
      (i) =>
        i.orderId === o.id &&
        (!productId ||
          s.cartons.find((c) => c.id === i.cartonId)?.product === productId),
    )
    .reduce((n, i) => n + i.qty, 0);
// A mismatch on one product must not be cancelled by an excess on another.
export const variance = (o: Order) => {
  const lines = orderLines(o);
  if (lines.some((l) => l.actual === null)) return null;
  return lines.map((l) => l.actual! - l.expected).find((n) => n !== 0) ?? 0;
};
export const singleProductOrder = (o: Order) =>
  new Set(orderLines(o).map((l) => l.product)).size === 1;
export const orderReady = (o: Order) => o.reviewState !== "pending";
export const dailyOrders = (s: Draft, date: string) =>
  s.orders.filter((o) => o.date === date && orderReady(o));
export function packageGroups(orders: Order[]) {
  const groups = new Map<
    string,
    {
      key: string;
      product: string;
      package: string;
      perParcel: number;
      orders: Order[];
    }
  >();
  for (const o of orders.filter(
    (o) => orderReady(o) && singleProductOrder(o),
  )) {
    const product = orderLines(o)[0].product;
    const perParcel = orderLines(o).reduce((n, l) => n + l.expected, 0);
    const key = JSON.stringify([product, o.package, perParcel]);
    const group = groups.get(key) ?? {
      key,
      product,
      package: o.package,
      perParcel,
      orders: [],
    };
    group.orders.push(o);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.product.localeCompare(b.product) ||
      a.package.localeCompare(b.package) ||
      a.perParcel - b.perParcel,
  );
}
export const demandFingerprint = (s: Draft, date: string, productId: string) =>
  JSON.stringify(
    dailyOrders(s, date)
      .filter((o) => orderLines(o).some((l) => l.product === productId))
      .map((o) => [
        o.id,
        orderLines(o)
          .filter((l) => l.product === productId)
          .reduce((n, l) => n + l.expected, 0),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
export const dailyTally = (s: Draft, date: string) =>
  products.map((p) => {
    const orders = dailyOrders(s, date).filter((o) =>
      orderLines(o).some((l) => l.product === p.id),
    );
    const lines = orders.flatMap((o) =>
      orderLines(o).filter((l) => l.product === p.id),
    );
    const count = s.sortCounts?.find(
      (c) => c.date === date && c.product === p.id,
    );
    return {
      product: p.id,
      awbs: orders.length,
      expected: lines.reduce((n, l) => n + l.expected, 0),
      issued: orders.reduce((n, o) => n + orderIssued(s, o, p.id), 0),
      packed: lines.reduce((n, l) => n + (l.actual ?? 0), 0),
      missing: lines.filter((l) => l.actual === null).length,
      mismatched: lines.filter(
        (l) => l.actual !== null && l.actual !== l.expected,
      ).length,
      count,
      stale: !!count && count.fingerprint !== demandFingerprint(s, date, p.id),
    };
  });
export const batchReceived = (s: Draft, b: Batch) =>
  s.cartons
    .filter((c) => c.batchId === b.id && c.unit === batchUnit(b))
    .reduce((n, c) => n + c.qty, 0);
export const id = () => crypto.randomUUID();
const blankStep = (): Step => ({
  pic: "",
  qty: null,
  start: "",
  end: "",
  done: false,
  qc: "not-recorded",
});
export function createDraft(): Draft {
  const date = today(),
    at = date + "T09:00:00+08:00";
  const batches: Batch[] = products.map((p, i) => ({
    id: "b-" + p.id,
    code: "TEST-" + p.short + "-001",
    product: p.id,
    date,
    target: isSachet(p.id) ? 0 : 240,
    actual: isSachet(p.id) ? 0 : 240,
    sent: isSachet(p.id) ? 0 : 120,
    ...(isSachet(p.id)
      ? {
          transferredAt: at,
          transferPic: people[0],
          route: {
            id: currentSachetRoute,
            stages: [...sachetRoutes[currentSachetRoute].stages],
            at,
          },
        }
      : {}),
    steps: (isSachet(p.id)
      ? sachetRoutes[currentSachetRoute].stages
      : bottleSteps
    ).map((key, j) => ({
      ...(isSachet(p.id)
        ? {
            machine: sachetStage(key as string)!.machine,
            sachetStage: key as string,
          }
        : {}),
      pic: people[(i + j) % 4],
      qty: isSachet(p.id) ? null : 240,
      start: "08:00",
      end: "09:00",
      done: true,
      qc: "not-recorded",
    })),
  }));
  batches.push({
    id: "b-cav-next",
    code: "TEST-CAV-002",
    product: "cav",
    date,
    target: 300,
    actual: 0,
    sent: 0,
    steps: [
      {
        ...blankStep(),
        pic: people[0],
        qty: 300,
        start: "09:00",
        end: "10:00",
        done: true,
      },
      { ...blankStep(), pic: people[1] },
      blankStep(),
      blankStep(),
    ],
  });
  const cartons: Carton[] = products
    .filter((p) => !isSachet(p.id))
    .map((p, i) => ({
      id: "c-" + p.id,
      ref: batches.find((b) => b.product === p.id)!.code,
      batchId: "b-" + p.id,
      product: p.id,
      unit: "bottle",
      qty: 120,
      rack: "A-0" + (i + 1),
      pic: people[2],
      at,
    }));
  const orders: Order[] = [
    {
      id: "o-1",
      awb: "TEST-AWB-1001",
      channel: "Shopee",
      product: "cav",
      package: "Sample 2-bottle package",
      expected: 2,
      originalExpected: 2,
      actual: 2,
      packer: people[4],
      labelPic: people[5],
      printed: true,
      dispatched: true,
      handoverRef: "TEST-NV-001",
      date,
      note: "",
    },
    {
      id: "o-2",
      awb: "TEST-AWB-1002",
      channel: "TikTok",
      product: "cav",
      package: "Sample 2-bottle package",
      expected: 2,
      originalExpected: 2,
      actual: 4,
      packer: people[5],
      labelPic: people[4],
      printed: true,
      dispatched: false,
      handoverRef: "",
      date,
      note: "Sample mismatch for the team to investigate.",
    },
    {
      id: "o-3",
      awb: "TEST-AWB-1003",
      channel: "Luxana",
      product: "gly",
      package: "Sample 2-bottle package",
      expected: 2,
      originalExpected: 2,
      actual: null,
      packer: "",
      labelPic: "",
      printed: true,
      dispatched: false,
      handoverRef: "",
      date,
      note: "",
    },
    {
      id: "o-4",
      awb: "TEST-AWB-1004",
      channel: "Shopee",
      product: "lip",
      package: "Sample 1-bottle package",
      expected: 1,
      originalExpected: 1,
      actual: null,
      packer: "",
      labelPic: "",
      printed: false,
      dispatched: false,
      handoverRef: "",
      date,
      note: "",
    },
    {
      id: "o-5",
      awb: "TEST-AWB-1005",
      channel: "TikTok",
      product: "syn",
      package: "Sample 2-bottle package",
      expected: 2,
      originalExpected: 2,
      actual: 2,
      packer: people[4],
      labelPic: people[5],
      printed: true,
      dispatched: false,
      handoverRef: "",
      date,
      note: "",
    },
    {
      id: "o-6",
      awb: "TEST-AWB-1006",
      channel: "Luxana",
      product: "ady",
      package: "Sample 2-box package",
      expected: 2,
      originalExpected: 2,
      actual: null,
      packer: "",
      labelPic: "",
      printed: false,
      dispatched: false,
      handoverRef: "",
      date,
      note: "Stock-in supervisor confirms finished boxes after warehouse boxing.",
    },
  ];
  return {
    version: 1,
    adypocideReceipts: [
      {
        id: "r-ady",
        ref: batches.find((b) => b.product === "ady")!.code,
        batchId: "b-ady",
        pic: people[2],
        at,
      },
    ],
    batches,
    cartons,
    orders,
    issues: [
      {
        id: "i-1",
        cartonId: "c-cav",
        orderId: "o-1",
        qty: 2,
        pic: people[0],
        at,
      },
      {
        id: "i-2",
        cartonId: "c-cav",
        orderId: "o-2",
        qty: 4,
        pic: people[0],
        at,
      },
      {
        id: "i-3",
        cartonId: "c-gly",
        orderId: "o-3",
        qty: 2,
        pic: people[1],
        at,
      },
      {
        id: "i-5",
        cartonId: "c-syn",
        orderId: "o-5",
        qty: 2,
        pic: people[1],
        at,
      },
    ],
    boxing: [],
    counts: [],
    adjustments: [],
    events: [
      {
        id: "seed",
        entity: "workspace",
        action: "Sample workspace prepared",
        detail:
          "All quantities, people, packages and references in this draft are fictional test data.",
        actor: "Demo setup",
        at,
      },
    ],
    notes: [],
    closedDays: [],
  };
}
export type Command = {
  type: string;
  role: Role;
  input: Record<string, unknown>;
  /** Server-derived recorder. Absent only in the fictional preview/tests. */
  actor?: Recorder;
  /** Server-derived effective capabilities at this site. Preview: role defaults. */
  capabilities?: readonly Capability[] | readonly string[];
};
/** A stale edit. Carries the current record so the supervisor can review it. */
export class ConflictError extends Error {
  conflict: Record<string, unknown>;
  constructor(message: string, conflict: Record<string, unknown>) {
    super(message);
    this.conflict = conflict;
  }
}
export const roleLabel = (role: Role) =>
  roles.find((r) => r.id === role)?.en ?? role;
export const recorderLabel = (r?: Recorder) =>
  !r
    ? ""
    : r.kind === "member"
      ? `${r.name} · ${roleLabel(r.role)}`
      : roleLabel(r.role) + " (test view)";
const MYT_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Malaysia local "YYYY-MM-DDTHH:mm" to ISO. */
export const fromMyt = (local: string) => {
  if (!MYT_LOCAL.test(local)) return null;
  const time = new Date(local + ":00+08:00");
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
};
export const toMyt = (iso: string) =>
  new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 16);
export function applyCommand(current: Draft, cmd: Command): Draft {
  if (!roles.some((r) => r.id === cmd.role))
    throw new Error("Choose a valid test role.");
  if (cmd.actor && cmd.actor.role !== cmd.role)
    throw new Error("Your signed-in role does not permit this action.");
  const recorder: Recorder = cmd.actor ?? {
    kind: "preview",
    role: cmd.role,
    name: roleLabel(cmd.role) + " (test view)",
  };
  const capabilities: readonly string[] =
    cmd.capabilities ?? previewCapabilities(cmd.role);
  const rule = commandRules[cmd.type];
  if (rule && !capabilities.includes(rule.capability))
    throw new Error(
      cmd.actor?.kind === "member"
        ? "Your role at this site does not permit this action."
        : `Switch to the responsible ${roles
            .filter((r) => previewCapabilities(r.id).includes(rule.capability))
            .map((r) => r.en)
            .join(" or ")} role for this action.`,
    );
  if (!rule && cmd.actor?.kind === "member")
    throw new Error("This action is not available in operational workspaces.");
  const site = recorder.siteId;
  const s = withBatchReferences(current),
    v = cmd.input,
    at = new Date().toISOString();
  const eventsBefore = s.events.length;
  const str = (k: string, required = true) => {
    const val = typeof v[k] === "string" ? (v[k] as string).trim() : "";
    if (required && !val) throw new Error("Please complete " + k + ".");
    if (val.length > 2000) throw new Error("Text is too long.");
    return val;
  };
  const num = (k: string, min = 0) => {
    const raw = v[k];
    if (raw === "" || raw === null || raw === undefined)
      throw new Error("Please enter " + k + ".");
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > 1000000)
      throw new Error("Enter a valid whole number for " + k + ".");
    return n;
  };
  const allow = (...rs: Role[]) => {
    if (!rs.includes(cmd.role))
      throw new Error(
        "Switch to the responsible supervisor role for this action.",
      );
  };
  const find = <T extends { id: string }>(list: T[], key = "id"): T => {
    const item = list.find((x) => x.id === str(key));
    if (!item)
      throw new Error("This record could not be found. Refresh and try again.");
    return item;
  };
  const noteScope = () => {
    const entity = str("entity", false);
    if (entity.length > 200) throw new Error("Use a shorter record reference.");
    return {
      author: recorder,
      ...(site ? { siteId: site } : {}),
      ...(entity ? { entity } : {}),
    };
  };
  const inSite = <T extends { siteId?: string }>(record: T) => {
    if (site && record.siteId && record.siteId !== site)
      throw new Error("This record belongs to another site.");
    return record;
  };
  const log = (
    entity: string,
    action: string,
    detail: string,
    extra: { performer?: string; occurredAt?: string } = {},
  ) =>
    s.events.unshift({
      id: id(),
      entity,
      action,
      detail,
      actor: recorderLabel(recorder),
      at,
      recorder,
      ...extra,
    });
  /** Optional actual-occurrence time; defaults to entry time. */
  const occurrence = (key: string, notBefore?: string, notAfter?: string) => {
    const local = str(key, false);
    if (!local) return at;
    const iso = fromMyt(local);
    if (!iso)
      throw new Error("Enter the actual date and time in Malaysia time.");
    if (Date.parse(iso) > Date.now() + 5 * 60000)
      throw new Error("The actual time cannot be in the future.");
    if (notBefore && local.slice(0, 10) < notBefore)
      throw new Error("The actual time cannot be before the batch work date.");
    if (notAfter && iso > notAfter)
      throw new Error(
        "The actual time cannot be after the batch was sent to the warehouse.",
      );
    return iso;
  };
  const expectVersion = (
    current: { version?: number } | undefined,
    label: string,
    required = false,
    detail: () => Record<string, unknown> = () => ({}),
  ) => {
    const raw = v.expectedVersion;
    if (raw === undefined || raw === null || raw === "") {
      if (required)
        throw new Error("Reopen this record before saving the change.");
      return;
    }
    const expected = Number(raw),
      actual = current?.version ?? 0;
    if (expected !== actual)
      throw new ConflictError(
        `${label} was changed by another entry after you opened it. Review the latest record, then save again if your change is still needed.`,
        { record: label, expectedVersion: expected, currentVersion: actual, ...detail() },
      );
  };
  /** Required/optional actual trip time in Malaysia time; never in the future. */
  const tripTime = (key: string, required = true) => {
    const local = str(key, required);
    if (!local) return undefined;
    const iso = fromMyt(local);
    if (!iso) throw new Error("Enter the trip times as a date and time in Malaysia time.");
    if (Date.parse(iso) > Date.now() + 5 * 60000)
      throw new Error("A trip time cannot be in the future.");
    return iso;
  };
  /** Optional uploaded trip photo; the API server checks the site folder and the file. */
  const tripPhoto = () => {
    const path = str("photo", false);
    if (path && !tripPhotoPath.test(path))
      throw new Error("The trip photo was not uploaded. Add it again.");
    return path || undefined;
  };
  const bump = (record: { version?: number }) =>
    (record.version = (record.version ?? 0) + 1);
  const resolveStage = (b: Batch) => {
    const key = str("stage");
    const stage = sachetStage(key);
    if (!stage)
      throw new Error(
        `Unknown production stage "${key}". Choose a fixed sachet stage from this batch's route.`,
      );
    const route = batchRoute(b);
    if (!route.stages.includes(stage.id))
      throw new Error(
        `${stage.en} is not part of this batch's route (${route.id}).` +
          (route.status === "needs-review"
            ? " Review the legacy route before recording it."
            : ""),
      );
    return stage;
  };
  const pickMachine = (stageKey: string, forCorrection = false) => {
    const machineId = str("machineId", false);
    if (!machineId) return undefined;
    const machine = s.machines?.find((m) => m.id === machineId);
    if (!machine)
      throw new Error("This machine could not be found for this site.");
    if (site && machine.siteId && machine.siteId !== site)
      throw new Error("This machine belongs to another site.");
    if (machine.stage !== stageKey)
      throw new Error(
        `${machine.name} is registered for ${sachetStage(machine.stage)?.en ?? machine.stage}, not this stage.`,
      );
    if (!machine.active && !forCorrection)
      throw new Error(
        `${machine.name} is inactive. Choose an active machine or reactivate it first.`,
      );
    return machine;
  };
  // Post-transfer corrections are flagged so downstream views/reports show a revision.
  const markRevision = (
    b: Batch,
    stage: string,
    field: string,
    from: string,
    to: string,
    reason: string,
  ) => {
    if (!batchTransferred(b)) return;
    (b.revisions ??= []).push({
      id: id(),
      stage,
      field,
      from,
      to,
      reason,
      at,
      recordedBy: recorder,
    });
  };
  switch (cmd.type) {
    case "import-save":
    case "import-release":
    case "import-receive": {
      const detail = applyImportCommand(s, cmd.type, v, cmd.role, at);
      log(String(v.id ?? (v.batch as AwbImport)?.id), cmd.type, detail);
      break;
    }
    case "batch": {
      allow("production");
      const p = str("product");
      if (!product(p)) throw new Error("Choose a product.");
      const code = str("code");
      if (s.batches.some((b) => b.code.toLowerCase() === code.toLowerCase()))
        throw new Error("That batch number already exists.");
      const routeKey = str("route", false);
      if (isSachet(p) && routeKey && routeKey !== currentSachetRoute)
        throw new Error(
          `Unknown or retired production route "${routeKey}". Reload and plan the batch on the current route.`,
        );
      const route = sachetRoutes[currentSachetRoute];
      const b: Batch = {
        id: id(),
        code,
        product: p,
        date: str("date"),
        ...(site ? { siteId: site } : {}),
        ...(isSachet(p)
          ? { route: { id: route.id, stages: [...route.stages], at } }
          : {}),
        target: isSachet(p) ? 0 : num("target", 1),
        actual: 0,
        sent: 0,
        steps: isSachet(p)
          ? route.stages.map((key) => ({
              ...blankStep(),
              machine: sachetStage(key)!.machine,
              sachetStage: key,
            }))
          : bottleSteps.map(blankStep),
      };
      b.steps.forEach((step, index) => {
        const pic = str("pic_" + index, false);
        if (pic) {
          step.pic = pic;
          step.picHistory = [
            {
              kind: "assignment",
              from: "",
              to: pic,
              at,
              reason: "Assigned during batch planning",
              recordedBy: recorder,
            },
          ];
        }
      });
      s.batches.unshift(b);
      log(
        b.id,
        "Batch planned",
        b.code +
          (isSachet(p)
            ? ` · ${route.en} · machine and PIC records`
            : " · " + b.target + " " + batchUnit(b)),
      );
      break;
    }
    case "route-review": {
      allow("production");
      const b = inSite(find(s.batches));
      if (!isSachet(b.product))
        throw new Error("Route review applies to sachet batches.");
      const current = batchRoute(b);
      if (current.status !== "needs-review")
        throw new Error(
          current.status === "historical"
            ? "Transferred batches keep their actual historical route."
            : "This batch already has a reviewed route.",
        );
      expectVersion(b, b.code);
      const decision = str("decision"),
        reason = str("reason");
      if (decision !== "upgrade" && decision !== "keep-legacy")
        throw new Error(
          "Choose whether to upgrade to the five-stage route or keep the recorded four-stage route.",
        );
      const next =
        decision === "upgrade"
          ? sachetRoutes[currentSachetRoute]
          : sachetRoutes["sachet-v1"];
      b.route = {
        id: next.id,
        stages: [...next.stages],
        at,
        review: { decision, from: current.id, reason, at, recordedBy: recorder },
      };
      // Append missing stages as open records. Existing positions and history are untouched;
      // a Hologram record is never created as completed.
      for (const key of next.stages)
        if (!stageStep(b, key))
          b.steps.push({
            ...blankStep(),
            machine: sachetStage(key)!.machine,
            sachetStage: key,
          });
      bump(b);
      log(
        b.id,
        decision === "upgrade"
          ? "Legacy batch upgraded to five-stage route"
          : "Legacy four-stage route kept",
        `${b.code} · ${current.id} → ${next.id} · ${reason}`,
      );
      break;
    }
    case "change-step-pic": {
      allow("production", "intake");
      const b = inSite(find(s.batches));
      const stageKey = str("stage", false);
      const index = stageKey
        ? b.steps.findIndex((step) => step.sachetStage === stageKey)
        : num("step");
      const step = b.steps[index];
      if (!step) throw new Error("Choose a valid production process.");
      if (cmd.role === "intake" && !isSachet(b.product))
        throw new Error(
          "Stock-in can edit sachet machine/PIC records only. Ask production to change bottle records.",
        );
      expectVersion(step, `${b.code} · ${stepNames(b)[index][0]}`, false, () => ({
        pic: step.pic,
        last: step.picHistory?.at(-1),
      }));
      const kind = str("kind"),
        pic = str("pic"),
        reason = str("reason");
      if (!["correction", "handover", "reassignment"].includes(kind))
        throw new Error(
          "Choose a PIC correction, reassignment or shift handover.",
        );
      if (pic === step.pic) throw new Error("Choose a different PIC.");
      if (kind === "reassignment" && step.done)
        throw new Error(
          "Completed work cannot be reassigned. Use a correction or shift handover.",
        );
      let effectiveAt: string | undefined;
      if (kind === "handover") {
        if (!step.pic)
          throw new Error("Assign the first PIC before recording a handover.");
        if (batchTransferred(b))
          throw new Error(
            "This batch is already transferred; use a correction for mistaken records.",
          );
        const local = str("effectiveAt");
        const iso = fromMyt(local);
        if (!iso || Date.parse(iso) > Date.now() || local.slice(0, 10) < b.date)
          throw new Error(
            "Takeover time must be on or after the batch date and not in the future.",
          );
        effectiveAt = iso;
        const lastHandover = step.picHistory
          ?.filter((h) => h.kind === "handover")
          .at(-1);
        if (
          lastHandover?.effectiveAt &&
          effectiveAt <= lastHandover.effectiveAt
        )
          throw new Error("Takeover must be later than the previous handover.");
      }
      const previous = step.pic;
      (step.picHistory ??= []).push({
        kind: kind as PicChange["kind"],
        from: previous,
        to: pic,
        at,
        effectiveAt,
        reason,
        recordedBy: recorder,
      });
      step.pic = pic;
      bump(step);
      if (kind === "correction")
        markRevision(
          b,
          step.sachetStage ?? String(index),
          "pic",
          previous,
          pic,
          reason,
        );
      log(
        b.id,
        kind === "handover"
          ? "Production shift handover"
          : kind === "reassignment"
            ? "Production PIC reassigned"
            : "Production PIC corrected",
        `${stepNames(b)[index][0]} · ${previous || "Unassigned"} → ${pic} · ${effectiveAt ?? at} · ${reason}` +
          (batchTransferred(b) ? " · revised after transfer" : ""),
        { performer: pic, occurredAt: effectiveAt },
      );
      break;
    }
    case "machine": {
      allow("production", "intake");
      const b = inSite(find(s.batches));
      if (!isSachet(b.product))
        throw new Error("Machine-only records are for sachet products.");
      if (batchTransferred(b))
        throw new Error("This batch has already been sent to the warehouse.");
      const stage = resolveStage(b);
      const previous = stageStep(b, stage.id);
      if (previous?.done)
        throw new Error(
          "This process already has a recorded PIC. Use a correction or record rework.",
        );
      expectVersion(previous, `${b.code} · ${stage.en}`, false, () => ({
        pic: previous?.pic,
      }));
      const pic = str("pic");
      if (previous?.pic && previous.pic !== pic)
        throw new Error(
          "Use Edit PIC or Shift handover to change the assigned person first.",
        );
      const machine = pickMachine(stage.id);
      const occurredAt = occurrence("occurredAt", b.date);
      const record: Step = {
        ...(previous ?? blankStep()),
        machine: stage.machine,
        sachetStage: stage.id,
        pic,
        done: true,
        occurredAt,
        recordedAt: at,
        recordedBy: recorder,
        ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
      };
      bump(record);
      if (previous) b.steps[b.steps.indexOf(previous)] = record;
      else b.steps.push(record);
      log(
        b.id,
        "Machine responsibility recorded",
        b.code +
          " · " +
          stage.en +
          (machine ? " · " + machine.name : "") +
          " · " +
          pic,
        { performer: pic, occurredAt },
      );
      break;
    }
    case "stage-rework": {
      allow("production", "intake");
      const b = inSite(find(s.batches));
      if (!isSachet(b.product) || batchTransferred(b))
        throw new Error(
          "Rework can be recorded for sachet batches still in production.",
        );
      const stage = resolveStage(b);
      const step = stageStep(b, stage.id);
      if (!step?.done)
        throw new Error("Record the first completion of this stage first.");
      expectVersion(step, `${b.code} · ${stage.en}`);
      const pic = str("pic"),
        reason = str("reason"),
        machine = pickMachine(stage.id),
        occurredAt = occurrence("occurredAt", b.date);
      (step.occurrences ??= []).push({
        id: id(),
        kind: "rework",
        pic,
        ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
        occurredAt,
        recordedAt: at,
        recordedBy: recorder,
        reason,
      });
      bump(step);
      log(
        b.id,
        "Stage rework recorded",
        `${b.code} · ${stage.en}${machine ? " · " + machine.name : ""} · ${pic} · ${reason}`,
        { performer: pic, occurredAt },
      );
      break;
    }
    case "stage-correct": {
      allow("production", "intake");
      const b = inSite(find(s.batches));
      if (!isSachet(b.product))
        throw new Error("Machine corrections apply to sachet batches.");
      const stage = resolveStage(b);
      const step = stageStep(b, stage.id);
      if (!step?.done)
        throw new Error("Only a recorded stage completion can be corrected.");
      expectVersion(step, `${b.code} · ${stage.en}`, true, () => ({
        machine: step.machineName ?? "",
        occurredAt: step.occurredAt ?? "",
        lastCorrection: step.corrections?.at(-1),
      }));
      const field = str("field"),
        reason = str("reason");
      let from: string, to: string;
      if (field === "machine") {
        const machine = pickMachine(stage.id, true);
        if (!machine) throw new Error("Choose the machine actually used.");
        if (machine.id === step.machineId)
          throw new Error("Choose a different machine.");
        from = step.machineName ?? "";
        to = machine.name;
        step.machineId = machine.id;
        step.machineName = machine.name;
      } else if (field === "occurredAt") {
        if (!str("occurredAt", false))
          throw new Error("Enter the actual completion time.");
        from = step.occurredAt ?? "";
        to = occurrence("occurredAt", b.date, b.transferredAt);
        if (to === from) throw new Error("Enter a different time.");
        step.occurredAt = to;
      } else throw new Error("Choose the machine or the completion time to correct.");
      (step.corrections ??= []).push({
        id: id(),
        field,
        from,
        to,
        reason,
        at,
        recordedBy: recorder,
      });
      bump(step);
      markRevision(b, stage.id, field, from, to, reason);
      log(
        b.id,
        "Stage record corrected",
        `${b.code} · ${stage.en} · ${field}: ${from || "—"} → ${to} · ${reason}` +
          (batchTransferred(b) ? " · revised after transfer" : ""),
      );
      break;
    }
    case "machine-create": {
      allow("production", "intake");
      const stage = sachetStage(str("stage"));
      if (!stage) throw new Error("Choose the stage this machine performs.");
      const name = str("name"),
        code = str("code", false);
      if (name.length > 80 || code.length > 40)
        throw new Error("Use a shorter machine name or code.");
      const clash = s.machines?.find(
        (m) =>
          (!site || !m.siteId || m.siteId === site) &&
          m.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash)
        throw new Error(
          `A machine named "${clash.name}" already exists for this site${clash.active ? "" : " (inactive)"}. Use or reactivate the existing record.`,
        );
      const machine: Machine = {
        id: id(),
        ...(site ? { siteId: site } : {}),
        stage: stage.id,
        name,
        ...(code ? { code } : {}),
        active: true,
        createdAt: at,
        updatedAt: at,
        version: 1,
        history: [
          { kind: "created", at, changes: { name: ["", name] }, recordedBy: recorder },
        ],
      };
      (s.machines ??= []).unshift(machine);
      log(machine.id, "Machine added", `${stage.machine} · ${name}`);
      break;
    }
    case "machine-update":
    case "machine-deactivate":
    case "machine-reactivate": {
      allow("production", "intake");
      const machine = inSite(find(s.machines ?? []));
      expectVersion(machine, machine.name, true, () => ({
        name: machine.name,
        code: machine.code ?? "",
        active: machine.active,
      }));
      const changes: Record<string, [string, string]> = {};
      let reason: string | undefined;
      if (cmd.type === "machine-update") {
        const name = str("name"),
          code = str("code", false);
        if (name.length > 80 || code.length > 40)
          throw new Error("Use a shorter machine name or code.");
        if (
          s.machines!.some(
            (m) =>
              m.id !== machine.id &&
              (!site || !m.siteId || m.siteId === site) &&
              m.name.toLowerCase() === name.toLowerCase(),
          )
        )
          throw new Error("Another machine already uses this name.");
        if (name !== machine.name) changes.name = [machine.name, name];
        if (code !== (machine.code ?? ""))
          changes.code = [machine.code ?? "", code];
        if (!Object.keys(changes).length)
          throw new Error("No machine details changed.");
        reason = str("reason", false) || undefined;
        machine.name = name;
        if (code) machine.code = code;
        else delete machine.code;
      } else {
        const active = cmd.type === "machine-reactivate";
        if (machine.active === active)
          throw new Error(
            active ? "This machine is already active." : "This machine is already inactive.",
          );
        reason = str("reason");
        changes.active = [String(machine.active), String(active)];
        machine.active = active;
      }
      machine.updatedAt = at;
      machine.version += 1;
      machine.history.push({
        kind:
          cmd.type === "machine-update"
            ? "edited"
            : cmd.type === "machine-deactivate"
              ? "deactivated"
              : "reactivated",
        at,
        changes,
        reason,
        recordedBy: recorder,
      });
      // Historical stage records keep their own machine-name snapshot.
      log(
        machine.id,
        cmd.type === "machine-update"
          ? "Machine details edited"
          : cmd.type === "machine-deactivate"
            ? "Machine deactivated"
            : "Machine reactivated",
        Object.entries(changes)
          .map(([k, [a, b]]) => `${k}: ${a || "—"} → ${b || "—"}`)
          .join(" · ") + (reason ? " · " + reason : ""),
      );
      break;
    }
    case "step": {
      allow("production");
      const b = inSite(find(s.batches));
      if (isSachet(b.product))
        throw new Error(
          "Record the machine and PIC without an output quantity.",
        );
      const index = num("step");
      const st = b.steps[index];
      if (!st) throw new Error("Invalid process step.");
      if (st.done)
        throw new Error(
          "This step is already recorded; use a correction workflow.",
        );
      // Only the last step (Batching, Sticker & QC) records a count: the QC count of
      // finished bottles. Earlier machine steps record who did the work, never an output.
      const qcStep = isQcStep(b, index);
      const qc = qcStep ? str("qc") : "not-recorded";
      if (!["not-recorded", "pass", "issue"].includes(qc))
        throw new Error("Choose a QC result.");
      if (st.pic && st.pic !== str("pic"))
        throw new Error(
          "Use Edit PIC or Shift handover to change the assigned person first.",
        );
      const qty = qcStep ? num("qty") : null;
      b.steps[index] = {
        ...st,
        pic: str("pic"),
        qty,
        start: str("start", false),
        end: str("end", false),
        done: true,
        qc: qc as Step["qc"],
      };
      if (qcStep) b.actual = qty!;
      log(
        b.id,
        "Process recorded",
        qcStep
          ? "QC count " +
              qty +
              " " +
              batchUnit(b) +
              "s" +
              (qc === "not-recorded" ? " · QC not recorded" : " · QC: " + qc) +
              " · " +
              str("pic")
          : stepNames(b)[index][0] + " · " + str("pic"),
      );
      break;
    }
    case "transfer": {
      allow("production");
      const b = inSite(find(s.batches));
      if (isSachet(b.product)) {
        if (batchTransferred(b))
          throw new Error("This batch has already been sent to the warehouse.");
        const route = batchRoute(b);
        if (route.status === "needs-review")
          throw new Error(
            "This batch was started before the five-stage route. Review its route (upgrade to five stages or keep the recorded four-stage route) before transfer.",
          );
        if (!batchComplete(b))
          throw new Error(
            `Record a machine and PIC for all ${countWords[route.stages.length] ?? route.stages.length} stages of this batch's route before transfer.`,
          );
        b.transferredAt = at;
        b.transferPic = str("pic");
        log(
          b.id,
          "Batch sent to warehouse",
          b.code + " · " + b.transferPic + " · box count pending stock-in",
        );
        break;
      }
      const qty = num("qty", 1);
      if (!b.steps.every((st) => st.done))
        throw new Error("Record the remaining process groups before transfer.");
      if (qty > b.actual - b.sent)
        throw new Error("Transfer quantity exceeds recorded output available.");
      b.sent += qty;
      log(
        b.id,
        "Factory transfer",
        qty + " " + batchUnit(b) + " sent · " + str("pic"),
      );
      break;
    }
    case "receive": {
      allow("intake");
      const b = inSite(find(s.batches, "batchId"));
      if (isSachet(b.product))
        throw new Error(
          "Receive sachets for boxing before confirming its finished boxes.",
        );
      const qty = num("qty", 1),
        ref = b.code;
      if (qty > b.sent - batchReceived(s, b))
        throw new Error(
          "Count exceeds the outstanding factory transfer. Review the transfer first.",
        );
      const c: Carton = {
        id: id(),
        ref,
        batchId: b.id,
        product: b.product,
        unit: batchUnit(b),
        qty,
        rack: str("rack"),
        pic: str("pic"),
        at,
      };
      s.cartons.unshift(c);
      log(
        b.id,
        "Stock received",
        ref + " · " + qty + " " + c.unit + " · " + c.pic,
      );
      break;
    }
    case "receive-ady": {
      allow("intake");
      const batch = inSite(find(s.batches, "batchId"));
      if (!isSachet(batch.product) || !batchTransferred(batch))
        throw new Error("Choose a sachet batch sent to the warehouse.");
      const ref = batch.code;
      if (
        adypocideReceipts(s).some((r) => r.batchId === batch.id && !r.stockedAt)
      )
        throw new Error(
          "This batch already has a receipt awaiting boxing. Finalize that receipt first.",
        );
      const receipt: AdypocideReceipt = {
        id: id(),
        ref,
        batchId: batch.id,
        pic: str("pic"),
        at,
      };
      (s.adypocideReceipts ??= []).unshift(receipt);
      log(
        batch.id,
        "Sachet cartons received for boxing",
        ref + " · " + receipt.pic + " · stock count pending",
      );
      break;
    }
    case "stock-in-ady": {
      allow("intake");
      const receipt = adypocideReceipts(s).find(
        (r) => r.id === str("receiptId"),
      );
      if (!receipt) throw new Error("Choose a sachet receipt awaiting boxing.");
      if (receipt.stockedAt)
        throw new Error("This receipt has already been stocked in.");
      const batch = s.batches.find((b) => b.id === receipt.batchId);
      if (!batch || !isSachet(batch.product))
        throw new Error("Choose a sachet batch.");
      const boxes = num("boxes"),
        pic = str("pic"),
        ref = batch.code;
      const carton: Carton = {
        id: id(),
        ref,
        batchId: receipt.batchId,
        product: batch.product,
        unit: batchUnit(batch),
        qty: boxes,
        rack: str("rack"),
        pic,
        at,
      };
      s.cartons.unshift(carton);
      const finalized = { ...receipt, stockedAt: at, stockCartonId: carton.id };
      s.adypocideReceipts ??= [];
      const index = s.adypocideReceipts.findIndex((r) => r.id === receipt.id);
      if (index < 0) s.adypocideReceipts.unshift(finalized);
      else s.adypocideReceipts[index] = finalized;
      log(
        receipt.batchId,
        "Sachet box count finalized",
        receipt.ref + " · " + boxes + " boxes · " + pic,
      );
      break;
    }
    case "box": {
      throw new Error(
        "Use sachet box stock-in; sachet quantities and conversion ratios are no longer recorded.",
      );
    }
    case "order": {
      allow("admin", "outbound");
      const p = str("product"),
        awb = normalizeAwb(str("awb")),
        expected = num("expected", 1);
      if (!product(p)) throw new Error("Choose a product.");
      if (s.orders.some((o) => normalizeAwb(o.awb) === awb))
        throw new Error("This AWB is already recorded.");
      if (!channels.includes(str("channel")))
        throw new Error("Choose an order source.");
      const o: Order = {
        id: id(),
        awb,
        reviewState: "pending",
        product: p,
        channel: str("channel"),
        package: str("package"),
        expected,
        originalExpected: expected,
        actual: null,
        packer: "",
        labelPic: "",
        printed: false,
        dispatched: false,
        handoverRef: "",
        date: str("date"),
        note: str("note", false),
      };
      s.orders.unshift(o);
      log(
        o.id,
        "AWB recorded",
        awb + " · expected " + expected + " " + product(p).unit,
      );
      break;
    }
    case "edit-order": {
      allow("admin", "outbound");
      const o = find(s.orders);
      if (orderReady(o))
        throw new Error("Reviewed orders require a supervisor correction.");
      const p = str("product"),
        awb = normalizeAwb(str("awb")),
        channel = str("channel");
      if (!product(p) || !channels.includes(channel))
        throw new Error("Choose a product and source.");
      if (
        s.orders.some(
          (other) => other.id !== o.id && normalizeAwb(other.awb) === awb,
        )
      )
        throw new Error("This AWB is already recorded.");
      const before = `${o.awb} · ${o.package} · ${o.expected}`;
      o.awb = awb;
      o.product = p;
      o.channel = channel;
      o.package = str("package");
      o.expected = num("expected", 1);
      o.originalExpected = o.expected;
      o.date = str("date");
      log(
        o.id,
        "Pending order edited",
        `${before} → ${o.awb} · ${o.package} · ${o.expected}`,
      );
      break;
    }
    case "review-order": {
      allow("admin", "outbound");
      const o = find(s.orders);
      if (orderReady(o)) throw new Error("This order is already reviewed.");
      o.reviewState = "confirmed";
      o.reviewedBy = str("pic");
      log(o.id, "Order reviewed", o.awb + " · " + o.reviewedBy);
      break;
    }
    case "sort-count": {
      allow("outbound");
      const date = str("date"),
        p = str("product"),
        counted = num("counted");
      const tally = dailyTally(s, date).find((t) => t.product === p);
      if (!tally?.awbs)
        throw new Error("No reviewed orders for this product and day.");
      const note = str("note", !!tally.count || counted !== tally.expected);
      const count: SortCount = {
        id: id(),
        date,
        product: p,
        counted,
        expected: tally.expected,
        fingerprint: demandFingerprint(s, date, p),
        pic: str("pic"),
        note,
        at,
      };
      s.sortCounts ??= [];
      s.sortCounts.unshift(count);
      log(
        date,
        "Supervisor sort count recorded",
        `${product(p).name}: system ${tally.expected}, supervisor ${counted} · ${count.pic} · ${note}`,
      );
      break;
    }
    case "assign-package": {
      allow("outbound");
      const date = str("date"),
        key = str("group"),
        pic = str("pic");
      const group = packageGroups(dailyOrders(s, date)).find(
        (g) => g.key === key,
      );
      if (!group) throw new Error("This package group is no longer available.");
      const tally = dailyTally(s, date).find(
        (t) => t.product === group.product,
      )!;
      if (!tally.count || tally.stale)
        throw new Error(
          "Record a current supervisor count before assigning packers.",
        );
      const orders = group.orders
        .filter((o) => !o.dispatched && o.actual === null)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!orders.length)
        throw new Error("No unpacked parcels remain in this package.");
      if (
        !Array.isArray(v.packers) ||
        !v.packers.length ||
        new Set(v.packers).size !== v.packers.length
      )
        throw new Error("Choose distinct packer profiles.");
      const targets = v.packers.map((packer, i) => {
        if (
          typeof packer !== "string" ||
          !(s.staffProfiles
            ? s.staffProfiles.some(
                (p) => p.id === packer && p.role === "packer",
              )
            : people.includes(packer))
        )
          throw new Error("Choose a packer profile.");
        return { packer, count: num("allocation_" + i) };
      });
      if (targets.reduce((n, t) => n + t.count, 0) > orders.length)
        throw new Error(
          "Assigned parcels exceed the remaining package orders.",
        );
      const assignments = new Map<string, string>();
      // Keep current assignments up to each quota, then allocate unassigned parcels.
      for (const target of targets)
        for (const o of orders
          .filter((o) => o.assignedPacker === target.packer)
          .slice(0, target.count))
          assignments.set(o.id, target.packer);
      const free = orders.filter((o) => !assignments.has(o.id));
      for (const target of targets) {
        let remaining =
          target.count -
          [...assignments.values()].filter((p) => p === target.packer).length;
        while (remaining-- > 0)
          assignments.set(free.shift()!.id, target.packer);
      }
      if (
        orders.some(
          (o) => o.assignedPacker && o.assignedPacker !== assignments.get(o.id),
        )
      )
        str("reason");
      for (const o of orders) {
        const next = assignments.get(o.id);
        if (o.assignedPacker === next) continue;
        const previous = o.assignedPacker ?? "Unassigned";
        o.assignedPacker = next;
        o.assignedAt = at;
        log(
          o.id,
          "Package packer assignment",
          `${group.package} · ${previous} → ${next ?? "Unassigned"} · by ${pic} · ${str("reason", false)}`,
        );
      }
      break;
    }
    case "split-order": {
      allow("admin", "outbound");
      const o = find(s.orders);
      if (singleProductOrder(o))
        throw new Error("This record already has one product.");
      if (
        o.actual !== null ||
        o.dispatched ||
        s.issues.some((i) => i.orderId === o.id)
      )
        throw new Error(
          "This historical record has stock or packing activity. Preserve it and ask a supervisor to reconcile it separately.",
        );
      const pic = str("pic"),
        reason = str("reason");
      const totals = new Map<string, number>();
      for (const line of orderLines(o))
        totals.set(
          line.product,
          (totals.get(line.product) ?? 0) + line.expected,
        );
      const parcels = [...totals].map(([product, expected], i) => ({
        ...o,
        id: i === 0 ? o.id : id(),
        awb: normalizeAwb(str("awb_" + product)),
        product,
        package: str("package_" + product),
        expected,
        originalExpected: expected,
        lines: undefined,
        reviewState: "confirmed" as const,
        reviewedBy: pic,
        assignedPacker: undefined,
        assignedAt: undefined,
        printed: false,
        packer: "",
        labelPic: "",
        note: `${o.note} · Split from ${o.awb}: ${reason}`,
      }));
      if (
        new Set(parcels.map((p) => p.awb)).size !== parcels.length ||
        parcels.some((p) =>
          s.orders.some(
            (other) => other.id !== o.id && normalizeAwb(other.awb) === p.awb,
          ),
        )
      )
        throw new Error("Enter a distinct actual AWB for each product parcel.");
      const original = { awb: o.awb, lines: orderLines(o), package: o.package };
      s.orders.splice(
        s.orders.findIndex((r) => r.id === o.id),
        1,
        ...parcels,
      );
      for (const parcel of parcels)
        log(
          parcel.id,
          "Brands separated into parcels",
          `${JSON.stringify(original)} → ${parcel.awb} · ${parcel.product} · ${parcel.expected} · ${pic} · ${reason}`,
        );
      break;
    }
    case "assign-orders":
    case "print-orders":
    case "move-orders":
    case "issue-orders": {
      allow("outbound");
      if (
        !Array.isArray(v.ids) ||
        !v.ids.length ||
        v.ids.length > 10000 ||
        new Set(v.ids).size !== v.ids.length
      )
        throw new Error("Select distinct AWBs first.");
      const orders = v.ids.map((key) => {
        const o = s.orders.find((o) => o.id === key);
        if (!o || !orderReady(o) || o.dispatched)
          throw new Error("Select reviewed AWBs awaiting handover.");
        return o;
      });
      const pic = str("pic");
      if (cmd.type === "assign-orders" || cmd.type === "issue-orders") {
        for (const o of orders) {
          if (!singleProductOrder(o))
            throw new Error(
              "Separate brands into independent parcels before fulfilment.",
            );
          for (const line of orderLines(o)) {
            const tally = dailyTally(s, o.date).find(
              (t) => t.product === line.product,
            )!;
            if (!tally.count || tally.stale)
              throw new Error(
                "Record a current supervisor count before issuing stock or assigning packers.",
              );
          }
        }
      }
      if (cmd.type === "move-orders") {
        const date = str("date"),
          reason = str("reason");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
          throw new Error("Choose a valid fulfilment date.");
        for (const o of orders) {
          if (o.actual !== null)
            throw new Error(
              "Only unpacked AWBs can move days. Existing stock allocations and assignments follow the AWB.",
            );
          log(
            o.id,
            "Fulfilment date changed",
            `${o.date} → ${date} · ${pic} · ${reason}`,
          );
          o.date = date;
        }
      } else if (cmd.type === "print-orders") {
        for (const o of orders) {
          if (o.printed) continue;
          o.printed = true;
          log(o.id, "AWB print recorded", o.awb + " · " + pic);
        }
      } else if (cmd.type === "assign-orders") {
        const packer = str("packer");
        if (
          !(s.staffProfiles
            ? s.staffProfiles.some(
                (p) => p.id === packer && p.role === "packer",
              )
            : people.includes(packer))
        )
          throw new Error("Choose a packer profile.");
        for (const o of orders) {
          if (o.actual !== null)
            throw new Error("Only unpacked parcels can be assigned.");
          if (o.assignedPacker && o.assignedPacker !== packer) str("reason");
          const previous = o.assignedPacker ?? "Unassigned";
          o.assignedPacker = packer;
          o.assignedAt = at;
          log(
            o.id,
            "Packer assigned",
            `${previous} → ${packer} · by ${pic} · ${str("reason", false)}`,
          );
        }
      } else {
        const c = find(s.cartons, "cartonId"),
          qty = num("qty", 1);
        if (c.unit !== product(c.product).unit)
          throw new Error("Choose finished stock.");
        const matching = orders.filter((o) =>
          orderLines(o).some((l) => l.product === c.product),
        );
        const remaining = (o: Order) =>
          Math.max(
            0,
            orderLines(o)
              .filter((l) => l.product === c.product)
              .reduce((n, l) => n + l.expected, 0) -
              orderIssued(s, o, c.product),
          );
        if (qty > available(s, c))
          throw new Error("Not enough stock in this carton.");
        if (qty > matching.reduce((n, o) => n + remaining(o), 0))
          throw new Error(
            "Quantity exceeds the remaining demand for selected AWBs.",
          );
        let left = qty;
        for (const o of matching) {
          const allocated = Math.min(left, remaining(o));
          if (!allocated) continue;
          s.issues.unshift({
            id: id(),
            cartonId: c.id,
            orderId: o.id,
            qty: allocated,
            pic,
            at,
          });
          log(
            o.id,
            "Stock issued to packing",
            `${c.ref} · ${allocated} ${c.unit} · ${pic}`,
          );
          left -= allocated;
        }
      }
      break;
    }
    case "print": {
      allow("outbound");
      const o = find(s.orders);
      if (!orderReady(o)) throw new Error("Review this order first.");
      if (o.printed) throw new Error("Already recorded as printed.");
      o.printed = true;
      log(o.id, "AWB print recorded", o.awb + " · " + str("pic"));
      break;
    }
    case "issue": {
      allow("outbound");
      const c = find(s.cartons, "cartonId"),
        o = find(s.orders, "orderId"),
        qty = num("qty", 1);
      if (!orderReady(o)) throw new Error("Review this order first.");
      if (!singleProductOrder(o))
        throw new Error(
          "Separate brands into independent parcels before fulfilment.",
        );
      if (o.dispatched)
        throw new Error("This parcel has already been handed over.");
      if (
        !orderLines(o).some((l) => l.product === c.product) ||
        c.unit !== product(c.product).unit
      )
        throw new Error("Choose matching saleable stock for this order.");
      if (qty > available(s, c))
        throw new Error("Not enough stock in this carton.");
      s.issues.unshift({
        id: id(),
        cartonId: c.id,
        orderId: o.id,
        qty,
        pic: str("pic"),
        at,
      });
      log(
        o.id,
        "Stock issued to packing",
        c.ref + " · " + qty + " " + c.unit + " · " + str("pic"),
      );
      break;
    }
    case "pack": {
      // SV-only entry: the stock-out supervisor records the actual packer's count.
      allow("outbound");
      const o = find(s.orders);
      if (!singleProductOrder(o))
        throw new Error(
          "Separate brands into independent parcels before fulfilment.",
        );
      if (o.actual !== null)
        throw new Error(
          "Saved parcel quantities require a supervisor correction.",
        );
      if (!orderReady(o) || !o.assignedPacker)
        throw new Error(
          "Only an assigned packer's work can be recorded. Assign this AWB first.",
        );
      const packer = str("pic");
      if (
        s.staffProfiles &&
        !s.staffProfiles.some((p) => p.id === packer && p.role === "packer")
      )
        throw new Error("Choose the actual packer's profile.");
      const reason = str("reason", false);
      if (packer !== o.assignedPacker && !reason)
        throw new Error(
          "The actual packer differs from the assigned packer. Enter a reason.",
        );
      const packedAt = occurrence("occurredAt");
      if (o.lines) {
        o.lines.forEach((l) => {
          l.actual = num("actual_" + l.product);
        });
        o.actual = o.lines.reduce((n, l) => n + l.actual!, 0);
      } else o.actual = num("actual");
      o.packer = packer;
      o.labelPic = str("labelPic");
      o.packedAt = packedAt;
      o.packRecordedAt = at;
      o.packRecordedBy = recorder;
      log(
        o.id,
        "Parcel quantity recorded",
        orderLines(o)
          .map(
            (l) =>
              `${product(l.product).name}: ${l.actual} ${product(l.product).unit}`,
          )
          .join(" · ") +
          " · packed by " +
          o.packer +
          " · AWB attached by " +
          o.labelPic +
          (packer !== o.assignedPacker
            ? ` · assigned to ${o.assignedPacker}: ${reason}`
            : ""),
        { performer: packer, occurredAt: packedAt },
      );
      break;
    }
    case "correct": {
      allow("outbound");
      const o = find(s.orders),
        field = str("field"),
        reason = str("reason");
      if (field !== "actual" && field !== "expected")
        throw new Error("Choose the quantity to correct.");
      if (o.lines) {
        const line = o.lines.find((l) => l.product === str("product"));
        if (!line) throw new Error("Choose the product to correct.");
        if (field === "actual" && line.actual === null)
          throw new Error("Record the packer's first count before correction.");
        const before = line[field];
        line[field] = num("qty");
        o.expected = o.lines.reduce((n, l) => n + l.expected, 0);
        o.actual = o.lines.some((l) => l.actual === null)
          ? null
          : o.lines.reduce((n, l) => n + l.actual!, 0);
        log(
          o.id,
          "Quantity corrected",
          `${product(line.product).name} ${field}: ${before} → ${line[field]} · ${reason}`,
        );
        break;
      }
      if (field === "actual" && o.actual === null)
        throw new Error("No saved packed count exists yet.");
      const old = o[field],
        value = num("qty", field === "expected" ? 1 : 0);
      o[field] = value;
      log(
        o.id,
        "Supervisor correction",
        field +
          ": " +
          old +
          " → " +
          value +
          " · " +
          reason +
          (o.dispatched ? " · revised after handover" : ""),
      );
      break;
    }
    case "dispatch": {
      allow("outbound");
      const o = find(s.orders);
      if (o.actual === null)
        throw new Error("Record the parcel quantity before handover.");
      if (o.dispatched) throw new Error("This parcel is already handed over.");
      const note = str("note", variance(o) !== 0);
      o.dispatched = true;
      o.handoverRef = str("reference");
      log(
        o.id,
        "Courier handover",
        o.handoverRef + " · " + str("pic") + (note ? " · " + note : ""),
      );
      break;
    }
    case "count": {
      allow("intake");
      const c = find(s.cartons, "cartonId");
      if (c.unit === "sachet")
        throw new Error("Finalize the finished box count in sachet stock-in.");
      const count: Count = {
        id: id(),
        cartonId: c.id,
        book: available(s, c),
        actual: num("actual"),
        pic: str("pic"),
        at,
        adjusted: false,
      };
      s.counts.unshift(count);
      log(
        c.batchId,
        "Physical stock count",
        c.ref +
          " · book " +
          count.book +
          " / counted " +
          count.actual +
          " · " +
          count.pic,
      );
      break;
    }
    case "adjust": {
      allow("intake");
      const count = find(s.counts);
      if (count.adjusted)
        throw new Error("This count has already been adjusted.");
      const c = s.cartons.find((c) => c.id === count.cartonId)!;
      if (c.unit === "sachet")
        throw new Error("Finalize the finished box count in sachet stock-in.");
      if (available(s, c) !== count.book)
        throw new Error(
          "Stock moved after this count. Count again before adjustment.",
        );
      const reason = str("reason");
      s.adjustments.unshift({
        id: id(),
        cartonId: c.id,
        delta: count.actual - count.book,
        reason,
        at,
      });
      count.adjusted = true;
      log(
        c.batchId,
        "Stock adjustment",
        c.ref +
          " · " +
          (count.actual - count.book) +
          " " +
          c.unit +
          " · " +
          reason,
      );
      break;
    }
    case "review": {
      allow("management");
      const text = str("text");
      s.notes.unshift({ id: id(), kind: "review", text, role: cmd.role, at, ...noteScope() });
      log("workspace", "Management follow-up", text);
      break;
    }
    case "feedback": {
      // Any signed-in role may post feedback; it never edits operational records.
      const text = str("text");
      s.notes.unshift({ id: id(), kind: "feedback", text, role: cmd.role, at, ...noteScope() });
      break;
    }
    case "trip": {
      // Drivers log their own trip; the driver is always the signed-in recorder.
      const assistant = str("assistant", false);
      if (assistant.length > 100) throw new Error("Use a shorter assistant name.");
      const pickupAt = tripTime("pickupAt")!;
      const arriveAt = tripTime("arriveAt", false);
      if (arriveAt && arriveAt < pickupAt)
        throw new Error("The arrival time cannot be before the pickup time.");
      const photo = tripPhoto();
      const note = str("note", false);
      if (note.length > 300) throw new Error("Use a shorter trip note.");
      const trip: Trip = {
        id: id(),
        ...(site ? { siteId: site } : {}),
        date: toMyt(pickupAt).slice(0, 10),
        driver: recorder.name,
        assistant,
        pickupAt,
        ...(arriveAt ? { arriveAt, arrivalRecordedAt: at } : {}),
        ...(photo ? { photo, photoRecordedAt: at } : {}),
        ...(note ? { note } : {}),
        recordedAt: at,
        recordedBy: recorder,
      };
      (s.trips ??= []).unshift(trip);
      log(
        "trip:" + trip.id,
        "Trip logged",
        [
          "Pickup " + toMyt(pickupAt).replace("T", " "),
          arriveAt ? "arrival " + toMyt(arriveAt).replace("T", " ") : "arrival pending",
          assistant ? "assistant " + assistant : "no assistant",
          photo ? "photo attached" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        { performer: recorder.name, occurredAt: pickupAt },
      );
      break;
    }
    case "trip-update": {
      const trip = inSite(find(s.trips ?? []));
      if (trip.recordedBy?.userId !== recorder.userId)
        throw new Error("Only the driver who logged this trip can add to it.");
      const arriveAt = tripTime("arriveAt", false);
      const photo = tripPhoto();
      if (!arriveAt && !photo)
        throw new Error("Enter the arrival time or add a photo.");
      if (arriveAt) {
        if (trip.arriveAt)
          throw new Error("The arrival time is already recorded for this trip.");
        if (arriveAt < trip.pickupAt)
          throw new Error("The arrival time cannot be before the pickup time.");
        trip.arriveAt = arriveAt;
        trip.arrivalRecordedAt = at;
      }
      if (photo) {
        if (trip.photo) throw new Error("This trip already has a photo.");
        trip.photo = photo;
        trip.photoRecordedAt = at;
      }
      log(
        "trip:" + trip.id,
        arriveAt ? "Trip arrival logged" : "Trip photo added",
        [
          arriveAt ? "Arrival " + toMyt(arriveAt).replace("T", " ") : "",
          photo ? "photo attached" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        { performer: trip.driver, ...(arriveAt ? { occurredAt: arriveAt } : {}) },
      );
      break;
    }
    case "close": {
      allow("production", "intake", "outbound");
      const date = str("date"),
        key = cmd.role + ":" + date;
      if (s.closedDays.includes(key))
        throw new Error("This role's day is already closed.");
      s.closedDays.push(key);
      log("workspace", "Daily close", date + " · " + str("note"));
      break;
    }
    case "reset": {
      return createDraft();
    }
    default:
      throw new Error("Unknown action.");
  }
  // Every audit entry created by this command carries the server-derived recorder.
  for (const e of s.events.slice(0, s.events.length - eventsBefore))
    if (!e.recorder) {
      e.recorder = recorder;
      e.actor = recorderLabel(recorder);
    }
  if (
    s.events.length > 1500 ||
    s.orders.length > 500 ||
    s.batches.length > 200 ||
    s.cartons.length > 500 ||
    (s.adypocideReceipts?.length ?? 0) > 500 ||
    (s.sortCounts?.length ?? 0) > 1000 ||
    s.notes.length > 200 ||
    (s.trips?.length ?? 0) > 500 ||
    (s.machines?.length ?? 0) > 300
  )
    throw new Error(
      "The test workspace is full. Export your review and reset the sample data.",
    );
  return s;
}

// Idempotency records commit atomically with the workspace state they describe.
export const OPERATION_LIMIT = 500;
export const findOperation = (s: Draft, operationId: string) =>
  s.operations?.find((op) => op.id === operationId);
export function recordOperation(s: Draft, op: OperationRecord): Draft {
  s.operations = [op, ...(s.operations ?? [])].slice(0, OPERATION_LIMIT);
  return s;
}
