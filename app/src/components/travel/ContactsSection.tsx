import { Pencil, Phone, Plus, Trash2, Users } from "lucide-react";
import type { TripContact } from "../../lib/travel/types";
import { telHref } from "../../lib/travel/links";

export function ContactsSection({
  contacts,
  canEdit,
  onAdd,
  onEdit,
  onDelete,
}: {
  contacts: TripContact[];
  canEdit: boolean;
  onAdd: () => void;
  onEdit: (c: TripContact) => void;
  onDelete: (c: TripContact) => void;
}) {
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><Users size={16} aria-hidden /> Contacts</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> Add contact
          </button>
        )}
      </div>

      {contacts.length === 0 ? (
        <p className="muted travel-empty-note">No contacts yet.</p>
      ) : (
        <div className="travel-contacts">
          {contacts.map((c) => {
            const href = telHref(c.phone);
            return (
              <article key={c.id} className="travel-contact">
                <div className="travel-contact-main">
                  <strong>{c.name}</strong>
                  {c.label && <span className="travel-badge">{c.label}</span>}
                  {c.notes && <span className="muted travel-contact-note">{c.notes}</span>}
                  {c.phone && <span className="muted">{c.phone}</span>}
                </div>
                <div className="travel-contact-actions">
                  {href && (
                    <a className="travel-call" href={href}>
                      <Phone size={14} aria-hidden /> <span>Call</span>
                    </a>
                  )}
                  {canEdit && (
                    <span className="travel-card-tools">
                      <button aria-label="Edit contact" onClick={() => onEdit(c)}><Pencil size={14} /></button>
                      <button aria-label="Delete contact" onClick={() => onDelete(c)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
