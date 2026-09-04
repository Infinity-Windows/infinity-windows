// One person's cards, on their Roster row and on their own My Work (Wave O,
// O2/O3).
//
// Who may do what is decided in SQL (set_certification) and only MIRRORED here:
// anybody may add their own card and it lands unchecked, a supervisor+ verifies,
// edits and voids. The UI does not offer a tap the server would refuse, and the
// server refuses it anyway.
//
// The card photo goes through the shared capture sheet with the watermark OFF.
// A phase photo is evidence about a place and a time and the stamp IS the proof;
// a picture of an OSHA card is a picture of a piece of paper, and burning a GPS
// fix onto a document that already carries somebody's full legal name adds a
// fact nobody asked for.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PhotoCaptureSheet } from "../PhotoCaptureSheet";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT } from "../../lib/i18n";
import { shortDay } from "../../lib/pipeline";
import { CERT_KIND_KEYS, useCertLabel } from "../../lib/credentialLabels";
import {
  CERTIFICATION_KINDS,
  credentialDocUrl,
  expiryState,
  setCertification,
  uploadCredentialDoc,
  todayLocalDay,
  type Certification,
  type CertificationKind,
  type ExpiryState,
} from "../../lib/credentials";

const CHIP_CLASS: Record<ExpiryState, string> = {
  none: "cred-chip none",
  ok: "cred-chip ok",
  soon: "cred-chip soon",
  expired: "cred-chip expired",
};

function ExpiryChip({ cert, today }: { cert: Certification; today: string }) {
  const t = useT();
  const { lang } = useLanguage();
  const state = expiryState(cert.expiresOn, today);
  const date = shortDay(cert.expiresOn, lang);
  const text =
    state === "none"
      ? t("cred.chip.noExpiry")
      : state === "expired"
        ? t("cred.chip.expired", { date })
        : state === "soon"
          ? t("cred.chip.soon", { date })
          : t("cred.chip.good", { date });
  return <span className={CHIP_CLASS[state]}>{text}</span>;
}

/** Opens the stored card in a new tab through a short-lived signed URL. The
 * bucket is private, so there is no link to render until one is asked for.
 *
 * The bucket refuses a read the same way it refuses a missing file — a denied
 * object simply is not there, as far as the storage API will say — so
 * credentialDocUrl cannot tell the two apart and hands back null for both. What
 * it must NOT do is nothing: a button that resolves successfully and opens no
 * window is a button somebody taps four times and then stops trusting. */
function CardDocLink({ path }: { path: string }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: () => credentialDocUrl(path),
    onSuccess: (url) => {
      if (!url) {
        setError(t("cred.viewCard.noLuck"));
        return;
      }
      setError(null);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    onError: (e) => setError(formatApiError(e)),
  });
  return (
    <>
      <button
        type="button"
        className="button-like"
        disabled={open.isPending}
        onClick={() => open.mutate()}
      >
        {t("cred.viewCard")}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function AddCardForm({
  profileId,
  isSelf,
  onSaved,
  onCancel,
}: {
  profileId: string;
  isSelf: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<CertificationKind>("osha10");
  const [otherLabel, setOtherLabel] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      let documentPath: string | null = null;
      if (photo) {
        setUploading(true);
        try {
          documentPath = await uploadCredentialDoc(profileId, photo);
        } finally {
          setUploading(false);
        }
      }
      await setCertification({
        profileId,
        kind,
        otherLabel: kind === "other" ? otherLabel.trim() : null,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        documentPath,
      });
    },
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) => setError(formatApiError(e)),
  });

  return (
    <div className="cred-form">
      <label className="field-label">{t("cred.whichCard")}</label>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {CERTIFICATION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={kind === k ? "button-like active-pill" : "button-like"}
            onClick={() => setKind(k)}
          >
            {t(CERT_KIND_KEYS[k])}
          </button>
        ))}
      </div>

      {kind === "other" && (
        <>
          <label className="field-label" htmlFor={`cred-other-${profileId}`}>
            {t("cred.nameIt")}
          </label>
          <input
            id={`cred-other-${profileId}`}
            value={otherLabel}
            onChange={(e) => setOtherLabel(e.target.value)}
          />
        </>
      )}

      <label className="field-label" htmlFor={`cred-issued-${profileId}`}>
        {t("cred.issued")}
      </label>
      <input
        id={`cred-issued-${profileId}`}
        type="date"
        value={issuedOn}
        onChange={(e) => setIssuedOn(e.target.value)}
      />

      <label className="field-label" htmlFor={`cred-expires-${profileId}`}>
        {t("cred.expires")}
      </label>
      <input
        id={`cred-expires-${profileId}`}
        type="date"
        value={expiresOn}
        onChange={(e) => setExpiresOn(e.target.value)}
      />
      <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
        {t("cred.expiresHint")}
      </p>

      {/* Only the cardholder can upload: the storage policy is "your own
          folder", so offering the camera to a supervisor filing somebody
          else's card would offer a tap the bucket refuses. */}
      {isSelf && (
        <>
          <label className="field-label">{t("cred.photo")}</label>
          <PhotoCaptureSheet
            mode="single"
            value={photo}
            onChange={setPhoto}
            prompt={t("cred.photo")}
            hint={t("cred.photoHint")}
            stamp={false}
          />
        </>
      )}

      {isSelf && (
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {t("cred.mineLandUnverified")}
        </p>
      )}
      {uploading && <p className="muted">{t("cred.uploading")}</p>}
      {error && <p className="error">{error}</p>}

      <div className="row-gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="action-btn"
          disabled={save.isPending || (kind === "other" && !otherLabel.trim())}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("cred.saving") : t("cred.save")}
        </button>
        <button type="button" className="button-like" onClick={onCancel}>
          {t("cred.cancel")}
        </button>
      </div>
    </div>
  );
}

