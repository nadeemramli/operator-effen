"use client";

import { useCallback, useEffect, useState } from "react";
import { FormError } from "./form-error";
import { KeyRound, Lock, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "./draft-primitives";
import { PersonBadge } from "./person-profile";
import {
  packerProfiles,
  tr,
  type Draft,
  type Lang,
} from "@/lib/draft";

/**
 * Shared packer sign-in: each packer taps their name and enters their own PIN. The server
 * checks the PIN and unlocks that one profile on this device; saves name the packer from
 * that session. The fictional preview has no PINs and unlocks a sample profile directly.
 */
export function PackerUnlock({
  state,
  lang,
  date,
  workspaceId,
  preview,
  onUnlock,
}: {
  state: Draft;
  lang: Lang;
  date: string;
  workspaceId?: string;
  preview: boolean;
  onUnlock: (profileId: string, expiresAt?: number) => void;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [chosen, setChosen] = useState(""),
    [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const packers = packerProfiles(state);
  const assigned = (id: string) =>
    state.orders.filter(
      (o) => o.date === date && o.assignedPacker === id && o.actual === null,
    ).length;
  async function unlock() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/packer-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, profileId: chosen, pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to check your PIN.");
      onUnlock(chosen, data.expiresAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to check your PIN.");
      setPin("");
    } finally {
      setBusy(false);
    }
  }
  const name = packers.find((p) => p.id === chosen)?.name ?? "";
  return (
    <Panel
      title={t("Who is packing?", "Siapa yang membungkus?")}
      detail={
        preview
          ? t(
              "Test view: tap a sample packer. Live packers also enter their own PIN.",
              "Paparan ujian: pilih pembungkus contoh. Pembungkus sebenar juga memasukkan PIN sendiri.",
            )
          : t(
              "Tap your name, then enter your own PIN. Only your assigned AWBs are shown.",
              "Pilih nama anda, kemudian masukkan PIN anda. Hanya AWB yang ditugaskan kepada anda dipaparkan.",
            )
      }
    >
      {!packers.length ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "No packer profiles yet. Ask the stock-out supervisor to add you.",
            "Belum ada profil pembungkus. Minta penyelia stok keluar menambah anda.",
          )}
        </p>
      ) : (
        <div className="pic-picker" role="radiogroup" aria-label={t("Packer", "Pembungkus")}>
          {packers.map((p) => (
            <label className="pic-option" key={p.id}>
              <input
                type="radio"
                name="packer-profile"
                value={p.id}
                checked={chosen === p.id}
                onChange={() => {
                  setChosen(p.id);
                  setPin("");
                  setError("");
                  if (preview) onUnlock(p.id);
                }}
              />
              <PersonBadge
                name={p.name}
                lang={lang}
                caption={
                  assigned(p.id) +
                  " " +
                  t("AWBs to pack today", "AWB untuk dibungkus hari ini")
                }
              />
            </label>
          ))}
        </div>
      )}
      {!preview && chosen && (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <label className="order-profile">
            {t("PIN for", "PIN untuk")} {name}
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{4,6}"
              maxLength={6}
              required
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <FormError message={error} />
          <Button className="action-primary" disabled={busy || pin.length < 4}>
            <KeyRound size={16} />
            {t("Open my AWBs", "Buka AWB saya")}
          </Button>
        </form>
      )}
    </Panel>
  );
}

type PinStatus = { profileId: string; setAt: string; lockedUntil: string | null };

/**
 * Stock-out supervisor (or HR): packer profiles for the shared packer sign-in and their
 * PINs. Profiles are workspace records; PINs go only to the database (/api/staff-pins).
 */
