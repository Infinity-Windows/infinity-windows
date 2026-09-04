// "Send a recording" — wave U, the owner's design (Q15/Q19).
//
// The app does not collect raw footage and is not going to. An installer films
// a unit going in, taps this, and their phone's mail composer opens ALREADY
// ADDRESSED to the leads on the job they are clocked into, with the job and the
// date in the subject line. The lead puts the clip on YouTube; a supervisor
// pastes the link into Learn. No upload, no inbox, no retention policy.
//
// WHY MAILTO AND NOT navigator.share: the Web Share API cannot address anybody.
// It hands the operating system a title and some text and lets the person
// choose where it goes — which is precisely the step this button exists to
// remove. A mailto: link opens the same composer with the To: line already
// filled, and it works on every phone in the field, including the ones that
// never granted the browser anything.

import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

/** The minimal projection foreman_contacts_for_me() answers with: a name to
 * show and an address to send to, and deliberately nothing else. */
export interface ForemanContact {
  display_name: string | null;
  email: string | null;
}

/**
 * Who to address a recording to.
 *
 * Empty rather than thrown when the database has not had 20260984000000 yet:
 * an un-addressed mail composer still lets an installer pick their lead by
 * hand, and a Learn page that throws instead is a Learn page nobody can use.
 */
export async function listForemanContacts(): Promise<ForemanContact[]> {
  const { data, error } = await supabase.rpc("foreman_contacts_for_me");
  if (error) {
    if (isMissingFunction(error)) return [];
    throw error;
  }
  return (data ?? []) as ForemanContact[];
}

/**
 * Addresses that are safe to drop into a mailto: URL, PURE — unit-tested.
 *
 * The addresses come out of the database, which makes them data, not
 * constants. A value carrying a `?`, a `&`, a comma or a newline would either
 * add query parameters of its own to the URL or split into extra recipients,
 * so anything that is not plainly one address is dropped rather than escaped —
 * there is no legitimate crew address this rejects, and no clever one it lets
 * through. Duplicates go too, case-insensitively: one lead on two jobs is
 * still one line in the To: field.
 */
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function mailAddresses(contacts: ForemanContact[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of contacts) {
    const address = (c.email ?? "").trim();
    if (!PLAIN_ADDRESS.test(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

export interface RecordingMail {
  /** The addresses that survived `mailAddresses` — empty is a real answer. */
  to: string[];
  subject: string;
  body: string;
  /** What the button's href is. Safe to render even with no recipients: the
   * composer opens empty and the person picks their lead themselves. */
  href: string;
}

/**
 * The whole share target, PURE — unit-tested.
 *
 * `subject` and `body` arrive already translated, so this file never has to
 * know which language the installer reads: the copy lives in the catalog with
 * both languages, and the assembly lives here with a test on it.
 */
export function buildRecordingMail(input: {
  contacts: ForemanContact[];
  subject: string;
  body: string;
}): RecordingMail {
  const to = mailAddresses(input.contacts);
  const query = `subject=${encodeURIComponent(input.subject)}&body=${encodeURIComponent(input.body)}`;
  return {
    to,
    subject: input.subject,
    body: input.body,
    href: `mailto:${to.join(",")}?${query}`,
  };
}

/**
 * The date in the subject line, PURE — unit-tested.
 *
 * Written the way the reader's own language writes a date, because the subject
 * is what a lead scans in a full inbox. Short month rather than a number:
 * "3/9" and "9/3" are the same day to two different people.
 */
export function recordingDateLabel(date: Date, lang: "en" | "es"): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
