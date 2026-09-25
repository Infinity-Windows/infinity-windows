// An answer about one person must never land on the next (Codex review of
// #654, finding 1, 2026-09-25).
//
// "Who is signed in?" can take a while to answer — supabase-js renews an
// expired sign-in first, and on bad signal that is up to half a minute. The
// person can sign out, or someone else can sign in, while the question is
// still out. The first version of the offline fallback answered from the
// sign-in it had read when it was ASKED, so the late answer named the person
// who had just left; App then took that answer over the sign-in that had
// replaced it. Codex reproduced both A → B and A → signed out.
//
// The rules held here: a late answer is checked against the phone as it is
// NOW; App ignores an answer to a question asked before a newer sign-in or
// sign-out; and every one of these reads the phone again rather than trusting
// what it read before an await.

import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  answerSoonerWhenOffline,
  createRenewalWatch,
  followSignIn,
  sessionToKeep,
} from "./offlineSession";

const NOW = Date.parse("2026-09-25T07:00:00Z");

function person(id: string, overrides: Partial<Session> = {}): Session {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(NOW / 1000) + 3600,
    user: { id, email: `${id}@example.com` },
    ...overrides,
  } as Session;
}

/** A, with 45 seconds left: using it means renewing it first. */
const A = person("A", { expires_at: Math.floor(NOW / 1000) + 45 });
const B = person("B");

type Answer = Awaited<ReturnType<Parameters<typeof answerSoonerWhenOffline>[0]>>;

describe("a late answer to 'who is signed in?'", () => {
  for (const next of [null, B]) {
    const change = next ? "B signed in" : "A signed out";
    it(`never names A after ${change} while A's renewal was still out`, async () => {
      let stored: Session | null = A;
      const renewals = createRenewalWatch(() => NOW);
      // A's renewal is held on a bad connection and never comes back.
      const load = vi.fn(() => new Promise<Answer>(() => {}));
      const getSession = answerSoonerWhenOffline(load, {
        stored: () => stored,
        isRefused: () => false,
        online: () => true,
        renewals,
        now: () => NOW,
      });
      const pending = getSession();

      stored = next; // what the sign-in or sign-out left on the phone
      renewals.trouble(); // then A's renewal fails to get through

      const { data } = await pending;
      expect(data.session?.user.id).not.toBe("A");
      expect(data.session).toBeNull();
      // And App, reading the phone as it is now, holds whoever is there.
      expect(sessionToKeep({ from: "load", session: data.session }, stored)).toEqual(next);
    });
  }

  it("an answer about A is never taken over the phone holding B, or nothing", () => {
    expect(sessionToKeep({ from: "load", session: A }, B)).toBe(B);
    expect(sessionToKeep({ from: "load", session: A }, null)).toBeNull();
    // INITIAL_SESSION is worked out the same way, so it can be just as late.
    expect(sessionToKeep({ from: "event", event: "INITIAL_SESSION", session: A }, B)).toBe(B);
    expect(sessionToKeep({ from: "event", event: "INITIAL_SESSION", session: A }, null)).toBeNull();
  });

  it("an answer that is about the sign-in the phone still holds is taken", () => {
    const again = { ...A };
    expect(sessionToKeep({ from: "load", session: A }, again)).toBe(A);
  });
});

/** App's side: the follower it hands every auth answer to. */
function rig(atLaunch: Session | null) {
  let stored = atLaunch;
  const refused = new Set<string>();
  let askedToSignOut = false;
  const held: (Session | null)[] = [];
  let notices = 0;
  const follow = followSignIn({
    stored: () => stored,
    isRefused: (s) => refused.has(s.refresh_token),
    hold: (s) => held.push(s),
    signedOutByServer: () => {
      notices += 1;
    },
    signOutWasRequested: () => askedToSignOut,
  });
  return {
    follow,
    put: (s: Session | null) => {
      stored = s;
    },
    refuse: (s: Session) => refused.add(s.refresh_token),
    askToSignOut: () => {
      askedToSignOut = true;
    },
    held,
    last: () => held.at(-1),
    notices: () => notices,
  };
}

describe("App follows the newest word on who is signed in", () => {
  it("a launch answer that arrives after B signed in is dropped", () => {
    const r = rig(A);
    const answer = r.follow.asking();
    r.put(B);
    r.follow.changed("SIGNED_IN", B);
    expect(answer(A)).toBeUndefined();
    expect(r.last()).toBe(B);
  });

  it("a launch answer that arrives after a sign-out is dropped", () => {
    const r = rig(A);
    const answer = r.follow.asking();
    r.put(null);
    r.follow.changed("SIGNED_OUT", null);
    expect(answer(A)).toBeUndefined();
    expect(r.last()).toBeNull();
  });

  it("a late INITIAL_SESSION is dropped too", () => {
    const r = rig(A);
    r.put(B);
    r.follow.changed("SIGNED_IN", B);
    expect(r.follow.changed("INITIAL_SESSION", A)).toBeUndefined();
    expect(r.last()).toBe(B);
  });

  it("with nothing newer, the launch answer is taken — through what the phone holds", () => {
    const r = rig(A);
    // No signal: supabase-js could not renew A, and the phone still holds A.
    expect(r.follow.asking()(null)).toBe(A);
    expect(r.last()).toBe(A);
  });

  it("a sign-out the server forced is explained; one the person asked for is not", () => {
    const forced = rig(A);
    forced.follow.asking()(A);
    forced.put(null);
    forced.follow.changed("SIGNED_OUT", null);
    expect(forced.last()).toBeNull();
    expect(forced.notices()).toBe(1);

    const asked = rig(A);
    asked.follow.asking()(A);
    asked.askToSignOut();
    asked.put(null);
    asked.follow.changed("SIGNED_OUT", null);
    expect(asked.last()).toBeNull();
    expect(asked.notices()).toBe(0);
  });

  it("no notice for a sign-out on a phone that was not signed in", () => {
    const r = rig(null);
    r.follow.changed("SIGNED_OUT", null);
    expect(r.notices()).toBe(0);
  });
});
