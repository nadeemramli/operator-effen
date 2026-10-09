"use client";

import {
  Fragment,
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
import { ProductionWorkspace, ProcessPicHistory } from "./production-workspace";
import { SachetProductionRecords, StageRecords } from "./sachet-records";
import { OrderWorkspace, PackerPackageSummary } from "./order-workspace";
import { AwbIntake } from "./awb-intake";
import { DriverTrips } from "./driver-trips";
import { PackerProfiles, PackerUnlock } from "./packer-station";
import { channels } from "@/lib/awb-import";
import {
  allowedViews,
  homeView,
  resolveView,
  type View,
} from "@/lib/landing";
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
  ErrorToast,
  FormError,
  fieldMessage,
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
  isSachet,
  batchComplete,
  batchTransferred,
  stageDone,
  warehouseStages,
  adypocideReceipts,
  stockCartons,
  type AdypocideReceipt,
  batchUnit,
  orderIssued,
  orderLines,
  packerProfiles,
  people,
  previewCapabilities,
  product,
  products,
  recorderLabel,
  roles,
  staffName,
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

/** Sidebar labels and icons; which roles see each screen lives in lib/landing. */
const navigation: Record<View, { en: string; ms: string; icon: typeof Factory }> = {
  production: { en: "Production", ms: "Pengeluaran", icon: Factory },
  warehouse: {
    en: "Stock in & inventory",
    ms: "Stok masuk & inventori",
    icon: Boxes,
  },
  input: { en: "Input orders", ms: "Masukkan pesanan", icon: FileText },
  orders: { en: "Order management", ms: "Pengurusan pesanan", icon: FileText },
  packing: { en: "Packing station", ms: "Stesen pembungkusan", icon: PackageCheck },
  trips: { en: "Driver trips", ms: "Perjalanan pemandu", icon: Truck },
  tally: { en: "Daily tally", ms: "Jumlah akhir hari", icon: ClipboardList },
  overview: { en: "Overview", ms: "Gambaran", icon: LayoutDashboard },
  trace: { en: "Traceability", ms: "Jejak rekod", icon: ScanLine },
  reports: { en: "Reports & people", ms: "Laporan & pasukan", icon: Activity },
  feedback: {
    en: "Testing & feedback",
    ms: "Ujian & maklum balas",
    icon: MessageSquare,
  },
};
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
  input: [
    "Input orders",
    "Masukkan pesanan",
    "Upload PDFs or enter an AWB manually, then review its contents.",
    "Muat naik PDF atau masukkan AWB secara manual, kemudian semak kandungannya.",
  ],
  tally: [
    "Daily fulfilment tally",
    "Jumlah pemenuhan harian",
    "Compare order demand, supervisor counts, issued stock and packer declarations.",
    "Bandingkan permintaan, kiraan penyelia, stok dikeluarkan dan rekod pembungkus.",
  ],
  orders: [
    "Order management",
    "Pengurusan pesanan",
    "Review orders by day, product and package.",
    "Semak pesanan mengikut hari, produk dan pakej.",
  ],
  packing: [
    "One parcel. An honest count.",
    "Satu bungkusan. Kiraan sebenar.",
    "Each packer records what they actually packed under their own name and PIN. Supervisors correct and review.",
    "Setiap pembungkus merekod jumlah sebenar yang dibungkus atas nama dan PIN sendiri. Penyelia membetulkan dan menyemak.",
  ],
  trips: [
    "Driver trips",
    "Perjalanan pemandu",
    "Drivers log each trip: driver and assistant names, pickup and arrival time, and a photo.",
    "Pemandu merekod setiap perjalanan: nama pemandu dan pembantu, masa ambil dan tiba, serta gambar.",
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

type Actor = {
  kind: "member" | "preview";
  userId: string;
  role?: string;
  name?: string;
  siteId?: string;
  workspaceId?: string;
  workspaceName?: string;
  scope?: "site" | "all-sites";
  capabilities?: string[];
  factory?: "bottle" | "sachet";
};
// A save that has not been acknowledged. Kept on this device until the server confirms it,
// and only offered back to the same signed-in user and workspace.
type PendingSave = {
  operationId: string;
  type: string;
  input: Record<string, unknown>;
  role: Role;
  userId?: string;
  workspaceId?: string;
  savedAt: string;
};
const PENDING_KEY = "operator-pending-save";
const readPending = (): PendingSave | null => {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  } catch {
    return null;
  }
};
// Management's "view as" lens lasts for this tab, refreshes included, and ends with it:
// nobody reopens Operator days later still looking through another role's screens.
const VIEW_AS_KEY = "operator-view-as";
// The fictional preview keeps the last role chosen on this device.
const PREVIEW_ROLE_KEY = "operator-role";
const storedRole = (storage: () => Storage, key: string): Role | undefined => {
  try {
    const value = storage().getItem(key);
    return roles.some((r) => r.id === value) ? (value as Role) : undefined;
  } catch {
    return undefined;
  }
};
// The shared packer phone locks the unlocked packer after this long without a touch, so the
// next person cannot save under the previous packer's name. The server session is longer.
const PACKER_IDLE_MS = 3 * 60 * 1000;
// Assistant drivers are drivers now; a server still on the older role list maps across.
const viewRole = (role?: string): Role =>
  role === "assistant"
    ? "driver"
    : roles.some((r) => r.id === role)
      ? (role as Role)
      : "packer";
/** The sign-in address that brings the person back to the screen open in this tab. */
const signInHref = (expired: boolean) => {
  const q = new URLSearchParams();
  if (expired) q.set("expired", "1");
  const here = window.location.pathname + window.location.search;
  if (here !== "/") q.set("next", here);
  const query = q.toString();
  return "/login" + (query ? "?" + query : "");
};

export function DraftApp() {
  const revisionRef = useRef(0);
  const [actor, setActor] = useState<Actor | null>(null),
    [workspaces, setWorkspaces] = useState<
      { id: string; name: string; role: string }[]
    >([]),
    [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const member = actor?.kind === "member";
  // Management members may look through any role's screens; their access stays Management.
  const canViewAs = member && actor?.role === "management";
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
    [formError, setFormError] = useState(""),
    [formField, setFormField] = useState<string | undefined>(),
    [formConflict, setFormConflict] = useState(false),
    [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false),
    [light, setLight] = useState(false),
    [reset, setReset] = useState(false),
    [query, setQuery] = useState(""),
    [channel] = useState("all"),
    [packerProfile, setPackerProfile] = useState(""),
    [packingDate, setPackingDate] = useState(today),
    [packingSelection, setPackingSelection] = useState<string[]>([]),
    [trace, setTrace] = useState<string | null>(null);
  const t = (en: string, ms: string) => tr(lang, en, ms);
  // Display only: the server and database decide. Members get their site capabilities;
  // the fictional preview gets the previewed role's defaults inside the sandbox.
  const caps: readonly string[] = member
    ? (actor?.capabilities ?? [])
    : previewCapabilities(role);
  const can = (capability: string) => caps.includes(capability);
  const operational = caps.some((c) => c !== "feedback.post");
  const allowed = allowedViews(role).map((id) => ({ id, ...navigation[id] }));
  const viewingAs = canViewAs && role !== "management";
  const roleName = (id?: string) =>
    roles.find((r) => r.id === id)?.[lang === "ms" ? "ms" : "en"] ?? id;
  const view = resolveView(role, params.get("view"));
  const go = (next: View) => {
    router.push("/?view=" + next);
    setQuery("");
    setMobile(false);
  };
  const changeRole = (next: Role) => {
    setRole(next);
    try {
      if (member) sessionStorage.setItem(VIEW_AS_KEY, next);
      else localStorage.setItem(PREVIEW_ROLE_KEY, next);
    } catch {
      /* Storage can be unavailable; the choice still applies to this page. */
    }
    // Keep the address and the screen in step when the new role cannot open this one.
    if (!allowedViews(next).includes(view)) go(homeView(next));
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
  // `silent`: a background refresh. It keeps the open screen, form and selections and
  // never shows an error; the next save or manual refresh reports any problem.
  const load = useCallback(async (workspace?: string, silent = false) => {
    try {
      const res = await fetch(
        "/api/draft" +
          (workspace ? "?workspace=" + encodeURIComponent(workspace) : ""),
        { cache: "no-store" },
      );
      if (res.status === 401) {
        router.replace(signInHref(false));
        router.refresh();
        return;
      }
      if (!res.ok)
        throw new Error("Workspace could not be loaded. Please refresh.");
      const data = await res.json();
      if (silent) {
        // Another site may have been chosen meanwhile; only refresh the one on screen.
        if (workspace && data.actor?.workspaceId !== workspace) return;
        setState(data.state);
        setRevision(data.revision);
        revisionRef.current = data.revision;
        return;
      }
      setState(data.state);
      setRevision(data.revision);
      revisionRef.current = data.revision;
      setActor(data.actor ?? null);
      setWorkspaces(data.workspaces ?? []);
      // Members act only in their server-assigned role; the preview switcher is ignored.
      // Management may keep a "view as" lens, which never changes what they can save.
      // The role is applied only now, once the server has said who this is: a guessed
      // role would choose the screen, and a refresh would open on the wrong one.
      setRole(
        data.actor?.kind === "member"
          ? data.actor.role === "management"
            ? (storedRole(() => sessionStorage, VIEW_AS_KEY) ?? "management")
            : viewRole(data.actor.role)
          : (storedRole(() => localStorage, PREVIEW_ROLE_KEY) ?? "management"),
      );
      if (
        data.actor?.kind === "member" &&
        data.actor.capabilities?.includes("packing.record")
      ) {
        const session = await fetch(
          "/api/packer-session?workspace=" +
            encodeURIComponent(data.actor.workspaceId),
          { cache: "no-store" },
        )
          .then((r): Promise<{ profileId?: string | null }> =>
            r.ok ? r.json() : Promise.resolve({}),
          )
          .catch(() => ({ profileId: null }));
        setPackerProfile(session.profileId ?? "");
      }
      setPendingSave(readPending());
      setError("");
    } catch (e) {
      if (silent) return;
      const message = e instanceof Error ? e.message : "Connection error.";
      setError(message);
      setToast(message);
    }
  }, [router]);
  const dismissToast = useCallback(() => setToast(""), []);
  // Keep the shared records fresh: when the tab becomes visible again, and every minute
  // while nobody is filling in a form or waiting for a save.
  const idle = !form && !busy && !reset;
  const workspaceId = actor?.workspaceId;
  const ready = !!actor;
  useEffect(() => {
    if (!ready || !idle) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load(workspaceId, true);
    };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [ready, idle, workspaceId, load]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        if (localStorage.getItem("operator-language") === "ms") {
          setLang("ms");
          document.documentElement.lang = "ms";
        }
        // Earlier builds kept the lens on the device; it now lives with the tab.
        localStorage.removeItem(VIEW_AS_KEY);
      } catch {
        /* Storage can be unavailable; defaults apply. */
      }
      void load();
    });
  }, [load]);
  // Hooks stay above the early return below so they run in the same order every render.
  // Shared packer sign-in: the packer currently unlocked on this device.
  const packerStation = role === "packer" && !viewingAs;
  const lastPackerTouch = useRef(0);
  const lockPacker = useCallback(async () => {
    setPackerProfile("");
    setPackingSelection([]);
    setForm(null);
    if (member)
      await fetch("/api/packer-session", { method: "DELETE" }).catch(() => null);
  }, [member]);
  useEffect(() => {
    if (!packerStation || !packerProfile) return;
    lastPackerTouch.current = Date.now();
    const touch = () => {
      lastPackerTouch.current = Date.now();
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    const timer = window.setInterval(() => {
      if (Date.now() - lastPackerTouch.current > PACKER_IDLE_MS) void lockPacker();
    }, 10000);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      window.clearInterval(timer);
    };
  }, [packerStation, packerProfile, lockPacker]);
  // Until the server says who is signed in, no screen is chosen: the role decides the
  // screen, and a guessed role sent every refresh to that guess's first screen.
  if (!actor)
    return (
      <main className="loading-state min-h-dvh" aria-live="polite">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("Try again", "Cuba lagi")}
            </Button>
          </>
        ) : (
          <>
            <LoaderCircle className="animate-spin" />
            <p>{t("Opening your workspace…", "Membuka ruang kerja anda…")}</p>
          </>
        )}
      </main>
    );
  /** A page-level error: shown under the heading and as a toast at the bottom. */
  const fail = (message: string) => {
    setError(message);
    setToast(message);
  };
  async function command(
    type: string,
    input: Record<string, unknown>,
    options: {
      retry?: PendingSave;
      /** Show the error next to the caller's own button instead of at page level. */
      onError?: (message: string) => void;
    } = {},
  ) {
    const { retry, onError } = options;
    if (viewingAs) {
      if (onError) onError(viewOnlyMessage());
      else fail(viewOnlyMessage());
      return null;
    }
    setBusy(true);
    setFormError("");
    setFormField(undefined);
    setError("");
    setToast("");
    // One operation ID per intended change; retries reuse it so the server applies it once.
    const pending: PendingSave = retry ?? {
      operationId: crypto.randomUUID(),
      type,
      input,
      role,
      userId: actor?.userId,
      workspaceId: actor?.workspaceId,
      savedAt: new Date().toISOString(),
    };
    const keep = () => {
      try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        /* Storage can be unavailable; the open form still holds the entry. */
      }
      setPendingSave(pending);
    };
    const clear = () => {
      try {
        if (readPending()?.operationId === pending.operationId)
          localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      setPendingSave(null);
    };
    keep();
    let conflicted = false;
    try {
      let res: Response;
      try {
        res = await fetch("/api/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: { type, role: pending.role, input },
            revision: revisionRef.current,
            operationId: pending.operationId,
            workspaceId: pending.workspaceId,
          }),
        });
      } catch {
        throw new Error(
          t(
            "Connection lost. Your entry is kept on this device — use Resubmit once you are back online. It will be saved only once.",
            "Sambungan terputus. Entri anda disimpan pada peranti ini — gunakan Hantar semula apabila dalam talian. Ia hanya disimpan sekali.",
          ),
        );
      }
      if (res.status === 401) {
        router.replace(signInHref(true));
        router.refresh();
        throw new Error(
          t(
            "Your session ended. Your entry is kept on this device; sign in again to resubmit it.",
            "Sesi anda tamat. Entri anda disimpan pada peranti ini; log masuk semula untuk menghantarnya.",
          ),
        );
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status < 500) clear();
        if (data.code === "packer-locked") {
          setPackerProfile("");
          setForm(null);
          fail(data.error);
          return null;
        }
        // Someone else changed the same record: load their version now, keep the open form
        // and its values, and let the person check and save again.
        if (res.status === 409 && (data.code === "record" || data.code === "revision")) {
          await load(pending.workspaceId, true);
          conflicted = true;
          throw new Error(
            (data.error ?? "") +
              " " +
              t(
                "The latest version has been loaded — check it, then save again.",
                "Versi terkini telah dimuatkan — semak, kemudian simpan semula.",
              ),
          );
        }
        throw new Error(data.error ?? "Unable to save. Please refresh.");
      }
      clear();
      setState(data.state);
      setRevision(data.revision);
      revisionRef.current = data.revision;
      setForm(null);
      setReset(false);
      setNotice(
        data.replayed
          ? t(
              "This entry was already saved. No duplicate was created.",
              "Entri ini telah disimpan. Tiada pendua dicipta.",
            )
          : member
            ? t("Saved to your site's records.", "Disimpan ke rekod tapak anda.")
            : t(
                "Saved to the shared test workspace.",
                "Disimpan ke ruang ujian bersama.",
              ),
      );
      return data.state as Draft;
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Unable to save.";
      setFormConflict(conflicted);
      if (onError) onError(fieldMessage(raw, null, lang).message);
      else if (form) {
        const mapped = fieldMessage(raw, form, lang);
        setFormError(mapped.message);
        setFormField(mapped.field);
      } else fail(raw);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const viewOnlyMessage = () =>
    t(
      `You are viewing as ${roleName(role)}. Switch back to Management to make changes.`,
      `Anda melihat sebagai ${roleName(role)}. Tukar kembali ke Pengurusan untuk membuat perubahan.`,
    );
  function show(spec: FormSpec) {
    setFormError("");
    setFormField(undefined);
    setNotice("");
    if (viewingAs) {
      fail(viewOnlyMessage());
      return;
    }
    setForm(spec);
  }
  const pic = (
    name = "pic",
    label = t("Person responsible (PIC)", "Orang bertanggungjawab (PIC)"),
  ): Field => ({
    name,
    label,
    type: "person",
    // Packer profiles exist only for the shared packer sign-in; they never replace the
    // people offered as process PICs.
    options: state?.staffProfiles?.some((p) => p.role !== "packer")
      ? state.staffProfiles
          .filter((p) => p.role !== "packer")
          .map((p) => ({ value: p.id, label: p.name }))
      : people.map((p) => ({ value: p, label: p })),
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
        "Type or scan the AWB reference using a barcode reader. Enter its contents, then confirm the order in Order management. Printing alone does not add an order.",
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
            "Use the same package name / SKU as your labels so orders group together.",
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
        "The carton number is the batch number. Record the units received and their rack.",
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
              (b) => !isSachet(b.product) && b.sent > batchReceived(state, b),
            )
            .map((b) => ({
              value: b.id,
              label:
                product(b.product).name +
                " · " +
                b.code +
                " · " +
                (b.sent - batchReceived(state, b)) +
                " " +
                units(lang, batchUnit(b)),
            })),
        },
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
      title: t("Receive sachets for boxing", "Terima sachet untuk pengkotakan"),
      description: t(
        "Select the factory batch; its number is used for the cartons too. Finished boxes are counted after boxing.",
        "Rekod karton yang tiba dan kelompoknya. Kotak siap akan dikira selepas pengkotakan.",
      ),
      fields: [
        {
          name: "batchId",
          label: t("Factory batch", "Kelompok kilang"),
          type: "select",
          options: state?.batches
            .filter(
              (b) =>
                isSachet(b.product) &&
                batchTransferred(b) &&
                !receipts.some((r) => r.batchId === b.id && !r.stockedAt),
            )
            .map((b) => ({
              value: b.id,
              label: product(b.product).name + " · " + b.code,
            })),
        },
        pic(),
      ],
    });
  const finalizeAdypocide = (receipt: AdypocideReceipt) =>
    show({
      type: "stock-in-ady",
      title: t(
        "Finalize sachet box stock-in",
        "Muktamadkan stok masuk kotak sachet",
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
  const pack = (o: Order) =>
    show({
      type: "pack",
      title: t("Record packed parcel", "Rekod bungkusan dibungkus"),
      description:
        o.awb +
        " · " +
        orderLines(o)
          .map(
            (l) =>
              `${product(l.product).name}: ${l.expected} ${units(lang, product(l.product).unit)}`,
          )
          .join(" · ") +
        " · " +
        t(
          "You are recording the actual packer's work as supervisor.",
          "Anda merekod kerja pembungkus sebenar sebagai penyelia.",
        ),
      hidden: { id: o.id },
      fields: [
        {
          ...pic("pic", t("Actual packer", "Pembungkus sebenar")),
          options: packerOptions,
          value: o.assignedPacker,
        },
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
        pic("labelPic", t("AWB attached by", "AWB dilekatkan oleh")),
        {
          name: "occurredAt",
          label: t(
            "When it was packed (Malaysia time)",
            "Masa dibungkus (waktu Malaysia)",
          ),
          type: "datetime-local",
          required: false,
          hint: t(
            "Leave blank if just packed. For late entry, enter the actual time.",
            "Biarkan kosong jika baru dibungkus. Untuk rekod lewat, masukkan masa sebenar.",
          ),
        },
        {
          name: "reason",
          label: t(
            "Reason, if someone other than the assigned packer packed it",
            "Sebab, jika bukan pembungkus ditugaskan yang membungkus",
          ),
          type: "textarea",
          required: false,
        },
      ],
      submit: t("Save actual count", "Simpan kiraan sebenar"),
    });
  // A packer's own count on the shared packer sign-in. The server takes the packer from the
  // PIN-unlocked session; the preview passes its sample profile instead.
  const packOwn = (o: Order) =>
    show({
      type: "pack-own",
      title: t("Record what I packed", "Rekod apa yang saya bungkus"),
      description:
        o.awb +
        " · " +
        orderLines(o)
          .map(
            (l) =>
              `${product(l.product).name}: ${l.expected} ${units(lang, product(l.product).unit)}`,
          )
          .join(" · ") +
        " · " +
        t(
          "Saved once under your name. Your supervisor corrects any mistake.",
          "Disimpan sekali atas nama anda. Penyelia anda membetulkan sebarang kesilapan.",
        ),
      hidden: { id: o.id, ...(member ? {} : { profile: packerProfile }) },
      summary: [
        {
          label: t("Packer", "Pembungkus"),
          value: staffName(state ?? { staffProfiles: undefined }, packerProfile),
        },
      ],
      fields: orderLines(o).map((l) =>
        number(
          o.lines ? "actual_" + l.product : "actual",
          product(l.product).name +
            " · " +
            t("I packed", "Saya bungkus") +
            " (" +
            units(lang, product(l.product).unit) +
            ")",
        ),
      ),
      submit: t("Save my count", "Simpan kiraan saya"),
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
        {
          name: "entity",
          label: t(
            "Related batch, AWB or screen",
            "Kelompok, AWB atau skrin berkaitan",
          ),
          required: false,
        },
      ],
    });
  const packerOptions = (
    state?.staffProfiles
      ? state.staffProfiles
          .filter((p) => p.role === "packer")
          .map((p) => ({ id: p.id, name: p.name }))
      : people.map((p) => ({ id: p, name: p }))
  ).map((p) => ({ value: p.id, label: p.name }));
  const search = (value: string) =>
    value.toLowerCase().includes(query.toLowerCase());
  const filteredOrders =
    state?.orders.filter(
      (o) =>
        (view !== "packing" ||
          (o.date === packingDate &&
            (!packingSelection.length || packingSelection.includes(o.id)))) &&
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
        "Packed at",
        "Pack entered by",
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
          o.packedAt ?? "",
          recorderLabel(o.packRecordedBy),
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
                        {t("Sachet boxing", "Pengkotakan sachet")}
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
              "Bottles and finished sachet boxes are counted separately.",
              "Botol dan kotak sachet siap dikira berasingan.",
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
          role={role}
          state={state}
          lang={lang}
          busy={busy}
          command={command}
          show={show}
          pic={pic}
          number={number}
          closeDay={closeDay}
          factoryScope={member ? actor?.factory : undefined}
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
                  "Receive sachets for boxing",
                  "Terima sachet untuk pengkotakan",
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
              "Sachets · warehouse boxing",
              "Sachet · pengkotakan gudang",
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
                      <th className="actions">{t("Action", "Tindakan")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((receipt) => {
                      const batch = state.batches.find(
                        (b) => b.id === receipt.batchId,
                      );
                      // Batches planned with a route need their warehouse stages first.
                      const gated = !!batch?.route && !receipt.stockedAt;
                      const stages = batch ? warehouseStages(batch) : [];
                      const recorded = batch
                        ? stages.filter((k) => stageDone(batch, k)).length
                        : 0;
                      const ready = !gated || batchComplete(batch!);
                      return (
                      <Fragment key={receipt.id}>
                      <tr>
                        <td
                          data-label={t("Product / batch", "Produk / kelompok")}
                        >
                          <ProductName
                            id={
                              state.batches.find(
                                (b) => b.id === receipt.batchId,
                              )!.product
                            }
                          />
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
                          {gated && (
                            <span
                              className={
                                "status-pill ml-1 " +
                                (ready ? "tone-success" : "tone-info")
                              }
                            >
                              {recorded}/{stages.length}{" "}
                              {t("warehouse stages", "peringkat gudang")}
                            </span>
                          )}
                        </td>
                        <td
                          className="actions"
                          data-label={t("Action", "Tindakan")}
                        >
                          {receipt.stockedAt ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setTrace(receipt.stockCartonId!)}
                            >
                              {t("View stock", "Lihat stok")}
                            </Button>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy || !ready}
                                aria-describedby={
                                  ready ? undefined : "box-gate-" + receipt.id
                                }
                                onClick={() => finalizeAdypocide(receipt)}
                              >
                                {t(
                                  "Finalize box count",
                                  "Muktamadkan kiraan kotak",
                                )}
                              </Button>
                              {!ready && (
                                <small
                                  id={"box-gate-" + receipt.id}
                                  className="field-hint block"
                                >
                                  {t(
                                    `${recorded} of ${stages.length} warehouse stages recorded. Record the rest below first.`,
                                    `${recorded} daripada ${stages.length} peringkat gudang direkod. Rekod selebihnya di bawah dahulu.`,
                                  )}
                                </small>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                      {gated && batch && (
                        <tr className="receipt-stages">
                          <td colSpan={4}>
                            <StageRecords
                              batch={batch}
                              state={state}
                              lang={lang}
                              show={can("stage.record") ? show : undefined}
                              pic={can("stage.record") ? pic : undefined}
                              role={role}
                              stageFilter="warehouse"
                            />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {t(
                  "No sachet receipts yet. Receive a factory carton to begin boxing.",
                  "Belum ada penerimaan sachet. Terima karton kilang untuk mula pengkotakan.",
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
                    <th className="actions" />
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
                          {new Date(c.at).toLocaleString(
                            lang === "ms" ? "ms-MY" : "en-MY",
                            {
                              timeZone: "Asia/Kuala_Lumpur",
                              dateStyle: "medium",
                              timeStyle: "short",
                            },
                          )}
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
                      <td className="actions">
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
                      <th className="actions" />
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
                        <td className="actions">
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
          <SachetProductionRecords
            state={state}
            lang={lang}
            show={can("stage.record") || can("stage.correct") ? show : undefined}
            pic={can("stage.record") || can("stage.correct") ? pic : undefined}
            role={role}
            onTrace={(id) => setTrace(id)}
            machineShow={can("machines.manage") ? show : undefined}
          />
          <div className="page-actions">
            <Button variant="outline" onClick={closeDay}>
              <ClipboardList size={16} />
              {t("End-of-day review", "Semakan akhir hari")}
            </Button>
          </div>
        </>
      );
    if (view === "input")
      return (
        <AwbIntake
          workspaceId={actor?.workspaceId}
          state={state}
          lang={lang}
          role={role}
          busy={busy}
          onCommand={command}
        >
          <Panel
            title={t("Manual / scanned AWB", "AWB manual / diimbas")}
            detail={t(
              "For TikTok labels already printed, enter or scan the reference and enter the package contents. A barcode identifies the parcel; it does not supply its contents. PDF import is also available.",
              "Untuk label TikTok sudah dicetak, masukkan atau imbas rujukan dan masukkan kandungan pakej. Kod bar mengenal pasti bungkusan sahaja. Import PDF juga tersedia.",
            )}
          >
            <div className="p-6 space-y-4">
              <Button className="action-primary" onClick={newOrder}>
                <Plus size={16} />
                {t("Enter an order", "Masukkan pesanan")}
              </Button>
              <p>
                {t(
                  "New manual orders wait for review before joining daily demand.",
                  "Pesanan manual baharu menunggu semakan sebelum ditambah ke permintaan harian.",
                )}
              </p>
              <Button variant="outline" onClick={() => go("orders")}>
                {t("Open order management", "Buka pengurusan pesanan")}
              </Button>
            </div>
          </Panel>
        </AwbIntake>
      );
    if (view === "orders" || view === "tally")
      return (
        <OrderWorkspace
          key={view}
          state={state}
          lang={lang}
          role={role}
          busy={busy}
          mode={view === "tally" ? "tally" : "management"}
          show={show}
          pic={pic}
          trace={setTrace}
          correct={correct}
          dispatch={dispatch}
        />
      );
    if (view === "packing" && packerStation && !packerProfile)
      return (
        <PackerUnlock
          state={state}
          lang={lang}
          date={packingDate}
          workspaceId={actor?.workspaceId}
          preview={!member}
          onUnlock={(id) => {
            setPackerProfile(id);
            setPackingSelection([]);
            setError("");
          }}
        />
      );
    if (view === "packing")
      return (
        <>
          {packerStation ? (
            <div className="inline-note">
              <ShieldCheck size={18} />
              <span className="flex-1">
                {t("Recording as", "Merekod sebagai")}{" "}
                <strong>{staffName(state, packerProfile)}</strong>.{" "}
                {t(
                  "Tap Done when you finish so the next person can choose their name.",
                  "Tekan Selesai apabila habis supaya orang seterusnya boleh memilih nama mereka.",
                )}
              </span>
              <Button variant="outline" size="sm" onClick={() => void lockPacker()}>
                {t("Done", "Selesai")}
              </Button>
            </div>
          ) : (
          <label className="order-profile">
            {t("Packer", "Pembungkus")}
            <select
              className="form-select"
              value={packerProfile}
              onChange={(e) => {
                setPackerProfile(e.target.value);
                setPackingSelection([]);
              }}
            >
              <option value="">
                {t(
                  "Choose a packer to see their packages",
                  "Pilih pembungkus untuk melihat pakej ditugaskan",
                )}
              </option>
              {packerProfiles(state).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <small>
              {t(
                "Packers record their own counts on the shared packer sign-in with their PIN. You can also record for them and correct saved counts.",
                "Pembungkus merekod kiraan sendiri pada log masuk pembungkus bersama dengan PIN mereka. Anda juga boleh merekod bagi pihak mereka dan membetulkan kiraan tersimpan.",
              )}
            </small>
          </label>
          )}
          {role === "outbound" && can("members.manage") && (
            <PackerProfiles
              state={state}
              lang={lang}
              busy={busy}
              workspaceId={actor?.workspaceId}
              live={member}
              command={command}
            />
          )}
          <label className="order-profile">
            {t("Packing day (Malaysia)", "Hari pembungkusan (Malaysia)")}
            <Input
              type="date"
              value={packingDate}
              onChange={(e) => {
                setPackingDate(e.target.value);
                setPackingSelection([]);
                setQuery("");
              }}
            />
          </label>
          <PackerPackageSummary
            orders={state.orders.filter(
              (o) =>
                o.date === packingDate &&
                !!packerProfile &&
                o.assignedPacker === packerProfile,
            )}
            lang={lang}
            onSelect={(ids) => {
              setPackingSelection(ids);
              setQuery("");
            }}
          />
          <div className="inline-note">
            {
              filteredOrders.filter(
                (o) =>
                  !o.dispatched &&
                  o.assignedPacker === packerProfile &&
                  packerProfile,
              ).length
            }{" "}
            {t(
              "assigned AWBs awaiting handover",
              "AWB ditugaskan menunggu serahan",
            )}
          </div>
          <div className="inline-note">
            <PackageCheck size={18} />
            {t(
              "Record the actual quantity once for the person who packed it. Saved counts change only through a reasoned supervisor correction. No second QC check is required.",
              "Rekod jumlah sebenar sekali bagi orang yang membungkus. Kiraan tersimpan hanya diubah melalui pembetulan penyelia bersebab. Tiada semakan QC kedua diperlukan.",
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
          {!!packingSelection.length && (
            <Button variant="outline" onClick={() => setPackingSelection([])}>
              {t("Show all assigned packages", "Papar semua pakej ditugaskan")}
            </Button>
          )}
          <div className="packing-grid">
            {filteredOrders
              .filter(
                (o) =>
                  !o.dispatched &&
                  !!packerProfile &&
                  o.assignedPacker === packerProfile,
              )
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
                      {t("Packed by", "Dibungkus oleh")} {staffName(state, o.packer)} ·{" "}
                      {t("AWB", "AWB")}: {staffName(state, o.labelPic)}
                      {o.packRecordedBy && (
                        <>
                          <br />
                          {t("Entered by", "Direkod oleh")}{" "}
                          {recorderLabel(o.packRecordedBy)}
                        </>
                      )}
                    </p>
                  ) : null}
                  {packerStation ? (
                    o.actual === null ? (
                      <Button
                        className="action-primary w-full"
                        onClick={() => packOwn(o)}
                      >
                        {t("Record what I packed", "Rekod apa yang saya bungkus")}
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Saved. Ask your supervisor if it needs a correction.",
                          "Disimpan. Minta penyelia anda jika perlu pembetulan.",
                        )}
                      </p>
                    )
                  ) : role !== "outbound" ? (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "The packer or their supervisor records this count.",
                        "Pembungkus atau penyelia mereka merekod kiraan ini.",
                      )}
                    </p>
                  ) : o.actual === null ? (
                    <Button
                      className="action-primary w-full"
                      onClick={() => pack(o)}
                    >
                      {t("Record actual quantity", "Rekod jumlah sebenar")}
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
    if (view === "trips")
      return (
        <DriverTrips
          state={state}
          lang={lang}
          canLog={can("trips.log")}
          canReview={can("trips.read")}
          userId={actor?.userId}
          member={member}
          workspace={member ? actor?.workspaceId : undefined}
          show={show}
        />
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
                      (c) =>
                        c.batchId === b.id &&
                        search(c.ref + " " + (c.legacyRef ?? "")),
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
                        {[
                          n.author ? recorderLabel(n.author) : null,
                          n.siteId,
                          n.entity,
                          new Date(n.at).toLocaleString("en-MY", {
                            timeZone: "Asia/Kuala_Lumpur",
                          }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
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
                  "Receive cartons. Finalize sachet product box counts after boxing, or record a monthly stock count.",
                  "Terima karton. Muktamadkan kiraan kotak produk sachet selepas pengkotakan, atau rekod kiraan stok bulanan.",
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
                  "Count daily product requirements, issue rack stock and assign packages to packers.",
                  "Kira keperluan produk harian, keluarkan stok rak dan tugaskan pakej kepada pembungkus.",
                ),
              ],
              [
                t("Driver", "Pemandu"),
                t(
                  "Log a trip with the assistant driver's name, pickup and arrival time, and a photo.",
                  "Rekod perjalanan dengan nama pembantu pemandu, masa ambil dan tiba, serta gambar.",
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
                      {[
                        n.author ? recorderLabel(n.author) : null,
                        n.siteId,
                        n.entity,
                        new Date(n.at).toLocaleString("en-MY", {
                          timeZone: "Asia/Kuala_Lumpur",
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
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
            <strong>
              {member
                ? actor?.name
                : t("EFFEN test team", "Pasukan ujian EFFEN")}
            </strong>
            <small>
              {member
                ? `${roles.find((r) => r.id === actor?.role)?.[lang === "ms" ? "ms" : "en"] ?? actor?.role} · ${actor?.workspaceName}`
                : t("Shared test account", "Akaun ujian bersama")}
            </small>
          </div>
          <button
            aria-label={t("Sign out", "Log keluar")}
            onClick={async () => {
              const res = await fetch("/api/logout", { method: "POST" });
              if (res.ok) {
                router.replace("/login");
                router.refresh();
              } else
                fail(
                  t(
                    "Unable to sign out. Please retry.",
                    "Tidak dapat log keluar. Sila cuba lagi.",
                  ),
                );
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
            <strong>{navigation[view][lang === "ms" ? "ms" : "en"]}</strong>
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
              {member
                ? t("Site workspace", "Ruang kerja tapak")
                : t("Test workspace", "Ruang ujian")}
            </span>
          </div>
        </header>
        {member ? (
          <div className="draft-strip">
            <span>
              <ShieldCheck size={14} />
              {t("SIGNED IN", "LOG MASUK")}
              <span className="strip-detail">
                {actor?.name} · {roleName(actor?.role)} ·{" "}
                {actor?.workspaceName}
                {(!operational || viewingAs) &&
                  " · " + t("view only", "lihat sahaja")}
              </span>
            </span>
            {canViewAs && (
              <label htmlFor="view-as">
                {t("View as", "Lihat sebagai")}
                <select
                  id="view-as"
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
            )}
            {workspaces.length > 1 && (
              <label htmlFor="site-switch">
                {t("Site", "Tapak")}
                <select
                  id="site-switch"
                  value={actor?.workspaceId}
                  onChange={(e) => void load(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option value={w.id} key={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          <div className="draft-strip">
            <span>
              <span className="test-dot" />
              {t("TEAM TESTING", "UJIAN PASUKAN")}
              <span className="strip-detail">
                {t(
                  "Fictional data · role preview does not grant operational access",
                  "Data rekaan · pratonton peranan tidak memberi akses operasi",
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
        )}
        <main className="workspace-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {t("EFFEN OPERATIONS", "OPERASI EFFEN")} <span>/</span>{" "}
                {new Date(
                  (view === "production"
                    ? (state?.batches.find((b) => b.id === params.get("batch"))
                        ?.date ??
                      params.get("date") ??
                      today())
                    : today()) + "T12:00:00+08:00",
                ).toLocaleDateString(lang === "ms" ? "ms-MY" : "en-MY", {
                  timeZone: "Asia/Kuala_Lumpur",
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
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
                void load(actor?.workspaceId);
              }}
            >
              <RefreshCw size={15} />
              <span>{t("Refresh", "Muat semula")}</span>
            </Button>
          </div>
          <FormError
            className="mb-5"
            message={error}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(actor?.workspaceId)}
              >
                {t("Refresh records", "Muat semula rekod")}
              </Button>
            }
          />
          {pendingSave && !busy && (
            <div className="form-error mb-5" role="status">
              {pendingSave.userId &&
              actor?.userId &&
              (pendingSave.userId !== actor.userId ||
                (pendingSave.workspaceId ?? "") !== (actor.workspaceId ?? "")) ? (
                t(
                  "An unsaved entry from another sign-in or site is kept on this device. Only that person can resubmit it.",
                  "Entri belum disimpan daripada log masuk atau tapak lain disimpan pada peranti ini. Hanya orang itu boleh menghantarnya semula.",
                )
              ) : (
                <>
                  {t("Unsaved entry kept on this device", "Entri belum disimpan pada peranti ini")}
                  {": "}
                  {pendingSave.type} ·{" "}
                  {new Date(pendingSave.savedAt).toLocaleString(
                    lang === "ms" ? "ms-MY" : "en-MY",
                    { timeZone: "Asia/Kuala_Lumpur" },
                  )}{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void command(pendingSave.type, pendingSave.input, {
                        retry: pendingSave,
                      })
                    }
                  >
                    {t("Resubmit", "Hantar semula")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      try {
                        localStorage.removeItem(PENDING_KEY);
                      } catch {
                        /* ignore */
                      }
                      setPendingSave(null);
                    }}
                  >
                    {t("Discard", "Buang")}
                  </Button>
                </>
              )}
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
        invalidField={formField}
        errorAction={
          formConflict ? (
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              <RefreshCw size={14} />
              {t("Try again", "Cuba lagi")}
            </Button>
          ) : undefined
        }
        onClose={() => setForm(null)}
        onSubmit={(type, values) => command(type, values)}
      />
      <ErrorToast message={toast} lang={lang} onDismiss={dismissToast} />
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
                  {!!linkedBatch.revisions?.length && (
                    <span className="status-pill tone-warning ml-2">
                      {t("Revised after transfer", "Disemak selepas pemindahan")}
                    </span>
                  )}
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
                          {!isSachet(linkedBatch.product) && (
                            <>
                              {st.qty ?? "—"}{" "}
                              {units(lang, batchUnit(linkedBatch))}
                            </>
                          )}
                        </p>
                        {st.machineName && <small>{st.machineName}</small>}
                        <ProcessPicHistory step={st} lang={lang} />
                        {!isSachet(linkedBatch.product) && (
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
