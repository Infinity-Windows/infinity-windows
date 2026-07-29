import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The only way into this app is now: request access -> a supervisor or the owner
 * approves -> that approval creates the login. Self-signup is switched off in
 * the project's auth settings, so if the approval path ever stops creating an
 * account, nobody new can get in at all and nothing would go red.
 *
 * These are source-contract assertions rather than behaviour tests on purpose.
 * The behaviour is proved end to end against the real database by
 * `scripts/prove-onboarding.py`, which creates a person, signs in as them and
 * deletes them again — something no unit test can honestly claim to do. What is
 * left to guard here is the shape of the code: that approval still goes through
 * the service-role edge function, that the browser never tries to sign anybody
 * up, and that a new account never asks for a role.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const api = read("src/lib/install/api.ts");
const admin = read("src/pages/Admin.tsx");
const signIn = read("src/pages/SignIn.tsx");
const fn = read("../supabase/functions/approve-access-request/index.ts");

describe("approving an access request creates a login", () => {
  it("the Admin screen approves through the edge function, not a status update", () => {
    expect(admin).toContain("approveAccessRequest");
    // Approve must not fall back to flipping the row directly: that is exactly
    // what used to happen, and it left the person with no way to sign in.
    expect(admin).not.toMatch(/decide\.mutate\(\{\s*id:[^}]*status:\s*"approved"/);
  });

  it("the client calls the service-role function that can create a user", () => {
    expect(api).toContain('supabase.functions.invoke(\n    "approve-access-request"');
  });

  it("the approver is shown the one-time password", () => {
    expect(admin).toContain("temporary_password");
  });

  it("the function refuses anyone below supervisor", () => {
    expect(fn).toContain("roleRank(role) < 2");
  });

  it("the function never grants the role that was asked for", () => {
    // requested_role is echoed back for display only; the profile insert must
    // not set `role` at all, so the column default (installer) applies.
    expect(fn).not.toMatch(/\.upsert\(\s*\{[^}]*\brole\s*:/s);
    expect(fn).toContain('role: "installer"');
  });

  it("the function creates the account pre-confirmed, because no mail is sent", () => {
    expect(fn).toContain("email_confirm: true");
  });

  it("the function refuses to touch an email that already has an account", () => {
    expect(fn).toContain("already has an account");
  });
});

describe("self-signup is closed in the browser too", () => {
  it("the sign-in screen never calls auth.signUp", () => {
    expect(signIn).not.toContain("signUp");
  });

  it("the sign-in screen offers only signing in and requesting access", () => {
    expect(signIn).toMatch(/type Mode = "signin" \| "request"/);
  });

  it("an access request cannot be submitted without the email that becomes the login", () => {
    expect(signIn).toContain("!reqEmail.trim()");
  });
});
