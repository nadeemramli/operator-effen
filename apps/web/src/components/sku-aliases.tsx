"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { FormError, Panel } from "./draft-primitives";
import { products, tr, type Draft, type Lang } from "@/lib/draft";
import { packageDefaults, type SkuAlias } from "@/lib/awb-import";

type Command = (
  type: string,
  input: Record<string, unknown>,
  options?: { onError?: (message: string) => void },
) => Promise<Draft | null>;
const blank = { sku: "", product: "", units: "", canonical: "", reason: "" };
const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

/**
 * Package SKUs (office admin): the built-in package defaults, read-only, and the SKUs the
 * site mapped itself. A mapped SKU is recognised by every later AWB import; a mapping no
 * longer in use is retired, never deleted.
 */
export function SkuAliasPanel({
  state,
  lang,
  busy,
  command,
}: {
  state: Draft;
  lang: Lang;
  busy: boolean;
  command: Command;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [form, setForm] = useState(blank),
    [editing, setEditing] = useState<SkuAlias | null>(null),
    [status, setStatus] = useState<{ alias: SkuAlias; reason: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const aliases = [...(state.skuAliases ?? [])].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.sku.localeCompare(b.sku),
  );
  const set = (patch: Partial<typeof blank>) => setForm({ ...form, ...patch });
  async function run(
    type: string,
    input: Record<string, unknown>,
    done: string,
  ) {
    setError("");
    setNotice("");
    const saved = await command(type, input, { onError: setError });
    if (saved) setNotice(done);
    return !!saved;
  }
  async function save() {
    const sku = form.sku.trim().toLowerCase();
    const ok = await run(
      "sku-alias-save",
      {
        ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
        sku,
        product: form.product,
        units: form.units,
        canonical: form.canonical,
        ...(editing ? { reason: form.reason } : {}),
      },
      editing
        ? t(
            `${sku} updated. Labels read from now on use the new details.`,
            `${sku} dikemas kini. Label yang dibaca selepas ini menggunakan butiran baharu.`,
          )
        : t(
            `${sku} mapped. Every later import recognises it.`,
            `${sku} dipetakan. Setiap import selepas ini mengenalinya.`,
          ),
    );
    if (ok) {
      setForm(blank);
      setEditing(null);
    }
  }
  async function changeStatus() {
    if (!status) return;
    const { alias, reason } = status;
    const ok = await run(
      alias.active ? "sku-alias-retire" : "sku-alias-reactivate",
      { id: alias.id, reason, expectedVersion: alias.version },
      alias.active
        ? t(
            `${alias.sku} retired. Labels with it need the product entered again.`,
            `${alias.sku} dihentikan. Label dengannya perlu produk dimasukkan semula.`,
          )
        : t(
            `${alias.sku} is recognised again.`,
            `${alias.sku} dikenali semula.`,
          ),
    );
    if (ok) setStatus(null);
  }
  return (
    <Panel
      title={t("Package SKUs", "SKU pakej")}
      detail={t(
        "The SKU printed on an AWB label and the package it stands for. Map a new SKU once: every later import recognises it. Built-in SKUs are fixed.",
        "SKU yang dicetak pada label AWB dan pakej yang diwakilinya. Petakan SKU baharu sekali: setiap import selepas ini mengenalinya. SKU terbina dalam adalah tetap.",
      )}
    >
      <div className="awb-upload-body">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="awb-fields">
            <label>
              SKU
              <Input
                value={form.sku}
                maxLength={40}
                required
                autoComplete="off"
                placeholder={t("As printed on the label", "Seperti pada label")}
                onChange={(e) => set({ sku: e.target.value })}
              />
            </label>
            <label>
              {t("Product", "Produk")}
              <select
                className="form-select"
                value={form.product}
                required
                onChange={(e) => set({ product: e.target.value })}
              >
                <option value="">{t("Select", "Pilih")}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Units / package", "Unit / pakej")}
              <Input
                type="number"
                min={1}
                max={1000}
                required
                value={form.units}
                onChange={(e) => set({ units: e.target.value })}
              />
            </label>
            <label>
              {t("Package label (optional)", "Label pakej (pilihan)")}
              <Input
                value={form.canonical}
                maxLength={60}
                autoComplete="off"
                placeholder={t("For example SYN-SG-PK8", "Contoh SYN-SG-PK8")}
                onChange={(e) => set({ canonical: e.target.value })}
              />
            </label>
            {editing && (
              <label>
                {t("Reason for the change", "Sebab perubahan")}
                <Input
                  value={form.reason}
                  maxLength={500}
                  required
                  onChange={(e) => set({ reason: e.target.value })}
                />
              </label>
            )}
          </div>
          <div className="awb-actions">
            {editing && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                }}
              >
                {t("Cancel", "Batal")}
              </Button>
            )}
            <Button className="action-primary" disabled={busy}>
              {editing ? null : <Plus size={16} />}
              {editing
                ? t(`Save changes to ${editing.sku}`, `Simpan perubahan ${editing.sku}`)
                : t("Map SKU", "Petakan SKU")}
            </Button>
          </div>
        </form>
        <FormError message={error} />
        {notice && <p className="text-sm text-success">{notice}</p>}
        {status && (
          <form
            className="awb-receive"
            onSubmit={(e) => {
              e.preventDefault();
              void changeStatus();
            }}
          >
            <label>
              {status.alias.active
                ? t(`Why retire ${status.alias.sku}?`, `Mengapa hentikan ${status.alias.sku}?`)
                : t(
                    `Why reactivate ${status.alias.sku}?`,
                    `Mengapa aktifkan semula ${status.alias.sku}?`,
                  )}
              <Input
                value={status.reason}
                maxLength={500}
                required
                autoFocus
                onChange={(e) => setStatus({ ...status, reason: e.target.value })}
              />
            </label>
            <Button type="submit" variant="outline" disabled={busy}>
              {status.alias.active
                ? t("Retire mapping", "Hentikan pemetaan")
                : t("Reactivate mapping", "Aktifkan semula pemetaan")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStatus(null)}>
              {t("Cancel", "Batal")}
            </Button>
          </form>
        )}
        {aliases.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>{t("Product", "Produk")}</th>
                  <th className="num">{t("Units / package", "Unit / pakej")}</th>
                  <th>{t("Package label", "Label pakej")}</th>
                  <th>{t("Status", "Status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {aliases.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.sku}</td>
                    <td>{productName(a.product)}</td>
                    <td className="num">{a.units}</td>
                    <td>{a.canonical}</td>
                    <td>
                      <span
                        className={
                          "status-pill " + (a.active ? "tone-muted" : "tone-warning")
                        }
                      >
                        {a.active ? t("Active", "Aktif") : t("Retired", "Dihentikan")}
                      </span>
                    </td>
                    <td className="flex flex-wrap gap-2 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setEditing(a);
                          setStatus(null);
                          setError("");
                          setNotice("");
                          setForm({
                            sku: a.sku,
                            product: a.product,
                            units: String(a.units),
                            canonical: a.canonical,
                            reason: "",
                          });
                        }}
                      >
                        {t("Edit", "Sunting")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setStatus({ alias: a, reason: "" });
                          setError("");
                          setNotice("");
                        }}
                      >
                        {a.active
                          ? t("Retire", "Hentikan")
                          : t("Reactivate", "Aktifkan semula")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              "No mapped SKUs yet. Map one here, or use “Remember this SKU” on a label whose SKU is unknown.",
              "Belum ada SKU dipetakan. Petakan di sini, atau gunakan “Ingat SKU ini” pada label yang SKU-nya tidak dikenali.",
            )}
          </p>
        )}
        <details className="field-hint">
          <summary>
            {t(
              `Built-in SKUs (${packageDefaults.length}) · fixed`,
              `SKU terbina dalam (${packageDefaults.length}) · tetap`,
            )}
          </summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>{t("Product", "Produk")}</th>
                  <th className="num">{t("Units / package", "Unit / pakej")}</th>
                  <th>{t("Package label", "Label pakej")}</th>
                </tr>
              </thead>
              <tbody>
                {packageDefaults.map((p) => (
                  <tr key={p.sku}>
                    <td className="mono">{p.sku}</td>
                    <td>{productName(p.product)}</td>
                    <td className="num">{p.units}</td>
                    <td>{p.canonical}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </Panel>
  );
}
