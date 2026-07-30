import { describe, expect, it } from "vitest";
import {
  buildInviteLink,
  canInviteRole,
  canManageMember,
  CODE_ALPHABET,
  CODE_LENGTH,
  crewLoginFromName,
  expiresInWords,
  formatInviteCode,
  generateInviteCode,
  hashInviteCode,
  INVITABLE_ROLES,
  invitableRolesFor,
  inviteExpiryFrom,
  inviteShareMessage,
  inviteStatus,
  INVITE_TTL_DAYS,
  isMintedCrewLogin,
  isRedeemable,
  looksLikeInviteCode,
  MIN_PASSWORD_LENGTH,
  normalizeInviteCode,
  readCodeFromUrl,
  redemptionRefusal,
  roleRank,
  validateInvitePassword,
} from "../../../supabase/functions/_shared/crewInvites";

// ===========================================================================
// The escalation rule. This is the security-critical part of the file: an
// invite says "create an account at role X", so if these tests are wrong the
// invite screen is a privilege ladder.
// ===========================================================================

describe("canInviteRole", () => {
  it("refuses an installer outright — they may not invite at any role", () => {
    for (const target of INVITABLE_ROLES) {
      const verdict = canInviteRole("installer", target);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe("not-allowed-to-invite");
    }
  });

  it("refuses a foreman outright, matching set_profile_role's supervisor floor", () => {
    for (const target of INVITABLE_ROLES) {
      expect(canInviteRole("foreman", target).ok).toBe(false);
    }
  });

  it("lets a supervisor invite up to their own rank but never an owner", () => {
    expect(canInviteRole("supervisor", "installer").ok).toBe(true);
    expect(canInviteRole("supervisor", "foreman").ok).toBe(true);
    expect(canInviteRole("supervisor", "supervisor").ok).toBe(true);

    const owner = canInviteRole("supervisor", "owner");
    expect(owner.ok).toBe(false);
    expect(owner.reason).toBe("above-own-role");
    expect(owner.message).toContain("above your own role");
  });

  it("lets an owner invite every role, including another owner", () => {
    for (const target of INVITABLE_ROLES) {
      expect(canInviteRole("owner", target).ok).toBe(true);
    }
  });

  it("treats an unknown, missing or empty caller role as an installer", () => {
    // The floor matters: a legacy or absent role must never over-grant.
    for (const caller of [null, undefined, "", "wizard", "ADMIN", "Owner"]) {
      expect(canInviteRole(caller, "installer").ok).toBe(false);
    }
  });

  it("honours the legacy role aliases the database still recognises", () => {
    // big_boss -> owner(3), admin -> supervisor(2), lead -> foreman(1).
    expect(canInviteRole("big_boss", "owner").ok).toBe(true);
    expect(canInviteRole("admin", "supervisor").ok).toBe(true);
    expect(canInviteRole("admin", "owner").ok).toBe(false);
    expect(canInviteRole("lead", "installer").ok).toBe(false);
  });

  it("rejects a role that is not a real role, however senior the caller", () => {
    for (const bad of ["superuser", "OWNER", "", null, undefined, "big_boss"]) {
      const verdict = canInviteRole("owner", bad);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe("unknown-role");
    }
  });

  it("checks the role floor before the ladder, so an installer is never told they nearly qualified", () => {
    expect(canInviteRole("installer", "owner").reason).toBe(
      "not-allowed-to-invite",
    );
  });
});

describe("invitableRolesFor", () => {
  it("offers nobody anything below supervisor", () => {
    expect(invitableRolesFor("installer")).toEqual([]);
    expect(invitableRolesFor("foreman")).toEqual([]);
    expect(invitableRolesFor(null)).toEqual([]);
  });

  it("stops a supervisor's list short of owner", () => {
    expect(invitableRolesFor("supervisor")).toEqual([
      "installer",
      "foreman",
      "supervisor",
    ]);
  });

  it("gives an owner the full ladder", () => {
    expect(invitableRolesFor("owner")).toEqual([
      "installer",
      "foreman",
      "supervisor",
      "owner",
    ]);
  });

  it("never offers a role canInviteRole would then refuse", () => {
    for (const caller of ["installer", "foreman", "supervisor", "owner", null]) {
      for (const role of invitableRolesFor(caller)) {
        expect(canInviteRole(caller, role).ok).toBe(true);
      }
    }
  });
});

