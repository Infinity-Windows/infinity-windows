// What an edge function answers when it falls over, and what it tells Sentry.
//
// The rules live in supabase/functions/_shared/sentryCore.ts so they can be run
// here for real rather than read: the property worth proving is an ORDER — the
// error is reported and THEN the caller gets one plain sentence, and the report
// never decides whether the caller gets an answer at all.
//
// The last block is a source contract in the style of mondayReadOnly.test.ts,
// for the ten lines that touch Deno and therefore cannot run under vitest: that
// SENTRY_DSN is read behind a truthiness guard and never bound to a module
// constant. That distinction is the difference between an optional secret and a
// backend deploy that goes red for everyone.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  UNEXPECTED_ERROR,
  buildFunctionEvent,
  describeThrowable,
  ingestHeaders,
  makeReportCaughtError,
  makeWithSentry,
  parseDsn,
  parseStack,
} from "../../../../supabase/functions/_shared/sentryCore.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTRY_TS = resolve(HERE, "../../../../supabase/functions/_shared/sentry.ts");
const FUNCTIONS_DIR = resolve(HERE, "../../../../supabase/functions");

const DSN = "https://abc123@o4507.ingest.sentry.io/42";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseDsn", () => {
  it("finds the ingest endpoint and the public key", () => {
    expect(parseDsn(DSN)).toEqual({
      url: "https://o4507.ingest.sentry.io/api/42/store/",
      key: "abc123",
    });
  });

  it("refuses anything that is not a DSN rather than posting at it", () => {
    for (const bad of ["", "   ", "not a url", "https://o4507.ingest.sentry.io/42", "https://k@host/"]) {
      expect(parseDsn(bad), bad).toBeNull();
    }
  });

  it("survives a value pasted with a newline on the end", () => {
    expect(parseDsn(`${DSN}\n`)?.key).toBe("abc123");
  });

  it("names the key in the header and never anything secret", () => {
    const headers = ingestHeaders(parseDsn(DSN)!);
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("parseStack", () => {
  it("reads V8 frames oldest first, the way Sentry renders them", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at saveReceipt (file:///src/index.ts:120:11)",
        "    at handler (file:///src/index.ts:40:3)",
      ].join("\n"),
    );
    expect(frames.map((f) => f.function)).toEqual(["handler", "saveReceipt"]);
    expect(frames[1]).toMatchObject({ filename: "file:///src/index.ts", lineno: 120, colno: 11 });
  });

  it("is fine with no stack at all", () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("Error: boom")).toEqual([]);
  });
});

describe("describeThrowable", () => {
  it("never produces [object Object] for a thrown payload", () => {
    expect(describeThrowable({ message: "insert on units failed" })).toBe(
      "insert on units failed",
    );
    expect(describeThrowable({ code: "23505" })).not.toContain("[object Object]");
  });
});

describe("buildFunctionEvent", () => {
  const req = {
    method: "POST",
    url:
      "https://czprjcskmzzagdztqonm.functions.supabase.co/extract-receipt" +
      "/2c1d0f3a-9b7e-4a55-9f2e-6d1c8b0a4e77?token=abc&note=sill%20was%20wet",
  };

  it("tags the function, the method and the route pattern — and nothing else", () => {
    const event = buildFunctionEvent("extract-receipt", req, new Error("boom"), "e1", 1);
    expect(event.tags).toEqual({
      function: "extract-receipt",
      method: "POST",
      route: "/extract-receipt/:id",
    });
  });

  it("throws the query string away, ids and all", () => {
    const event = buildFunctionEvent("extract-receipt", req, new Error("boom"), "e1", 1);
    const json = JSON.stringify(event);
    expect(json).not.toContain("token=abc");
    expect(json).not.toContain("sill");
    expect(json).not.toContain("2c1d0f3a");
  });

  it("keeps the error and its stack, which is the whole point", () => {
    const err = new Error("finish_unit failed");
    err.stack = "Error: finish_unit failed\n    at finish (file:///a.ts:1:1)";
    const event = buildFunctionEvent("ask", null, err, "e1", 1);
    const value = event.exception!.values![0];
    expect(value.type).toBe("Error");
    expect(value.value).toBe("finish_unit failed");
    expect((value.stacktrace as { frames: unknown[] }).frames).toHaveLength(1);
  });

  it("masks an email that made it into the message", () => {
    const event = buildFunctionEvent(
      "send-email",
      null,
      new Error("Resend refused ben.taylor@stgwindows.com"),
      "e1",
      1,
    );
    expect(event.exception!.values![0].value).toBe("Resend refused [email]");
  });

  it("still reports a thrown payload that is not an Error", () => {
    const event = buildFunctionEvent("ask", null, { message: "no rows" }, "e1", 1);
    expect(event.exception!.values![0].value).toBe("no rows");
  });
});

