import { Pencil, Plane, Plus, Trash2, User } from "lucide-react";
import type { Flight, TripAttachment } from "../../lib/travel/types";
import {
  arriveByISO,
  formatDateTimeWithZone,
  formatTimeWithZone,
  leaveByISO,
} from "../../lib/travel/dates";
import { DirectionsButton } from "../maps/DirectionsButton";
import { CopyButton } from "./CopyButton";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { useT } from "../../lib/i18n";

export function FlightsSection({
  tripId,
  flights,
  attachments,
  canEdit,
  codesVisible,
  nameOf,
  onAdd,
  onEdit,
  onDelete,
  onAttachmentsChanged,
}: {
  tripId: string;
  flights: Flight[];
  attachments: TripAttachment[];
  canEdit: boolean;
  codesVisible: boolean;
  nameOf: (id: string) => string;
  onAdd: () => void;
  onEdit: (f: Flight) => void;
  onDelete: (f: Flight) => void;
  onAttachmentsChanged: () => void;
}) {
  const t = useT();
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><Plane size={16} aria-hidden /> {t("travelDetail.tab.flights")}</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> {t("travelFlights.addFlight")}
          </button>
        )}
      </div>

      {flights.length === 0 ? (
        <p className="muted travel-empty-note">{t("travelFlights.noFlights")}</p>
      ) : (
        <div className="travel-cards">
          {flights.map((f) => {
            const arriveBy = arriveByISO(f.depart_at, f.minutes_before_departure);
            const leaveBy = leaveByISO(
              f.depart_at,
              f.minutes_before_departure,
              f.drive_minutes_to_airport,
            );
            return (
              <article key={f.id} className="travel-card">
                <div className="travel-card-head">
                  <strong>
                    {[f.airline, f.flight_number].filter(Boolean).join(" ") || t("travelTimeline.flightFallback")}
                  </strong>
                  {f.profile_id ? (
                    <span className="travel-badge"><User size={12} aria-hidden /> {nameOf(f.profile_id)}</span>
                  ) : (
                    <span className="travel-badge travel-badge-crew">{t("travelFlights.wholeCrew")}</span>
                  )}
                  {canEdit && (
                    <span className="travel-card-tools">
                      <button aria-label={t("travelFlights.editFlight")} onClick={() => onEdit(f)}><Pencil size={14} /></button>
                      <button aria-label={t("travelFlights.deleteFlight")} onClick={() => onDelete(f)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </div>

                <div className="travel-route">
                  <span>{f.depart_airport ?? "—"}</span>
                  <span aria-hidden>→</span>
                  <span>{f.arrive_airport ?? "—"}</span>
                  <DirectionsButton address={f.depart_airport} label={t("travelFlights.airport")} />
                </div>

                <dl className="travel-kv">
                  <div><dt>{t("travelFlights.departs")}</dt><dd>{formatDateTimeWithZone(f.depart_at, f.depart_timezone) ?? "—"}</dd></div>
                  <div><dt>{t("travelFlights.arrives")}</dt><dd>{formatDateTimeWithZone(f.arrive_at, f.arrive_timezone) ?? "—"}</dd></div>
                  {leaveBy && (
                    <div className="travel-kv-hot"><dt>{t("travelFlights.leaveBy")}</dt><dd>{formatTimeWithZone(leaveBy, f.depart_timezone)}</dd></div>
                  )}
                  <div className="travel-kv-hot">
                    <dt>{t("travelFlights.airportBy")}</dt>
                    <dd>{formatTimeWithZone(arriveBy, f.depart_timezone) ?? "—"}
                      <span className="muted travel-kv-note"> · {t("travelFlights.minBefore", { n: f.minutes_before_departure })}</span>
                    </dd>
                  </div>
                  {f.seat && <div><dt>{t("travelFlights.seat")}</dt><dd>{f.seat}</dd></div>}
                </dl>

                {codesVisible && f.confirmation_code && (
                  <div className="travel-code-row">
                    <span className="travel-code-label">{t("travelFlights.confirmation")}</span>
                    <code className="travel-code">{f.confirmation_code}</code>
                    <CopyButton value={f.confirmation_code} label={t("travelFlights.confirmationCode")} />
                  </div>
                )}
                {f.notes && <p className="travel-notes">{f.notes}</p>}

                <AttachmentsPanel
                  tripId={tripId}
                  attachments={attachments.filter((a) => a.flight_id === f.id)}
                  canEdit={canEdit}
                  scope={{ flightId: f.id }}
                  onChanged={onAttachmentsChanged}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
