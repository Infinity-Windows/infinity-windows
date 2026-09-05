// The name on a photo, read without asking the network. Every case here is a
// phone in the field: signed in, signed out, an account with no email on it,
// and the one that matters most — a session that has gone stale in a dead zone,
// where the auth call this replaced would have stalled and then said "nobody".

import { beforeEach, describe, expect, it } from "vitest";
import { rememberSignedIn, signedInEmail } from "./signedIn";

beforeEach(() => {
  rememberSignedIn(null);
});

describe("who took this photo", () => {
  it("knows nobody until sign-in has resolved", () => {
    expect(signedInEmail()).toBeNull();
  });

  it("remembers the signed-in email and hands it back with no await", () => {
    rememberSignedIn({ user: { email: "installer@example.com" } });
    expect(signedInEmail()).toBe("installer@example.com");
  });

  it("keeps the name after the token goes stale, because the person has not changed", () => {
    // The whole point. An expired access token on a phone with no bars makes
    // getSession() answer `session: null`; the person holding it is still the
    // same installer, and their photos must still carry their name.
    rememberSignedIn({ user: { email: "installer@example.com" } });
    // ...time passes offline; nothing tells this module otherwise...
    expect(signedInEmail()).toBe("installer@example.com");
  });

  it("forgets on sign-out", () => {
    rememberSignedIn({ user: { email: "installer@example.com" } });
    rememberSignedIn(null);
    expect(signedInEmail()).toBeNull();
  });

  it("says nobody rather than undefined when the account carries no email", () => {
    rememberSignedIn({ user: { email: null } });
    expect(signedInEmail()).toBeNull();
    rememberSignedIn({ user: {} });
    expect(signedInEmail()).toBeNull();
    rememberSignedIn({});
    expect(signedInEmail()).toBeNull();
  });
});
