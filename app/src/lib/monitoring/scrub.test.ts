// What may leave this crew's phones, pinned down with the events that would
// actually leak.
//
// Every case here is built from something this app really holds: an install
// failure carrying the installer's position, a receipt error with the note
// somebody typed and a builder's email in the message, a URL with a job id and
// a GC token in the query, a fetch breadcrumb carrying the whole request body.
// The assertions are two-sided on purpose — what is gone AND what survived —
// because a scrubber that deleted everything would pass a one-sided test and be
// useless, and the point is a report that is still worth reading.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  routePattern,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
  type ScrubbableEvent,
} from "./scrub";

describe("isSensitiveKey", () => {
  it("catches the named keys, however they are spelled", () => {
    for (const key of [
      "note",
      "notes",
      "caption",
      "address",
      "display_name",
      "name",
      "email",
      "phone",
      "pin",
      "token",
      "password",
      "authorization",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches them inside a longer key, on word boundaries", () => {
    for (const key of [
      "job_address",
      "jobAddress",
      "installer_email",
      "crew_notes",
      "photo_caption",
      "displayName",
      "access_token",
      "pin_hash",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches where a person was standing", () => {
    for (const key of ["lat", "lng", "latitude", "longitude", "accuracy"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches a house, whatever the column happened to be called", () => {
    for (const key of ["site", "site_address", "street", "city", "zip", "location", "place"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches a person under a key that never says the word name", () => {
    for (const key of ["driver", "customer", "contact", "crew_member", "assigned_person"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches free text somebody typed", () => {
    for (const key of ["description", "memo", "title", "details", "summary", "line_text"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("leaves the keys a fix actually needs", () => {
    for (const key of ["role", "build", "offline", "status_code", "method", "route"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("scrubText", () => {
  it("keeps the sentence and masks the email inside it", () => {
    expect(
      scrubText("Could not email the receipt to ben.taylor@stgwindows.com"),
    ).toBe("Could not email the receipt to [email]");
  });

  it("masks a phone number without eating a build id or a timestamp", () => {
    expect(scrubText("call 512-555-0117 back")).toBe("call [phone] back");
    expect(scrubText("(512) 555-0117")).toBe("[phone]");
    expect(scrubText("+1 512 555 0117 is the site")).toBe("[phone] is the site");
    expect(scrubText("build 31eb3cd5f9a2b1")).toBe("build 31eb3cd5f9a2b1");
    expect(scrubText("stamped 1757116800000")).toBe("stamped 1757116800000");
  });

  it("uses no regex feature an older iPhone would refuse to parse", () => {
    // A lookbehind is a PARSE error on Safari before 16.4, and this module is
    // imported before the app mounts — so one here would white-screen the app
    // rather than merely fail to mask something.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../supabase/functions/_shared/scrub.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/\(\?<[=!]/);
  });

  it("masks a jobsite address written into a message, and keeps the sentence", () => {
    expect(
      scrubText("Could not save the receipt — Home Depot, 1425 Sagebrush Hollow Dr"),
    ).toBe("Could not save the receipt — Home Depot, [address]");
    expect(scrubText("could not save install at 1428 Elm Street, Austin TX")).toBe(
      "could not save install at [address], Austin TX",
    );
  });

  it("masks a rounded lat/lng pair, not only a precise one", () => {
    // Three decimals is about a hundred metres — still enough to say which
    // house somebody was standing at.
    expect(scrubText('where: "30.267,-97.743"')).toBe('where: "[coords]"');
  });

  it("masks a lat/lng pair written into a message", () => {
    expect(scrubText("stamped at 30.267153,-97.743061 on arrival")).toBe(
      "stamped at [coords] on arrival",
    );
  });

  it("masks a session token that found its way into a message", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno";
    expect(scrubText(`refresh failed for ${jwt}`)).toBe("refresh failed for [token]");
  });

  it("caps a runaway message", () => {
    const long = scrubText("x".repeat(900));
    expect(long.length).toBeLessThanOrEqual(501);
  });
});

describe("routePattern / scrubUrl", () => {
  it("replaces uuids with :id and keeps the shape of the route", () => {
    expect(
      routePattern("/projects/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77/openings"),
    ).toBe("/projects/:id/openings");
  });

  it("replaces every uuid in the path, not just the first", () => {
    expect(
      routePattern(
        "/projects/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77/openings/9f3b21ce-4d10-4a7b-8c11-77aa9b2e5f01",
      ),
    ).toBe("/projects/:id/openings/:id");
  });

  it("keeps a job code, which names a house and not a person", () => {
    expect(routePattern("/projects/BLACK22/map")).toBe("/projects/BLACK22/map");
  });

  it("drops a GC link token out of the path", () => {
    expect(routePattern("/gc/Ku7Rr3xQm1PdV8ZaN0sYtLbE")).toBe("/gc/:id");
  });

  it("throws the whole query string away — a job id and a token both ride there", () => {
    expect(
      scrubUrl(
        "https://czprjcskmzzagdztqonm.supabase.co/rest/v1/openings" +
          "?project_id=eq.2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77&select=id,notes",
      ),
    ).toBe("https://czprjcskmzzagdztqonm.supabase.co/rest/v1/openings");
  });

  it("keeps the origin, so it is obvious which service answered", () => {
    expect(scrubUrl("https://app.forgewd.com/projects/abc#top")).toBe(
      "https://app.forgewd.com/projects/abc",
    );
  });
});

describe("scrubValue", () => {
  it("redacts a sensitive key at any depth and keeps its neighbours", () => {
    const out = scrubValue({
      unit: "1-1",
      install: { notes: "Ben said the sill was wet", grade: 4 },
    }) as Record<string, Record<string, unknown>>;
    expect(out.unit).toBe("1-1");
    expect(out.install.notes).toBe(REDACTED);
    expect(out.install.grade).toBe(4);
  });

  it("stops at a depth rather than walking an endless object", () => {
    let deep: Record<string, unknown> = { end: "here" };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain(REDACTED);
  });
});

describe("scrubEvent", () => {
  it("an install failure keeps its message and loses the crew member's position", () => {
    const event: ScrubbableEvent = {
      message: "finish_unit failed",
      release: "31eb3cd",
      tags: { role: "installer", build: "31eb3cd", offline: "true" },
      user: { id: "u-1", email: "installer@forgewd.com", ip_address: "10.0.0.4" },
      server_name: "somebodys-laptop",
      extra: {
        unit: "1-1",
        lat: 30.267153,
        lng: -97.743061,
        accuracy: 4.5,
        caption: "before shot, north elevation",
      },
    };
    const out = scrubEvent(event) as ScrubbableEvent;

    // What a fix needs, still there.
    expect(out.message).toBe("finish_unit failed");
    expect(out.release).toBe("31eb3cd");
    expect(out.tags).toEqual({ role: "installer", build: "31eb3cd", offline: "true" });
    expect((out.extra as Record<string, unknown>).unit).toBe("1-1");

    // What nobody outside this company gets.
    expect(out.user).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    const extra = out.extra as Record<string, unknown>;
    expect(extra.lat).toBe(REDACTED);
    expect(extra.lng).toBe(REDACTED);
    expect(extra.accuracy).toBe(REDACTED);
    expect(extra.caption).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain("30.267153");
    expect(JSON.stringify(out)).not.toContain("installer@forgewd.com");
  });

  it("a receipt error keeps the sentence and drops the note and the email in it", () => {
    const event: ScrubbableEvent = {
      exception: {
        values: [
          {
            type: "PostgrestError",
            value:
              "receipt for ben.taylor@stgwindows.com rejected: body too long",
            stacktrace: {
              frames: [
                {
                  function: "saveReceipt",
                  filename: "/src/lib/install/api.ts",
                  lineno: 4120,
                  vars: {
                    note: "picked up shims and a case of caulk",
                    address: "1204 Bluff Trail, Austin TX",
                  },
                },
              ],
            },
          },
        ],
      },
      extra: {
        note: "picked up shims and a case of caulk",
        receipt_kind: "fuel",
        // The keys nobody thought to put on the list: a jobsite under `site`,
        // a crew member under `description`.
        site: "1425 Sagebrush Hollow Dr, Austin TX",
        description: "receipt for Maria Gomez",
      },
    };
    const out = scrubEvent(event) as ScrubbableEvent;
    const value = out.exception!.values![0];
    expect(value.type).toBe("PostgrestError");
    expect(value.value).toBe("receipt for [email] rejected: body too long");

    const frame = (value.stacktrace as { frames: Record<string, unknown>[] }).frames[0];
    // The frame itself is the useful part and stays; its locals do not.
    expect(frame.function).toBe("saveReceipt");
    expect(frame.lineno).toBe(4120);
    expect(frame.vars).toBeUndefined();

    expect((out.extra as Record<string, unknown>).note).toBe(REDACTED);
    expect((out.extra as Record<string, unknown>).receipt_kind).toBe("fuel");
    expect((out.extra as Record<string, unknown>).site).toBe(REDACTED);
    expect((out.extra as Record<string, unknown>).description).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain("Bluff Trail");
    expect(JSON.stringify(out)).not.toContain("Sagebrush");
    expect(JSON.stringify(out)).not.toContain("Maria Gomez");
    expect(JSON.stringify(out)).not.toContain("case of caulk");
  });

  it("a request keeps its method and route pattern and loses body, headers and query", () => {
    const event: ScrubbableEvent = {
      request: {
        method: "POST",
        url:
          "https://czprjcskmzzagdztqonm.supabase.co/rest/v1/units" +
          "?id=eq.2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77&apikey=sb_publishable_abcdefghijklmnop",
        data: { notes: "sill was wet", installer_phone: "512-555-0117" },
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.zzzzzzzzzz" },
        cookies: "sb-access-token=abc",
        query_string: "id=eq.2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77",
      },
    };
    const out = scrubEvent(event) as ScrubbableEvent;
    expect(out.request).toEqual({
      method: "POST",
      url: "https://czprjcskmzzagdztqonm.supabase.co/rest/v1/units",
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("sill was wet");
    expect(json).not.toContain("512-555-0117");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("sb-access-token");
  });

  it("a fetch breadcrumb keeps method, status and route — and drops the body", () => {
    const out = scrubBreadcrumb({
      type: "http",
      category: "fetch",
      level: "info",
      timestamp: 1_757_000_000,
      data: {
        method: "PATCH",
        url:
          "https://czprjcskmzzagdztqonm.supabase.co/rest/v1/units" +
          "?id=eq.2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77",
        status_code: 400,
        body: '{"notes":"Ben said the sill was wet","lat":30.267153}',
        request_body: '{"caption":"before shot"}',
      },
    });
    expect(out.category).toBe("fetch");
    expect(out.data).toEqual({
      method: "PATCH",
      url: "https://czprjcskmzzagdztqonm.supabase.co/rest/v1/units",
      status_code: 400,
    });
    expect(JSON.stringify(out)).not.toContain("sill was wet");
    expect(JSON.stringify(out)).not.toContain("30.267153");
  });

  it("caps a breadcrumb message so a hundred of them cannot carry a screenful each", () => {
    const out = scrubBreadcrumb({ category: "ui.click", message: "y".repeat(900) });
    expect((out.message as string).length).toBeLessThanOrEqual(201);
  });

  // The SDK writes these itself, from the element that was tapped — see
  // htmlTreeAsString in @sentry/core. Every string below is the real shape it
  // produces for a control this app really renders.
  it("a tap on the crew board keeps the control and loses whose row it was", () => {
    const out = scrubBreadcrumb({
      category: "ui.click",
      message:
        'button.cb-plus[aria-label="Schedule Maria Gomez on Tuesday"]' +
        ' > div.cb-row[title="Maria Gomez"]',
    });
    expect(out.message).toBe("button.cb-plus > div.cb-row");
    expect(JSON.stringify(out)).not.toContain("Maria Gomez");
  });

  it("a tap on Directions loses the house it was pointing at", () => {
    const out = scrubBreadcrumb({
      category: "ui.click",
      message: 'button.directions-chip[aria-label="Get directions to 1428 Elm Street"]',
    });
    expect(out.message).toBe("button.directions-chip");
    expect(JSON.stringify(out)).not.toContain("Elm Street");
  });

  it("a tap on a photo loses the caption somebody typed under it", () => {
    const out = scrubBreadcrumb({
      category: "ui.click",
      message: 'img.photo-card[alt="Ben leaving the sill wet again"]',
    });
    expect(out.message).toBe("img.photo-card");
  });

  it("keeps a console breadcrumb but not what was printed into it", () => {
    // The SDK JSON-stringifies every non-primitive console argument into this
    // message, so one console.error("saving", row) would carry the whole row.
    const out = scrubBreadcrumb({
      category: "console",
      level: "error",
      message:
        '[query fault] 42703 {"notes":"sill was wet","job_address":"1428 Elm Street"}',
    });
    expect(out.category).toBe("console");
    expect(out.level).toBe("error");
    expect(out.message).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Elm Street");
    expect(JSON.stringify(out)).not.toContain("sill was wet");
  });

  it("drops a console breadcrumb's arguments as well as its message", () => {
    const out = scrubBreadcrumb({
      category: "console",
      message: "saving",
      data: { arguments: [{ caption: "before shot", lat: 30.267153 }], logger: "console" },
    });
    expect(out.data).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("30.267153");
  });

  it("names the event by its route, not by the URL the SDK saw", () => {
    const out = scrubEvent({
      transaction: "/projects/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77/openings?sort=name",
      culprit: "https://app.forgewd.com/gc/Ku7Rr3xQm1PdV8ZaN0sYtLbE",
    }) as ScrubbableEvent;
    expect(out.transaction).toBe("/projects/:id/openings");
    expect(out.culprit).toBe("https://app.forgewd.com/gc/:id");
  });

  it("keeps a navigation breadcrumb's from and to, as route patterns", () => {
    const out = scrubBreadcrumb({
      category: "navigation",
      data: {
        from: "/projects/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77",
        to: "/projects/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77/openings?note=wet",
        extra: "whatever a library felt like attaching",
      },
    });
    expect(out.data).toEqual({ from: "/projects/:id", to: "/projects/:id/openings" });
  });

  it("leaves an event with nothing in it alone rather than inventing fields", () => {
    expect(scrubEvent({})).toEqual({});
  });
});
