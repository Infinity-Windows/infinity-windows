// "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift" — the line a bid asks for (Wave O,
// O5).
//
// NO NAMES. A bid says how many cards the company holds; who holds which one is
// nobody outside the company's business, and a pasted list of names is a list of
// names that lives in somebody else's document forever. summaryText builds the
// line and credentials.test.ts holds it to that.
//
// Supervisor+ only, because it is a number about the company rather than about
// a person, and because it is written to be copied out of the app.

import { useState } from "react";
import { useT } from "../../lib/i18n";
import {
  summarizeCertifications,
  summaryText,
  todayLocalDay,
  type Certification,
} from "../../lib/credentials";
import { CERT_KIND_KEYS } from "../../lib/credentialLabels";

export function CredentialSummary({
  certifications,
  today = todayLocalDay(),
}: {
  certifications: Certification[];
  today?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const counts = summarizeCertifications(certifications, today);
  const line = summaryText(counts, (kind) => t(CERT_KIND_KEYS[kind]));

  const copy = () => {
    // navigator.clipboard is absent on an http origin and on some older
    // Android WebViews; the line is on screen either way, so a failed copy
    // silently leaves the text to be selected by hand rather than throwing.
    void navigator.clipboard
      ?.writeText(line)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <section className="detail-card cred-summary">
      <h2>{t("cred.summary.heading")}</h2>
      <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
        {t("cred.summary.hint")}
      </p>
      {counts.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t("cred.summary.none")}
        </p>
      ) : (
        <>
          <p className="cred-summary-line" style={{ margin: 0, fontWeight: 650 }}>
            {line}
          </p>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button type="button" className="button-like" onClick={copy}>
              {copied ? t("cred.summary.copied") : t("cred.summary.copy")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
