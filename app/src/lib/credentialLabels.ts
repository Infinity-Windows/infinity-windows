// The words for a credential, kept out of the component files (Wave O).
//
// Lives here rather than beside CredentialsSection for a mechanical reason: a
// file that exports a component AND a constant trips the fast-refresh lint rule,
// the same reason lib/i18n/context.ts sits apart from LanguageProvider.tsx.

import { useT, type TKey } from "./i18n";
import type { Certification, CertificationKind } from "./credentials";

/**
 * Kind -> catalog key. A literal map rather than a built string, so a kind added
 * to the union without a matching catalog entry is a compile error here instead
 * of an empty label on a phone (translate() answers an unknown key with "").
 */
export const CERT_KIND_KEYS: Record<CertificationKind, TKey> = {
  osha30: "cred.kind.osha30",
  osha10: "cred.kind.osha10",
  first_aid_cpr: "cred.kind.first_aid_cpr",
  aerial_lift: "cred.kind.aerial_lift",
  forklift: "cred.kind.forklift",
  fall_protection: "cred.kind.fall_protection",
  other: "cred.kind.other",
};

/** What a card is called, in the reader's language. An `other` card uses the
 * words whoever filed it typed — never the database's own `first_aid_cpr`. */
export function useCertLabel(): (
  cert: Pick<Certification, "kind" | "otherLabel">,
) => string {
  const t = useT();
  return (cert) =>
    cert.kind === "other"
      ? cert.otherLabel?.trim() || t("cred.kind.other")
      : t(CERT_KIND_KEYS[cert.kind]);
}
