// The share target behind "Send a recording" (wave U). The addresses come out
// of the database, so the thing worth testing hardest is what this refuses to
// put in a URL.

import { describe, expect, it } from "vitest";
import {
  buildRecordingMail,
  mailAddresses,
  recordingDateLabel,
  type ForemanContact,
} from "./recordings";

const contact = (email: string | null, name = "Jed"): ForemanContact => ({
  contact_name: name,
  contact_email: email,
});

describe("mailAddresses", () => {
  it("keeps ordinary crew addresses in the order they arrived", () => {
    expect(
      mailAddresses([contact("jed@forgewd.com"), contact("sam.b@forgewd.com", "Sam")]),
    ).toEqual(["jed@forgewd.com", "sam.b@forgewd.com"]);
  });

  it("trims whitespace around an address", () => {
    expect(mailAddresses([contact("  jed@forgewd.com ")])).toEqual(["jed@forgewd.com"]);
  });

  it("drops one lead twice — one job or two, they get one line", () => {
    expect(
      mailAddresses([contact("jed@forgewd.com"), contact("JED@ForgeWD.com")]),
    ).toEqual(["jed@forgewd.com"]);
  });

  it("drops anything that could smuggle a second recipient or a query parameter", () => {
    expect(
      mailAddresses([
        contact("jed@forgewd.com,evil@example.com"),
        contact("jed@forgewd.com?bcc=evil@example.com"),
        contact("jed@forgewd.com&cc=evil@example.com"),
        contact("jed@forgewd.com\nBcc: evil@example.com"),
        contact("not an address"),
        contact(""),
        contact(null),
      ]),
    ).toEqual([]);
  });
});

describe("buildRecordingMail", () => {
  it("addresses every lead and puts the job and the day in the subject", () => {
    const mail = buildRecordingMail({
      contacts: [contact("jed@forgewd.com"), contact("sam@forgewd.com", "Sam")],
      subject: "Recording — Sand Hollow — Sep 3, 2026",
      body: "Attach your video.",
    });
    expect(mail.to).toEqual(["jed@forgewd.com", "sam@forgewd.com"]);
    expect(mail.href).toBe(
      "mailto:jed@forgewd.com,sam@forgewd.com" +
        "?subject=Recording%20%E2%80%94%20Sand%20Hollow%20%E2%80%94%20Sep%203%2C%202026" +
        "&body=Attach%20your%20video.",
    );
  });

  it("still opens the composer when nobody could be addressed", () => {
    // The database may not have the address book yet, or a young company may
    // have no lead on the books. An empty To: is a composer the person fills
    // in themselves — better than a button that does nothing.
    const mail = buildRecordingMail({
      contacts: [],
      subject: "Recording — Sep 3, 2026",
      body: "Attach your video.",
    });
    expect(mail.to).toEqual([]);
    expect(mail.href.startsWith("mailto:?subject=")).toBe(true);
  });

  it("escapes a job name that would otherwise break the URL", () => {
    const mail = buildRecordingMail({
      contacts: [contact("jed@forgewd.com")],
      subject: "Recording — Smith & Sons #4 — Sep 3, 2026",
      body: "Attach your video.",
    });
    expect(mail.href).toContain("Smith%20%26%20Sons%20%234");
    expect(mail.href.split("?")[1].split("&").length).toBe(2);
  });
});

describe("recordingDateLabel", () => {
  const day = new Date(2026, 8, 3); // 3 September 2026, local

  it("writes an English date a lead can scan in a full inbox", () => {
    expect(recordingDateLabel(day, "en")).toBe("Sep 3, 2026");
  });

  it("writes a Spanish date in Spanish", () => {
    // The exact short-month spelling moves with the platform's ICU data, so
    // this asserts the parts that matter rather than one library's rendering.
    const es = recordingDateLabel(day, "es");
    expect(es).toContain("2026");
    expect(es).toContain("3");
    expect(es).not.toBe(recordingDateLabel(day, "en"));
  });
});
