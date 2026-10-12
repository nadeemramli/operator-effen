"use client";

import { useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { FormError } from "./form-error";
import { PersonBadge } from "./person-profile";
import {
  roleLabel,
  roles,
  tr,
  type Draft,
  type Lang,
  type TeamRole,
} from "@/lib/draft";

/**
 * A team's preset PIC names (production, stock-in or stock-out). The supervisor adds each
 * teammate once; every person field at the site then offers the name. Records keep the
 * name itself, so renaming or deactivating a profile never rewrites history.
 */
export function TeamProfiles({
  state,
  lang,
  busy,
  team,
  command,
}: {
  state: Draft;
  lang: Lang;
  busy: boolean;
  team: TeamRole;
  command: (
    type: string,
    input: Record<string, unknown>,
  ) => Promise<Draft | null>;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [renaming, setRenaming] = useState(""),
    [newName, setNewName] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [working, setWorking] = useState(false);
  const teamName =
    roles.find((r) => r.id === team)?.[lang === "ms" ? "ms" : "en"] ??
    roleLabel(team);
  const profiles = (state.staffProfiles ?? []).filter((p) => p.role === team);
  const disabled = busy || working;
  async function run(
    type: string,
    input: Record<string, unknown>,
    done: string,
  ) {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const saved = await command(type, input);
      if (saved) setNotice(done);
      return !!saved;
    } finally {
      setWorking(false);
    }
  }
  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await run(
      "staff-profile-create",
      { profileId: crypto.randomUUID(), name: trimmed, role: team },
      t(
        `${trimmed} added to the ${teamName} list.`,
        `${trimmed} ditambah ke senarai ${teamName}.`,
      ),
    );
    if (ok) setName("");
  }
  async function rename() {
    const trimmed = newName.trim();
    if (!trimmed || !renaming) return;
    const ok = await run(
      "staff-profile-update",
      { id: renaming, name: trimmed },
      t(
        "Renamed. Earlier records keep the name they were saved with.",
        "Dinamakan semula. Rekod terdahulu mengekalkan nama asal.",
      ),
    );
    if (ok) {
      setRenaming("");
      setNewName("");
    }
  }
  const label = t(`${teamName} team`, `Pasukan ${teamName}`);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          className="team-button"
          aria-label={label}
          title={label}
        >
          <Users size={15} />
          <span>{t("Team", "Pasukan")}</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b px-[23px] py-5 pr-12">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription className="text-xs">
            {t(
              "The people offered wherever this team records who did the work (PIC). Add a teammate once; the name is then a preset for everyone at the site. Deactivate someone who has left: their recorded work stays.",
              "Nama yang ditawarkan apabila pasukan ini merekod siapa yang melakukan kerja (PIC). Tambah rakan sepasukan sekali; nama itu menjadi pilihan tetap untuk semua di tapak. Nyahaktifkan orang yang telah pergi: kerja yang direkodkan kekal.",
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-[23px] py-5 space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_auto] items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label className="order-profile">
              {t("Teammate's name", "Nama rakan sepasukan")}
              <Input
                value={name}
                maxLength={60}
                required
                autoComplete="off"
                placeholder={t(
                  "Full name or name and initial",
                  "Nama penuh atau nama dan inisial",
                )}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button
              className="action-primary"
              disabled={disabled || !name.trim()}
            >
              <UserPlus size={16} />
              {t("Add to team", "Tambah ke pasukan")}
            </Button>
          </form>
          <FormError message={error} />
          {notice && <p className="text-sm text-success">{notice}</p>}
          {profiles.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("Teammate", "Rakan sepasukan")}</th>
                    <th>{t("Status", "Status")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => {
                    const active = p.active !== false;
                    return (
                      <tr key={p.id}>
                        <td>
                          <PersonBadge name={p.name} lang={lang} compact />
                        </td>
                        <td>
                          {active
                            ? t("Active", "Aktif")
                            : t("Inactive", "Tidak aktif")}
                        </td>
                        <td className="flex flex-wrap gap-2 justify-end">
                          {active && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={disabled}
                              onClick={() => {
                                setRenaming(p.id);
                                setNewName(p.name);
                              }}
                            >
                              {t("Rename", "Namakan semula")}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={disabled}
                            onClick={() =>
                              void run(
                                "staff-profile-update",
                                { id: p.id, active: !active },
                                active
                                  ? t(
                                      `${p.name} is no longer offered as a PIC.`,
                                      `${p.name} tidak lagi ditawarkan sebagai PIC.`,
                                    )
                                  : t(
                                      `${p.name} is offered as a PIC again.`,
                                      `${p.name} ditawarkan sebagai PIC semula.`,
                                    ),
                              )
                            }
                          >
                            {active
                              ? t("Deactivate", "Nyahaktif")
                              : t("Reactivate", "Aktifkan semula")}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "Nobody yet. Add the teammates who do this team's work; records can also add a name on the spot.",
                "Belum ada. Tambah rakan sepasukan yang melakukan kerja pasukan ini; rekod juga boleh menambah nama serta-merta.",
              )}
            </p>
          )}
          {renaming && (
            <form
              className="grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <label className="order-profile">
                {t("New name for", "Nama baharu untuk")}{" "}
                {profiles.find((p) => p.id === renaming)?.name}
                <Input
                  value={newName}
                  maxLength={60}
                  required
                  autoFocus
                  autoComplete="off"
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <Button
                className="action-primary"
                disabled={disabled || !newName.trim()}
              >
                {t("Save name", "Simpan nama")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenaming("")}
              >
                {t("Cancel", "Batal")}
              </Button>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
