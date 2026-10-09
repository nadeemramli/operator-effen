"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  Eye,
  EyeOff,
  Factory,
  ScanLine,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({
  expired = false,
  next = "/",
}: {
  expired?: boolean;
  /** Where to go after sign-in; already checked by the server to be a path on this site. */
  next?: string;
}) {
  const router = useRouter();
  const [lang, setLang] = useState<"en" | "ms">("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reveal, setReveal] = useState(false);
  const t = (en: string, ms: string) => (lang === "ms" ? ms : en);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const values = {
      username: form.get("username"),
      password: form.get("password"),
      remember: form.get("remember") === "on",
    };
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const { reason } = await response.json().catch(() => ({}));
        throw new Error(
          reason === "no-access"
            ? t(
                "Your password is correct, but this account has not been given Operator access yet. Ask Nadeem to enable it.",
                "Kata laluan anda betul, tetapi akaun ini belum diberi akses Operator. Minta Nadeem mengaktifkannya.",
              )
            : reason === "unconfirmed"
              ? t(
                  "This account's email address has not been confirmed yet. Ask Nadeem to confirm it.",
                  "Alamat e-mel akaun ini belum disahkan. Minta Nadeem mengesahkannya.",
                )
              : reason === "rate-limited"
                ? t(
                    "Too many attempts. Wait a minute, then try again.",
                    "Terlalu banyak cubaan. Tunggu seminit, kemudian cuba lagi.",
                  )
                : reason === "unavailable"
                  ? t(
                      "Operator could not check your access right now. Please try again shortly.",
                      "Operator tidak dapat menyemak akses anda sekarang. Sila cuba sebentar lagi.",
                    )
                  : t(
                      "The username or password is incorrect. Please try again.",
                      "Nama pengguna atau kata laluan tidak betul. Sila cuba lagi.",
                    ),
        );
      }
      router.replace(next);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign in.");
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">e.</span>
          <span>
            operator<span className="brand-company">EFFEN GROUP</span>
          </span>
        </div>
        <div className="login-message">
          <div className="eyebrow">
            {t("CONNECTED OPERATIONS", "OPERASI BERHUBUNG")}
          </div>
          <h1>
            {t("Every batch.", "Setiap kelompok.")}
            <br />
            {t("Every parcel.", "Setiap bungkusan.")}
            <br />
            <span className="text-success">
              {t("One clear picture.", "Satu gambaran jelas.")}
            </span>
          </h1>
          <p>
            {t(
              "From the factory floor to the customer's door. A shared workspace for the people behind every EFFEN product.",
              "Dari kilang ke pintu pelanggan. Ruang kerja bersama untuk pasukan di sebalik setiap produk EFFEN.",
            )}
          </p>
          <div className="login-flow">
            {[
              { Icon: Factory, label: t("Produce", "Hasilkan") },
              { Icon: Boxes, label: t("Receive", "Terima") },
              { Icon: ScanLine, label: t("Fulfil", "Penuhi") },
            ].map(({ Icon, label }, i) => (
              <div key={label}>
                <span>
                  <Icon size={21} />
                </span>
                <small>0{i + 1}</small>
                <strong>{label}</strong>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          EFFEN Group ·{" "}
          {t(
            "Operations, with accountability.",
            "Operasi dengan tanggungjawab.",
          )}
        </p>
      </section>
      <section className="login-panel">
        <Button
          variant="ghost"
          className="language-button"
          onClick={() => setLang(lang === "en" ? "ms" : "en")}
        >
          {lang === "en" ? "Bahasa Melayu" : "English"}
        </Button>
        <div className="login-card">
          <h2>{t("Welcome to Operator", "Selamat datang ke Operator")}</h2>
          <p className="text-muted-foreground">
            {t(
              "Sign in with your own Operator account.",
              "Log masuk dengan akaun Operator anda sendiri.",
            )}
          </p>
          {expired && (
            <div className="save-notice mt-6" role="status">
              {t(
                "Your session ended. Sign in again; any unsaved entry is kept on this device and can be resubmitted.",
                "Sesi anda tamat. Log masuk semula; entri yang belum disimpan kekal pada peranti ini dan boleh dihantar semula.",
              )}
            </div>
          )}
          <form onSubmit={submit} className="space-y-5 mt-8">
            <div className="space-y-2">
              <Label htmlFor="username">
                {t("Work email", "E-mel kerja")}
              </Label>
              <Input
                id="username"
                name="username"
                type="email"
                autoComplete="username"
                placeholder="name@effengroup.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("Password", "Kata laluan")}</Label>
              <div className="password-field">
                <Input
                  id="password"
                  name="password"
                  type={reveal ? "text" : "password"}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  onClick={() => setReveal(!reveal)}
                  aria-pressed={reveal}
                  aria-controls="password"
                  aria-label={
                    reveal
                      ? t("Hide password", "Sembunyikan kata laluan")
                      : t("Show password", "Tunjukkan kata laluan")
                  }
                  title={
                    reveal
                      ? t("Hide password", "Sembunyikan kata laluan")
                      : t("Show password", "Tunjukkan kata laluan")
                  }
                >
                  {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <label className="remember-field">
              <input type="checkbox" name="remember" />
              <span>
                {t("Keep me signed in", "Kekal log masuk")}
                <small>
                  {t(
                    "On your own device only. Leave unticked on shared devices; you will be signed out when the browser closes.",
                    "Pada peranti anda sendiri sahaja. Biarkan kosong pada peranti dikongsi; anda akan dilog keluar apabila pelayar ditutup.",
                  )}
                </small>
              </span>
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="action-primary w-full h-11"
              disabled={busy}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {busy
                ? t("Signing in…", "Sedang log masuk…")
                : t("Enter workspace", "Masuk ruang kerja")}
              <ArrowRight size={16} />
            </Button>
          </form>
          <div className="login-note">
            <ShieldCheck size={19} />
            <p>
              {t(
                "Live operations. What you can see and record follows your role. Ask Nadeem if your role is wrong or you need a password reset.",
                "Operasi sebenar. Apa yang anda boleh lihat dan rekod mengikut peranan anda. Hubungi Nadeem jika peranan anda salah atau anda perlu tetapkan semula kata laluan.",
              )}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
