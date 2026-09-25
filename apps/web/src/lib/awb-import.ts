import type { Draft, Order } from "./draft";

export const channels = ["Luxana", "Shopee", "TikTok", "Lazada"];
export const couriers = ["Ninja Van", "SPX", "J&T", "LEX", "Other"];
export const importLimit = 200;
export type PackageDefault = {
  sku: string;
  product: string;
  units: number;
  canonical: string;
};
// Owner-authorized starting values. These are snapshots, not a live Fullkit sync.
export const packageDefaults: PackageDefault[] = [
  ...[
    ["cave01", 1, "PK1"],
    ["cave02", 2, "PK2"],
    ["cave04", 4, "PK31"],
    ["3free3mycaver", 6, "PK33"],
    ["cave01sg", 1, "SG-PK1"],
    ["cave02sg", 2, "SG-PK2"],
    ["cave04sg", 4, "SG-PK4"],
    ["3free3caver", 6, "SG-PK33"],
  ].map(([sku, units, key]) => ({
    sku: String(sku),
    product: "cav",
    units: Number(units),
    canonical: `CAV-${String(key).startsWith("SG-") ? key : `MY-${key}`}`,
  })),
  ...[
    ["glycoxil01", 1, "PK1"],
    ["glycoxil02", 2, "PK2"],
    ["glycoxil05", 5, "PK32"],
  ].map(([sku, units, key]) => ({
    sku: String(sku),
    product: "gly",
    units: Number(units),
    canonical: `GLY-MY-${key}`,
  })),
  ...[
    ["lip01", 1],
    ["lip01n", 1],
    ["lip02", 2],
    ["lip03", 3],
    ["lip04", 6],
    ["lip08", 8],
    ["lip02sg", 2],
    ["lip03sg", 3],
    ["lip06sg", 6],
    ["lip08sg", 8],
  ].map(([sku, units]) => ({
    sku: String(sku),
    product: "lip",
    units: Number(units),
    canonical: `LIP-${String(sku).endsWith("sg") ? "SG" : "MY"}-${sku === "lip01n" ? "PK1N" : sku === "lip04" ? "PK42" : `PK${units}`}`,
  })),
  ...[
    ["syn01n", 1],
    ["syn02", 2],
    ["syn03", 3],
    ["syn04", 6],
    ["syn08", 8],
    ["9botol", 9],
    ["syn1nsg", 1],
    ["syn2nsg", 2],
    ["synovil03", 3],
    ["syn6nsg", 6],
    ["syn08sg", 8],
    ["9botolsg", 9],
  ].map(([sku, units]) => ({
    sku: String(sku),
    product: "syn",
    units: Number(units),
    canonical: `SYN-${String(sku).endsWith("sg") || sku === "synovil03" ? "SG" : "MY"}-${sku === "syn01n" || sku === "syn1nsg" ? "PK1N" : sku === "syn2nsg" ? "PK2N" : sku === "syn6nsg" ? "PK6N" : sku === "syn04" ? "PK42" : `PK${units}`}`,
  })),
  ...[
    ["adipocyde1", 1],
    ["adipocyde2", 2],
    ["adipocyde3", 3],
    ["adipocyde6", 6],
    ["adipocyde8", 8],
    ["adiposg2", 2],
    ["adiposg3", 3],
    ["adiposg6", 6],
    ["adiposg8", 8],
  ].map(([sku, units]) => ({
    sku: String(sku),
    product: "ady",
    units: Number(units),
    canonical: `ADI-${String(sku).startsWith("adiposg") ? "SG" : "MY"}-${sku === "adipocyde6" ? "PK42" : `PK${units}`}`,
  })),
];
export type ImportLine = {
  sku: string;
  product: string;
  packages: number | null;
  units: number | null;
  originalUnits: number | null;
  canonical: string;
};
export type SourcePage = {
  file: string;
  page: number;
  method: "text" | "ocr" | "manual";
};
export type ImportRow = {
  id: string;
  awb: string;
  orderRef: string;
  channel: string;
  store: string;
  courier: string;
  lines: ImportLine[];
  sources: SourcePage[];
  warnings: string[];
  reviewed: boolean;
  reviewNote: string;
  excluded: boolean;
  releasedOrderId?: string;
  original: string;
};
export type ImportFile = {
  id: string;
  name: string;
  path: string;
  pages: number;
  size: number;
};
export type AwbImport = {
  id: string;
  date: string;
  name: string;
  files: ImportFile[];
  rows: ImportRow[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  receivedAt?: string;
  receivedBy?: string;
};
export type ParsedPage = {
  file: string;
  page: number;
  text: string;
  method: "text" | "ocr";
  error?: string;
};
export const normalizeAwb = (value: string) =>
  value.trim().toUpperCase().replace(/\s+/g, "");
export function defaultFor(sku: string) {
  return packageDefaults.find((p) => p.sku === sku.trim().toLowerCase());
}
const productIds = ["cav", "gly", "lip", "syn", "ady"];
const whole = (n: unknown, min = 1): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= 1000000;
const refPattern =
  /(?:Order\s*(?:ID|No\.?|Number)?\s*[:#]|O\/N\s*:)\s*#?\s*([A-Z0-9-]+)/gi;

export function parsePages(
  pages: ParsedPage[],
  channel: string,
  store: string,
): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const page of pages) {
    const text = page.text.replace(/\r/g, "");
    const upper = text.toUpperCase();
    const orderRefs = [
      ...new Set([...text.matchAll(refPattern)].map((m) => m[1].toUpperCase())),
    ];
    const tracking = [
      ...new Set(
        upper.match(
          /\b(?:NVMY[A-Z0-9]{7,30}|SPXMY[A-Z0-9]{7,25}|SG\d{9,18}[A-Z]?|MYMP[A-Z0-9]{7,25})\b/g,
        ) ?? [],
      ),
    ];
    const explicit = [
      ...text.matchAll(
        /(?:AWB|Tracking\s*(?:Number|No\.?)?)\s*[:#]\s*([A-Z0-9-]{6,40})/gi,
      ),
    ].map((m) => normalizeAwb(m[1]));
    explicit.forEach((a) => {
      if (!tracking.includes(a)) tracking.push(a);
    });
    if (/J\s*&\s*T/i.test(text)) {
      const nums = upper.match(/\b\d{12,15}\b/g) ?? [];
      nums
        .filter((n) => !orderRefs.includes(n))
        .forEach((n) => {
          if (!tracking.includes(n)) tracking.push(n);
        });
    }
    const detectedChannel = /TIKTOK/i.test(text)
      ? "TikTok"
      : /LAZADA|\bLEX\b/i.test(text)
        ? "Lazada"
        : /SHOPEE|SPX/i.test(text)
          ? "Shopee"
          : /NINJA|NVMY/i.test(text)
            ? "Luxana"
            : channel;
    const courier = /NINJA|NVMY/i.test(text)
      ? "Ninja Van"
      : /SPX/i.test(text)
        ? "SPX"
        : /J\s*&\s*T/i.test(text)
          ? "J&T"
          : /\bLEX\b|MYMP/i.test(text)
            ? "LEX"
            : "";
    const lines: ImportLine[] = [];
    const warnings: string[] = [];
    const rawLines = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    // Only known aliases or explicit SKU fields; product names alone never choose a recipe.
    const tokens =
      text.match(
        /\b[a-z][a-z0-9_-]*\d[a-z0-9_-]*\b|\b[39](?:botol|free3)[a-z]*\b/gi,
      ) ?? [];
    const skus = [
      ...new Set(
        tokens.filter((s) => defaultFor(s)).map((s) => s.toLowerCase()),
      ),
    ];
    const declared = [
      ...text.matchAll(/(?:Seller\s+SKU|SKU)\s*:\s*([a-z0-9_-]+)/gi),
    ].map((m) => m[1].toLowerCase());
    const bracketSkus = [...text.matchAll(/\[([a-z0-9_-]+)\]/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    const tableStart = text.search(
      /Packing List|Product Name|SKU\s*\/\s*Item Description/i,
    );
    const tableSkus =
      tableStart < 0
        ? []
        : (
            text
              .slice(tableStart)
              .match(/\b[a-z][a-z0-9_-]*\d[a-z0-9_-]*\b/gi) ?? []
          )
            .filter(
              (s) =>
                !orderRefs.includes(s.toUpperCase()) &&
                !tracking.includes(s.toUpperCase()),
            )
            .map((s) => s.toLowerCase());
    [...declared, ...bracketSkus, ...tableSkus].forEach((s) => {
      if (!skus.includes(s)) skus.push(s);
    });
    for (const sku of skus) {
      const def = defaultFor(sku);
      const positions = rawLines
        .map((line, i) => (new RegExp(`\\b${sku}\\b`, "i").test(line) ? i : -1))
        .filter((i) => i >= 0);
      if (positions.length > 1)
        warnings.push(
          "Repeated SKU entries: check the combined package quantity",
        );
      const candidates = new Set<number>();
      for (const pos of positions) {
        const line = rawLines[pos];
        const prefix = line.match(/^\s*(\d+)\s*[x×]\s/i);
        if (prefix) candidates.add(Number(prefix[1]));
        const explicitQty = line.match(
          /\b(?:Qty|Quantity|Item Count)\s*:\s*(\d+)\b/i,
        );
        if (explicitQty) candidates.add(Number(explicitQty[1]));
        // Tables: use the right-most integer before two decimal prices, never a variation number.
        const prices = line.match(/\s(\d+)\s+\d+\.\d{2}\s+\d+\.\d{2}\s*$/);
        if (prices) candidates.add(Number(prices[1]));
        const tail = line
          .slice(line.toLowerCase().lastIndexOf(sku) + sku.length)
          .trim();
        if (/^\d+$/.test(tail)) candidates.add(Number(tail));
      }
      if (skus.length === 1 && !candidates.size) {
        const q = text.match(/\b(?:Qty\s*Total|Quantity|Qty)\s*:\s*(\d+)\b/i);
        if (q) candidates.add(Number(q[1]));
        // LEX prints a SKU and its quantity on a separate table row.
        if (courier === "LEX") {
          const p = positions[0];
          if (p !== undefined && /^\d+$/.test(rawLines[p + 1] ?? ""))
            candidates.add(Number(rawLines[p + 1]));
        }
      }
      const packages = candidates.size === 1 ? [...candidates][0] : null;
      if (candidates.size > 1) warnings.push("Conflicting package quantities");
      lines.push({
        sku,
        product: def?.product ?? "",
        packages,
        units: def?.units ?? null,
        originalUnits: def?.units ?? null,
        canonical: def?.canonical ?? "Manual mapping",
      });
    }
    if (page.error) warnings.push(page.error);
    if (page.method === "ocr")
      warnings.push("Check OCR transcription against the PDF");
    if (tracking.length > 1 || orderRefs.length > 1)
      warnings.push(
        "Multiple labels on this page: check each parcel's contents",
      );
    if (/free\s*gift|tumbler|hadiah/i.test(text))
      warnings.push(
        "Check gift contents; add any gift as a separate supported item before release",
      );
    const refs = tracking.length ? tracking : [""];
    for (const awb of refs) {
      const row: ImportRow = {
        id: crypto.randomUUID(),
        awb,
        orderRef: orderRefs.length === 1 ? orderRefs[0] : "",
        channel: detectedChannel,
        store,
        courier,
        lines: tracking.length > 1 || orderRefs.length > 1 ? [] : lines,
        sources: [{ file: page.file, page: page.page, method: page.method }],
        warnings: [...warnings],
        reviewed: false,
        reviewNote: "",
        excluded: false,
        original: "",
      };
      row.original = JSON.stringify({
        awb: row.awb,
        orderRef: row.orderRef,
        lines: row.lines,
      });
      rows.push(row);
    }
  }
  // Link a separate packing list only when its order reference has exactly one candidate AWB.
  for (const row of rows.filter(
    (r) => !r.awb && r.orderRef && r.lines.length,
  )) {
    const matches = rows.filter(
      (r) =>
        r.awb &&
        r.orderRef === row.orderRef &&
        r.store === row.store &&
        (r.channel === row.channel ||
          r.sources.some((s) => row.sources.some((p) => p.file === s.file))),
    );
    const awbs = new Set(matches.map((r) => r.awb));
    if (awbs.size === 1) {
      const target = matches[0];
      if (!target.lines.length) {
        target.lines = row.lines;
        target.warnings.push(...row.warnings);
      } else if (lineSignature(target.lines) !== lineSignature(row.lines)) {
        target.warnings.push("Label and packing list disagree");
        continue;
      }
      target.sources.push(...row.sources);
      row.excluded = true;
      row.reviewNote = "Linked packing list";
      target.original = JSON.stringify({
        awb: target.awb,
        orderRef: target.orderRef,
        lines: target.lines,
      });
    }
  }
  return rows;
}
export const lineSignature = (lines: ImportLine[]) =>
  JSON.stringify(
    lines
      .map((l) => [l.sku.toLowerCase(), l.product, l.packages, l.units])
      .sort((a, b) => String(a).localeCompare(String(b))),
  );
export function rowProblems(row: ImportRow): string[] {
  const problems: string[] = [];
  if (!/^[A-Z0-9-]{6,40}$/.test(normalizeAwb(row.awb)))
    problems.push("AWB required");
  if (!row.orderRef.trim()) problems.push("Order reference required");
  if (!channels.includes(row.channel) || !row.store.trim())
    problems.push("Source and store required");
  if (!couriers.includes(row.courier)) problems.push("Courier required");
  if (!row.lines.length) problems.push("Product details missing");
  if (new Set(row.lines.map((l) => l.product)).size > 1)
    problems.push(
      "Each brand needs its own parcel and actual AWB. Keep one product here and use Add missed label for the other parcel.",
    );
  if (
    row.lines.some(
      (l) =>
        !productIds.includes(l.product) ||
        !l.sku.trim() ||
        !whole(l.packages) ||
        !whole(l.units) ||
        Number(l.packages) * Number(l.units) > 1000000,
    )
  )
    problems.push("Complete product, SKU and package quantities");
  if (row.warnings.length && !row.reviewed) problems.push(...row.warnings);
  if (row.warnings.some((w) => w.includes("gift contents")))
    problems.push(
      "Non-product gifts need a supported item mapping; keep this label pending or exclude it for now",
    );
  return problems;
}
function contents(lines: ImportLine[]) {
  const totals: Record<string, number> = {};
  for (const l of lines)
    totals[l.product] =
      (totals[l.product] ?? 0) + Number(l.packages) * Number(l.units);
  return JSON.stringify(Object.entries(totals).sort());
}
export function rowStatus(
  row: ImportRow,
  batch: AwbImport,
  state: Draft,
): "released" | "excluded" | "review" | "duplicate" | "conflict" | "ready" {
  if (row.releasedOrderId) return "released";
  if (row.excluded) return "excluded";
  if (rowProblems(row).length) return "review";
  const key = normalizeAwb(row.awb);
  const existing = state.orders.find((o) => normalizeAwb(o.awb) === key);
  if (existing) {
    const lines = existing.lines ?? [
      { product: existing.product, expected: existing.expected },
    ];
    const same =
      JSON.stringify(lines.map((l) => [l.product, l.expected]).sort()) ===
      contents(row.lines);
    return same &&
      existing.channel === row.channel &&
      (!existing.courier || existing.courier === row.courier) &&
      (!existing.orderRef || existing.orderRef === row.orderRef) &&
      (!existing.store || existing.store === row.store)
      ? "duplicate"
      : "conflict";
  }
  const peers = batch.rows.filter(
    (r) => !r.excluded && normalizeAwb(r.awb) === key,
  );
  if (
    peers.some(
      (r) =>
        lineSignature(r.lines) !== lineSignature(row.lines) ||
        r.orderRef !== row.orderRef ||
        r.store !== row.store ||
        r.courier !== row.courier ||
        r.channel !== row.channel,
    )
  )
    return "conflict";
  if (peers[0]?.id !== row.id) return "duplicate";
  const split =
    batch.rows.some(
      (r) =>
        r.id !== row.id &&
        !r.excluded &&
        r.orderRef === row.orderRef &&
        r.store === row.store &&
        r.channel === row.channel &&
        normalizeAwb(r.awb) !== key,
    ) ||
    state.orders.some(
      (o) =>
        o.orderRef === row.orderRef &&
        o.store === row.store &&
        o.channel === row.channel &&
        normalizeAwb(o.awb) !== key,
    );
  if (split && !row.reviewed) return "review";
  return "ready";
}

// Revalidate all client input before accepting a saved draft or release.
export function validateImport(value: unknown): AwbImport {
  if (!value || typeof value !== "object") throw new Error("Invalid import.");
  const b = value as AwbImport;
  const text = (v: unknown, max = 200) =>
    typeof v === "string" && v.length <= max;
  if (
    !text(b.id, 80) ||
    !b.id ||
    !text(b.name) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
    !Array.isArray(b.files) ||
    b.files.length > 10 ||
    !Array.isArray(b.rows) ||
    b.rows.length > importLimit
  )
    throw new Error("Use up to 10 PDFs and 200 labels per batch.");
  if (
    new Set(b.files.map((f) => f.id)).size !== b.files.length ||
    new Set(b.rows.map((r) => r.id)).size !== b.rows.length
  )
    throw new Error("Duplicate import record identifiers.");
  for (const f of b.files)
    if (
      !text(f.id, 80) ||
      !text(f.name) ||
      !text(f.path, 200) ||
      !whole(f.pages) ||
      f.pages > 200 ||
      !whole(f.size) ||
      f.size > 20 * 1024 * 1024
    )
      throw new Error("Invalid source file.");
  for (const r of b.rows) {
    if (
      !r ||
      ![r.id, r.awb, r.orderRef, r.channel, r.store, r.courier].every((x) =>
        text(x),
      ) ||
      !text(r.reviewNote, 1000) ||
      !text(r.original, 10000) ||
      typeof r.excluded !== "boolean" ||
      typeof r.reviewed !== "boolean" ||
      !Array.isArray(r.lines) ||
      r.lines.length > 20 ||
      !Array.isArray(r.sources) ||
      r.sources.length > 200 ||
      !r.sources.length ||
      !Array.isArray(r.warnings) ||
      r.warnings.length > 20 ||
      r.warnings.some((w) => !text(w, 200))
    )
      throw new Error("Invalid label record.");
    if (
      r.sources.some(
        (s) =>
          !b.files.some(
            (f) => f.id === s.file && whole(s.page) && s.page <= f.pages,
          ) || !["text", "ocr", "manual"].includes(s.method),
      )
    )
      throw new Error("Invalid source page.");
    if (
      r.lines.some(
        (l) =>
          !l ||
          !text(l.sku) ||
          !text(l.product) ||
          !text(l.canonical) ||
          ![l.packages, l.units, l.originalUnits].every(
            (n) => n === null || whole(n, 0),
          ),
      )
    )
      throw new Error("Invalid product line.");
    if ((r.reviewed || r.excluded) && !r.reviewNote.trim())
      throw new Error("Explain a reviewed or excluded label.");
  }
  return structuredClone(b);
}
export function applyImportCommand(
  state: Draft,
  type: string,
  input: Record<string, unknown>,
  role: string,
  at: string,
) {
  state.awbImports ??= [];
  if (type === "import-save") {
    if (role !== "admin") throw new Error("Use the office admin role.");
    const batch = validateImport(input.batch);
    const old = state.awbImports.find((b) => b.id === batch.id);
    if (old?.confirmedAt)
      throw new Error(
        "Released batches cannot be edited. Make a new handoff for remaining labels.",
      );
    if (old && old.updatedAt !== batch.updatedAt)
      throw new Error(
        "A teammate updated this PDF review. Reopen the batch before saving.",
      );
    batch.createdAt = old?.createdAt ?? at;
    batch.updatedAt = at;
    delete batch.confirmedAt;
    delete batch.receivedAt;
    delete batch.receivedBy;
    for (const row of batch.rows) {
      delete row.releasedOrderId;
      const previous = old?.rows.find((r) => r.id === row.id);
      if (previous) row.original = previous.original;
    }
    if (old) state.awbImports[state.awbImports.indexOf(old)] = batch;
    else state.awbImports.unshift(batch);
    return `Saved ${batch.rows.length} label records for review`;
  }
  const batch = state.awbImports.find((b) => b.id === input.id);
  if (!batch) throw new Error("Upload batch not found.");
  if (type === "import-receive") {
    if (role !== "outbound" || !batch.confirmedAt || batch.receivedAt)
      throw new Error("Only stock-out can acknowledge a released batch once.");
    if (
      typeof input.pic !== "string" ||
      !input.pic.trim() ||
      input.pic.length > 100
    )
      throw new Error("Choose the receiving PIC.");
    batch.receivedAt = at;
    batch.receivedBy = input.pic.trim();
    return "Handoff received · " + batch.receivedBy;
  }
  if (role !== "admin") throw new Error("Use the office admin role.");
  if (type !== "import-release") throw new Error("Unknown import action.");
  if (batch.confirmedAt) throw new Error("This handoff is already confirmed.");
  const ready = batch.rows.filter(
    (r) => rowStatus(r, batch, state) === "ready",
  );
  const unresolved = batch.rows.filter((r) =>
    ["review", "conflict"].includes(rowStatus(r, batch, state)),
  );
  if (unresolved.length)
    throw new Error(
      "Resolve or explicitly exclude the flagged labels before confirming.",
    );
  if (!ready.length) throw new Error("No new complete labels to release.");
  for (const row of ready) {
    const byProduct = new Map<string, number>();
    row.lines.forEach((l) =>
      byProduct.set(
        l.product,
        (byProduct.get(l.product) ?? 0) + Number(l.packages) * Number(l.units),
      ),
    );
    const lines = [...byProduct].map(([product, expected]) => ({
      product,
      expected,
      originalExpected: expected,
      actual: null,
    }));
    const order: Order = {
      id: crypto.randomUUID(),
      awb: normalizeAwb(row.awb),
      channel: row.channel,
      store: row.store,
      orderRef: row.orderRef,
      courier: row.courier,
      importId: batch.id,
      importRowId: row.id,
      product: lines[0].product,
      package: row.lines
        .map((l) => `${l.packages} × ${l.sku} (${l.units})`)
        .join(" · "),
      expected: lines.reduce((sum, l) => sum + l.expected, 0),
      originalExpected: lines.reduce((sum, l) => sum + l.expected, 0),
      lines,
      actual: null,
      packer: "",
      labelPic: "",
      printed: false,
      dispatched: false,
      handoverRef: "",
      date: batch.date,
      note: "",
    };
    state.orders.unshift(order);
    row.releasedOrderId = order.id;
    state.events.unshift({
      id: crypto.randomUUID(),
      entity: order.id,
      action: "AWB imported",
      detail: `${order.awb} · ${batch.name} · ${row.sources.map((s) => `PDF page ${s.page}`).join(", ")} · ${order.package}`,
      actor: "Office admin (test view)",
      at,
    });
  }
  batch.confirmedAt = at;
  batch.updatedAt = at;
  return `Handoff confirmed · ${ready.length} new AWBs · no print, packing or stock movement inferred`;
}
