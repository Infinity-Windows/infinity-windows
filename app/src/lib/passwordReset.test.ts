// The password-reset landing (owner report, 2026-08-18): the emailed link
// must come back to the APP's url — origin + base path — not the domain
// root, which on GitHub Pages is a 404. And the landing itself must be
// readable from the hash before the supabase client strips it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authErrorFromHash,
  cooldownLabel,
  isRecoveryLanding,
  newPasswordProblem,
  passwordResetRedirectUrl,
  resetEmailRefusal,
} from "./passwordReset";

describe("passwordResetRedirectUrl", () => {
  it("joins origin and the Pages base path — the exact 404 this fixes", () => {
    expect(
      passwordResetRedirectUrl("https://infinity-windows.github.io", "/infinity-windows/"),
    ).toBe("https://infinity-windows.github.io/infinity-windows/");
  });

  it("dev: base is just '/'", () => {
    expect(passwordResetRedirectUrl("http://localhost:5173", "/")).toBe(
      "http://localhost:5173/",
    );
  });

  it("never doubles slashes and never drops the base", () => {
    expect(
      passwordResetRedirectUrl("https://x.github.io/", "/infinity-windows/"),
    ).toBe("https://x.github.io/infinity-windows/");
    expect(passwordResetRedirectUrl("https://x.github.io", "")).toBe(
      "https://x.github.io/",
    );
  });
});

describe("isRecoveryLanding", () => {
  it("spots the recovery hash Supabase actually sends", () => {
    expect(
      isRecoveryLanding("#access_token=abc&refresh_token=def&type=recovery"),
    ).toBe(true);
    expect(isRecoveryLanding("#type=recovery")).toBe(true);
  });

  it("stays quiet on normal loads and error landings", () => {
    expect(isRecoveryLanding("")).toBe(false);
    expect(isRecoveryLanding("#/warehouse")).toBe(false);
    expect(
      isRecoveryLanding("#error=access_denied&error_code=otp_expired"),
    ).toBe(false);
  });
});

describe("authErrorFromHash", () => {
  it("an expired link reads as one plain sentence", () => {
    expect(
      authErrorFromHash(
        "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
    ).toBe("That reset link has expired — send yourself a fresh one below.");
  });

  it("other auth errors surface their description, de-plus-signed", () => {
    expect(
      authErrorFromHash("#error=server_error&error_description=Something+went+wrong"),
    ).toBe("Something went wrong");
  });

  it("no error in the hash → null, the app boots normally", () => {
    expect(authErrorFromHash("")).toBeNull();
    expect(authErrorFromHash("#access_token=abc&type=recovery")).toBeNull();
  });
});

describe("newPasswordProblem", () => {
  it("short, mismatched, and good pairs", () => {
    expect(newPasswordProblem("short", "short")).toBe("Use at least 8 characters.");
    expect(newPasswordProblem("longenough", "different")).toBe(
      "The two passwords don't match.",
    );
    expect(newPasswordProblem("longenough", "longenough")).toBeNull();
  });
});

// Regression pins on the call sites themselves (same style as
// App.prefetch.test.ts): the bug was SignIn passing bare origin.
describe("the call sites use the helpers", () => {
  it("SignIn builds redirectTo from origin + BASE_URL, not bare origin", () => {
    const src = readFileSync(new URL("../pages/SignIn.tsx", import.meta.url), "utf8");
    expect(src).toContain("passwordResetRedirectUrl(");
    expect(src).toContain("import.meta.env.BASE_URL");
    expect(src).not.toMatch(/redirectTo:\s*window\.location\.origin\b/);
  });

  it("App reads the landing hash at import time and routes recovery", () => {
    const src = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(src).toContain("isRecoveryLanding(");
    expect(src).toContain("PASSWORD_RECOVERY");
    expect(src).toContain("SetNewPassword");
  });
});

// The mailer's pace refusals (owner hit the cap after two tries, 2026-08-18):
// plain words plus a rest matched to the refusal — the per-address gap is a
// minute, the service-wide cap is the five minutes the owner asked for.
describe("resetEmailRefusal", () => {
  it("the service cap → five-minute rest, plain words", () => {
    const r = resetEmailRefusal("Email rate limit exceeded");
    expect(r?.waitSec).toBe(300);
    expect(r?.line).toContain("Wait 5 minutes");
  });

  it("the per-address gap → one-minute rest", () => {
    const r = resetEmailRefusal(
      "For security purposes, you can only request this once every 60 seconds",
    );
    expect(r?.waitSec).toBe(60);
    expect(r?.line).toContain("give it a minute");
  });

  it("anything else is not a pace refusal — caller shows it as-is", () => {
    expect(resetEmailRefusal("Invalid email address")).toBeNull();
  });
});

describe("cooldownLabel", () => {
  it("minutes read as m:ss, seconds as Ns", () => {
    expect(cooldownLabel(300)).toBe("5:00");
    expect(cooldownLabel(90)).toBe("1:30");
    expect(cooldownLabel(45)).toBe("45s");
  });
});
