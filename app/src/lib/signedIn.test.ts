// The name on a photo, read without asking the network. Every case here is a
// phone in the field: signed in, signed out, an account with no email on it,
// and the one that matters most — a session that has gone stale in a dead zone,
// where the auth call this replaced would have stalled and then said "nobody".

import { beforeEach, describe, expect, it } from "vitest";
import { rememberSignedIn, signInMark, signedInEmail, signedInUserId, stillSignedInAs } from "./signedIn";

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
    rememberSignedIn({ user: { id: "u-1", email: "installer@example.com" } });
    rememberSignedIn(null);
    expect(signedInEmail()).toBeNull();
    expect(signedInUserId()).toBeNull();
  });

  it("knows the signed-in id too, for the device lock's saved answer", () => {
    expect(signedInUserId()).toBeNull();
    rememberSignedIn({ user: { id: "u-1", email: "installer@example.com" } });
    expect(signedInUserId()).toBe("u-1");
    // A different login on the same phone is a different person.
    rememberSignedIn({ user: { id: "u-2", email: "foreman@example.com" } });
    expect(signedInUserId()).toBe("u-2");
    rememberSignedIn({ user: { email: "installer@example.com" } });
    expect(signedInUserId()).toBeNull();
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

// The device lock's check with the server can take up to fifteen seconds to
// land, and its offline fingerprint a good part of a second. Whatever they
// finish with is held to the sign-in they began in (Codex review of #651).
describe("the sign-in mark, for slow work that could let somebody in", () => {
  it("holds while the same person stays signed in, through token refreshes", () => {
    rememberSignedIn({ user: { id: "u-1", email: "installer@example.com" } });
    const mark = signInMark();
    // TOKEN_REFRESHED, USER_UPDATED, a SIGNED_IN on returning to the app: the same person.
    rememberSignedIn({ user: { id: "u-1", email: "installer@example.com" } });
    expect(stillSignedInAs(mark, "u-1")).toBe(true);
  });

  it("is over at sign-out", () => {
    rememberSignedIn({ user: { id: "u-1" } });
    const mark = signInMark();
    rememberSignedIn(null);
    expect(stillSignedInAs(mark, "u-1")).toBe(false);
  });

  it("is over when somebody else signs in, with no sign-out between", () => {
    rememberSignedIn({ user: { id: "u-1" } });
    const mark = signInMark();
    rememberSignedIn({ user: { id: "u-2" } });
    expect(stillSignedInAs(mark, "u-1")).toBe(false);
    expect(stillSignedInAs(mark, "u-2")).toBe(false);
  });

  it("is over even when the same person signs out and back in", () => {
    rememberSignedIn({ user: { id: "u-1" } });
    const mark = signInMark();
    rememberSignedIn(null);
    rememberSignedIn({ user: { id: "u-1" } });
    expect(stillSignedInAs(mark, "u-1")).toBe(false);
    expect(stillSignedInAs(signInMark(), "u-1")).toBe(true);
  });

  it("never holds for anybody but the person it was taken for, and means nothing signed out", () => {
    rememberSignedIn({ user: { id: "u-1" } });
    expect(stillSignedInAs(signInMark(), "u-2")).toBe(false);
    rememberSignedIn(null);
    expect(stillSignedInAs(signInMark(), "u-1")).toBe(false);
  });
});
