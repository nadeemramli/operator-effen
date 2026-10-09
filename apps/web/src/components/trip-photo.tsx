"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { FormError } from "./form-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tr, type Lang } from "@/lib/draft";

const MAX_SIDE = 1600;

/** Re-encodes a camera or gallery image as a resized JPEG (also strips its metadata). */
async function toJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  }).catch(() => null);
  if (!bitmap) throw new Error("unreadable");
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("unreadable"))),
      "image/jpeg",
      0.82,
    ),
  );
}

/**
 * Photo field for the trip forms. The photo is uploaded as soon as it is chosen; the form
 * submits only its stored path, and cannot be submitted while an upload is in progress.
 */
export function TripPhotoInput({
  name,
  lang,
  workspace,
}: {
  name: string;
  lang: Lang;
  workspace?: string;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const input = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState(""),
    [preview, setPreview] = useState(""),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => () => URL.revokeObjectURL(preview), [preview]);
  async function choose(file?: File) {
    setPath("");
    setPreview("");
    setError("");
    if (!file) {
      input.current?.setCustomValidity("");
      return;
    }
    setUploading(true);
    input.current?.setCustomValidity(
      t("Wait for the photo to finish uploading.", "Tunggu gambar selesai dimuat naik."),
    );
    try {
      const blob = await toJpeg(file).catch(() => {
        throw new Error(
          t(
            "This photo could not be read. Take it again or choose a JPEG or PNG photo.",
            "Gambar ini tidak dapat dibaca. Ambil semula atau pilih gambar JPEG atau PNG.",
          ),
        );
      });
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const res = await fetch("/api/trip-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, size: blob.size, workspace }),
      });
      const signed = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          signed.error ?? t("Unable to upload the photo.", "Gambar tidak dapat dimuat naik."),
        );
      if (!signed.exists) {
        const sent = await fetch(signed.url, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        }).catch(() => null);
        if (!sent?.ok)
          throw new Error(
            t(
              "Photo upload failed. Check your connection and try again.",
              "Muat naik gambar gagal. Semak sambungan dan cuba lagi.",
            ),
          );
      }
      setPath(signed.path);
      setPreview(URL.createObjectURL(blob));
      input.current?.setCustomValidity("");
    } catch (e) {
      // Leave the form usable: the trip can be saved without a photo and the photo added later.
      if (input.current) input.current.value = "";
      input.current?.setCustomValidity("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }
  return (
    <div className="trip-photo-input">
      <Input
        ref={input}
        id={"field-" + name}
        type="file"
        accept="image/*"
        onChange={(event) => void choose(event.currentTarget.files?.[0])}
      />
      <input type="hidden" name={name} value={path} />
      {uploading && (
        <p className="field-hint">{t("Uploading photo…", "Memuat naik gambar…")}</p>
      )}
      {preview && (
        // A local preview of the photo that was just uploaded.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={t("Selected trip photo", "Gambar perjalanan dipilih")} />
      )}
      <FormError message={error} />
    </div>
  );
}

/** Thumbnail of a stored trip photo; opens larger on click. Signed URLs are short-lived. */
export function TripPhoto({ path, lang }: { path: string; lang: Lang }) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false),
    [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/trip-photos?path=" + encodeURIComponent(path), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => active && setUrl(data.url))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [path]);
  if (failed)
    return <span className="text-muted-foreground">{t("Unavailable", "Tiada")}</span>;
  if (!url) return <span className="text-muted-foreground">…</span>;
  const alt = t("Trip photo", "Gambar perjalanan");
  return (
    <>
      <button type="button" className="trip-photo-thumb" onClick={() => setOpen(true)}>
        {/* Signed storage URL; next/image cannot optimize it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{alt}</DialogTitle>
            <DialogDescription className="sr-only">{alt}</DialogDescription>
          </DialogHeader>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="trip-photo-full" src={url} alt={alt} />
        </DialogContent>
      </Dialog>
    </>
  );
}