describe("canManageMember", () => {
  it("refuses anyone below supervisor", () => {
    expect(canManageMember("installer", "installer").ok).toBe(false);
    expect(canManageMember("foreman", "installer").ok).toBe(false);
  });

  it("stops a supervisor touching an owner — this is the takeover guard", () => {
    // "Send new login code" lets the holder set that account's password, so
    // allowing it against a senior account would hand over the company.
    const verdict = canManageMember("supervisor", "owner");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("above-own-role");
  });

  it("allows equals and juniors", () => {
    expect(canManageMember("supervisor", "supervisor").ok).toBe(true);
    expect(canManageMember("supervisor", "foreman").ok).toBe(true);
    expect(canManageMember("owner", "owner").ok).toBe(true);
  });

  it("treats a member with no role as an installer rather than as unmanageable", () => {
    expect(canManageMember("supervisor", null).ok).toBe(true);
    expect(canManageMember("supervisor", "wizard").ok).toBe(true);
  });
});

describe("roleRank", () => {
  it("ranks the ladder and every legacy alias", () => {
    expect(roleRank("owner")).toBe(3);
    expect(roleRank("big_boss")).toBe(3);
    expect(roleRank("supervisor")).toBe(2);
    expect(roleRank("admin")).toBe(2);
    expect(roleRank("foreman")).toBe(1);
    expect(roleRank("lead")).toBe(1);
    expect(roleRank("installer")).toBe(0);
  });

  it("floors anything it does not recognise", () => {
    for (const junk of [null, undefined, "", "Owner", "OWNER", "root"]) {
      expect(roleRank(junk)).toBe(0);
    }
  });
});

// ===========================================================================
// Expiry and single use
// ===========================================================================

const NOW = new Date("2026-08-01T12:00:00.000Z");

function invite(over: Partial<{
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}> = {}) {
  return {
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    redeemed_at: null,
    revoked_at: null,
    ...over,
  };
}

describe("inviteStatus", () => {
  it("is pending while it is unused and in date", () => {
    expect(inviteStatus(invite(), NOW)).toBe("pending");
    expect(isRedeemable(invite(), NOW)).toBe(true);
  });

  it("is expired once the moment passes, and at the exact boundary", () => {
    expect(inviteStatus(invite({ expires_at: NOW.toISOString() }), NOW)).toBe(
      "expired",
    );
    const past = new Date(NOW.getTime() - 1).toISOString();
    expect(inviteStatus(invite({ expires_at: past }), NOW)).toBe("expired");
    expect(isRedeemable(invite({ expires_at: past }), NOW)).toBe(false);
  });

  it("is redeemed once used, and stays redeemed for ever", () => {
    const used = invite({ redeemed_at: "2026-08-01T11:00:00.000Z" });
    expect(inviteStatus(used, NOW)).toBe("redeemed");
    // Single use: a used code must not come back to life just because time
    // passed, or because the row was touched afterwards.
    expect(inviteStatus(used, new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "redeemed",
    );
    expect(isRedeemable(used, NOW)).toBe(false);
  });

  it("reports redeemed ahead of revoked and expired — the past wins", () => {
    const messy = invite({
      redeemed_at: "2026-08-01T11:00:00.000Z",
      revoked_at: "2026-08-01T11:30:00.000Z",
      expires_at: "2026-07-01T00:00:00.000Z",
    });
    expect(inviteStatus(messy, NOW)).toBe("redeemed");
  });

  it("reports revoked ahead of expired, so a cancelled code reads as cancelled", () => {
    const killed = invite({
      revoked_at: "2026-08-01T11:00:00.000Z",
      expires_at: "2026-07-01T00:00:00.000Z",
    });
    expect(inviteStatus(killed, NOW)).toBe("revoked");
    expect(isRedeemable(killed, NOW)).toBe(false);
  });

  it("treats an unreadable expiry date as expired, never as valid", () => {
    // Refusing a good invite is a phone call; honouring a bad one is an account.
    for (const bad of ["", "not a date", "2026-13-45"]) {
      expect(inviteStatus(invite({ expires_at: bad }), NOW)).toBe("expired");
      expect(isRedeemable(invite({ expires_at: bad }), NOW)).toBe(false);
    }
  });
});

describe("inviteExpiryFrom", () => {
  it("is exactly the documented seven days out", () => {
    const out = inviteExpiryFrom(NOW);
    expect(out.getTime() - NOW.getTime()).toBe(
      INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(INVITE_TTL_DAYS).toBe(7);
  });

  it("produces something that is immediately redeemable and later is not", () => {
    const expires_at = inviteExpiryFrom(NOW).toISOString();
    expect(isRedeemable(invite({ expires_at }), NOW)).toBe(true);
    const justAfter = new Date(
      NOW.getTime() + (INVITE_TTL_DAYS * 24 * 60 * 60 * 1000) + 1,
    );
    expect(isRedeemable(invite({ expires_at }), justAfter)).toBe(false);
  });
});

describe("expiresInWords", () => {
  const inDays = (d: number) =>
    new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000).toISOString();

  it("counts whole days down", () => {
    expect(expiresInWords(inDays(7), NOW)).toBe("7 days left");
    expect(expiresInWords(inDays(2), NOW)).toBe("2 days left");
  });

  it("switches to hours inside the last two days", () => {
    expect(expiresInWords(inDays(1), NOW)).toBe("24 hours left");
    const oneHour = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(expiresInWords(oneHour, NOW)).toBe("1 hour left");
  });

  it("says so plainly in the last hour, and once it is gone", () => {
    const soon = new Date(NOW.getTime() + 60_000).toISOString();
    expect(expiresInWords(soon, NOW)).toBe("Expires within the hour");
    expect(expiresInWords(NOW.toISOString(), NOW)).toBe("Expired");
    expect(expiresInWords("rubbish", NOW)).toBe("Expired");
  });
});

describe("redemptionRefusal", () => {
  it("tells the crew member what to do about each dead end", () => {
    expect(redemptionRefusal("redeemed")).toContain("already been used");
    expect(redemptionRefusal("expired")).toContain("expired");
    expect(redemptionRefusal("revoked")).toContain("cancelled");
    for (const s of ["redeemed", "expired", "revoked"] as const) {
      expect(redemptionRefusal(s)).toContain("Ask for a new one");
    }
  });

  it("says nothing about a pending invite, which is not a refusal", () => {
    expect(redemptionRefusal("pending")).toBe("");
  });
});

// ===========================================================================
// The code
// ===========================================================================

describe("generateInviteCode", () => {
  it("is the documented length and uses only the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it("never contains a character people mis-read off a cracked screen", () => {
    const confusable = ["I", "L", "O", "0", "1"];
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      for (const c of confusable) expect(code).not.toContain(c);
    }
    for (const c of confusable) expect(CODE_ALPHABET).not.toContain(c);
  });

  it("does not repeat itself — ~49.5 bits, so collisions must not show up", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateInviteCode());
    expect(seen.size).toBe(500);
  });

  it("uses a good spread of the alphabet rather than a biased slice", () => {
    // Rejection sampling exists so `byte % 31` does not favour the first four
    // symbols. Over 400 ten-symbol codes every symbol should appear.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const c of generateInviteCode()) seen.add(c);
    }
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });
});