export function CredentialsSection({
  profileId,
  certifications,
  isSelf,
  canManage,
  onChanged,
  today = todayLocalDay(),
}: {
  profileId: string;
  /** This person's cards, already filtered to them by the caller. */
  certifications: Certification[];
  /** True when this is the signed-in person's own row. */
  isSelf: boolean;
  /** Supervisor+: may verify, un-verify and void. */
  canManage: boolean;
  onChanged: () => void;
  today?: string;
}) {
  const t = useT();
  const label = useCertLabel();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: (args: { id: string; verified?: boolean; voided?: boolean }) =>
      setCertification(args),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError(formatApiError(e)),
  });

  return (
    <div className="cred-section">
      <label className="field-label">{t("cred.heading")}</label>
      {certifications.length === 0 && !adding && (
        <p className="muted" style={{ margin: 0 }}>
          {t("cred.none")}
        </p>
      )}
      <ul className="cred-list">
        {certifications.map((cert) => (
          <li key={cert.id} className="cred-row">
            <span className="cred-name">{label(cert)}</span>
            <ExpiryChip cert={cert} today={today} />
            <span className={cert.verifiedAt ? "cred-checked" : "cred-unchecked"}>
              {cert.verifiedAt ? t("cred.verified") : t("cred.unverified")}
            </span>
            {/* The ROW is readable to foreman+, the PHOTO is not: the bucket's
                read policy is the cardholder or a supervisor+, because knowing
                a card exists and when it runs out is a different thing from
                being handed a picture of somebody's government-adjacent ID.
                A foreman was still offered the button, and the bucket answers a
                refusal the same way it answers a missing file — so the tap did
                nothing at all. Offer it to the people the policy actually lets
                through. */}
            {cert.documentPath && (isSelf || canManage) && (
              <CardDocLink path={cert.documentPath} />
            )}
            {/* Nobody checks their own card, whatever their rank — so a
                supervisor looking at their OWN row is not offered the tap.
                Un-checking one they already hold IS offered, because taking a
                claim back is not making one, and set_certification draws the
                line in exactly the same place. */}
            {canManage && (!isSelf || Boolean(cert.verifiedAt)) && (
              <button
                type="button"
                className="button-like"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({ id: cert.id, verified: !cert.verifiedAt })
                }
              >
                {cert.verifiedAt ? t("cred.unverify") : t("cred.verify")}
              </button>
            )}
            {/* Voiding your own card IS offered: "this row was a mistake" takes
                a claim away rather than making one. */}
            {canManage && (
              <button
                type="button"
                className="button-like"
                disabled={change.isPending}
                onClick={() => {
                  if (!window.confirm(t("cred.voidConfirm"))) return;
                  change.mutate({ id: cert.id, voided: true });
                }}
              >
                {t("cred.void")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}

      {adding ? (
        <AddCardForm
          profileId={profileId}
          isSelf={isSelf}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        // Adding your own card needs no rank; adding somebody else's is
        // supervisor+, which is exactly what set_certification enforces.
        (isSelf || canManage) && (
          <button
            type="button"
            className="button-like"
            style={{ marginTop: 6 }}
            onClick={() => setAdding(true)}
          >
            {isSelf ? t("cred.addMine") : t("cred.add")}
          </button>
        )
      )}
    </div>
  );
}
