"use client";
import { useState } from "react";
import { Camera, Clock, ImageIcon, Plus, Truck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, Metric, Panel, type FormSpec } from "./draft-primitives";
import { TripPhoto } from "./trip-photo";
import {
  MAX_ASSISTANTS,
  MAX_DROPOFFS,
  toMyt,
  today,
  tr,
  tripAssistants,
  type Draft,
  type Lang,
  type Trip,
} from "@/lib/draft";

const nowMyt = () => toMyt(new Date().toISOString());
const time = (iso?: string) => (iso ? toMyt(iso).slice(11, 16) : "—");
const duration = (lang: Lang, trip: Trip) => {
  if (!trip.arriveAt) return "—";
  const minutes = Math.round(
    (Date.parse(trip.arriveAt) - Date.parse(trip.pickupAt)) / 60000,
  );
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return (h ? `${h} ${tr(lang, "h", "j")} ` : "") + `${m} min`;
};

/**
 * Drivers log trips on a shared sign-in: driver and assistant names, pickup and arrival
 * time, and a photo. Supervisors and management with trips.read see every trip at the site.
 */
export function DriverTrips({
  state,
  lang,
  canLog,
  canReview,
  userId,
  member,
  workspace,
  show,
}: {
  state: Draft;
  lang: Lang;
  canLog: boolean;
  canReview: boolean;
  userId?: string;
  member: boolean;
  workspace?: string;
  show: (spec: FormSpec) => void;
}) {
  const t = (en: string, ms: string) => tr(lang, en, ms);
  const [date, setDate] = useState(today);
  const trips = state.trips ?? [];
  // Members see their own trips unless they review the site; the preview sandbox is one account.
  const mine = (trip: Trip) => !member || trip.recordedBy?.userId === userId;
  const visible = canReview ? trips : trips.filter(mine);
  const onRoad = visible.filter((trip) => !trip.arriveAt);
  const listed = visible.filter((trip) => !date || trip.date === date);
  const photoField = {
    name: "photo",
    label: t("Photo", "Gambar"),
    type: "photo" as const,
    required: false,
    workspace,
  };
  const logTrip = () =>
    show({
      type: "trip",
      title: t("Log a trip", "Rekod perjalanan"),
      description: t(
        "Record your own trip in Malaysia time. Saved times cannot be changed, so check them first. You can add the arrival time and photo later.",
        "Rekod perjalanan anda dalam waktu Malaysia. Masa yang disimpan tidak boleh diubah, jadi semak dahulu. Masa tiba dan gambar boleh ditambah kemudian.",
      ),
      fields: [
        {
          name: "driver",
          label: t("Driver name", "Nama pemandu"),
          hint: t(
            "Your own name. Drivers share this sign-in, so every trip names its driver.",
            "Nama anda sendiri. Pemandu berkongsi log masuk ini, jadi setiap perjalanan menamakan pemandunya.",
          ),
        },
        {
          name: "assistant",
          label: t("Assistant driver", "Pembantu pemandu"),
          type: "list",
          max: MAX_ASSISTANTS,
          required: false,
          hint: t(
            "Leave blank if you drove alone. Use “Add another” for each extra assistant.",
            "Biarkan kosong jika memandu seorang. Gunakan “Tambah lagi” untuk setiap pembantu tambahan.",
          ),
        },
        {
          name: "pickupAt",
          label: t("Pickup time", "Masa ambil"),
          type: "datetime-local",
          value: nowMyt(),
        },
        {
          name: "arriveAt",
          label: t("Arrival time", "Masa tiba"),
          type: "datetime-local",
          required: false,
          hint: t(
            "Leave blank until you arrive.",
            "Biarkan kosong sehingga anda tiba.",
          ),
        },
        photoField,
        {
          name: "note",
          label: t("Trip note", "Catatan perjalanan"),
          required: false,
          hint: t(
            "For example where you went or what you collected.",
            "Contohnya destinasi atau barang yang diambil.",
          ),
        },
      ],
      submit: t("Save trip", "Simpan perjalanan"),
    });
  const addToTrip = (trip: Trip) =>
    show({
      type: "trip-update",
      title: trip.arriveAt
        ? t("Add trip photo", "Tambah gambar perjalanan")
        : t("Log arrival", "Rekod ketibaan"),
      description: t(
        "Only missing details can be added. Saved values cannot be changed.",
        "Hanya maklumat yang belum diisi boleh ditambah. Nilai yang disimpan tidak boleh diubah.",
      ),
      hidden: { id: trip.id },
      summary: [
        { label: t("Driver", "Pemandu"), value: trip.driver },
        { label: t("Pickup", "Ambil"), value: toMyt(trip.pickupAt).replace("T", " ") },
        {
          label: t("Assistant", "Pembantu"),
          value: tripAssistants(trip).join(", ") || t("None", "Tiada"),
        },
      ],
      fields: [
        ...(trip.arriveAt
          ? []
          : [
              {
                name: "arriveAt",
                label: t("Arrival time", "Masa tiba"),
                type: "datetime-local" as const,
                value: nowMyt(),
              },
            ]),
        ...(trip.photo ? [] : [photoField]),
      ],
      submit: t("Save", "Simpan"),
    });
  const ownOpen = (trip: Trip) => canLog && mine(trip) && (!trip.arriveAt || !trip.photo);
  // Drop-offs: the trip's own sign-in, open or already arrived, up to the limit.
  const canDrop = (trip: Trip) =>
    canLog && mine(trip) && (trip.dropoffs?.length ?? 0) < MAX_DROPOFFS;
  const addDropoff = (trip: Trip) =>
    show({
      type: "trip-dropoff",
      title: t("Log a drop-off", "Rekod penghantaran"),
      description: t(
        "Each drop-off needs its actual time and a photo as proof. Saved drop-offs cannot be changed.",
        "Setiap penghantaran memerlukan masa sebenar dan gambar sebagai bukti. Penghantaran yang disimpan tidak boleh diubah.",
      ),
      hidden: { id: trip.id },
      summary: [
        { label: t("Driver", "Pemandu"), value: trip.driver },
        { label: t("Pickup", "Ambil"), value: toMyt(trip.pickupAt).replace("T", " ") },
        {
          label: t("Drop-offs so far", "Penghantaran setakat ini"),
          value: String(trip.dropoffs?.length ?? 0),
        },
      ],
      fields: [
        {
          name: "at",
          label: t("Drop-off time", "Masa penghantaran"),
          type: "datetime-local",
          value: nowMyt(),
        },
        { ...photoField, label: t("Drop-off photo", "Gambar penghantaran"), required: true },
        {
          name: "note",
          label: t("Note", "Catatan"),
          required: false,
          hint: t("For example the shop or address.", "Contohnya kedai atau alamat."),
        },
      ],
      submit: t("Save drop-off", "Simpan penghantaran"),
    });
  const dropsToday = visible
    .flatMap((trip) => trip.dropoffs ?? [])
    .filter((d) => toMyt(d.at).slice(0, 10) === today()).length;
  const dropoffList = (trip: Trip) =>
    trip.dropoffs?.length ? (
      <ul className="dropoff-list">
        {trip.dropoffs.map((d, i) => (
          <li key={d.id}>
            <span>
              {i + 1}. {time(d.at)}
              {d.note ? " · " + d.note : ""}
            </span>
            <TripPhoto path={d.photo} lang={lang} />
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <>
      <div className="toolbar">
        <label className="inline-label">
          {t("Trips on", "Perjalanan pada")}
          <Input
            type="date"
            className="w-auto"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          {date && (
            <Button variant="ghost" size="sm" onClick={() => setDate("")}>
              {t("All dates", "Semua tarikh")}
            </Button>
          )}
        </label>
        {canLog && (
          <Button className="action-primary" onClick={logTrip}>
            <Truck size={16} />
            {t("Log a trip", "Rekod perjalanan")}
          </Button>
        )}
      </div>
      <div className="metrics-grid">
        <Metric
          label={t("Trips", "Perjalanan")}
          value={listed.length}
          detail={date ? date : t("All dates", "Semua tarikh")}
        />
        <Metric
          label={t("On the road", "Dalam perjalanan")}
          value={onRoad.length}
          detail={t("Arrival not logged yet", "Ketibaan belum direkod")}
        />
        <Metric
          label={t("With photo", "Dengan gambar")}
          value={listed.filter((trip) => trip.photo).length}
          detail={t("Of the trips shown", "Daripada perjalanan dipaparkan")}
        />
        <Metric
          label={t("Drop-offs today", "Penghantaran hari ini")}
          value={dropsToday}
          detail={t("Each with its own photo", "Setiap satu dengan gambar")}
        />
      </div>
      {onRoad.length > 0 && (
        <Panel
          title={t("On the road", "Dalam perjalanan")}
          detail={t(
            "Log the arrival time when the trip ends.",
            "Rekod masa tiba apabila perjalanan tamat.",
          )}
        >
          <div className="trip-cards">
            {onRoad.map((trip) => (
              <article key={trip.id}>
                <div>
                  <strong>
                    <Clock size={14} /> {t("Picked up", "Diambil")}{" "}
                    {toMyt(trip.pickupAt).replace("T", " ")}
                  </strong>
                  <small>
                    {trip.driver + " · "}
                    <UserRound size={12} />{" "}
                    {tripAssistants(trip).join(", ") || t("No assistant", "Tiada pembantu")}
                    {trip.note ? " · " + trip.note : ""}
                  </small>
                  {dropoffList(trip)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {canDrop(trip) && (
                    <Button variant="outline" onClick={() => addDropoff(trip)}>
                      <Plus size={14} />
                      {t("Drop-off", "Penghantaran")}
                    </Button>
                  )}
                  {ownOpen(trip) && (
                    <Button className="action-primary" onClick={() => addToTrip(trip)}>
                      {t("Log arrival", "Rekod ketibaan")}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Panel>
      )}
      <Panel
        title={
          canReview
            ? t("Driver trips", "Perjalanan pemandu")
            : t("Trips on this sign-in", "Perjalanan log masuk ini")
        }
        detail={t(
          "Malaysia time. Each trip names its driver and assistant.",
          "Waktu Malaysia. Setiap perjalanan menamakan pemandu dan pembantunya.",
        )}
      >
        {listed.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Date", "Tarikh")}</th>
                  <th>{t("Driver", "Pemandu")}</th>
                  <th>{t("Assistant", "Pembantu")}</th>
                  <th>{t("Pickup", "Ambil")}</th>
                  <th>{t("Arrival", "Tiba")}</th>
                  <th>{t("Duration", "Tempoh")}</th>
                  <th>{t("Photo", "Gambar")}</th>
                  <th>{t("Drop-offs", "Penghantaran")}</th>
                  <th>{t("Note", "Catatan")}</th>
                  {canLog && <th />}
                </tr>
              </thead>
              <tbody>
                {listed.map((trip) => (
                  <tr key={trip.id}>
                    <td>{trip.date}</td>
                    <td>{trip.driver}</td>
                    <td>{tripAssistants(trip).join(", ") || "—"}</td>
                    <td>{time(trip.pickupAt)}</td>
                    <td>{time(trip.arriveAt)}</td>
                    <td>{duration(lang, trip)}</td>
                    <td>
                      {trip.photo ? (
                        <TripPhoto path={trip.photo} lang={lang} />
                      ) : (
                        <span className="text-muted-foreground">
                          <ImageIcon size={14} className="inline" /> —
                        </span>
                      )}
                    </td>
                    <td>{dropoffList(trip) ?? "—"}</td>
                    <td>{trip.note || "—"}</td>
                    {canLog && (
                      <td>
                        {canDrop(trip) && (
                          <Button variant="outline" size="sm" onClick={() => addDropoff(trip)}>
                            <Plus size={14} />
                            {t("Drop-off", "Penghantaran")}
                          </Button>
                        )}
                        {ownOpen(trip) && (
                          <Button variant="outline" size="sm" onClick={() => addToTrip(trip)}>
                            {trip.arriveAt ? (
                              <>
                                <Camera size={14} />
                                {t("Add photo", "Tambah gambar")}
                              </>
                            ) : (
                              t("Log arrival", "Rekod ketibaan")
                            )}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {canLog
              ? t(
                  "No trips for this date. Use “Log a trip” when you pick up.",
                  "Tiada perjalanan pada tarikh ini. Gunakan “Rekod perjalanan” semasa mengambil.",
                )
              : t("No trips for this date.", "Tiada perjalanan pada tarikh ini.")}
          </Empty>
        )}
      </Panel>
    </>
  );
}
