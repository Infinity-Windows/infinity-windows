// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  OFFLINE_PILOT_PROOF_KEY, OFFLINE_PILOT_PROOF_MS,
  forgetOfflinePilotProof, pilotSessionId, readOfflinePilotProof,
  rememberOfflinePilotProof, type PilotSignIn,
} from "./offlinePilotProof";

const OWNER = "00000000-0000-4000-8000-000000000101";
const OTHER = "00000000-0000-4000-8000-000000000102";
const LOGIN = "11111111-1111-4111-8111-111111111111";
const NEXT_LOGIN = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 9, 6, 12);

function signIn(userId = OWNER, sessionId = LOGIN, tokenSuffix = "a"): PilotSignIn {
  const claims = btoa(JSON.stringify({ sub: userId, session_id: sessionId, nonce: tokenSuffix }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { user: { id: userId }, access_token: `header.${claims}.signature` };
}

beforeEach(() => localStorage.clear());

describe("owner pilot offline proof", () => {
  it("keeps the confirmed choice through a reload and a token refresh in the same login", () => {
    expect(rememberOfflinePilotProof(signIn(), NOW)).toBe(true);
    expect(readOfflinePilotProof(signIn(), NOW + 60_000)).toBe(true);
    expect(readOfflinePilotProof(signIn(OWNER, LOGIN, "refreshed-token"), NOW + 60_000)).toBe(true);
    expect(Object.keys(JSON.parse(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)!))).toEqual([
      "v", "userId", "sessionId", "choice", "issuedAt", "expiresAt",
    ]);
  });

  it("rejects a different account, a new login for the same owner, and no sign-in", () => {
    rememberOfflinePilotProof(signIn(), NOW);
    expect(readOfflinePilotProof(signIn(OTHER), NOW + 1)).toBe(false);
    expect(readOfflinePilotProof(signIn(OWNER, NEXT_LOGIN), NOW + 1)).toBe(false);
    expect(readOfflinePilotProof(null, NOW + 1)).toBe(false);
  });

  it("expires after twelve hours and rejects a clock moved far before issuance", () => {
    rememberOfflinePilotProof(signIn(), NOW);
    expect(readOfflinePilotProof(signIn(), NOW + OFFLINE_PILOT_PROOF_MS - 1)).toBe(true);
    expect(readOfflinePilotProof(signIn(), NOW + OFFLINE_PILOT_PROOF_MS)).toBe(false);
    expect(readOfflinePilotProof(signIn(), NOW - 6 * 60_000)).toBe(false);
  });

  it("fails closed for missing or mismatched session claims and corrupted records", () => {
    expect(pilotSessionId({ user: { id: OWNER }, access_token: "not-a-jwt" })).toBeNull();
    expect(pilotSessionId({ user: { id: OTHER }, access_token: signIn().access_token })).toBeNull();
    expect(rememberOfflinePilotProof({ user: { id: OWNER }, access_token: "not-a-jwt" }, NOW)).toBe(false);
    localStorage.setItem(OFFLINE_PILOT_PROOF_KEY, "not-json");
    expect(readOfflinePilotProof(signIn(), NOW)).toBe(false);
    rememberOfflinePilotProof(signIn(), NOW);
    const record = JSON.parse(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)!);
    record.expiresAt += OFFLINE_PILOT_PROOF_MS;
    localStorage.setItem(OFFLINE_PILOT_PROOF_KEY, JSON.stringify(record));
    expect(readOfflinePilotProof(signIn(), NOW)).toBe(false);
    forgetOfflinePilotProof();
    expect(localStorage.getItem(OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  });
});
