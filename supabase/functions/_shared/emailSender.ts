/**
 * Who a GC email comes FROM.
 *
 * The company answers to two names (CONTEXT.md, "The GC handshake"), and a
 * builder who has only ever known us as STG should not get mail from
 * forgewd.com. The From line is the half a phone shows before anybody opens the
 * message, so it is the wrong name in the most visible place there is — and the
 * subject and signature already follow the job's brand. This makes the sender
 * follow it too.
 *
 * THE ADDRESSES ARE CONFIGURATION, NOT CODE. The owner may move either brand to
 * a different mailbox — a new domain, a shared inbox, whatever his accountant
 * prefers — without anybody editing this repo. Each brand gets its own optional
 * setting, EMAIL_FROM still covers both when they share one mailbox, and a
 * built-in address keeps the feature working before any of them exist:
 *
 *     EMAIL_FROM_STG   ─┐
 *     EMAIL_FROM_FORGE ─┴─► EMAIL_FROM ─► office@forgewd.com
 *
 * All three are OPTIONAL. A sender address nobody has set must fall back to the
 * next thing in that chain, never fail a deploy — the reads and their
 * truthiness guards live in supabase/functions/send-email/index.ts, which is
 * where scripts/function_secrets.py looks for them.
 *
 * Runtime-agnostic on purpose: plain strings and regexes, no Deno, no fetch. So
 * `app/src/lib/emailSender.test.ts` tests the very code that runs in production
 * rather than a copy of it — the same arrangement crewInvites.ts and gcToken.ts
 * use, and the reason a rule this small is worth its own file.
 */

/** The two names the company uses with a customer. */
export type GcBrand = "stg" | "forge";

/** Spelled the way the owner spells them (Q20). `&` for STG, "and" for Forge. */
export const BRAND_NAMES: Record<GcBrand, string> = {
  stg: "STG Windows & Doors",
  forge: "Forge Windows and Doors",
};

/** What a send uses before the owner has configured anything at all. */
export const DEFAULT_FROM_ADDRESS = "office@forgewd.com";

/**
 * Anything that is not `forge` is STG.
 *
 * `projects.gc_brand` defaults to `stg`, and a job with a null or unrecognised
 * brand has always been mailed under the STG name — this keeps the sender and
 * the signature agreeing about that rather than each having its own opinion.
 */
export function brandKey(brand: unknown): GcBrand {
  return brand === "forge" ? "forge" : "stg";
}

/** The configured addresses, however many of them are actually set. */
export interface SenderSettings {
  /** EMAIL_FROM_STG */
  stg?: string;
  /** EMAIL_FROM_FORGE */
  forge?: string;
  /** EMAIL_FROM — one mailbox standing in for both brands. */
  both?: string;
}

/**
 * A resolved sender, or a refusal that names the setting to fix.
 *
 * `source` is a SETTING NAME, never a value, so it is safe to put in front of
 * the person who pressed the button: it tells whoever can fix it which of the
 * three to look at, and tells nobody anything they should not have.
 */
export type ResolvedSender =
  | { ok: true; header: string; address: string; source: string }
  | { ok: false; source: string };

// A bare address, deliberately loose about the local part (Resend is the real
// judge of that) and strict about the domain having a dot in it, since the one
// mistake worth catching here is a mailbox name typed in without a domain.
const BARE_ADDRESS =
  /^[^\s<>@,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** `Name <address>` — the other shape Resend takes, and the one we produce. */
const NAMED_ADDRESS = /^([^<>]*)<([^<>]+)>$/;

// RFC 5322 atext plus spaces. A display name made only of these can travel
// bare, which is how "STG Windows & Doors" reaches an inbox spelled the way the
// owner spells it (`&` is an ordinary atom character, not punctuation that
// needs hiding). Anything outside it — a comma, a full stop in "Inc." — has to
// be quoted, or a mail server reads one sender as two.
const BARE_DISPLAY_NAME = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/;

function displayName(name: string): string {
  return BARE_DISPLAY_NAME.test(name) ? name : JSON.stringify(name);
}

/**
 * The whole rule: which setting this brand's mail comes from, and what goes in
 * the From header.
 *
 * A configured value may be a bare address (`office@stgwindows.com`), in which
 * case the brand's own name is put in front of it, or it may already carry a
 * name (`STG Windows <office@stgwindows.com>`), in which case the owner's
 * wording wins — he may want something other than the brand's full name and
 * should not have to ask.
 *
 * Garbage is refused rather than sent. Resend would refuse it too, but a
 * sentence naming the setting is worth more to the person pressing the button
 * than a 422 relayed from an API he has never heard of. What Resend refuses for
 * its OWN reasons — an unverified domain, most often — still comes back in its
 * own words; that is a different failure and this must not pre-empt it.
 */
export function resolveSender(brand: unknown, settings: SenderSettings): ResolvedSender {
  const key = brandKey(brand);
  const own = key === "forge" ? settings.forge : settings.stg;
  const ownName = key === "forge" ? "EMAIL_FROM_FORGE" : "EMAIL_FROM_STG";

  let configured = "";
  let source = "";
  if (own && own.trim()) {
    configured = own.trim();
    source = ownName;
  } else if (settings.both && settings.both.trim()) {
    configured = settings.both.trim();
    source = "EMAIL_FROM";
  } else {
    configured = DEFAULT_FROM_ADDRESS;
    source = "the built-in address";
  }

  // A From header is a header. A line break inside one is how a message grows a
  // second header nobody wrote, so a value carrying one is refused outright
  // rather than trimmed into shape.
  if (/[\r\n]/.test(configured)) return { ok: false, source };

  const named = configured.match(NAMED_ADDRESS);
  const address = (named ? named[2] : configured).trim();
  if (!BARE_ADDRESS.test(address)) return { ok: false, source };

  const name = named ? named[1].trim() : "";
  return {
    ok: true,
    header: `${displayName(name || BRAND_NAMES[key])} <${address}>`,
    address,
    source,
  };
}
