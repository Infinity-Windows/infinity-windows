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

  it("masks a phone number without eating a build id", () => {
    expect(scrubText("call 512-555-0117 back")).toBe("call [phone] back");
    expect(scrubText("build 31eb3cd5f9a2b1")).toBe("build 31eb3cd5f9a2b1");
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
      extra: { note: "picked up shims and a case of caulk", receipt_kind: "fuel" },
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
    expect(JSON.stringify(out)).not.toContain("Bluff Trail");
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
    const out = scrubBreadcrumb({ category: "console", message: "y".repeat(900) });
    expect((out.message as string).length).toBeLessThanOrEqual(201);
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
