import { Bed, DoorClosed, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import type { Lodging, TripAttachment } from "../../lib/travel/types";
import { formatDateTimeWithZone } from "../../lib/travel/dates";
import { telHref } from "../../lib/travel/links";
import { DirectionsButton } from "../maps/DirectionsButton";
import { CopyButton } from "./CopyButton";
import { AttachmentsPanel } from "./AttachmentsPanel";

export function LodgingSection({
  tripId,
  lodging,
  attachments,
  canEdit,
  codesVisible,
  onAdd,
  onEdit,
  onDelete,
  onAttachmentsChanged,
}: {
  tripId: string;
  lodging: Lodging[];
  attachments: TripAttachment[];
  canEdit: boolean;
  codesVisible: boolean;
  onAdd: () => void;
  onEdit: (l: Lodging) => void;
  onDelete: (l: Lodging) => void;
  onAttachmentsChanged: () => void;
}) {
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><Bed size={16} aria-hidden /> Lodging</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> Add lodging
          </button>
        )}
      </div>

      {lodging.length === 0 ? (
        <p className="muted travel-empty-note">No lodging yet.</p>
      ) : (
        lodging.map((l) => {
          const phone = telHref(l.host_phone);
          return (
            <article key={l.id} className="travel-card travel-lodging">
              <div className="travel-card-head">
                <strong>{l.name ?? "Lodging"}</strong>
                {canEdit && (
                  <span className="travel-card-tools">
                    <button aria-label="Edit lodging" onClick={() => onEdit(l)}><Pencil size={14} /></button>
                    <button aria-label="Delete lodging" onClick={() => onDelete(l)}><Trash2 size={14} /></button>
                  </span>
                )}
              </div>

              {/* Pinned wifi + door code at the very top (house-manual style). */}
              {codesVisible && (l.wifi_ssid || l.wifi_password || l.door_code) && (
                <div className="travel-pinned">
                  {(l.wifi_ssid || l.wifi_password) && (
                    <div className="travel-pin-row">
                      <span className="travel-pin-icon" aria-hidden><Wifi size={16} /></span>
                      <div className="travel-pin-body">
                        <span className="travel-pin-label">Wi-Fi{l.wifi_ssid ? ` · ${l.wifi_ssid}` : ""}</span>
                        {l.wifi_password && <code className="travel-code">{l.wifi_password}</code>}
                      </div>
                      {l.wifi_password && <CopyButton value={l.wifi_password} label="Wi-Fi password" />}
                    </div>
                  )}
                  {l.door_code && (
                    <div className="travel-pin-row">
                      <span className="travel-pin-icon" aria-hidden><DoorClosed size={16} /></span>
                      <div className="travel-pin-body">
                        <span className="travel-pin-label">Door / lockbox code</span>
                        <code className="travel-code">{l.door_code}</code>
                      </div>
                      <CopyButton value={l.door_code} label="Door code" />
                    </div>
                  )}
                </div>
              )}
              {!codesVisible && (l.wifi_password || l.door_code) && (
                <p className="muted travel-empty-note">Codes are hidden for past trips.</p>
              )}

              {l.address && (
                <div className="travel-route">
                  <span>{l.address}</span>
                  <DirectionsButton address={l.address} />
                </div>
              )}

              <dl className="travel-kv">
                <div><dt>Check-in</dt><dd>{formatDateTimeWithZone(l.check_in_at, l.timezone) ?? "—"}</dd></div>
                <div><dt>Check-out</dt><dd>{formatDateTimeWithZone(l.check_out_at, l.timezone) ?? "—"}</dd></div>
                {l.nights != null && <div><dt>Nights</dt><dd>{l.nights}</dd></div>}
                {(l.bedrooms != null || l.beds != null || l.baths != null) && (
                  <div><dt>Layout</dt><dd>
                    {[l.bedrooms != null ? `${l.bedrooms} bd` : null,
                      l.beds != null ? `${l.beds} beds` : null,
                      l.baths != null ? `${l.baths} ba` : null].filter(Boolean).join(" · ")}
                  </dd></div>
                )}
                {(l.washer_dryer != null || l.kitchen != null) && (
                  <div><dt>Amenities</dt><dd>
                    {[l.washer_dryer ? "Washer/dryer" : null, l.kitchen ? "Kitchen" : null]
                      .filter(Boolean).join(" · ") || "—"}
                  </dd></div>
                )}
                {l.parking && <div><dt>Parking</dt><dd>{l.parking}</dd></div>}
                {l.quiet_hours && <div><dt>Quiet hours</dt><dd>{l.quiet_hours}</dd></div>}
                {(l.host_name || phone) && (
                  <div><dt>Host</dt><dd>
                    {l.host_name ?? "Host"}
                    {phone && <a className="travel-call-inline" href={phone}> · Call</a>}
                  </dd></div>
                )}
              </dl>

              {l.entry_steps && (
                <div className="travel-block"><span className="travel-block-label">Getting in</span><p>{l.entry_steps}</p></div>
              )}
              {l.backup_entry && (
                <div className="travel-block"><span className="travel-block-label">Backup entry</span><p>{l.backup_entry}</p></div>
              )}
              {l.checkout_tasks && (
                <div className="travel-block"><span className="travel-block-label">Before checkout</span><p>{l.checkout_tasks}</p></div>
              )}
              {l.notes && <p className="travel-notes">{l.notes}</p>}

              <AttachmentsPanel
                tripId={tripId}
                attachments={attachments.filter((a) => a.lodging_id === l.id)}
                canEdit={canEdit}
                scope={{ lodgingId: l.id }}
                onChanged={onAttachmentsChanged}
              />
            </article>
          );
        })
      )}
    </section>
  );
}
