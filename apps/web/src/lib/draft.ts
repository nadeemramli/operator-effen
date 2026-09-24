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
  | "packer"
  | "management";
export const roles: { id: Role; en: string; ms: string }[] = [
  { id: "production", en: "Production supervisor", ms: "Penyelia pengeluaran" },
  { id: "intake", en: "Stock-in supervisor", ms: "Penyelia stok masuk" },
  { id: "outbound", en: "Stock-out supervisor", ms: "Penyelia stok keluar" },
  { id: "admin", en: "Office admin", ms: "Admin pejabat" },
  { id: "packer", en: "Packer", ms: "Pembungkus" },
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
    id: "wrapping",
    machine: "Shrink machine",
    en: "Shrink machine (plastic wrapping)",
    ms: "Mesin shrink (balutan plastik)",
  },
];
// Labels for historical records created before the fixed sachet route.
export const sachetSteps = [
  ["Filling & sealing", "Pengisian & pengedapan"],
  ["Batch marking & checks", "Penandaan kelompok & semakan"],
  ["Count & bag", "Pengiraan & pembungkusan beg"],
];
export interface PicChange {
  kind: "assignment" | "correction" | "handover";
  from: string;
  to: string;
  at: string;
  effectiveAt?: string;
  reason: string;
}
export interface Step {
  picHistory?: PicChange[];
  sachetStage?: string;
  machine?: string;
  pic: string;
  qty: number | null;
  start: string;
  end: string;
  done: boolean;
  qc: "not-recorded" | "pass" | "issue";
}
export interface Batch {
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
}
export interface Note {
  id: string;
  kind: "review" | "feedback";
  text: string;
  role: Role;
  at: string;
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
export interface StaffProfile {
  id: string;
  name: string;
  role: Role;
}
export interface Draft {
  staffProfiles?: StaffProfile[];
  sortCounts?: SortCount[];
  adypocideReceipts?: AdypocideReceipt[];
  awbImports?: AwbImport[];
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
        const stage = sachetProcesses.find((p) => p.id === step.sachetStage);
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
export const batchComplete = (b: Batch) =>
  isSachet(b.product)
    ? sachetProcesses.every((stage) =>
        b.steps.some(
          (step) => step.sachetStage === stage.id && step.done && !!step.pic,
        ),
      )
    : b.steps.every((step) => step.done);
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
export const orderReady = (o: Order) => o.reviewState !== "pending";
export const dailyOrders = (s: Draft, date: string) =>
  s.orders.filter((o) => o.date === date && orderReady(o));
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
    ...(isSachet(p.id) ? { transferredAt: at, transferPic: people[0] } : {}),
    steps: (isSachet(p.id) ? sachetProcesses : bottleSteps).map((_, j) => ({
      ...(isSachet(p.id)
        ? {
            machine: sachetProcesses[j].machine,
            sachetStage: sachetProcesses[j].id,
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
};
export function applyCommand(current: Draft, cmd: Command): Draft {
  if (!roles.some((r) => r.id === cmd.role))
    throw new Error("Choose a valid test role.");
  const s = withBatchReferences(current),
    v = cmd.input,
    at = new Date().toISOString();
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
  const log = (entity: string, action: string, detail: string) =>
    s.events.unshift({
      id: id(),
      entity,
      action,
      detail,
      actor: roles.find((r) => r.id === cmd.role)!.en + " (test view)",
      at,
    });
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
      const b: Batch = {
        id: id(),
        code,
        product: p,
        date: str("date"),
        target: isSachet(p) ? 0 : num("target", 1),
        actual: 0,
        sent: 0,
        steps: isSachet(p)
          ? sachetProcesses.map((stage) => ({
              ...blankStep(),
              machine: stage.machine,
              sachetStage: stage.id,
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
            ? " · machine and PIC records"
            : " · " + b.target + " " + batchUnit(b)),
      );
      break;
    }
    case "change-step-pic": {
      allow("production");
      const b = find(s.batches),
        index = num("step"),
        step = b.steps[index];
      if (!step) throw new Error("Choose a valid production process.");
      const kind = str("kind"),
        pic = str("pic"),
        reason = str("reason");
      if (kind !== "correction" && kind !== "handover")
        throw new Error("Choose a PIC correction or shift handover.");
      if (pic === step.pic) throw new Error("Choose a different PIC.");
      let effectiveAt: string | undefined;
      if (kind === "handover") {
        if (!step.pic)
          throw new Error("Assign the first PIC before recording a handover.");
        if (batchTransferred(b))
          throw new Error(
            "This batch is already transferred; use a correction for mistaken records.",
          );
        const local = str("effectiveAt");
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
          throw new Error("Enter the takeover date and time in Malaysia time.");
        const time = new Date(local + ":00+08:00");
        if (
          !Number.isFinite(time.getTime()) ||
          time.getTime() > Date.now() ||
          local.slice(0, 10) < b.date
        )
          throw new Error(
            "Takeover time must be on or after the batch date and not in the future.",
          );
        effectiveAt = time.toISOString();
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
        kind,
        from: previous,
        to: pic,
        at,
        effectiveAt,
        reason,
      });
      step.pic = pic;
      log(
        b.id,
        kind === "handover"
          ? "Production shift handover"
          : "Production PIC corrected",
        `${stepNames(b)[index][0]} · ${previous || "Unassigned"} → ${pic} · ${effectiveAt ?? at} · ${reason}`,
      );
      break;
    }
    case "machine": {
      allow("production");
      const b = find(s.batches);
      if (!isSachet(b.product))
        throw new Error("Machine-only records are for sachet products.");
      if (batchTransferred(b))
        throw new Error("This batch has already been sent to the warehouse.");
      const stage = sachetProcesses.find((stage) => stage.id === str("stage"));
      if (!stage)
        throw new Error("Choose one of the four fixed sachet processes.");
      const previous = b.steps.find((step) => step.sachetStage === stage.id);
      if (previous?.done)
        throw new Error("This process already has a recorded PIC.");
      const pic = str("pic");
      if (previous?.pic && previous.pic !== pic)
        throw new Error(
          "Use Edit PIC or Shift handover to change the assigned person first.",
        );
      const record = {
        ...(previous ?? blankStep()),
        machine: stage.machine,
        sachetStage: stage.id,
        pic,
        done: true,
      };
      if (previous) b.steps[b.steps.indexOf(previous)] = record;
      else b.steps.push(record);

      log(
        b.id,
        "Machine responsibility recorded",
        b.code + " · " + stage.en + " · " + pic,
      );
      break;
    }
    case "step": {
      allow("production");
      const b = find(s.batches);
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
      const qc = str("qc");
      if (!["not-recorded", "pass", "issue"].includes(qc))
        throw new Error("Choose a QC result.");
      if (st.pic && st.pic !== str("pic"))
        throw new Error(
          "Use Edit PIC or Shift handover to change the assigned person first.",
        );
      b.steps[index] = {
        ...st,
        pic: str("pic"),
        qty: num("qty"),
        start: str("start", false),
        end: str("end", false),
        done: true,
        qc: qc as Step["qc"],
      };
      if (index === b.steps.length - 1) b.actual = num("qty");
      log(
        b.id,
        "Process recorded",
        stepNames(b)[index][0] +
          " · " +
          str("pic") +
          " · " +
          num("qty") +
          " " +
          batchUnit(b) +
          (qc === "not-recorded" ? " · QC not recorded" : " · QC: " + qc),
      );
      break;
    }
    case "transfer": {
      allow("production");
      const b = find(s.batches);
      if (isSachet(b.product)) {
        if (batchTransferred(b))
          throw new Error("This batch has already been sent to the warehouse.");
        if (!batchComplete(b))
          throw new Error(
            "Record a machine and PIC for all four fixed processes before transfer.",
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
      const b = find(s.batches, "batchId");
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
      const batch = find(s.batches, "batchId");
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
      if (
        dailyOrders(s, date).some(
          (o) => orderLines(o).some((l) => l.product === p) && !o.printed,
        )
      )
        throw new Error(
          "Record the printed labels for this product before counting.",
        );
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
        "Printed-label count recorded",
        `${product(p).name}: system ${tally.expected}, supervisor ${counted} · ${count.pic} · ${note}`,
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
        v.ids.length > 500 ||
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
          if (!o.printed) throw new Error("Record the printed labels first.");
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
          if (!o.printed || o.actual !== null)
            throw new Error("Only printed, unpacked AWBs can be assigned.");
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
      allow("packer");
      const o = find(s.orders);
      if (o.actual !== null)
        throw new Error(
          "Saved parcel quantities require a supervisor correction.",
        );
      if (
        !orderReady(o) ||
        !o.assignedPacker ||
        o.assignedPacker !== str("pic")
      )
        throw new Error(
          "Only the assigned packer can record this AWB. Ask the supervisor to assign it first.",
        );
      if (o.lines) {
        o.lines.forEach((l) => {
          l.actual = num("actual_" + l.product);
        });
        o.actual = o.lines.reduce((n, l) => n + l.actual!, 0);
      } else o.actual = num("actual");
      o.packer = str("pic");
      o.labelPic = str("labelPic");
      log(
        o.id,
        "Parcel quantity declared",
        orderLines(o)
          .map(
            (l) =>
              `${product(l.product).name}: ${l.actual} ${product(l.product).unit}`,
          )
          .join(" · ") +
          " · " +
          o.packer +
          " · AWB attached by " +
          o.labelPic,
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
      s.notes.unshift({ id: id(), kind: "review", text, role: cmd.role, at });
      log("workspace", "Management follow-up", text);
      break;
    }
    case "feedback": {
      const text = str("text");
      s.notes.unshift({ id: id(), kind: "feedback", text, role: cmd.role, at });
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
  if (
    s.events.length > 1500 ||
    s.orders.length > 500 ||
    s.batches.length > 200 ||
    s.cartons.length > 500 ||
    (s.adypocideReceipts?.length ?? 0) > 500 ||
    (s.sortCounts?.length ?? 0) > 1000 ||
    s.notes.length > 200
  )
    throw new Error(
      "The test workspace is full. Export your review and reset the sample data.",
    );
  return s;
}