export function PackerProfiles({
  state,
  lang,
  busy,
  workspaceId,
  live,
  command,
}: {
  state: Draft;
  lang: Lang;
  busy: boolean;
  workspaceId?: string;
  live: boolean;
  command: (type: string, input: Record<string, unknown>) => Promise<Draft | null>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [pins, setPins] = useState<PinStatus[]>([]),
    [name, setName] = useState(""),
    [newPin, setNewPin] = useState(""),
    [pinFor, setPinFor] = useState(""),
    [pinValue, setPinValue] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [working, setWorking] = useState(false);
  const profiles = (state.staffProfiles ?? []).filter((p) => p.role === "packer");
  const loadPins = useCallback(async () => {
    if (!live) return;
    const res = await fetch(
      "/api/staff-pins" + (workspaceId ? "?workspace=" + encodeURIComponent(workspaceId) : ""),
      { cache: "no-store" },
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) setPins(data.pins ?? []);
    else setError(data.error ?? "Unable to load packer PINs.");
  }, [live, workspaceId]);
  useEffect(() => {
    void Promise.resolve().then(loadPins);
  }, [loadPins]);
  async function savePin(profileId: string, pin: string) {
    const res = await fetch("/api/staff-pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, profileId, pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Unable to save the PIN.");
    await loadPins();
  }
  async function add() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const profileId = crypto.randomUUID();
      const saved = await command("staff-profile-create", { profileId, name });
      if (!saved) return;
      if (live) await savePin(profileId, newPin);
      setNotice(
        live
          ? t(`${name} added with their PIN.`, `${name} ditambah dengan PIN mereka.`)
          : t(`${name} added (test view, no PIN).`, `${name} ditambah (paparan ujian, tiada PIN).`),
      );
      setName("");
      setNewPin("");
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "Unable to save the PIN.") +
          " " +
          t("The profile was added; set the PIN below.", "Profil telah ditambah; tetapkan PIN di bawah."),
      );
    } finally {
      setWorking(false);
    }
  }
  async function changePin() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await savePin(pinFor, pinValue);
      setNotice(t("New PIN saved. Any lockout is cleared.", "PIN baharu disimpan. Sekatan dibuka."));
      setPinFor("");
      setPinValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save the PIN.");
    } finally {
      setWorking(false);
    }
  }
  const status = (id: string) => pins.find((p) => p.profileId === id);
  const disabled = busy || working;
  return (
    <Panel
      title={t("Packer profiles & PINs", "Profil & PIN pembungkus")}
      detail={t(
        "Packers sign in with the shared packer account, tap their name and enter their own PIN. Give each PIN privately; set a new one if it is forgotten or shared.",
        "Pembungkus log masuk dengan akaun pembungkus bersama, pilih nama dan masukkan PIN sendiri. Beri PIN secara peribadi; tetapkan yang baharu jika terlupa atau dikongsi.",
      )}
    >
      <form
        className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="order-profile">
          {t("Packer name", "Nama pembungkus")}
          <Input value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
        </label>
        {live && (
          <label className="order-profile">
            {t("PIN (4–6 digits)", "PIN (4–6 digit)")}
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,6}"
              maxLength={6}
              required
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        <Button className="action-primary" disabled={disabled || !name.trim()}>
          <UserPlus size={16} />
          {t("Add packer", "Tambah pembungkus")}
        </Button>
      </form>
      <FormError message={error} className="mt-3" />
      {notice && <p className="text-sm text-success mt-3">{notice}</p>}
      {!!profiles.length && (
        <div className="table-scroll mt-4">
          <table>
            <thead>
              <tr>
                <th>{t("Packer", "Pembungkus")}</th>
                {live && <th>{t("PIN", "PIN")}</th>}
                <th>{t("Status", "Status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const pin = status(p.id);
                const active = p.active !== false;
                return (
                  <tr key={p.id}>
                    <td>
                      <PersonBadge name={p.name} lang={lang} compact />
                    </td>
                    {live && (
                      <td>
                        {!pin
                          ? t("Not set", "Belum ditetapkan")
                          : pin.lockedUntil
                            ? t("Locked after wrong PINs", "Disekat selepas PIN salah")
                            : t("Set", "Ditetapkan")}
                      </td>
                    )}
                    <td>{active ? t("Active", "Aktif") : t("Inactive", "Tidak aktif")}</td>
                    <td className="flex flex-wrap gap-2 justify-end">
                      {live && active && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled}
                          onClick={() => {
                            setPinFor(p.id);
                            setPinValue("");
                          }}
                        >
                          <Lock size={14} />
                          {t("New PIN", "PIN baharu")}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          void command("staff-profile-update", { id: p.id, active: !active })
                        }
                      >
                        {active ? t("Deactivate", "Nyahaktif") : t("Reactivate", "Aktifkan semula")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pinFor && (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void changePin();
          }}
        >
          <label className="order-profile">
            {t("New PIN for", "PIN baharu untuk")}{" "}
            {profiles.find((p) => p.id === pinFor)?.name}
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,6}"
              maxLength={6}
              required
              autoFocus
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <Button className="action-primary" disabled={disabled || pinValue.length < 4}>
            {t("Save PIN", "Simpan PIN")}
          </Button>
          <Button type="button" variant="outline" onClick={() => setPinFor("")}>
            {t("Cancel", "Batal")}
          </Button>
        </form>
      )}
    </Panel>
  );
}
