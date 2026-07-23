import { useState } from "react";
import type { TripContact } from "../../lib/travel/types";
import { upsertContact } from "../../lib/travel/api";
import { toastError, toastSuccess } from "../../lib/toast";
import { Sheet } from "./Sheet";
import { AreaField, Field, FieldRow } from "./Field";

export function ContactEditor({
  tripId,
  contact,
  onClose,
  onSaved,
}: {
  tripId: string;
  contact: TripContact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: contact?.name ?? "",
    label: contact?.label ?? "",
    phone: contact?.phone ?? "",
    notes: contact?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) {
      toastError(null, "Add a name first");
      return;
    }
    setSaving(true);
    try {
      await upsertContact(tripId, {
        id: contact?.id,
        name: form.name.trim(),
        label: form.label.trim() || null,
        phone: form.phone.trim() || null,
        notes: form.notes.trim() || null,
      });
      toastSuccess(contact ? "Contact updated" : "Contact added");
      onSaved();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={contact ? "Edit contact" : "Add contact"}
      footer={
        <>
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <FieldRow>
        <Field label="Name" value={form.name} onChange={set("name")} />
        <Field label="Label" value={form.label} onChange={set("label")} placeholder="Emergency / Host / Site" />
      </FieldRow>
      <Field label="Phone" type="tel" value={form.phone} onChange={set("phone")} />
      <AreaField label="Notes" value={form.notes} onChange={set("notes")} rows={2} />
    </Sheet>
  );
}