describe("withSentry", () => {
  const req = new Request("https://x.functions.supabase.co/ask", { method: "POST" });

  function build(capture = vi.fn().mockResolvedValue(true)) {
    const respond = vi.fn((_req: Request, message: string) =>
      jsonResponse({ error: message }, 500),
    );
    const log = vi.fn();
    return { capture, respond, log, withSentry: makeWithSentry({ capture, respond, log }) };
  }

  it("passes a good answer straight through, untouched", async () => {
    const { capture, withSentry } = build();
    const ok = jsonResponse({ ok: true }, 200);
    const res = await withSentry("ask", () => ok)(req);
    expect(res).toBe(ok);
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures a throw and then answers with the plain sentence", async () => {
    const { capture, withSentry } = build();
    const boom = new Error("relation \"units\" does not exist");
    const res = await withSentry("ask", () => {
      throw boom;
    })(req);

    expect(capture).toHaveBeenCalledTimes(1);
    const [name, facts, error] = capture.mock.calls[0];
    expect(name).toBe("ask");
    expect(facts).toEqual({ method: "POST", url: "https://x.functions.supabase.co/ask" });
    expect(error).toBe(boom);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: UNEXPECTED_ERROR });
  });

  it("never answers with the raw error — that is the leak this closes", async () => {
    const { withSentry } = build();
    const res = await withSentry("ask", () => {
      throw new Error('relation "profiles_pin_hash_idx" does not exist');
    })(req);
    const body = await res.text();
    expect(body).not.toContain("pin_hash");
    expect(body).not.toContain("does not exist");
    expect(body).toContain(UNEXPECTED_ERROR);
  });

  it("answers even when the monitor itself falls over", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("sentry is down"));
    const { withSentry } = build(capture);
    const res = await withSentry("ask", () => {
      throw new Error("boom");
    })(req);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: UNEXPECTED_ERROR });
  });

  it("writes the reason to the log, which is what works with no DSN set", async () => {
    const { log, withSentry } = build();
    await withSentry("ask", () => {
      throw new Error("boom");
    })(req);
    expect(log).toHaveBeenCalledWith("ask threw:", "boom");
  });

  it("captures a rejected promise, not only a synchronous throw", async () => {
    const { capture, withSentry } = build();
    const res = await withSentry("ask", () => Promise.reject(new Error("late")))(req);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });
});

describe("the Deno half stays optional", () => {
  const src = readFileSync(SENTRY_TS, "utf8");
  // scripts/function_secrets.py strips comments before it matches, so this has
  // to as well — the header comment names the forbidden shape in order to say
  // it is forbidden, and a check that could not tell those apart would fail on
  // the very documentation that explains it.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("feature-detects the DSN with the guard the census reads as optional", () => {
    expect(code).toContain('if (Deno.env.get("SENTRY_DSN"))');
  });

  it("never binds it to a module constant, which would make it REQUIRED", () => {
    // `const X = Deno.env.get("SENTRY_DSN") ?? ""` is the shape
    // scripts/function_secrets.py counts as required. One of those here turns
    // the whole backend deploy red on a project with no Sentry account.
    expect(code).not.toMatch(/const\s+\w+\s*(:[^=]+)?=\s*Deno\.env\.get\(\s*["']SENTRY_DSN/);
  });

  it("never prints the DSN", () => {
    for (const line of code.split("\n")) {
      if (/console\.(log|error|warn)/.test(line)) {
        expect(line).not.toContain("configuredDsn");
        expect(line).not.toContain("SENTRY_DSN");
      }
    }
  });
});

describe("reportCaughtError", () => {
  const req = { method: "POST", url: "https://x.functions.supabase.co/extract-receipt" };

  it("reports an error the function caught and answered itself", async () => {
    const capture = vi.fn().mockResolvedValue(true);
    const log = vi.fn();
    await makeReportCaughtError({ capture, log })("extract-receipt", req, new Error("boom"));

    expect(capture).toHaveBeenCalledWith("extract-receipt", req, expect.any(Error));
    expect(log).toHaveBeenCalledWith("extract-receipt threw:", "boom");
  });

  it("never throws out of a catch block, whatever the monitor does", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("sentry is down"));
    await expect(
      makeReportCaughtError({ capture })("ask", req, new Error("boom")),
    ).resolves.toBeUndefined();
  });

  it("says something useful about a thrown payload that is not an Error", async () => {
    const log = vi.fn();
    await makeReportCaughtError({ capture: vi.fn().mockResolvedValue(false), log })(
      "ask",
      req,
      { message: "insert on units failed" },
    );
    expect(log).toHaveBeenCalledWith("ask threw:", "insert on units failed");
  });
});

// A source contract over all 23 functions.
//
// WHY: withSentry only sees a throw that ESCAPES a handler, and most functions
// here wrap their whole body in a try. Before this, 14 of them caught
// everything and answered `String(e)` — so the monitor was silent about exactly
// the failure docs/monitoring.md opens by promising to find, and an installer
// was shown a Postgres constraint name. Neither can come back quietly.
describe("a function that catches its own errors reports them", () => {
  const names = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((n) => {
      try {
        readFileSync(resolve(FUNCTIONS_DIR, n, "index.ts"), "utf8");
        return true;
      } catch {
        return false;
      }
    });

  it("finds every function, so this contract cannot pass by looking at none", () => {
    expect(names.length).toBeGreaterThanOrEqual(23);
  });

  it("never answers a caller with String(err) — the leak lib/errors.ts exists to stop", () => {
    for (const name of names) {
      const src = readFileSync(resolve(FUNCTIONS_DIR, name, "index.ts"), "utf8");
      expect(src, name).not.toContain("error: String(");
    }
  });

  it("reports from the outer catch, where the throw would otherwise stop", () => {
    for (const name of names) {
      const src = readFileSync(resolve(FUNCTIONS_DIR, name, "index.ts"), "utf8");
      // The handler's own catch is the last one in the file; a function with
      // no catch at all lets withSentry do the reporting and needs nothing.
      const tail = src.slice(src.lastIndexOf("} catch ("));
      const swallowsIntoA500 =
        src.includes("} catch (") && tail.includes("jsonResponse(") && tail.includes("500");
      if (!swallowsIntoA500) continue;
      expect(tail, name).toContain("reportCaughtError(");
      expect(tail, name).toContain(`"${name}"`);
    }
  });
});
