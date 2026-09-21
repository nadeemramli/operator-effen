export type Lang = "en" | "ms";
export const tr = (lang: Lang, en: string, ms: string) =>
  lang === "ms" ? ms : en;
export type Role =
  "production" | "intake" | "outbound" | "admin" | "packer" | "management";
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
    color: "var(--info)",
  },
  {
    id: "gly",
    name: "Glycoxil",
    short: "GLY",
    unit: "bottle" as Unit,
    color: "var(--success)",
  },
  {
    id: "lip",
    name: "Lipidri",
    short: "LIP",
    unit: "bottle" as Unit,
    color: "var(--warning)",
  },
  {
    id: "syn",
    name: "Synovil",
    short: "SYN",
    unit: "bottle" as Unit,
    color: "var(--ai)",
  },
  {
    id: "ady",
    name: "Adypocide",
    short: "ADY",
    unit: "box" as Unit,
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
export const sachetSteps = [
  ["Filling & sealing", "Pengisian & pengedapan"],
  ["Batch marking & checks", "Penandaan kelompok & semakan"],
  ["Count & bag", "Pengiraan & pembungkusan beg"],
];
export interface Step {
  pic: string;
  qty: number | null;
  start: string;
  end: string;
  done: boolean;
  qc: "not-recorded" | "pass" | "issue";
}
export interface Batch {
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
  batchId: string;
  product: string;
  unit: Unit;
  qty: number;
  rack: string;
  pic: string;
  at: string;
}
export interface Order {
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
export interface Draft {
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
export const stepNames = (b: Batch) =>
  b.product === "ady" ? sachetSteps : bottleSteps;
export const batchUnit = (b: Batch): Unit =>
  b.product === "ady" ? "sachet" : "bottle";
export const available = (s: Draft, c: Carton) =>
  c.qty -
  s.issues.filter((i) => i.cartonId === c.id).reduce((n, i) => n + i.qty, 0) -
  s.boxing
    .filter((i) => i.sourceId === c.id)
    .reduce((n, i) => n + i.boxes * i.ratio + i.loss, 0) +
  s.adjustments
    .filter((i) => i.cartonId === c.id)
    .reduce((n, i) => n + i.delta, 0);
export const orderIssued = (s: Draft, o: Order) =>
  s.issues.filter((i) => i.orderId === o.id).reduce((n, i) => n + i.qty, 0);
export const variance = (o: Order) =>
  o.actual === null ? null : o.actual - o.expected;
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
    target: p.id === "ady" ? 1000 : 240,
    actual: p.id === "ady" ? 1000 : 240,
    sent: p.id === "ady" ? 500 : 120,
    steps: (p.id === "ady" ? sachetSteps : bottleSteps).map((_, j) => ({
      pic: people[(i + j) % 4],
      qty: p.id === "ady" ? 1000 : 240,
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
  const cartons: Carton[] = products.map((p, i) => ({
    id: "c-" + p.id,
    ref: "TEST-CTN-" + String(i + 1).padStart(3, "0"),
    batchId: "b-" + p.id,
    product: p.id,
    unit: p.id === "ady" ? "sachet" : "bottle",
    qty: p.id === "ady" ? 500 : 120,
    rack: p.id === "ady" ? "BOXING-01" : "A-0" + (i + 1),
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
      note: "Sachets per box must be entered for a boxing job.",
    },
  ];
  return {
    version: 1,
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
  const s = structuredClone(current),
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
        target: num("target", 1),
        actual: 0,
        sent: 0,
        steps: (p === "ady" ? sachetSteps : bottleSteps).map(blankStep),
      };
      s.batches.unshift(b);
      log(
        b.id,
        "Batch planned",
        b.code + " · " + b.target + " " + batchUnit(b),
      );
      break;
    }
    case "step": {
      allow("production");
      const b = find(s.batches);
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
      b.steps[index] = {
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
      const b = find(s.batches, "batchId"),
        qty = num("qty", 1),
        ref = str("ref");
      if (s.cartons.some((c) => c.ref.toLowerCase() === ref.toLowerCase()))
        throw new Error("Use a unique carton reference in this draft.");
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
    case "box": {
      allow("intake");
      const source = find(s.cartons, "cartonId"),
        ratio = num("ratio", 1),
        boxes = num("boxes", 1),
        loss = num("loss");
      if (source.unit !== "sachet")
        throw new Error("Select a loose-sachet carton.");
      if (boxes * ratio + loss > available(s, source))
        throw new Error("Not enough loose sachets for this boxing job.");
      const ref = str("ref");
      if (s.cartons.some((c) => c.ref.toLowerCase() === ref.toLowerCase()))
        throw new Error("Carton reference already exists.");
      const c: Carton = {
        id: id(),
        ref,
        batchId: source.batchId,
        product: source.product,
        unit: "box",
        qty: boxes,
        rack: str("rack"),
        pic: str("pic"),
        at,
      };
      s.cartons.unshift(c);
      s.boxing.unshift({
        id: id(),
        sourceId: source.id,
        cartonId: c.id,
        ratio,
        boxes,
        loss,
        pic: c.pic,
        at,
      });
      log(
        source.batchId,
        "Sachets boxed",
        boxes +
          " boxes × " +
          ratio +
          " sachets · " +
          loss +
          " recorded loss · " +
          ref,
      );
      break;
    }
    case "order": {
      allow("admin");
      const p = str("product"),
        awb = str("awb"),
        expected = num("expected", 1);
      if (!product(p)) throw new Error("Choose a product.");
      if (s.orders.some((o) => o.awb.toLowerCase() === awb.toLowerCase()))
        throw new Error("This AWB is already recorded.");
      if (!["Shopee", "TikTok", "Luxana"].includes(str("channel")))
        throw new Error("Choose an order source.");
      const o: Order = {
        id: id(),
        awb,
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
    case "print": {
      allow("outbound");
      const o = find(s.orders);
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
      if (o.dispatched)
        throw new Error("This parcel has already been handed over.");
      if (c.product !== o.product || c.unit !== product(o.product).unit)
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
      o.actual = num("actual");
      o.packer = str("pic");
      o.labelPic = str("labelPic");
      log(
        o.id,
        "Parcel quantity declared",
        o.actual +
          " " +
          product(o.product).unit +
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
    s.notes.length > 200
  )
    throw new Error(
      "The test workspace is full. Export your review and reset the sample data.",
    );
  return s;
}
