// The GC check-in validator, and the brand names (Wave H, H1/H2).
//
// THE RULE LIVES TWICE ON PURPOSE. `firstMissingAnswer` is what the card and
// the GC's own page check before they send anything, and log_gc_checkin's body
// (migration 20260981000000) checks the same six things again with the same six
// sentences. The browser's copy saves a round trip and puts the message beside
// the empty box; the server's copy is the one that holds when somebody posts
// from a script or an old tab. This file is what stops them drifting: every
// case below names the SQL sentence it mirrors.
//
// The order matters as much as the rule. The message always points at the FIRST
// empty box in form order, so somebody filling this in on a phone with the
// builder still on the line is never scrolled up and down the card.

import { describe, expect, it } from "vitest";
import {
  GC_BRAND_NAMES,
  firstMissingAnswer,
  gcBrandOf,
  gcLinkDelivery,
  type GcCheckinDraft,
} from "./gc";

/** A complete check-in — every case below breaks exactly one thing. */
function full(over: Partial<GcCheckinDraft> = {}): GcCheckinDraft {
  return {
    expectedEndDate: "2026-11-20",
    roofOnDate: "2026-09-30",
    framingChecked: true,
    setPreference: "outset",
    exteriorMaterial: "Stucco",
    interiorMaterial: "Drywall",
    channel: "call",
    contactName: "Dave",
    notes: "",
    ...over,
  };
}

describe("firstMissingAnswer", () => {
  it("passes a complete check-in", () => {
    expect(firstMissingAnswer(full())).toBeNull();
  });

  it("requires all six answers, and names them in form order", () => {
    // Each of these is a `raise exception` in log_gc_checkin with the same
    // meaning; the catalog key beside it is the English the crew reads.
    expect(firstMissingAnswer(full({ expectedEndDate: "" }))).toBe("expectedEndDate");
    expect(firstMissingAnswer(full({ roofOnDate: "" }))).toBe("roofOnDate");
    expect(firstMissingAnswer(full({ framingChecked: null }))).toBe("framingChecked");
    expect(firstMissingAnswer(full({ setPreference: "" }))).toBe("setPreference");
    expect(firstMissingAnswer(full({ exteriorMaterial: "" }))).toBe("exteriorMaterial");
    expect(firstMissingAnswer(full({ interiorMaterial: "" }))).toBe("interiorMaterial");
  });

  it("points at the first empty box when several are empty", () => {
    const empty = full({ expectedEndDate: "", roofOnDate: "", exteriorMaterial: "" });
    expect(firstMissingAnswer(empty)).toBe("expectedEndDate");
  });

  it("counts 'he has not said' as an answer", () => {
    // The GC genuinely not having decided is a real answer and the commonest
    // one early on. Refusing it would push somebody into inventing "inset".
    expect(firstMissingAnswer(full({ setPreference: "unknown" }))).toBeNull();
  });

  it("refuses a set preference that is not one of the three", () => {
    expect(firstMissingAnswer(full({ setPreference: "flush" }))).toBe("setPreference");
  });

  it("refuses whitespace as a material", () => {
    // "   " passes a bare truthiness check and lands in the database as a
    // material nobody can read. The SQL trims and refuses it too.
    expect(firstMissingAnswer(full({ exteriorMaterial: "   " }))).toBe("exteriorMaterial");
    expect(firstMissingAnswer(full({ interiorMaterial: "\t" }))).toBe("interiorMaterial");
  });

  it("refuses a date that only looks like one", () => {
    // `new Date("2026-02-31")` rolls silently forward to March 3rd, so a bare
    // regex would accept a day that does not exist and store the wrong one.
    expect(firstMissingAnswer(full({ roofOnDate: "2026-02-31" }))).toBe("roofOnDate");
    expect(firstMissingAnswer(full({ roofOnDate: "next Tuesday" }))).toBe("roofOnDate");
    expect(firstMissingAnswer(full({ roofOnDate: "2026-13-01" }))).toBe("roofOnDate");
  });

  it("accepts a check-in with no channel at all", () => {
    // The GC's own page never asks how he talked to us — he is answering ON the
    // page, and asking would be a seventh question for no information.
    const { channel: _channel, ...noChannel } = full();
    expect(firstMissingAnswer(noChannel as GcCheckinDraft)).toBeNull();
  });

  it("refuses a channel that is not one of the four", () => {
    expect(firstMissingAnswer(full({ channel: "carrier pigeon" }))).toBe("channel");
  });
});

describe("gcBrandOf", () => {
  it("reads the two the office can choose", () => {
    expect(gcBrandOf("forge")).toBe("forge");
    expect(gcBrandOf("stg")).toBe("stg");
  });

  it("falls back to STG for anything else", () => {
    // STG is the outward-facing brand and the column's default, so a null (a
    // job created before this wave) or a value from the future reads as the
    // brand a customer already expects to hear from.
    expect(gcBrandOf(null)).toBe("stg");
    expect(gcBrandOf(undefined)).toBe("stg");
    expect(gcBrandOf("something else")).toBe("stg");
  });

  it("writes each brand out the way the owner spells it", () => {
    // Q20 is the owner's own design and these are his words, ampersand and all.
    expect(GC_BRAND_NAMES.stg).toBe("STG Windows & Doors");
    expect(GC_BRAND_NAMES.forge).toBe("Forge Windows and Doors");
  });
});

describe("gcLinkDelivery", () => {
  // The card used to read its "Sent to …" line off sent_to_email, which is
  // written when the link is MINTED. So a foreman saw the builder's address on
  // the card whether or not a mail server had ever seen the message — and the
  // "email is not configured" note that told him the truth was component state
  // that vanished the moment he reloaded the job. These cases are that bug.

  it("says an email went only when the send stamped it", () => {
    expect(
      gcLinkDelivery({ sent_at: "2026-09-04T10:00:00Z", sent_to_email: "bob@builder.com" }),
    ).toBe("sent");
  });

  it("says nothing went when the address is there and the stamp is not", () => {
    // RESEND_API_KEY unset: create_gc_link wrote the address, send-email
    // answered "not configured", and nothing left the building.
    expect(gcLinkDelivery({ sent_at: null, sent_to_email: "bob@builder.com" })).toBe("unsent");
  });

  it("stays quiet for a link nobody put an address on", () => {
    // Minted to be copied and texted. There is no email to report either way.
    expect(gcLinkDelivery({ sent_at: null, sent_to_email: null })).toBe("silent");
  });

  it("stays quiet for a job with no live link at all", () => {
    expect(gcLinkDelivery(null)).toBe("silent");
  });

  it("stays quiet rather than naming a blank address", () => {
    // Unreachable — send-email refuses a link with no address before it ever
    // stamps one. An impossible row should make the card quiet, not print
    // "Sent to ".
    expect(gcLinkDelivery({ sent_at: "2026-09-04T10:00:00Z", sent_to_email: null })).toBe(
      "silent",
    );
  });
});
