import { useState } from "react";
import type { ServiceSession } from "../../lib/servicing/model";
import { useServiceText } from "../../lib/servicing/text";
const local = (date: string) => {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function ServiceTimeReview({
  session,
  busy,
  onSave,
}: {
  session: ServiceSession;
  busy: boolean;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const tx = useServiceText(),
    [start, setStart] = useState(local(session.started_at)),
    [end, setEnd] = useState(local(session.ended_at ?? session.started_at)),
    [reason, setReason] = useState("");
  return (
    <details className="sv-span">
      <summary>{tx("reviewTime")}</summary>
      <div className="sv-fields">
        <label>
          {tx("startTime")}
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          {tx("endTime")}
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>
      <label>
        {tx("reviewReason")}
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !start || !end || !reason.trim()}
        onClick={() =>
          void onSave({
            visit_id: session.visit_id,
            id: session.id,
            expected_start: session.started_at,
            expected_end: session.ended_at,
            started_at: new Date(start).toISOString(),
            ended_at: new Date(end).toISOString(),
            reason,
          })
        }
      >
        {tx("save")}
      </button>
    </details>
  );
}
