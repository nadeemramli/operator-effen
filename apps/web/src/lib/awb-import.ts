import type { Draft, Order, Recorder } from "./draft";

export const channels = ["Luxana", "Shopee", "TikTok", "Lazada"];
export const couriers = ["Ninja Van", "SPX", "J&T", "LEX", "Other"];
/** Label records one upload may hold (released AWBs are counted in the workspace ceiling). */
export const importLimit = 300;
/** PDF pages one upload may hold across its files, read in the browser before review. */
export const pageLimit = 600;
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
    // Singapore (Luxana website) packages; owner confirmed the box counts.
    ["gly01sg", 1, "PK1"],
    ["gly02sg", 2, "PK2"],
    ["gly05sg", 5, "PK32"],
  ].map(([sku, units, key]) => ({
    sku: String(sku),
    product: "gly",
    units: Number(units),
    canonical: `GLY-${String(sku).endsWith("sg") ? "SG" : "MY"}-${key}`,
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
    // TikTok prints the 1-pack as syn01; owner confirmed it is the same package as syn01n.
    ["syn01", 1],
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
    canonical: `SYN-${String(sku).endsWith("sg") || sku === "synovil03" ? "SG" : "MY"}-${sku === "syn01n" || sku === "syn01" || sku === "syn1nsg" ? "PK1N" : sku === "syn2nsg" ? "PK2N" : sku === "syn6nsg" ? "PK6N" : sku === "syn04" ? "PK42" : `PK${units}`}`,
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
  /** Blocking until the row is reviewed: something on the label needs a decision. */
  warnings: string[];
  /** Informational only, never blocking (for example "Read by OCR — compare with the PDF"). */
  notes?: string[];
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
  /** Pages with no tracking number, order reference or known SKU (cover, title, separator). */
  skippedPages?: number[];
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
  /**
   * Set on upload-list entries sent without their label rows (operational sites keep
   * uploads in their own table); the screen fetches the rows when the upload is opened.
   */
  rowCount?: number;
  releasedCount?: number;
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
/** The market a package is sold in: Malaysia, or Singapore (the Luxana SG website). */
export type SkuMarket = "MY" | "SG";
export const skuMarkets: readonly SkuMarket[] = ["MY", "SG"];
/**
 * A record in the site's package SKU catalogue (Package SKUs), kept in `Draft.skuAliases`.
 * Either a SKU the built-in `packageDefaults` do not know (origin "custom"), or the office
 * admin's override of a built-in SKU (origin "built-in": same SKU, edited or retired). A
 * record is kept for good: a SKU no longer in use is retired, never deleted, so the audit
 * trail and earlier imports still explain themselves.
 */
export type SkuAlias = {
  id: string;
  /** Lower-case and trimmed; unique among the records. */
  sku: string;
  /**
   * Display name ("Cavernosil Pakej 3 Free 1"). Absent on records saved before the
   * catalogue existed; read through `packageCatalog`, which fills in the default.
   */
  name?: string;
  /** Absent on records saved before the catalogue existed; defaulted from the SKU. */
  market?: SkuMarket;
  /** Whether the record overrides a built-in SKU; the catalogue derives it from the SKU. */
  origin?: "built-in" | "custom";
  product: string;
  units: number;
  canonical: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: {
    kind: "created" | "edited" | "retired" | "reactivated";
    at: string;
    changes: Record<string, [string, string]>;
    reason?: string;
    recordedBy?: Recorder;
  }[];
};
/** Catalogue records one site may hold (custom SKUs and built-in overrides together). */
export const skuAliasLimit = 500;
const productLabels: Record<string, string> = {
  cav: "Cavernosil",
  gly: "Glycoxil",
  lip: "Lipidri",
  syn: "Synovil",
  nur: "Nurokids",
  ady: "Adypocide",
};
const normSku = (sku: string) => sku.trim().toLowerCase();
const seedFor = (sku: string) =>
  packageDefaults.find((p) => p.sku === normSku(sku));
/**
 * The market a package is sold in when no one chose it: Singapore when its package code
 * carries an SG segment (CAV-SG-PK1, SG-PK4) or its SKU ends in "sg" (with an optional
 * number, as in adiposg2) or has an "sg" part (lip-sg-8); otherwise Malaysia.
 */
export function marketFor(sku: string, canonical = ""): SkuMarket {
  const s = normSku(sku);
  return /(?:^|[-_ ])SG(?:[-_ ]|$)/i.test(canonical.trim()) ||
    /sg\d*$/.test(s) ||
    /(?:^|[-_])sg(?:[-_]|$)/.test(s)
    ? "SG"
    : "MY";
}
/**
 * The display name a package gets when no one named it: the product, "SG" for Singapore
 * and the package code without its product and market parts. A code that adds up to the
 * units reads as the shop names it: PK31 for 4 units is "Pakej 3 Free 1", PK2 for 2 units
 * is "Pakej 2". Without a package code of its own, "<Product> · <sku>".
 */
export function defaultPackageName(entry: {
  sku: string;
  product: string;
  units: number;
  canonical: string;
  market?: SkuMarket;
}): string {
  const product = productLabels[entry.product] ?? entry.product.toUpperCase();
  const sku = normSku(entry.sku);
  const canonical = entry.canonical.trim();
  if (!canonical || canonical.toLowerCase() === sku) return `${product} · ${sku}`;
  const market = entry.market ?? marketFor(sku, canonical);
  const code = canonical
    .toUpperCase()
    .split("-")
    .filter((part, i, all) => !(i === 0 && all.length > 1) && part !== "MY" && part !== "SG")
    .join("-");
  const pk = code.match(/^PK(\d)(\d)$/);
  const single = code.match(/^PK(\d+)([A-Z]*)$/);
  const pakej =
    pk && Number(pk[1]) + Number(pk[2]) === entry.units
      ? `Pakej ${pk[1]} Free ${pk[2]}`
      : single && Number(single[1]) === entry.units
        ? `Pakej ${single[1]}${single[2]}`
        : code || canonical;
  return `${product}${market === "SG" ? " SG" : ""} ${pakej}`;
}
/** One SKU in the merged package catalogue: the built-in seed with the site's records on top. */
export type CatalogEntry = {
  sku: string;
  name: string;
  product: string;
  market: SkuMarket;
  units: number;
  canonical: string;
  active: boolean;
  /** "built-in" when the SKU is in `packageDefaults` (edited or not), else "custom". */
  origin: "built-in" | "custom";
  /** The built-in starting values, for a built-in SKU. */
  seed?: PackageDefault;
  /** The site's record (custom SKU, or override of a built-in), when there is one. */
  id?: string;
  /** The record's version; 0 for a built-in SKU nobody has changed yet. */
  version: number;
  history: SkuAlias["history"];
  createdAt?: string;
  updatedAt?: string;
};
/**
 * The site's record for a SKU: the active one first (records are unique per SKU, but a
 * stray duplicate must never hide an active SKU), else the most recently updated.
 */
function recordFor(sku: string, aliases?: readonly SkuAlias[]) {
  const key = normSku(sku);
  let found: SkuAlias | undefined;
  for (const a of aliases ?? []) {
    if (a.sku !== key) continue;
    if (
      !found ||
      (a.active && !found.active) ||
      (a.active === found.active && a.updatedAt > found.updatedAt)
    )
      found = a;
  }
  return found;
}
function entryFrom(
  sku: string,
  seed: PackageDefault | undefined,
  record: SkuAlias | undefined,
): CatalogEntry {
  const base = record ?? seed!;
  const market = record?.market ?? marketFor(sku, base.canonical);
  return {
    sku,
    name:
      record?.name?.trim() ||
      defaultPackageName({ ...base, sku, market }),
    product: base.product,
    market,
    units: base.units,
    canonical: base.canonical,
    active: record ? record.active : true,
    origin: seed ? "built-in" : "custom",
    ...(seed ? { seed } : {}),
    ...(record
      ? {
          id: record.id,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      : {}),
    version: record?.version ?? 0,
    history: record?.history ?? [],
  };
}
/**
 * The package SKU catalogue: exactly one entry per SKU. Built-in SKUs (`packageDefaults`,
 * the seed) come first in seed order; a site record with the same SKU overrides the
 * built-in (edited values, or retired). Then the site's own SKUs, by SKU.
 */
export function packageCatalog(
  source?: readonly SkuAlias[] | { skuAliases?: readonly SkuAlias[] },
): CatalogEntry[] {
  const aliases = Array.isArray(source)
    ? (source as readonly SkuAlias[])
    : ((source as { skuAliases?: readonly SkuAlias[] } | undefined)
        ?.skuAliases ?? []);
  const entries = packageDefaults.map((seed) =>
    entryFrom(seed.sku, seed, recordFor(seed.sku, aliases)),
  );
  const seen = new Set(packageDefaults.map((p) => p.sku));
  const custom = [...new Set(aliases.map((a) => a.sku))]
    .filter((sku) => !seen.has(sku))
    .sort((a, b) => a.localeCompare(b));
  for (const sku of custom)
    entries.push(entryFrom(sku, undefined, recordFor(sku, aliases)));
  return entries;
}
/** A catalogue section: one product in one market ("Cavernosil", "Cavernosil SG"). */
export type CatalogSection = {
  key: string;
  product: string;
  market: SkuMarket;
  title: string;
  entries: CatalogEntry[];
};
/** Catalogue entries grouped by product and market, in product order, Malaysia first. */
export function catalogSections(entries: readonly CatalogEntry[]): CatalogSection[] {
  const sections = new Map<string, CatalogSection>();
  for (const e of entries) {
    const key = `${e.product}:${e.market}`;
    let section = sections.get(key);
    if (!section) {
      const name = productLabels[e.product] ?? e.product.toUpperCase();
      section = {
        key,
        product: e.product,
        market: e.market,
        title: e.market === "SG" ? `${name} SG` : name,
        entries: [],
      };
      sections.set(key, section);
    }
    section.entries.push(e);
  }
  const rank = (s: CatalogSection) => {
    const i = productIds.indexOf(s.product);
    return (i < 0 ? productIds.length : i) * 2 + (s.market === "SG" ? 1 : 0);
  };
  return [...sections.values()].sort(
    (a, b) => rank(a) - rank(b) || a.product.localeCompare(b.product),
  );
}
/**
 * The package a SKU stands for, through the catalogue: the site's record for the SKU when
 * there is one (active: its values; retired: nothing, even for a built-in SKU), otherwise
 * the built-in default. Retired and unknown SKUs give undefined.
 */
export function defaultFor(
  sku: string,
  aliases?: readonly SkuAlias[],
): PackageDefault | undefined {
  const record = recordFor(sku, aliases);
  if (!record) return seedFor(sku);
  return record.active
    ? {
        sku: record.sku,
        product: record.product,
        units: record.units,
        canonical: record.canonical,
      }
    : undefined;
}
/** Whether the catalogue knows a SKU but it is retired (it then resolves to nothing). */
export const isRetiredSku = (sku: string, aliases?: readonly SkuAlias[]) =>
  recordFor(sku, aliases)?.active === false;
const skuShape =
  /\b[a-z][a-z0-9_-]*\d[a-z0-9_-]*\b|\b[39](?:botol|free3)[a-z]*\b/gi;
/**
 * SKU candidates in a text, in reading order: the built-in SKU shapes plus the exact text
 * of every SKU the site's catalogue records (a custom SKU need not look like a built-in
 * one; a retired one is still found, so the label shows it for review).
 */
function skuTokens(text: string, aliases?: readonly SkuAlias[]) {
  const mapped = [
    ...new Set(
      (aliases ?? [])
        .filter((a) => skuAliasProblem(a.sku) === null)
        .map((a) => a.sku),
    ),
  ].sort((a, b) => b.length - a.length);
  const pattern = mapped.length
    ? new RegExp(`\\b(?:${mapped.join("|")})\\b|${skuShape.source}`, "gi")
    : skuShape;
  return text.match(pattern) ?? [];
}
const productIds = ["cav", "gly", "lip", "syn", "nur", "ady"];
// Product names alone never choose a package, so they cannot become a mapped SKU either.
const productWords = [
  ...productIds,
  "cavernosil",
  "glycoxil",
  "lipidri",
  "synovil",
  "nurokids",
  "adypocide",
  "adipocyde",
];
/**
 * Why a SKU cannot be mapped, or null. A mapped SKU is found anywhere in a label's text,
 * so it must be distinctive: 3 to 40 letters, digits, "-" or "_", starting and ending
 * with a letter or digit, with at least one letter, and never a product name.
 */
export function skuAliasProblem(raw: string): string | null {
  const sku = raw.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(sku))
    return "Use only letters, digits, - or _ in the SKU.";
  if (sku.length < 3 || sku.length > 40)
    return "Use a SKU of 3 to 40 characters.";
  if (!/^[a-z0-9](?:.*[a-z0-9])?$/.test(sku) || !/[a-z]/.test(sku))
    return "Start and end the SKU with a letter or digit, and include a letter.";
  if (productWords.includes(sku))
    return "A product name is not a package SKU. Use the SKU printed on the label.";
  return null;
}
const whole = (n: unknown, min = 1): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= 1000000;
// Ninja Van orders keyed in by hand print a "Reference" instead of an order number.
const refPattern =
  /(?:Order\s*(?:ID|No\.?|Number)?\s*[:#]|O\/N\s*:|Ref(?:erence)?\s*(?:No\.?|Number)?\s*[:#])\s*#?\s*([A-Z0-9-]+)/gi;

/**
 * The references a page's text carries: tracking numbers (AWBs), order references and
 * SKU tokens with a known package mapping. Shared by the OCR decision and the parser.
 */
export function detectReferences(raw: string, aliases?: readonly SkuAlias[]) {
  const text = raw.replace(/\r/g, "");
  const upper = text.toUpperCase();
  const orderRefs = [
    ...new Set([...text.matchAll(refPattern)].map((m) => m[1].toUpperCase())),
  ];
  const tracking = [
    ...new Set(
      upper.match(
        // SPX also prints its number as MY + digits, with or without a trailing letter
        // (MY263140741048F, MY2660933987983).
        /\b(?:NVMY[A-Z0-9]{7,30}|SPXMY[A-Z0-9]{7,25}|SPXSG[A-Z0-9]{7,25}|MY\d{10,14}[A-Z]?|SG\d{9,18}[A-Z]?|MYMP[A-Z0-9]{7,25})\b/g,
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
  // TikTok labels print a bare tracking number with no courier name, repeated along the
  // barcode and the label edges; an order reference or phone number appears only once.
  const counts = new Map<string, number>();
  for (const n of upper.match(/\b\d{12,18}\b/g) ?? [])
    counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [n, c] of counts)
    if (c >= 3 && !orderRefs.includes(n) && !tracking.includes(n))
      tracking.push(n);
  if (/J\s*&\s*T/i.test(text)) {
    const nums = upper.match(/\b\d{12,15}\b/g) ?? [];
    nums
      .filter((n) => !orderRefs.includes(n))
      .forEach((n) => {
        if (!tracking.includes(n)) tracking.push(n);
      });
  }
  const knownSkus = [
    ...new Set(
      skuTokens(text, aliases)
        .filter((s) => defaultFor(s, aliases))
        .map((s) => s.toLowerCase()),
    ),
  ];
  return { orderRefs, tracking, knownSkus };
}
/**
 * OCR is automatic: a page is read by OCR when its extracted text yields no AWB and no
 * order reference (image labels often carry a little real text, such as a store name).
 * `force` reads every page by OCR (the slow fallback).
 */
export function needsOcr(text: string, force = false) {
  if (force) return true;
  const { tracking, orderRefs } = detectReferences(text);
  return !tracking.length && !orderRefs.length;
}
/**
 * Pages whose text has an order reference but no tracking number anywhere in the file:
 * the label part is an image (common on Shopee and TikTok prints), so OCR reads it. A
 * packing list whose order reference has a tracking number on another page is left alone.
 */
export function pagesNeedingAwbOcr(
  pages: { page: number; text: string; method: string; error?: string }[],
) {
  const found = pages.map((p) => detectReferences(p.text));
  const tracked = new Set(
    found.flatMap((r) => (r.tracking.length ? r.orderRefs : [])),
  );
  return pages
    .filter(
      (p, i) =>
        p.method === "text" &&
        !p.error &&
        !found[i].tracking.length &&
        found[i].orderRefs.some((ref) => !tracked.has(ref)),
    )
    .map((p) => p.page);
}
const markers: [RegExp, string][] = [
  [/TIKTOK/i, "TikTok"],
  [/LAZADA/i, "Lazada"],
  [/SHOPEE/i, "Shopee"],
  [/NINJA/i, "Ninja Van"],
  [/J\s*&\s*T/i, "J&T"],
  [/\bLEX\b/i, "LEX"],
];
/**
 * Adds what OCR found on a page that already had readable text: its tracking numbers and
 * the courier and source names. The text layer stays the source of the order reference
 * and products, so an OCR misread cannot add a second order or product.
 */
export function mergeOcrText(textLayer: string, ocrText: string) {
  const added = [
    ...markers
      .filter(([re]) => re.test(ocrText) && !re.test(textLayer))
      .map(([, name]) => name),
    ...detectReferences(ocrText).tracking.map((t) => `Tracking: ${t}`),
  ];
  return added.length ? `${textLayer}\n${added.join("\n")}` : textLayer;
}
/** A page with no tracking number, order reference or known SKU produces no label row. */
export const isLabelPage = (
  page: ParsedPage,
  aliases?: readonly SkuAlias[],
) => {
  if (page.error) return true;
  const { tracking, orderRefs, knownSkus } = detectReferences(
    page.text,
    aliases,
  );
  return !!(tracking.length || orderRefs.length || knownSkus.length);
};
export const OCR_NOTE = "Read by OCR — compare with the PDF";
export const NO_ORDER_REF_NOTE =
  "No order reference printed; the AWB stands in as the reference";

export function parsePages(
  pages: ParsedPage[],
  channel: string,
  store: string,
  aliases?: readonly SkuAlias[],
): ImportRow[] {
  return parseImport(pages, channel, store, aliases).rows;
}
/**
 * Label rows from the pages, plus the pages skipped as non-label (cover, title, …).
 * `aliases` are the site's package SKU catalogue records (`Draft.skuAliases`), resolved
 * through the catalogue (see `defaultFor`).
 */
export function parseImport(
  pages: ParsedPage[],
  channel: string,
  store: string,
  aliases?: readonly SkuAlias[],
): { rows: ImportRow[]; skipped: { file: string; page: number }[] } {
  const lookup = (sku: string) => defaultFor(sku, aliases);
  const rows: ImportRow[] = [];
  const skipped: { file: string; page: number }[] = [];
  for (const page of pages) {
    if (!isLabelPage(page, aliases)) {
      skipped.push({ file: page.file, page: page.page });
      continue;
    }
    const text = page.text.replace(/\r/g, "");
    const { orderRefs, tracking } = detectReferences(text, aliases);
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
            : // A bare repeated tracking number (TikTok) names no courier.
              tracking.some((t) => /^\d+$/.test(t))
              ? "Other"
              : "";
    const lines: ImportLine[] = [];
    const warnings: string[] = [];
    const rawLines = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    // Only catalogue SKUs or explicit SKU fields; product names alone never choose a recipe.
    // A retired catalogue SKU stays on the label as a line without a product, so the
    // review shows it as an unknown SKU instead of silently dropping it.
    const tokens = skuTokens(text, aliases);
    const skus = [
      ...new Set(
        tokens
          .filter((s) => lookup(s) || isRetiredSku(s, aliases))
          .map((s) => s.toLowerCase()),
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
      // A parent SKU printed beside its variation ("adipocyde" with "adipocyde6") is not a product.
      if (!lookup(s) && skus.some((k) => lookup(k) && k.startsWith(s)))
        return;
      if (!skus.includes(s)) skus.push(s);
    });
    for (const sku of skus) {
      const def = lookup(sku);
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
    const notes = page.method === "ocr" ? [OCR_NOTE] : [];
    if (tracking.length > 1 || orderRefs.length > 1)
      warnings.push(
        "Multiple labels on this page: check each parcel's contents",
      );
    if (/free\s*gift|tumbler|hadiah/i.test(text))
      warnings.push(
        "Check gift contents; add any gift as a separate supported item before release",
      );
    // A Ninja Van order keyed in by hand prints no order reference at all; its AWB is
    // the only reference the parcel has, so it stands in (noted, not flagged).
    const awbAsRef =
      courier === "Ninja Van" && tracking.length === 1 && !orderRefs.length;
    if (awbAsRef) notes.push(NO_ORDER_REF_NOTE);
    const refs = tracking.length ? tracking : [""];
    for (const awb of refs) {
      const row: ImportRow = {
        id: crypto.randomUUID(),
        awb,
        orderRef: orderRefs.length === 1 ? orderRefs[0] : awbAsRef ? awb : "",
        channel: detectedChannel,
        store,
        courier,
        lines: tracking.length > 1 || orderRefs.length > 1 ? [] : lines,
        sources: [{ file: page.file, page: page.page, method: page.method }],
        warnings: [...warnings],
        ...(notes.length ? { notes: [...notes] } : {}),
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
        if (row.notes?.length)
          target.notes = [...new Set([...(target.notes ?? []), ...row.notes])];
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
  return { rows, skipped };
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
  // Store is optional: only needed where one source has several shops (TikTok).
  if (!channels.includes(row.channel)) problems.push("Source required");
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
    throw new Error(`Use up to 10 PDFs and ${importLimit} labels per batch.`);
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
      f.pages > pageLimit ||
      // Byte count, not a quantity: whole() stops at 1,000,000, so check the range here.
      !Number.isSafeInteger(f.size) ||
      f.size < 1 ||
      f.size > 20 * 1024 * 1024 ||
      (f.skippedPages !== undefined &&
        (!Array.isArray(f.skippedPages) ||
          f.skippedPages.length > pageLimit ||
          f.skippedPages.some((n) => !whole(n) || n > f.pages)))
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
      r.warnings.some((w) => !text(w, 200)) ||
      (r.notes !== undefined &&
        (!Array.isArray(r.notes) ||
          r.notes.length > 20 ||
          r.notes.some((n) => !text(n, 200))))
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
    // Excluding a label needs a reason; marking a label checked does not.
    if (r.excluded && !r.reviewNote.trim())
      throw new Error("Explain why the label is excluded.");
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
    delete batch.rowCount;
    delete batch.releasedCount;
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
  // A released batch is read-only; its raw extraction text (about a fifth of the upload's
  // bytes) is no longer reviewed. The source PDF pages stay in storage for checking.
  for (const row of batch.rows) row.original = "";
  batch.confirmedAt = at;
  batch.updatedAt = at;
  return `Handoff confirmed · ${ready.length} new AWBs · no print, packing or stock movement inferred`;
}
/**
 * The package SKU catalogue: `sku-alias-save` (a new SKU, or a change to a catalogue entry:
 * a custom SKU with its `id`, or a built-in SKU, which creates or updates its override
 * record), `sku-alias-retire` and `sku-alias-reactivate` (by `id`, or by `sku` for a
 * built-in SKU nobody has changed yet). A record is kept for good (retired, never deleted)
 * with its own history; changing an existing entry, built-in or custom, needs a reason.
 * Returns the audit entry for the caller to record.
 */
export function applySkuAliasCommand(
  state: Draft,
  type: string,
  input: Record<string, unknown>,
  at: string,
  recordedBy: Recorder,
): { entity: string; action: string; detail: string } {
  const aliases = (state.skuAliases ??= []);
  const text = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string).trim() : "";
  const reason = () => {
    const value = text("reason");
    if (!value) throw new Error("Give a reason for this change.");
    if (value.length > 500) throw new Error("Use a shorter reason.");
    return value;
  };
  const stale = () =>
    new Error(
      "This SKU was changed by someone else after you opened it. Review it and save again.",
    );
  const expected = () => {
    const raw = input.expectedVersion;
    return raw === undefined || raw === null || raw === "" ? null : Number(raw);
  };
  const describe = (e: CatalogEntry | SkuAlias) =>
    `${e.sku} · ${"name" in e && e.name ? e.name + " · " : ""}${e.product.toUpperCase()} ${e.market ?? marketFor(e.sku, e.canonical)} · ${e.units} per package · ${e.canonical}`;
  const entryOf = (record: SkuAlias) =>
    entryFrom(record.sku, seedFor(record.sku), record);
  const find = () => {
    const alias = aliases.find((a) => a.id === text("id"));
    if (!alias)
      throw new Error(
        "This package SKU could not be found. Refresh and try again.",
      );
    const version = expected();
    if (version !== null && version !== alias.version) throw stale();
    return alias;
  };
  const room = () => {
    if (aliases.length >= skuAliasLimit)
      throw new Error(
        `This site already has ${skuAliasLimit} package SKU records. Retire unused ones or ask for the SKU to become a built-in default.`,
      );
  };
  /** A new override record for a built-in SKU, starting from its catalogue values. */
  const override = (seed: PackageDefault): SkuAlias => {
    const start = entryFrom(seed.sku, seed, undefined);
    return {
      id: crypto.randomUUID(),
      sku: seed.sku,
      name: start.name,
      market: start.market,
      origin: "built-in",
      product: seed.product,
      units: seed.units,
      canonical: seed.canonical,
      active: true,
      createdAt: at,
      updatedAt: at,
      version: 0,
      history: [],
    };
  };
  if (type === "sku-alias-save") {
    const sku = text("sku").toLowerCase();
    const problem = skuAliasProblem(sku);
    if (problem) throw new Error(problem);
    const product = text("product");
    if (!productIds.includes(product))
      throw new Error("Choose the product this SKU packs.");
    const units =
      input.units === "" || input.units === null ? NaN : Number(input.units);
    if (!Number.isSafeInteger(units) || units < 1 || units > 1000)
      throw new Error(
        "Enter the units per package as a whole number from 1 to 1000.",
      );
    const label = text("canonical");
    if (label.length > 60) throw new Error("Use a shorter package label.");
    const rawName = text("name").replace(/\s+/g, " ");
    if (rawName.length > 80) throw new Error("Use a shorter display name.");
    const rawMarket = text("market").toUpperCase();
    if (rawMarket && !skuMarkets.includes(rawMarket as SkuMarket))
      throw new Error("Choose the market: MY or SG.");
    let editing = text("id") ? find() : undefined;
    const seed = seedFor(editing?.sku ?? sku);
    if (editing && editing.sku !== sku) {
      // The SKU is what a label prints, so a built-in SKU keeps it; a custom SKU cannot
      // take a built-in one (that SKU has its own entry to edit).
      if (seedFor(editing.sku))
        throw new Error(
          `${editing.sku} is a built-in package SKU and keeps its SKU. Add the new SKU as its own package and retire ${editing.sku} when labels stop printing it.`,
        );
      if (seedFor(sku))
        throw new Error(
          `${sku} is a built-in package SKU. Edit it in its own row in Package SKUs.`,
        );
    }
    const clash = aliases.find((a) => a.sku === sku && a.id !== editing?.id);
    if (clash) {
      if (!editing && seed && expected() === 0) throw stale();
      throw new Error(
        clash.active
          ? `${sku} is already in the catalogue. Edit it in Package SKUs.`
          : `${sku} is retired in the catalogue. Reactivate or edit it in Package SKUs.`,
      );
    }
    const canonical = label || seed?.canonical || sku.toUpperCase();
    // A change to an existing entry: a custom SKU, an overridden built-in, or a built-in
    // nobody has changed yet (its override record is made below).
    const before = editing
      ? entryOf(editing)
      : seed
        ? entryFrom(seed.sku, seed, undefined)
        : undefined;
    // Left blank, the market and name keep what the entry has, or are derived for a new SKU.
    const market =
      (rawMarket as SkuMarket) || before?.market || marketFor(sku, canonical);
    const name =
      rawName ||
      before?.name ||
      defaultPackageName({ sku, product, units, canonical, market });
    if (!before) {
      room();
      const alias: SkuAlias = {
        id: crypto.randomUUID(),
        sku,
        name,
        market,
        origin: "custom",
        product,
        units,
        canonical,
        active: true,
        createdAt: at,
        updatedAt: at,
        version: 1,
        history: [
          {
            kind: "created",
            at,
            changes: {
              sku: ["", sku],
              name: ["", name],
              market: ["", market],
              product: ["", product],
              units: ["", String(units)],
              canonical: ["", canonical],
            },
            recordedBy,
          },
        ],
      };
      aliases.push(alias);
      return {
        entity: "sku-alias:" + alias.id,
        action: "Package SKU added",
        detail: describe(alias),
      };
    }
    const changes: Record<string, [string, string]> = {};
    const next = { sku, name, market, product, units: String(units), canonical };
    for (const key of ["sku", "name", "market", "product", "units", "canonical"] as const)
      if (String(before[key]) !== next[key])
        changes[key] = [String(before[key]), next[key]];
    if (!Object.keys(changes).length)
      throw new Error("No package SKU details changed.");
    const why = reason();
    if (!editing) {
      room();
      editing = override(seed!);
      aliases.push(editing);
    }
    Object.assign(editing, {
      sku,
      name,
      market,
      origin: seedFor(sku) ? "built-in" : "custom",
      product,
      units,
      canonical,
      updatedAt: at,
    });
    editing.version += 1;
    editing.history.push({
      kind: "edited",
      at,
      changes,
      reason: why,
      recordedBy,
    });
    return {
      entity: "sku-alias:" + editing.id,
      action: seed ? "Built-in package SKU edited" : "Package SKU edited",
      detail:
        `${sku} · ` +
        Object.entries(changes)
          .map(([k, [a, b]]) => `${k}: ${a} → ${b}`)
          .join(" · ") +
        ` · ${why}`,
    };
  }
  if (type !== "sku-alias-retire" && type !== "sku-alias-reactivate")
    throw new Error("Unknown action.");
  const active = type === "sku-alias-reactivate";
  let alias: SkuAlias | undefined;
  let seed: PackageDefault | undefined;
  if (text("id")) alias = find();
  else {
    // A built-in SKU nobody has changed yet has no record: it is named by its SKU.
    seed = seedFor(text("sku"));
    if (!seed)
      throw new Error(
        "This package SKU could not be found. Refresh and try again.",
      );
    alias = aliases.find((a) => a.sku === seed!.sku);
    if (alias && expected() === 0) throw stale();
  }
  const current = alias ? alias.active : true;
  if (current === active)
    throw new Error(
      active
        ? "This package SKU is already active."
        : "This package SKU is already retired.",
    );
  const why = reason();
  if (!alias) {
    room();
    alias = override(seed!);
    aliases.push(alias);
  }
  alias.active = active;
  alias.origin = seedFor(alias.sku) ? "built-in" : "custom";
  alias.updatedAt = at;
  alias.version += 1;
  alias.history.push({
    kind: active ? "reactivated" : "retired",
    at,
    changes: { active: [String(!active), String(active)] },
    reason: why,
    recordedBy,
  });
  return {
    entity: "sku-alias:" + alias.id,
    action: active ? "Package SKU reactivated" : "Package SKU retired",
    detail: `${describe(entryOf(alias))} · ${why}`,
  };
}
