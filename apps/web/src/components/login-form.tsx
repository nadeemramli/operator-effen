"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  Factory,
  ScanLine,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const router = useRouter();
  const [lang, setLang] = useState<"en" | "ms">("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = (en: string, ms: string) => (lang === "ms" ? ms : en);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok)
        throw new Error(
          t(
            "The username or password is incorrect. Please try again.",
            "Nama pengguna atau kata laluan tidak betul. Sila cuba lagi.",
          ),
        );
      router.replace("/");
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
          <span className="status-pill tone-warning">
            {t("TEAM TESTING", "UJIAN PASUKAN")}
          </span>
          <h2>{t("Welcome to Operator", "Selamat datang ke Operator")}</h2>
          <p className="text-muted-foreground">
            {t(
              "Sign in to explore your team's new workspace.",
              "Log masuk untuk mencuba ruang kerja baharu pasukan anda.",
            )}
          </p>
          <form onSubmit={submit} className="space-y-5 mt-8">
            <div className="space-y-2">
              <Label htmlFor="username">
                {t("Team username", "Nama pengguna pasukan")}
              </Label>
              <Input
                id="username"
                name="username"
                type="email"
                autoComplete="username"
                placeholder="team@effengroup.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("Password", "Kata laluan")}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
              />
            </div>
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
                "A safe place to test. All records are fictional and separate from live operations. Use the shared credentials provided by Nadeem.",
                "Ruang selamat untuk ujian. Semua rekod ialah contoh rekaan dan berasingan daripada operasi sebenar. Gunakan maklumat log masuk daripada Nadeem.",
              )}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
