import { describe, expect, it } from "vitest";
import {
  creditChoices,
  creditLine,
  creditToSend,
  defaultCredit,
  shouldAskWhoInstalled,
} from "./credit";

const SAM = { id: "sam", name: "Sam", role: "installer" };
const JED = { id: "jed", name: "Jed", role: "foreman" };
const MARIA = { id: "maria", name: "Maria", role: "installer" };
const CREW = [SAM, JED, MARIA];

describe("shouldAskWhoInstalled", () => {
  it("stays quiet on your own unit — the ordinary finish is one tap", () => {
    expect(shouldAskWhoInstalled({ meId: "sam", assignedTo: "sam" })).toBe(false);
  });

  it("stays quiet on a unit nobody has been given", () => {
    expect(shouldAskWhoInstalled({ meId: "sam", assignedTo: null })).toBe(false);
  });

  it("asks when the unit is somebody else's", () => {
    expect(shouldAskWhoInstalled({ meId: "jed", assignedTo: "sam" })).toBe(true);
  });

  it("stays quiet while we do not yet know who is signed in", () => {
    // A null profile is "not known yet", never "not me" — the same rule route
    // guards follow for a loading role.
    expect(shouldAskWhoInstalled({ meId: null, assignedTo: "sam" })).toBe(false);
  });
});

describe("creditChoices", () => {
  it("offers a plain installer the assignee and themselves, nobody else", () => {
    const choices = creditChoices({
      meId: "maria",
      assignedTo: "sam",
      canCreditAnyone: false,
      crew: CREW,
    });
    expect(choices.map((c) => c.id)).toEqual(["sam", "maria"]);
  });

  it("opens the whole crew to a foreman, assignee first", () => {
    const choices = creditChoices({
      meId: "jed",
      assignedTo: "sam",
      canCreditAnyone: true,
      crew: CREW,
    });
    expect(choices.map((c) => c.id)).toEqual(["sam", "jed", "maria"]);
  });

  it("never lists the same person twice when they are both assignee and me", () => {
    const choices = creditChoices({
      meId: "sam",
      assignedTo: "sam",
      canCreditAnyone: true,
      crew: CREW,
    });
    expect(choices.map((c) => c.id)).toEqual(["sam", "jed", "maria"]);
  });

  it("drops an assignee the crew list does not know — the server refuses those", () => {
    const choices = creditChoices({
      meId: "jed",
      assignedTo: "left-the-company",
      canCreditAnyone: false,
      crew: CREW,
    });
    expect(choices.map((c) => c.id)).toEqual(["jed"]);
  });
});

describe("defaultCredit", () => {
  it("starts on the assignee — the unit was given to them", () => {
    const choices = creditChoices({
      meId: "jed",
      assignedTo: "sam",
      canCreditAnyone: true,
      crew: CREW,
    });
    expect(defaultCredit({ meId: "jed", assignedTo: "sam", choices })).toBe("sam");
  });

  it("falls back to me when the assignee is not on the crew list", () => {
    const choices = creditChoices({
      meId: "jed",
      assignedTo: "ghost",
      canCreditAnyone: false,
      crew: CREW,
    });
    expect(defaultCredit({ meId: "jed", assignedTo: "ghost", choices })).toBe("jed");
  });
});

describe("creditToSend", () => {
  it("sends nothing when the credit is my own work", () => {
    expect(creditToSend({ meId: "sam", creditedTo: "sam" })).toBeNull();
  });

  it("sends nothing when nobody was picked", () => {
    expect(creditToSend({ meId: "sam", creditedTo: null })).toBeNull();
  });

  it("sends the person when it is somebody else", () => {
    expect(creditToSend({ meId: "jed", creditedTo: "sam" })).toBe("sam");
  });
});

describe("creditLine", () => {
  const nameOf = (id: string) => CREW.find((c) => c.id === id)?.name ?? null;
  // What `install_events.installer` ACTUALLY holds. The app fills p_installer
  // from the signed-in email and always has, so every one of these cases feeds
  // the real column shape — a test that put "Jed" in there proved nothing and
  // shipped a Record line reading "filed by jed@forgewd.com".
  const JED_EMAIL = "jed@forgewd.com";

  it("names the filer from their profile, not from the login they filed with", () => {
    expect(creditLine({ installer: JED_EMAIL, installer_id: "jed" }, nameOf)).toBe("Jed");
  });

  it("names both people when one filed for another", () => {
    expect(
      creditLine(
        { installer: JED_EMAIL, installer_id: "jed", credited_to: "sam" },
        nameOf,
      ),
    ).toBe("Installed by Sam · filed by Jed");
  });

  it("shows the stored text when the roster cannot name the filer", () => {
    // A profile that has since gone, or a round filed before ids were stored:
    // an email a foreman recognises beats no name at all.
    expect(
      creditLine({ installer: JED_EMAIL, installer_id: "ghost" }, nameOf),
    ).toBe(JED_EMAIL);
    expect(creditLine({ installer: JED_EMAIL, credited_to: null }, nameOf)).toBe(
      JED_EMAIL,
    );
  });

  it("falls back to the filer's id when no name was typed at file time", () => {
    expect(creditLine({ installer: null, installer_id: "jed" }, nameOf)).toBe("Jed");
  });

  it("says something rather than nothing for a credited person we cannot name", () => {
    expect(
      creditLine({ installer: JED_EMAIL, installer_id: "jed", credited_to: "who-dis" }, nameOf),
    ).toBe("Installed by someone else · filed by Jed");
  });

  it("is null for a round with no name on it at all", () => {
    expect(creditLine({ installer: null }, nameOf)).toBeNull();
  });
});
