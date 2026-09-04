// The credential rule, tested where it is readable (Wave O, O1/O4/O5).
//
// The block named after claim_credential_nudges() is the pin between this file
// and migration 20260983000000: the SQL and the TypeScript answer the same
// question, and a change to one that is not made to the other fails here rather
// than at 7 AM on somebody's phone.

import { describe, expect, it } from "vitest";
import {
  CERTIFICATION_KINDS,
  EXPIRED_NUDGE_GRACE_DAYS,
  EXPIRY_WARN_DAYS,
  countsOnBid,
  credentialDocExt,
  credentialDocPath,
  dueCredentialNudges,
  expiringSoon,
  expiryState,
  isLive,
  summarizeCertifications,
  summaryText,
  type Certification,
  type CertificationKind,
} from "./credentials";

const TODAY = "2026-09-04";

/** A day `offset` days from TODAY, as YYYY-MM-DD. */
function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00`);
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cert(over: Partial<Certification> = {}): Certification {
  return {
    id: "c1",
    profileId: "p1",
    kind: "osha30",
    otherLabel: null,
    issuedOn: day(-400),
    expiresOn: day(200),
    documentPath: null,
    verifiedBy: "sup",
    verifiedAt: "2026-01-01T00:00:00Z",
    createdBy: "p1",
    createdAt: "2026-01-01T00:00:00Z",
    voidedAt: null,
    ...over,
  };
}

/** English labels, so the summary line reads like the one in the spec. */
const EN: Record<CertificationKind, string> = {
  osha30: "OSHA 30",
  osha10: "OSHA 10",
  first_aid_cpr: "first aid / CPR",
  aerial_lift: "aerial lift",
  forklift: "forklift",
  fall_protection: "fall protection",
  other: "other",
};

describe("expiryState — what colour the chip is", () => {
  it("is grey when the card carries no expiry date at all", () => {
    // Not a warning and not a clean bill of health: nobody said when it runs
    // out, and pretending that is "fine forever" is the lie worth avoiding.
    expect(expiryState(null, TODAY)).toBe("none");
    expect(expiryState(undefined, TODAY)).toBe("none");
    expect(expiryState("", TODAY)).toBe("none");
  });

  it("is green with more than thirty days left", () => {
    expect(expiryState(day(EXPIRY_WARN_DAYS + 1), TODAY)).toBe("ok");
    expect(expiryState(day(365), TODAY)).toBe("ok");
  });

  it("turns amber on the day the last thirty days begin, not the day after", () => {
    expect(expiryState(day(EXPIRY_WARN_DAYS), TODAY)).toBe("soon");
    expect(expiryState(day(1), TODAY)).toBe("soon");
    // The day it expires is still amber — the card is valid until midnight.
    expect(expiryState(TODAY, TODAY)).toBe("soon");
  });

  it("is red the day after it runs out", () => {
    expect(expiryState(day(-1), TODAY)).toBe("expired");
    expect(expiryState(day(-900), TODAY)).toBe("expired");
  });

  it("reads a timestamp as its date half rather than failing", () => {
    expect(expiryState(`${day(5)}T00:00:00Z`, TODAY)).toBe("soon");
  });

  it("says nothing about a date it cannot read", () => {
    expect(expiryState("soon-ish", TODAY)).toBe("none");
  });
});

describe("countsOnBid — which cards a bid may claim", () => {
  it("counts a verified, unexpired card", () => {
    expect(countsOnBid(cert(), TODAY)).toBe(true);
  });

  it("counts a verified card that never expires", () => {
    expect(countsOnBid(cert({ expiresOn: null }), TODAY)).toBe(true);
  });

  it("refuses a card nobody has verified", () => {
    // "I have an OSHA 30" is a claim until somebody looks at the paper, and a
    // bid that counts claims is a bid that gets somebody turned away at a gate.
    expect(countsOnBid(cert({ verifiedAt: null, verifiedBy: null }), TODAY)).toBe(false);
  });

  it("refuses an expired card", () => {
    expect(countsOnBid(cert({ expiresOn: day(-1) }), TODAY)).toBe(false);
  });

  it("refuses a voided card even though it is still on file", () => {
    expect(countsOnBid(cert({ voidedAt: "2026-05-01T00:00:00Z" }), TODAY)).toBe(false);
    expect(isLive(cert({ voidedAt: "2026-05-01T00:00:00Z" }))).toBe(false);
  });
});

describe("summarizeCertifications and summaryText — the line a bid pastes", () => {
  it("produces the spec's own example, in the spec's own order", () => {
    const rows: Certification[] = [
      ...Array.from({ length: 4 }, (_, i) => cert({ id: `a${i}`, kind: "osha30" })),
      ...Array.from({ length: 12 }, (_, i) => cert({ id: `b${i}`, kind: "osha10" })),
      ...Array.from({ length: 6 }, (_, i) => cert({ id: `c${i}`, kind: "aerial_lift" })),
    ];
    expect(summaryText(summarizeCertifications(rows, TODAY), (k) => EN[k])).toBe(
      "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift",
    );
  });

  it("leaves out the kinds nobody holds rather than printing a zero", () => {
    const counts = summarizeCertifications([cert({ kind: "forklift" })], TODAY);
    expect(counts).toEqual([{ kind: "forklift", n: 1 }]);
  });

  it("never counts an unverified, expired or voided card", () => {
    const rows = [
      cert({ id: "ok" }),
      cert({ id: "unverified", verifiedAt: null }),
      cert({ id: "expired", expiresOn: day(-2) }),
      cert({ id: "void", voidedAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(summarizeCertifications(rows, TODAY)).toEqual([{ kind: "osha30", n: 1 }]);
  });

  it("carries no names, because the line is pasted into somebody else's document", () => {
    const rows = [cert({ profileId: "cesar" }), cert({ id: "c2", profileId: "maria" })];
    const line = summaryText(summarizeCertifications(rows, TODAY), (k) => EN[k]);
    expect(line).not.toMatch(/cesar|maria/i);
    expect(line).toBe("2 OSHA 30");
  });

  it("is an empty string when the company holds nothing yet", () => {
    expect(summaryText(summarizeCertifications([], TODAY), (k) => EN[k])).toBe("");
  });

  it("orders by the vocabulary, not by how many there are", () => {
    const rows = [
      cert({ id: "l1", kind: "forklift" }),
      cert({ id: "l2", kind: "forklift" }),
      cert({ id: "o1", kind: "osha30" }),
    ];
    expect(summarizeCertifications(rows, TODAY).map((c) => c.kind)).toEqual([
      "osha30",
      "forklift",
    ]);
  });

  it("keeps every kind the CHECK allows", () => {
    expect([...CERTIFICATION_KINDS].sort()).toEqual(
      [
        "aerial_lift",
        "fall_protection",
        "first_aid_cpr",
        "forklift",
        "osha10",
        "osha30",
        "other",
      ].sort(),
    );
  });
});

describe("expiringSoon — the Heartbeat tile's number", () => {
  it("counts the cards inside the warning window and nothing else", () => {
    const rows = [
      cert({ id: "today", expiresOn: TODAY }),
      cert({ id: "edge", expiresOn: day(EXPIRY_WARN_DAYS) }),
      cert({ id: "past-edge", expiresOn: day(EXPIRY_WARN_DAYS + 1) }),
      cert({ id: "gone", expiresOn: day(-1) }),
      cert({ id: "never", expiresOn: null }),
    ];
    expect(expiringSoon(rows, TODAY).map((c) => c.id)).toEqual(["today", "edge"]);
  });

  it("counts an unverified card, because it is still somebody's card", () => {
    expect(expiringSoon([cert({ expiresOn: day(3), verifiedAt: null })], TODAY)).toHaveLength(1);
  });

  it("ignores a voided card", () => {
    const rows = [cert({ expiresOn: day(3), voidedAt: "2026-08-01T00:00:00Z" })];
    expect(expiringSoon(rows, TODAY)).toHaveLength(0);
  });
});

describe("dueCredentialNudges — the readable twin of claim_credential_nudges()", () => {
  it("claims the last thirty days as a WINDOW, so a missed morning drops nothing", () => {
    // The SQL says `days_out between 1 and 30`, not "= 30", for exactly this
    // reason; the ledger's unique key is what keeps it to once per expiry date.
    for (const offset of [1, 2, 15, EXPIRY_WARN_DAYS]) {
      const due = dueCredentialNudges([cert({ expiresOn: day(offset) })], TODAY);
      expect(due.map((d) => d.kind)).toEqual(["credential_30d"]);
      expect(due[0].onDate).toBe(day(offset));
      expect(due[0].daysUntil).toBe(offset);
    }
  });

  it("says something ON the day the card runs out, not the morning after", () => {
    // Both rules key their ledger row on the SAME date — the expiry — so a day
    // claimed by the thirty-day rule is a day the expiry rule can never speak
    // on. With the thirty-day window starting at 0 the last morning somebody
    // could still act was the one morning nothing was said, and the next push
    // landed a day late, worded as a lapse. Day 0 therefore belongs to the
    // expiry rule.
    const due = dueCredentialNudges([cert({ expiresOn: TODAY })], TODAY);
    expect(due.map((d) => d.kind)).toEqual(["credential_expired"]);
    expect(due[0].daysUntil).toBe(0);
    expect(due[0].onDate).toBe(TODAY);
  });

  it("gives the two pushes one ledger key each, so neither swallows the other", () => {
    // The spec asks for exactly two pushes over a card's life: one when it
    // enters the window, one on the day. Their (kind, onDate) pairs must differ
    // or the second is dropped by `on conflict do nothing`.
    const entering = dueCredentialNudges([cert({ expiresOn: day(EXPIRY_WARN_DAYS) })], TODAY);
    const onTheDay = dueCredentialNudges([cert({ expiresOn: TODAY })], TODAY);
    expect(entering[0].kind).not.toBe(onTheDay[0].kind);
  });

  it("never claims two kinds for one card on one morning", () => {
    // The windows are 1..30 and -30..0. An overlap would push twice in a
    // morning about the same card.
    for (let offset = -EXPIRED_NUDGE_GRACE_DAYS; offset <= EXPIRY_WARN_DAYS; offset += 1) {
      expect(dueCredentialNudges([cert({ expiresOn: day(offset) })], TODAY)).toHaveLength(1);
    }
  });

  it("says nothing about a card with more than thirty days left", () => {
    expect(dueCredentialNudges([cert({ expiresOn: day(EXPIRY_WARN_DAYS + 1) })], TODAY)).toEqual(
      [],
    );
  });

  it("claims a card that has run out inside the grace window", () => {
    const due = dueCredentialNudges([cert({ expiresOn: day(-1) })], TODAY);
    expect(due.map((d) => d.kind)).toEqual(["credential_expired"]);
    expect(due[0].onDate).toBe(day(-1));
  });

  it("stays quiet about a card that expired long ago", () => {
    // A 2019 card typed in today as history must not wake three supervisors'
    // phones about a fact everybody already knows.
    expect(
      dueCredentialNudges([cert({ expiresOn: day(-EXPIRED_NUDGE_GRACE_DAYS - 1) })], TODAY),
    ).toEqual([]);
    expect(
      dueCredentialNudges([cert({ expiresOn: day(-EXPIRED_NUDGE_GRACE_DAYS) })], TODAY),
    ).toHaveLength(1);
  });

  it("keys the warning to the expiry date, so a renewal earns a fresh one", () => {
    const first = dueCredentialNudges([cert({ expiresOn: day(10) })], TODAY);
    const renewed = dueCredentialNudges([cert({ expiresOn: day(20) })], TODAY);
    expect(first[0].onDate).not.toBe(renewed[0].onDate);
  });

  it("warns about an UNVERIFIED card", () => {
    // The office not having got round to looking at the paper is not a reason
    // to let somebody's OSHA card lapse.
    expect(
      dueCredentialNudges([cert({ expiresOn: day(5), verifiedAt: null })], TODAY),
    ).toHaveLength(1);
  });

  it("never warns about a voided card or one with no expiry", () => {
    expect(
      dueCredentialNudges(
        [
          cert({ id: "v", expiresOn: day(5), voidedAt: "2026-08-01T00:00:00Z" }),
          cert({ id: "n", expiresOn: null }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  it("carries the person, so the sweep knows whose phone to reach", () => {
    const due = dueCredentialNudges([cert({ profileId: "cesar", expiresOn: day(2) })], TODAY);
    expect(due[0].profileId).toBe("cesar");
    expect(due[0].certificationId).toBe("c1");
  });
});

describe("credentialDocPath — the path IS the permission", () => {
  it("puts the person's id in the first folder, which the storage policy reads", () => {
    const path = credentialDocPath("11111111-2222-4333-8444-555555555555");
    expect(path.split("/")[0]).toBe("11111111-2222-4333-8444-555555555555");
    expect(path).toMatch(/\.jpg$/);
  });

  it("never hands out the same name twice", () => {
    const a = credentialDocPath("p1");
    const b = credentialDocPath("p1");
    expect(a).not.toBe(b);
  });

  it("keeps a PDF a PDF", () => {
    expect(credentialDocPath("p1", "pdf")).toMatch(/\.pdf$/);
  });
});

describe("credentialDocExt — a stored card is named what it actually is", () => {
  it("names each of the bucket's four types honestly", () => {
    // A signed URL serves this path. A PNG under a .jpg name is a file the
    // browser downloads instead of showing.
    expect(credentialDocExt("image/jpeg")).toBe("jpg");
    expect(credentialDocExt("image/png")).toBe("png");
    expect(credentialDocExt("image/webp")).toBe("webp");
    expect(credentialDocExt("application/pdf")).toBe("pdf");
  });

  it("falls back to jpg for anything the bucket would refuse anyway", () => {
    expect(credentialDocExt("image/heic")).toBe("jpg");
    expect(credentialDocExt("")).toBe("jpg");
    expect(credentialDocExt(null)).toBe("jpg");
    expect(credentialDocExt(undefined)).toBe("jpg");
  });
});
