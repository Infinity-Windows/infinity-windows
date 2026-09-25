import { useIsRestoring, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { checkMyPin, myPinStatus, setMyPin } from "../lib/install/api";
import { getMyProfile } from "../lib/install/api";
import { useT } from "../lib/i18n";
import { checkPinOffline, forgetOfflinePin, rememberPinForOffline } from "../lib/offlinePin";
import { PIN_CHECK_WAIT_MS, pinGateView } from "../lib/pinGate";
import { signedInUserId } from "../lib/signedIn";

const UNLOCK_KEY = "wops-pin-unlocked";

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

function initialsFrom(name: string | null | undefined): string {
  if (!name?.trim()) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Does this person have a PIN — from the server when it can be asked, else the
 * last answer this phone got. The root is kept on the phone (lib/queryKeys.ts)
 * and keyed by the signed-in id, so an app reopened with no signal still knows
 * which lock to show (2026-09-24).
 *
 * `networkMode: "always"`: with no signal the read FAILS rather than pausing.
 * A paused read is neither an answer nor an error — the lock could only wait on
 * it, and a Try again tap on it does nothing until the browser says it is back
 * online. A failed one leaves the saved answer in place (React Query keeps data
 * through a failed refetch), which is exactly what the lock falls back to.
 */
function usePinStatus(userId: string | null) {
  return useQuery({
    queryKey: ["myPinStatus", userId],
    queryFn: async () => {
      const hasPin = await myPinStatus();
      // The server says there is no PIN now — cleared here, on another phone
      // or by a supervisor. There is nothing left for the offline unlock to
      // stand in for (lib/offlinePin.ts).
      if (!hasPin) forgetOfflinePin();
      return hasPin;
    },
    enabled: Boolean(userId),
    networkMode: "always",
  });
}

/** Why the PIN pad is not letting somebody in, when it has something to say. */
type PinProblem =
  /** The server says that is not the PIN. */
  | { kind: "wrong" }
  /** No signal, and the offline unlock says that is not the PIN. */
  | { kind: "wrong-offline"; triesLeft: number }
  /** …and that was the fifth wrong try: the offline unlock is gone. */
  | { kind: "locked-offline" }
  /** No signal, and no offline unlock for this person on this phone. */
  | { kind: "no-signal" }
  /** No signal, and the offline unlock is past its twelve hours. */
  | { kind: "expired" }
  /** The server answered, but not with a yes or a no. */
  | { kind: "not-checked" };

/**
 * Lightweight device PIN lock on top of the persisted Supabase session.
 * The PIN's hash never leaves the server — status and verification are RPCs.
 * The one exception is the owner's shift-long offline unlock: when the server
 * cannot be reached, a PIN it accepted on this phone in the last twelve hours
 * is checked against a slow fingerprint kept here (lib/offlinePin.ts).
 *
 * It opens on a definite "no PIN" and on nothing else; lib/pinGate.ts has the
 * rule and why. `userId` is the real signed-in login (App.tsx's session), never
 * a person being previewed — my_pin_status answers for auth.uid().
 */
export function PinGate({ userId, children }: { userId: string; children: React.ReactNode }) {
  const t = useT();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const pinStatus = usePinStatus(userId);
  const restoring = useIsRestoring();
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<PinProblem | null>(null);
  const [checkingPin, setCheckingPin] = useState(false);
  // The four digits of a check the server could not answer, so Try again can
  // send them again. Memory only, like the digits being typed; cleared once
  // anybody has judged them.
  const lastTry = useRef("");
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(UNLOCK_KEY) === "1",
  );
  const [waitedOut, setWaitedOut] = useState(false);

  useEffect(() => {
    if (unlocked) sessionStorage.setItem(UNLOCK_KEY, "1");
  }, [unlocked]);

  const view = pinGateView({
    unlocked,
    restoring,
    hasPin: pinStatus.data,
    asking: pinStatus.fetchStatus === "fetching",
    profileLoading: me.isLoading,
    waitedOut,
  });

  // "Checking device lock…" is bounded. When the wait runs out the person is
  // told why; the read keeps going, and an answer that lands later still moves
  // the lock on by itself.
  const checking = view === "checking";
  useEffect(() => {
    if (!checking || waitedOut) return;
    const timer = setTimeout(() => setWaitedOut(true), PIN_CHECK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [checking, waitedOut]);

  if (view === "open") return <>{children}</>;

  if (view === "checking") {
    return (
      <div className="pin-gate">
        <h1 className="pin-gate-brand">FORGE WINDOWS</h1>
        <p className="pin-hint">{t("pin.checking")}</p>
      </div>
    );
  }

  if (view === "no-answer") {
    // Never learned whether this person has a PIN, and cannot ask. Opening
    // would let a PIN account past its own lock, so it stays shut and says so.
    return (
      <div className="pin-gate">
        <h1 className="pin-gate-brand">FORGE WINDOWS</h1>
        <p className="pin-name">{t("pin.offlineTitle")}</p>
        <p className="pin-hint">{t("pin.offlineNeverChecked")}</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setWaitedOut(false);
            void pinStatus.refetch();
          }}
        >
          {t("pin.tryAgain")}
        </button>
      </div>
    );
  }

  /**
   * Who decides, in order. With an answer from the server, the server alone —
   * unchanged. Only when it cannot be reached, the offline unlock kept from the
   * last yes on this phone (lib/offlinePin.ts, the owner's call 2026-09-24).
   * Null means let them in.
   */
  const judge = async (value: string): Promise<PinProblem | null> => {
    lastTry.current = "";
    let result: Awaited<ReturnType<typeof checkMyPin>>;
    try {
      result = await checkMyPin(value);
    } catch {
      result = { ok: false, reason: "network" };
    }
    if (result.ok) {
      // A fresh offline unlock: this PIN, for the next twelve hours.
      void rememberPinForOffline(userId, value);
      return null;
    }
    if (result.reason === "wrong") {
      // Mistyped, or changed on another phone — either way the copy kept here
      // can no longer be trusted to match.
      forgetOfflinePin();
      return { kind: "wrong" };
    }
    if (result.reason === "error") {
      lastTry.current = value;
      return { kind: "not-checked" };
    }
    let offline: Awaited<ReturnType<typeof checkPinOffline>>;
    try {
      offline = await checkPinOffline(userId, value);
    } catch {
      offline = { kind: "none" };
    }
    switch (offline.kind) {
      case "ok":
        return null;
      case "wrong":
        return { kind: "wrong-offline", triesLeft: offline.triesLeft };
      case "locked":
        return { kind: "locked-offline" };
      case "expired":
        lastTry.current = value;
        return { kind: "expired" };
      case "none":
        lastTry.current = value;
        return { kind: "no-signal" };
    }
  };

  const submit = async (value: string) => {
    setCheckingPin(true);
    setError(null);
    let problem: PinProblem | null;
    try {
      problem = await judge(value);
    } finally {
      setCheckingPin(false);
    }
    if (problem) {
      setError(problem);
      setEntry("");
    } else {
      setUnlocked(true);
    }
  };

  const problemText = (p: PinProblem): string => {
    switch (p.kind) {
      case "wrong":
        return t("pin.wrong");
      case "wrong-offline":
        return t("pin.wrongOffline", { n: p.triesLeft });
      case "locked-offline":
        return t("pin.offlineLocked");
      case "no-signal":
        return t("pin.noSignal");
      case "expired":
        return t("pin.offlineExpired");
      case "not-checked":
        return t("pin.notChecked");
    }
  };
  // The digits are worth sending again only when nobody could judge them.
  const canTryAgain =
    error?.kind === "no-signal" || error?.kind === "expired" || error?.kind === "not-checked";

  const pushDigit = (digit: string) => {
    if (checkingPin || entry.length >= 4) return;
    const next = entry + digit;
    setEntry(next);
    setError(null);
    if (next.length === 4) void submit(next);
  };

  const backspace = () => {
    setEntry((v) => v.slice(0, -1));
    setError(null);
  };

  const name = me.data?.display_name ?? t("pin.someone");

  return (
    <div className="pin-gate">
      <h1 className="pin-gate-brand">FORGE WINDOWS</h1>
      <div className="pin-avatar" aria-hidden>
        {initialsFrom(name)}
      </div>
      <p className="pin-name">{name}</p>
      <p className="pin-hint">{checkingPin ? t("pin.checkingPin") : t("pin.enter")}</p>
      <div className="pin-dots" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={i < entry.length ? "pin-dot filled" : "pin-dot"}
          />
        ))}
      </div>
      {/* Hidden input keeps autofill / accessibility; pad drives the same state. */}
      <input
        className="pin-input"
        inputMode="numeric"
        maxLength={4}
        value={entry}
        autoFocus
        aria-label={t("pin.inputLabel")}
        onChange={(e) => {
          if (checkingPin) return;
          const v = e.target.value.replace(/\D/g, "").slice(0, 4);
          setEntry(v);
          setError(null);
          if (v.length === 4) void submit(v);
        }}
      />
      {error && <p className="error">{problemText(error)}</p>}
      {canTryAgain && (
        <button
          type="button"
          disabled={checkingPin}
          onClick={() => {
            if (lastTry.current) void submit(lastTry.current);
          }}
        >
          {t("pin.tryAgain")}
        </button>
      )}
      <div className="pin-pad">
        {PAD_KEYS.map((key, i) => {
          if (key === "") {
            return <div key={`empty-${i}`} className="pin-key empty" />;
          }
          if (key === "⌫") {
            return (
              <button
                key="back"
                type="button"
                className="pin-key"
                aria-label={t("pin.delete")}
                onClick={backspace}
              >
                ⌫
              </button>
            );
          }
          return (
            <button
              key={key}
              type="button"
              className="pin-key"
              onClick={() => pushDigit(key)}
            >
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Self-service control to set/clear your PIN (used on the Crew screen). */
export function PinSetter() {
  const queryClient = useQueryClient();
  // The same answer the lock reads — and keeps for a relaunch with no signal —
  // so setting or clearing a PIN here changes what the lock does next time,
  // signal or not.
  const userId = signedInUserId();
  const hasPin = usePinStatus(userId);
  const [pin, setPin] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <label className="field-label">
        Your quick-unlock PIN {hasPin.data ? "(set)" : "(none)"}
      </label>
      <div className="row-gap">
        <input
          inputMode="numeric"
          maxLength={4}
          placeholder="4 digits"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          style={{ maxWidth: 120, marginBottom: 0 }}
        />
        <button
          className="button-like"
          disabled={pin.length !== 4}
          onClick={async () => {
            await setMyPin(pin);
            // A new PIN: the offline unlock kept for the old one must not open
            // the lock. The next check with signal makes a fresh one.
            forgetOfflinePin();
            queryClient.setQueryData(["myPinStatus", userId], true);
            setSaved(true);
            setPin("");
            hasPin.refetch();
          }}
        >
          Save PIN
        </button>
        {hasPin.data && (
          <button
            className="button-like"
            onClick={async () => {
              await setMyPin("");
              forgetOfflinePin();
              queryClient.setQueryData(["myPinStatus", userId], false);
              setSaved(false);
              hasPin.refetch();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {saved && (
        <p className="ok" style={{ fontSize: 13 }}>
          PIN saved.
        </p>
      )}
    </div>
  );
}