describe("normalizeInviteCode", () => {
  it("forgives the ways a code arrives out of a text message", () => {
    const canonical = "ABCDE23456";
    for (
      const typed of [
        "abcde23456",
        "ABCDE-23456",
        "abcde 23456",
        "  ABCDE-23456  ",
        "(ABCDE-23456)",
        "abcde–23456",
      ]
    ) {
      expect(normalizeInviteCode(typed)).toBe(canonical);
    }
  });

  it("copes with nothing at all", () => {
    expect(normalizeInviteCode(null)).toBe("");
    expect(normalizeInviteCode(undefined)).toBe("");
    expect(normalizeInviteCode("")).toBe("");
  });
});

describe("formatInviteCode", () => {
  it("splits a full code into two readable halves", () => {
    expect(formatInviteCode("ABCDE23456")).toBe("ABCDE-23456");
    expect(formatInviteCode("abcde-23456")).toBe("ABCDE-23456");
  });

  it("round-trips through normalize", () => {
    const code = generateInviteCode();
    expect(normalizeInviteCode(formatInviteCode(code))).toBe(code);
  });

  it("leaves anything that is not a full code alone rather than mangling it", () => {
    expect(formatInviteCode("ABC")).toBe("ABC");
  });
});

describe("looksLikeInviteCode", () => {
  it("accepts a real code however it was typed", () => {
    const code = generateInviteCode();
    expect(looksLikeInviteCode(code)).toBe(true);
    expect(looksLikeInviteCode(formatInviteCode(code))).toBe(true);
    expect(looksLikeInviteCode(code.toLowerCase())).toBe(true);
  });

  it("rejects the wrong length, so junk never reaches the hash", () => {
    expect(looksLikeInviteCode("ABCDE2345")).toBe(false);
    expect(looksLikeInviteCode("ABCDE234567")).toBe(false);
    expect(looksLikeInviteCode("")).toBe(false);
    expect(looksLikeInviteCode(null)).toBe(false);
  });

  it("rejects right-length codes containing excluded characters", () => {
    expect(looksLikeInviteCode("ABCDE2345O")).toBe(false);
    expect(looksLikeInviteCode("1BCDE23456")).toBe(false);
    expect(looksLikeInviteCode("ILCDE23456")).toBe(false);
  });
});

