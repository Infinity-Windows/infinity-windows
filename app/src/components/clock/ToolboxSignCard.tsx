import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HardHat } from "lucide-react";
import type { SafetyTalk } from "../../lib/ops";
import { submitToolboxCompletion } from "../../lib/toolbox";
import { SignaturePad, type SignaturePadHandle } from "../SignaturePad";
import { formatApiError } from "../../lib/install/errors";
import { TalkContent } from "../safety/TalkContent";
import { useT } from "../../lib/i18n";

/**
 * Sign today's toolbox talk without leaving the clock-in sheet — or the
 * landing block, which hosts the same card since 2026-09-06.
 *
 * The morning ritual is one flow — pick the job, pick the cost code, sign the
 * talk, pick your first window, start — so the signing lives HERE, not on a
 * separate page the sheet bounces you to. Same record as the Safety page's
 * flow (same submitToolboxCompletion: acknowledgment, typed name, drawn
 * signature, archived PDF); only the wrapper is compact. The full talk text
 * stays one tap away rather than filling the sheet.
 *
 * `onSigned` lets the host finish what the tap started: the landing block
 * passes its own clock-in, so signing IS the punch and nobody picks the job
 * and cost code a second time (owner ask, 2026-09-06). Optional — the sheet
 * still mounts the card without it and keeps its own Start button.
 */
export function ToolboxSignCard({
  profileId,
  talk,
  onSigned,
}: {
  profileId: string;
  talk: SafetyTalk;
  onSigned?: () => void;
}) {
  const queryClient = useQueryClient();
  const t = useT();
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
    onSuccess: (row) => {
      // Write the signed row into the cache BEFORE asking for a refetch, so
      // every host — this card's own parent, the landing block, the sheet,
      // the on-the-clock nag — knows the talk is signed in the same render,
      // not one network round trip later. Two things hung on that gap
      // (review, 2026-09-06): the landing block kept this card on screen with
      // its button live until the refetch landed, so a second tap filed a
      // second signature AND a second clock_in, which auto-closes the shift
      // the first one had just opened; and a phone that lost signal right
      // after the signature never got the refetch at all (offlineFirst
      // pauses it), so the clock sheet it was handed to still read "unsigned"
      // and held its Start — the punch could not even be queued.
      queryClient.setQueryData(["toolboxToday", profileId], row);
      queryClient.invalidateQueries({ queryKey: ["toolboxToday"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxHistory"] });
      queryClient.invalidateQueries({ queryKey: ["toolboxCompliance"] });
      // Called from the mutation OPTION, not a per-call mutate(_, { onSuccess })
      // callback on purpose: the cache write above is what makes the host stop
      // rendering this card, and React Query drops a per-call callback once
      // the component that made the call has unmounted — the clock-in would
      // then silently never fire. Option callbacks survive.
      onSigned?.();
    },
  });

  const canSubmit = ack && typedName.trim().length > 1 && !sigEmpty;
  // Held after success as well as during it: a host that keys "signed" off
  // something other than toolboxToday would otherwise show a live button on a
  // talk already on record.
  const held = !canSubmit || sign.isPending || sign.isSuccess;

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      {/* SAFETY / toolbox strings — Spanish flagged for bilingual review. */}
      <p className="clock-row-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <HardHat size={16} aria-hidden /> {t("toolbox.today")}
      </p>
      <p style={{ margin: "2px 0 6px", fontWeight: 600 }}>{talk.title}</p>
      <details>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
          {t("toolbox.read")}
        </summary>
        {/* The same tiered render the Safety page uses — key points, watch
            for, stop work — not just the plain-text fallback body. */}
        <div style={{ fontSize: 13, maxHeight: 300, overflowY: "auto", marginTop: 6 }}>
          <TalkContent talk={talk} />
        </div>
      </details>
      <label className="ack-row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        {talk.pledge ?? t("toolbox.pledge")}
      </label>
      <label className="field-label">{t("toolbox.typeName")}</label>
      <input
        type="text"
        value={typedName}
        placeholder={t("toolbox.fullName")}
        onChange={(e) => setTypedName(e.target.value)}
      />
      <label className="field-label">{t("toolbox.sign")}</label>
      <SignaturePad ref={sigRef} onChange={setSigEmpty} />
      {sign.isError && <p className="error">{formatApiError(sign.error)}</p>}
      <button
        type="button"
        className="button-like active-pill"
        style={{ marginTop: 8 }}
        disabled={held}
        onClick={() => sign.mutate()}
      >
        {sign.isPending ? t("toolbox.signing") : t("toolbox.signTalk")}
      </button>
    </div>
  );
}
