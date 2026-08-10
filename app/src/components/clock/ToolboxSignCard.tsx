import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HardHat } from "lucide-react";
import type { SafetyTalk } from "../../lib/ops";
import { submitToolboxCompletion } from "../../lib/toolbox";
import { SignaturePad, type SignaturePadHandle } from "../SignaturePad";
import { formatApiError } from "../../lib/install/errors";

/**
 * Sign today's toolbox talk without leaving the clock-in sheet.
 *
 * The morning ritual is one flow — pick the job, pick the cost code, sign the
 * talk, pick your first window, start — so the signing lives HERE, not on a
 * separate page the sheet bounces you to. Same record as the Safety page's
 * flow (same submitToolboxCompletion: acknowledgment, typed name, drawn
 * signature, archived PDF); only the wrapper is compact. The full talk text
 * stays one tap away rather than filling the sheet.
 */
export function ToolboxSignCard({
  profileId,
  talk,
}: {
  profileId: string;
  talk: SafetyTalk;
}) {
  const queryClient = useQueryClient();
  const sigRef = useRef<SignaturePadHandle>(null);
  const [ack, setAck] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [sigEmpty, setSigEmpty] = useState(true);

  const sign = useMutation({
    mutationFn: () =>
      submitToolboxCompletion({
        talk,
        profileId,
        typedName: typedName.trim(),
        signatureDataUrl: sigRef.current!.toDataUrl(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["toolboxToday"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxHistory"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxCompliance"] });
    },
  });

  const canSubmit = ack && typedName.trim().length > 1 && !sigEmpty;

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <p className="clock-row-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <HardHat size={16} aria-hidden /> Today's toolbox talk
      </p>
      <p style={{ margin: "2px 0 6px", fontWeight: 600 }}>{talk.title}</p>
      <details>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
          Read the talk
        </summary>
        <div
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 13,
            maxHeight: 220,
            overflowY: "auto",
            marginTop: 6,
          }}
        >
          {talk.body}
        </div>
      </details>
      <label className="ack-row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        I read and understood today's talk
      </label>
      <label className="field-label">Type your name</label>
      <input
        type="text"
        value={typedName}
        placeholder="Full name"
        onChange={(e) => setTypedName(e.target.value)}
      />
      <label className="field-label">Sign</label>
      <SignaturePad ref={sigRef} onChange={setSigEmpty} />
      {sign.isError && <p className="error">{formatApiError(sign.error)}</p>}
      <button
        type="button"
        className="button-like active-pill"
        style={{ marginTop: 8 }}
        disabled={!canSubmit || sign.isPending}
        onClick={() => sign.mutate()}
      >
        {sign.isPending ? "Signing…" : "Sign today's talk"}
      </button>
    </div>
  );
}
