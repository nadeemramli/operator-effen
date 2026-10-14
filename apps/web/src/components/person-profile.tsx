"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { people, tr, type Lang } from "@/lib/draft";

const colors = [
  "#4f9ed8",
  "#39bc98",
  "#c39b56",
  "#a18bce",
  "#d38291",
  "#66aeb9",
];
/** A stable colour per name, so the same teammate keeps the same avatar everywhere. */
const colorIndex = (name: string) => {
  const sample = people.indexOf(name);
  if (sample >= 0) return sample;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 1000003;
  return hash;
};

/** Illustrative avatars (initial and colour), never staff photos. */
export function PersonAvatar({ name }: { name: string }) {
  const index = colorIndex(name);
  const color = colors[index % colors.length];
  return (
    <span
      className="pic-avatar"
      style={{ background: color + "25" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path d="M4 48c0-12 8-19 20-19s20 7 20 19" fill={color} />
        <path d="M19 26h10v9c-3 3-7 3-10 0z" fill="#bb8667" />
        <ellipse
          cx="24"
          cy="19"
          rx="10"
          ry="12"
          fill={index % 2 ? "#c99675" : "#e0b190"}
        />
        <path
          d={
            index % 2
              ? "M13 22V14c0-13 22-13 22 0v8l-4-9-7 2-7-2z"
              : "M13 20v-6c0-12 22-12 22 0v7l-5-11-13 5z"
          }
          fill="#303849"
        />
        <circle cx="20" cy="19" r="1" fill="#303849" />
        <circle cx="28" cy="19" r="1" fill="#303849" />
        <path
          d="M21 25q3 2 6 0"
          fill="none"
          stroke="#835a4c"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      <span className="pic-avatar-mark">
        {(name.split(" ").at(-1)?.[0] || "?").toUpperCase()}
      </span>
    </span>
  );
}

export function PersonBadge({
  name,
  lang,
  caption,
  compact = false,
}: {
  name: string;
  lang: Lang;
  caption?: string;
  compact?: boolean;
}) {
  if (!name)
    return (
      <span className="text-muted-foreground">
        {tr(lang, "Not assigned", "Belum ditugaskan")}
      </span>
    );
  const sample = people.includes(name);
  return (
    <span className={"pic-profile" + (compact ? " pic-profile-compact" : "")}>
      <PersonAvatar name={name} />
      <span className="pic-identity">
        <strong>{name}</strong>
        <small className={compact ? "sr-only" : undefined}>
          {caption ?? tr(lang, "Person responsible", "Orang bertanggungjawab")}
          {sample ? tr(lang, " · Sample profile", " · Profil contoh") : ""}
        </small>
      </span>
    </span>
  );
}

/**
 * The person field's value when the supervisor types a name that is not a preset yet. The
 * typed name travels in the companion `<name>_new` input; the app turns it into a team
 * profile before saving the record, so it is a preset from then on.
 */
export const NEW_PERSON = "__new__";
export const newPersonField = (name: string) => name + "_new";

function NewPersonInput({
  name,
  lang,
  autoFocus,
}: {
  name: string;
  lang: Lang;
  autoFocus?: boolean;
}) {
  return (
    <Input
      id={"field-" + newPersonField(name)}
      name={newPersonField(name)}
      className="mt-2"
      aria-label={tr(lang, "Name of the person", "Nama orang itu")}
      placeholder={tr(
        lang,
        "Full name or name and initial",
        "Nama penuh atau nama dan inisial",
      )}
      maxLength={60}
      required
      autoFocus={autoFocus}
      autoComplete="off"
    />
  );
}

/**
 * Tap-to-select cards for the person responsible. With `newOption`, a last card lets the
 * supervisor type someone who is not in the list yet; it is selected by default when the
 * list is empty, so a new site can record its first entry straight away.
 */
export function PersonPicker({
  name,
  label,
  options,
  value,
  required = true,
  lang,
  newOption,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  value?: string | number;
  required?: boolean;
  lang: Lang;
  newOption?: string;
}) {
  const initial =
    value !== undefined && options.some((o) => o.value === value)
      ? String(value)
      : newOption && !options.length
        ? NEW_PERSON
        : "";
  const [chosen, setChosen] = useState(initial);
  return (
    <div className="pic-picker" role="radiogroup" aria-label={label}>
      {options.map((person, index) => (
        <label className="pic-option" key={person.value}>
          <input
            type="radio"
            id={index === 0 ? "field-" + name : undefined}
            name={name}
            value={person.value}
            checked={chosen === person.value}
            onChange={() => setChosen(person.value)}
            required={required}
          />
          <PersonBadge
            name={person.label}
            lang={lang}
            caption={tr(lang, "Select performer", "Pilih pelaksana")}
          />
        </label>
      ))}
      {newOption && (
        <label className="pic-option pic-option-new">
          <input
            type="radio"
            id={options.length ? undefined : "field-" + name}
            name={name}
            value={NEW_PERSON}
            checked={chosen === NEW_PERSON}
            onChange={() => setChosen(NEW_PERSON)}
            required={required}
          />
          <span className="pic-identity">
            <strong>{newOption}</strong>
            <small>
              {tr(
                lang,
                "Added to this list for everyone at the site",
                "Ditambah ke senarai ini untuk semua di tapak",
              )}
            </small>
          </span>
          {chosen === NEW_PERSON && (
            <span className="pic-option-input">
              <NewPersonInput
                name={name}
                lang={lang}
                autoFocus={!!options.length}
              />
            </span>
          )}
        </label>
      )}
    </div>
  );
}

/** Compact person field for dense forms: a select, plus a name input when "someone else" is chosen. */
export function PersonSelect({
  name,
  options,
  value,
  required = true,
  lang,
  newOption,
  invalid,
  placeholder,
}: {
  name: string;
  options: { value: string; label: string }[];
  value?: string | number;
  required?: boolean;
  lang: Lang;
  newOption?: string;
  invalid?: boolean;
  /** Text of the empty choice; optional fields keep it selectable. */
  placeholder?: string;
}) {
  // An empty required list opens on "someone else"; an optional field stays unassigned.
  const initial =
    value !== undefined && options.some((o) => o.value === value)
      ? String(value)
      : newOption && !options.length && required
        ? NEW_PERSON
        : "";
  const [chosen, setChosen] = useState(initial);
  return (
    <>
      <select
        id={"field-" + name}
        aria-invalid={invalid}
        name={name}
        className="form-select"
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        required={required}
      >
        <option value="" disabled={required}>
          {placeholder ??
            (required
              ? tr(lang, "Select…", "Pilih…")
              : tr(lang, "Not specified", "Tidak dinyatakan"))}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {newOption && <option value={NEW_PERSON}>{newOption}</option>}
      </select>
      {chosen === NEW_PERSON && (
        <NewPersonInput name={name} lang={lang} autoFocus />
      )}
    </>
  );
}
