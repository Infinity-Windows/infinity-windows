import { describe, expect, it } from "vitest";
import { edgeFunctionMessage } from "./edgeErrors";

/**
 * THE SENTENCE THE SERVER WROTE HAS TO REACH THE PERSON.
 *
 * supabase-js turns any non-2xx from an edge function into an error whose
 * message is the fixed string below and drops the response body — so every
 * refusal monday-sync writes in plain English ("Only a foreman or above can
 * bring files in from Monday.") was arriving on an office screen as machine
 * noise. The body is on `error.context`; this is the unwrap.
 */
const SUPABASE_JS_MESSAGE = "Edge Function returned a non-2xx status code";

/** What supabase-js hands over for a non-2xx: message + the Response. */
function httpError(body: unknown): Error & { context: { json: () => Promise<unknown> } } {
  return Object.assign(new Error(SUPABASE_JS_MESSAGE), {
    context: { json: () => Promise.resolve(body) },
  });
}

describe("edgeFunctionMessage", () => {
  it("digs the server's own sentence out of the body", async () => {
    const said = await edgeFunctionMessage(
      httpError({ ok: false, error: "Only a foreman or above can bring files in from Monday." }),
    );
    expect(said).toBe("Only a foreman or above can bring files in from Monday.");
  });

  it("gets the one the office needs before the migration lands", async () => {
    // The 503 the pull answers with while the app is ahead of the database.
    const said = await edgeFunctionMessage(
      httpError({ ok: false, error: "Getting files from Monday needs the next database update." }),
    );
    expect(said).toBe("Getting files from Monday needs the next database update.");
  });

  it("never shows supabase-js's own string when a sentence exists", async () => {
    const said = await edgeFunctionMessage(httpError({ error: "That job is gone." }));
    expect(said).not.toContain("non-2xx");
  });

  it("falls back plainly when the body says nothing useful", async () => {
    for (const body of [{}, { error: "" }, { error: "   " }, { error: 7 }, null]) {
      const said = await edgeFunctionMessage(httpError(body), "We could not get the files.");
      expect(said).toBe("We could not get the files.");
    }
  });

  it("survives a body that cannot be read at all", async () => {
    // An empty body, HTML from a proxy, a connection that dies mid-read: the
    // unwrap must not throw on its way to reporting an error.
    const broken = Object.assign(new Error(SUPABASE_JS_MESSAGE), {
      context: { json: () => Promise.reject(new Error("Unexpected end of JSON input")) },
    });
    expect(await edgeFunctionMessage(broken, "We could not get the files.")).toBe(
      "We could not get the files.",
    );
  });

  it("never lets supabase-js's own string through, body or no body", async () => {
    // The whole point. formatApiError passes a short, brace-free server
    // message straight through, and this one is short and brace-free — so
    // without naming it, the fallback would never fire.
    expect(await edgeFunctionMessage(httpError({}), "We could not get the files.")).toBe(
      "We could not get the files.",
    );
    const noContext = new Error(SUPABASE_JS_MESSAGE);
    expect(await edgeFunctionMessage(noContext)).not.toContain("non-2xx");
    expect(await edgeFunctionMessage(noContext, "We could not get the files.")).toBe(
      "We could not get the files.",
    );
  });

  it("handles an error with no context at all", async () => {
    // A real sentence from somewhere else is kept — that is formatApiError's
    // own rule for a short server message, and this must not fight it.
    expect(await edgeFunctionMessage(new Error("That job is gone."), "Plain fallback.")).toBe(
      "That job is gone.",
    );
    expect(await edgeFunctionMessage(null, "Plain fallback.")).toBe("Plain fallback.");
    expect(await edgeFunctionMessage(undefined, "Plain fallback.")).toBe("Plain fallback.");
  });

  it("recognises being offline, through formatApiError", async () => {
    // No context, so it goes to the house formatter — which is the reason the
    // fallback is formatApiError and not the raw message.
    const said = await edgeFunctionMessage(new TypeError("Failed to fetch"));
    expect(said.toLowerCase()).toContain("offline");
  });
});
