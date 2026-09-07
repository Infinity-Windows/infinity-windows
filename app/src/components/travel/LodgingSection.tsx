import { Bed, DoorClosed, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import type { Lodging, TripAttachment } from "../../lib/travel/types";
import { formatDateTimeWithZone } from "../../lib/travel/dates";
import { telHref } from "../../lib/travel/links";
import { DirectionsButton } from "../maps/DirectionsButton";
import { CopyButton } from "./CopyButton";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { useT } from "../../lib/i18n";

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
  const t = useT();
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><Bed size={16} aria-hidden /> {t("travelDetail.tab.lodging")}</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> {t("travelLodging.addLodging")}
          </button>
        )}
      </div>

      {lodging.length === 0 ? (
        <p className="muted travel-empty-note">{t("travelLodging.noLodging")}</p>
      ) : (
        lodging.map((l) => {
          const phone = telHref(l.host_phone);
          return (
            <article key={l.id} className="travel-card travel-lodging">
              <div className="travel-card-head">
                <strong>{l.name ?? t("travelTimeline.lodgingFallback")}</strong>
                {canEdit && (
                  <span className="travel-card-tools">
                    <button aria-label={t("travelLodging.editLodging")} onClick={() => onEdit(l)}><Pencil size={14} /></button>
                    <button aria-label={t("travelLodging.deleteLodging")} onClick={() => onDelete(l)}><Trash2 size={14} /></button>
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
                        <span className="travel-pin-label">{t("travelLodging.wifi")}{l.wifi_ssid ? ` · ${l.wifi_ssid}` : ""}</span>
                        {l.wifi_password && <code className="travel-code">{l.wifi_password}</code>}
                      </div>
                      {l.wifi_password && <CopyButton value={l.wifi_password} label={t("travelLodging.wifiPassword")} />}
                    </div>
                  )}
                  {l.door_code && (
                    <div className="travel-pin-row">
                      <span className="travel-pin-icon" aria-hidden><DoorClosed size={16} /></span>
                      <div className="travel-pin-body">
                        <span className="travel-pin-label">{t("travelLodging.doorLockboxCode")}</span>
                        <code className="travel-code">{l.door_code}</code>
                      </div>
                      <CopyButton value={l.door_code} label={t("travelTimeline.doorCode")} />
                    </div>
                  )}
                </div>
              )}
              {!codesVisible && (l.wifi_password || l.door_code) && (
                <p className="muted travel-empty-note">{t("travelLodging.codesHidden")}</p>
              )}

              {l.address && (
                <div className="travel-route">
                  <span>{l.address}</span>
                  <DirectionsButton address={l.address} />
                </div>
              )}

              <dl className="travel-kv">
                <div><dt>{t("travelLodging.checkIn")}</dt><dd>{formatDateTimeWithZone(l.check_in_at, l.timezone) ?? "—"}</dd></div>
                <div><dt>{t("travelLodging.checkOut")}</dt><dd>{formatDateTimeWithZone(l.check_out_at, l.timezone) ?? "—"}</dd></div>
                {l.nights != null && <div><dt>{t("travelLodging.nights")}</dt><dd>{l.nights}</dd></div>}
                {(l.bedrooms != null || l.beds != null || l.baths != null) && (
                  <div><dt>{t("travelLodging.layout")}</dt><dd>
                    {[l.bedrooms != null ? t("travelLodging.bd", { n: l.bedrooms }) : null,
                      l.beds != null ? t("travelLodging.beds", { n: l.beds }) : null,
                      l.baths != null ? t("travelLodging.ba", { n: l.baths }) : null].filter(Boolean).join(" · ")}
                  </dd></div>
                )}
                {(l.washer_dryer != null || l.kitchen != null) && (
                  <div><dt>{t("travelLodging.amenities")}</dt><dd>
                    {[l.washer_dryer ? t("travelLodging.washerDryer") : null, l.kitchen ? t("travelLodging.kitchen") : null]
                      .filter(Boolean).join(" · ") || "—"}
                  </dd></div>
                )}
                {l.parking && <div><dt>{t("travelLodging.parking")}</dt><dd>{l.parking}</dd></div>}
                {l.quiet_hours && <div><dt>{t("travelLodging.quietHours")}</dt><dd>{l.quiet_hours}</dd></div>}
                {(l.host_name || phone) && (
                  <div><dt>{t("travelLodging.host")}</dt><dd>
                    {l.host_name ?? t("travelLodging.hostFallback")}
                    {phone && <a className="travel-call-inline" href={phone}> · {t("travelTimeline.call")}</a>}
                  </dd></div>
                )}
              </dl>

              {l.entry_steps && (
                <div className="travel-block"><span className="travel-block-label">{t("travelLodging.gettingIn")}</span><p>{l.entry_steps}</p></div>
              )}
              {l.backup_entry && (
                <div className="travel-block"><span className="travel-block-label">{t("travelLodging.backupEntry")}</span><p>{l.backup_entry}</p></div>
              )}
              {l.checkout_tasks && (
                <div className="travel-block"><span className="travel-block-label">{t("travelLodging.beforeCheckout")}</span><p>{l.checkout_tasks}</p></div>
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
