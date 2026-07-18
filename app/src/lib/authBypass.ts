import type { Profile } from "./install/types";

const KEY = "infinity-auth-bypass";

/** Prototype/dev: skip Supabase sign-in and enter the app shell. */
export function isAuthBypassed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAuthBypass(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Synthetic profile so lead/admin nav works while bypassed (no real user). */
export const BYPASS_PROFILE: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  display_name: "Guest",
  skill_level: 5,
  role: "big_boss",
  active: true,
};
