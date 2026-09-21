import { people, tr, type Lang } from "@/lib/draft";

const colors = [
  "#4f9ed8",
  "#39bc98",
  "#c39b56",
  "#a18bce",
  "#d38291",
  "#66aeb9",
];

/** Illustrative avatars for the existing fictional identities, never staff photos. */
export function PersonAvatar({ name }: { name: string }) {
  const index = people.indexOf(name);
  const color = colors[Math.max(index, 0) % colors.length];
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
      <span className="pic-avatar-mark">{name.split(" ").at(-1) || "?"}</span>
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

export function PersonPicker({
  name,
  label,
  options,
  value,
  required = true,
  lang,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  value?: string | number;
  required?: boolean;
  lang: Lang;
}) {
  return (
    <div className="pic-picker" role="radiogroup" aria-label={label}>
      {options.map((person, index) => (
        <label className="pic-option" key={person.value}>
          <input
            type="radio"
            id={index === 0 ? "field-" + name : undefined}
            name={name}
            value={person.value}
            defaultChecked={person.value === value}
            required={required}
          />
          <PersonBadge
            name={person.label}
            lang={lang}
            caption={tr(lang, "Select performer", "Pilih pelaksana")}
          />
        </label>
      ))}
    </div>
  );
}