describe("hashInviteCode", () => {
  it("is deterministic, so a stored invite can be found from the code alone", async () => {
    const code = generateInviteCode();
    expect(await hashInviteCode(code)).toBe(await hashInviteCode(code));
  });

  it("never stores or reveals the code itself", async () => {
    const code = generateInviteCode();
    const hash = await hashInviteCode(code);
    expect(hash).not.toContain(code);
    expect(hash).not.toBe(code);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("differs for different codes, including a one-character change", async () => {
    const a = await hashInviteCode("ABCDE23456");
    const b = await hashInviteCode("ABCDE23457");
    expect(a).not.toBe(b);
  });

  it("matches however the person typed it, so case and dashes still redeem", async () => {
    const canonical = await hashInviteCode("ABCDE23456");
    for (const typed of ["abcde23456", "ABCDE-23456", " abcde-23456 "]) {
      expect(await hashInviteCode(typed)).toBe(canonical);
    }
  });
});

// ===========================================================================
// The link Taylor sends
// ===========================================================================

const LIVE = "https://infinity-windows.github.io/infinity-windows/";

describe("buildInviteLink", () => {
  it("keeps the GitHub Pages subpath, which is where the app actually lives", () => {
    const link = buildInviteLink(LIVE, "ABCDE23456");
    expect(link).toBe(
      "https://infinity-windows.github.io/infinity-windows/?join=ABCDE23456",
    );
    // The subpath must survive: dropping it lands on the org's own page.
    expect(link).toContain("/infinity-windows/");
  });

  it("puts the code in a query on a URL that cannot 404 on a static host", () => {
    // GitHub Pages has no rewrite rules, so `/infinity-windows/join` is only a
    // page if a fallback happens to be deployed. `…/infinity-windows/?join=` is
    // always the real index.html.
    const link = buildInviteLink(LIVE, "ABCDE23456");
    expect(link).toContain("/?join=");
    expect(link).not.toMatch(/\/join(\/|\?|$)/);
  });

  it("adds the missing slash so the code is not glued onto the folder name", () => {
    expect(buildInviteLink("https://example.com/app", "ABCDE23456")).toBe(
      "https://example.com/app/?join=ABCDE23456",
    );
  });

  it("works for the localhost dev server too", () => {
    expect(buildInviteLink("http://localhost:5173/", "ABCDE23456")).toBe(
      "http://localhost:5173/?join=ABCDE23456",
    );
  });

  it("drops any query or hash already on the page URL", () => {
    // Built from window.location, which may be mid-route with a stale query.
    expect(buildInviteLink(`${LIVE}?join=OLDCODE123`, "ABCDE23456")).toBe(
      `${LIVE}?join=ABCDE23456`,
    );
    expect(buildInviteLink(`${LIVE}#/crew`, "ABCDE23456")).toBe(
      `${LIVE}?join=ABCDE23456`,
    );
  });

  it("normalises the code it embeds", () => {
    expect(buildInviteLink(LIVE, "abcde-23456")).toContain("join=ABCDE23456");
  });
});

describe("readCodeFromUrl", () => {
  it("reads back exactly what buildInviteLink wrote", () => {
    const code = generateInviteCode();
    expect(readCodeFromUrl(buildInviteLink(LIVE, code))).toBe(code);
  });

  it("finds the code from a bare query string, as location.search gives it", () => {
    expect(readCodeFromUrl("?join=ABCDE23456")).toBe("ABCDE23456");
  });

  it("finds it alongside other parameters, in either order", () => {
    expect(readCodeFromUrl("?utm=sms&join=ABCDE23456")).toBe("ABCDE23456");
    expect(readCodeFromUrl("?join=ABCDE23456&utm=sms")).toBe("ABCDE23456");
  });

  it("returns null when there is no usable code, rather than a broken one", () => {
    expect(readCodeFromUrl(LIVE)).toBeNull();
    expect(readCodeFromUrl("?join=")).toBeNull();
    expect(readCodeFromUrl("?join=TOOSHORT")).toBeNull();
    expect(readCodeFromUrl("?join=ABCDE2345O")).toBeNull();
    expect(readCodeFromUrl(null)).toBeNull();
    expect(readCodeFromUrl("")).toBeNull();
  });

  it("survives a chat app percent-encoding the value", () => {
    expect(readCodeFromUrl("?join=ABCDE%2D23456")).toBe("ABCDE23456");
  });
});

describe("inviteShareMessage", () => {
  it("contains everything the crew member needs and nothing they don't", () => {
    const link = buildInviteLink(LIVE, "ABCDE23456");
    const msg = inviteShareMessage("Mike Alvarez", "installer", link, "ABCDE23456");
    expect(msg).toContain("Mike");
    expect(msg).toContain("Installer");
    expect(msg).toContain(link);
    // The code is spelled out as well, for a chat app that mangles the link.
    expect(msg).toContain("ABCDE-23456");
    expect(msg).toContain(`${INVITE_TTL_DAYS} days`);
  });

  it("uses the first name only, and copes with one-word or empty names", () => {
    expect(inviteShareMessage("Mike Alvarez", "installer", "x", "ABCDE23456"))
      .toContain("Mike —");
    expect(inviteShareMessage("Mike", "installer", "x", "ABCDE23456"))
      .toContain("Mike —");
    expect(inviteShareMessage("  ", "installer", "x", "ABCDE23456"))
      .toContain("there —");
  });

  it("names the role in words a crew member reads, not the database value", () => {
    const msg = inviteShareMessage("Sam", "supervisor", "x", "ABCDE23456");
    expect(msg).toContain("Supervisor");
    expect(msg).not.toContain("supervisor)");
  });
});

// ===========================================================================
// What the crew member types
// ===========================================================================

describe("validateInvitePassword", () => {
  it("requires a password at all", () => {
    expect(validateInvitePassword("").ok).toBe(false);
    expect(validateInvitePassword(undefined).ok).toBe(false);
    expect(validateInvitePassword(null).ok).toBe(false);
    expect(validateInvitePassword(12345678).ok).toBe(false);
  });

  it("enforces length, and only length", () => {
    expect(validateInvitePassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(
      false,
    );
    expect(validateInvitePassword("a".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    // No character-class rule on purpose: those produce Winter2026! written
    // inside a hard hat. A long memorable phrase is accepted.
    expect(validateInvitePassword("my dog is called rusty").ok).toBe(true);
  });

  it("catches a mistyped confirmation when one is given", () => {
    expect(validateInvitePassword("longenough1", "longenough1").ok).toBe(true);
    const mismatch = validateInvitePassword("longenough1", "longenough2");
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toContain("don't match");
  });

  it("reports too-short before mismatched, the more useful of the two", () => {
    expect(validateInvitePassword("short", "different")?.error).toContain(
      "at least",
    );
  });
});

describe("crewLoginFromName", () => {
  it("builds a login from a name when there is no real email", () => {
    expect(crewLoginFromName("Mike Alvarez", "AB12CD")).toBe(
      "mike.alvarez.ab12cd@crew.infinitywindows.app",
    );
  });

  it("is obviously internal, so nobody expects mail to arrive at it", () => {
    const login = crewLoginFromName("Mike Alvarez", "AB12CD");
    expect(isMintedCrewLogin(login)).toBe(true);
    expect(isMintedCrewLogin("mike@gmail.com")).toBe(false);
    expect(isMintedCrewLogin(null)).toBe(false);
  });

  it("survives accents, punctuation and spacing without producing an invalid address", () => {
    for (
      const name of ["José Núñez", "O'Brien-Smith", "  Mary   Jane  ", "李雷"]
    ) {
      const login = crewLoginFromName(name, "AB12CD");
      expect(login).toMatch(/^[a-z0-9.]+@crew\.infinitywindows\.app$/);
      expect(login).not.toContain("..");
      expect(login).not.toMatch(/^\./);
    }
  });

  it("falls back to a usable stem when the name leaves nothing behind", () => {
    expect(crewLoginFromName("", "AB12CD")).toBe(
      "crew.ab12cd@crew.infinitywindows.app",
    );
    expect(crewLoginFromName("!!!", "AB12CD")).toBe(
      "crew.ab12cd@crew.infinitywindows.app",
    );
  });

  it("is unique per invite even for two people with the same name", () => {
    const a = crewLoginFromName("John Smith", generateInviteCode(6));
    const b = crewLoginFromName("John Smith", generateInviteCode(6));
    expect(a).not.toBe(b);
  });

  it("keeps a very long name inside a sane address length", () => {
    const login = crewLoginFromName("A".repeat(200), "AB12CD");
    expect(login.split("@")[0].length).toBeLessThanOrEqual(32);
  });
});
