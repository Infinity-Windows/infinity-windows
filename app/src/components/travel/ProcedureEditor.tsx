import { useState } from "react";
import type { Procedure } from "../../lib/travel/types";
import { upsertProcedure } from "../../lib/travel/api";
import { toastError, toastSuccess } from "../../lib/toast";
import { Sheet } from "./Sheet";
import { AreaField, Field } from "./Field";

export function ProcedureEditor({
  tripId,
  procedure,
  onClose,
  onSaved,
}: {
  tripId: string;
  procedure: Procedure | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(procedure?.title ?? "");
  const [body, setBody] = useState(procedure?.body ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      toastError(null, "Add a title first");
      return;
    }
    setSaving(true);
    try {
      await upsertProcedure(tripId, {
        id: procedure?.id,
        trip_id: tripId,
        title: title.trim(),
        body: body.trim() || null,
      });
      toastSuccess(procedure ? "Rule updated" : "Rule added");
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
      title={procedure ? "Edit rule" : "Add rule"}
      footer={
        <>
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Title" value={title} onChange={setTitle} placeholder="Keep the kitchen clean" />
      <AreaField label="Details" value={body} onChange={setBody} rows={4} />
    </Sheet>
  );
}
