import { useIsRestoring, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { checkMyPin, myPinStatus, setMyPin } from "../lib/install/api";
import { getMyProfile } from "../lib/install/api";
import { useT } from "../lib/i18n";
import { checkPinOffline, forgetOfflinePin, rememberPinForOffline } from "../lib/offlinePin";
import {
  PIN_CHECK_WAIT_MS,
  isUnlockedInThisTab,
  pinGateView,
  rememberUnlockInThisTab,
} from "../lib/pinGate";
import {
  signInGeneration,
  signInMark,
  signedInUserId,
  stillSignedInAs,
  type SignInMark,
} from "../lib/signedIn";

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
      const signIn = signInMark();
      // Throws on anything but a real yes or no (install/api.ts): a failed
      // read leaves the saved answer as it was — a saved yes stays a yes.
      const hasPin = await myPinStatus();
      // my_pin_status answers for whoever the request went out as. An answer
      // that lands after a sign-out or another login may be somebody else's,
      // and is not kept as this person's.
      if (!userId || !stillSignedInAs(signIn, userId)) throw new Error("signed in as somebody else now");
      // The server says there is no PIN now — cleared here, on another phone
      // or by a supervisor. There is nothing left for the offline unlock to
      // stand in for (lib/offlinePin.ts).
      if (hasPin === false) forgetOfflinePin();
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

/** A check whose sign-in ended while it was out: it judges nobody. */
const ENDED = "ended";

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
 *
 * One lock per person AND per sign-in. Everything it holds — an unlock, digits
 * typed, a check on the wire — belongs to the sign-in it was drawn for. Every
 * sign-out, sign-in or switch of account moves lib/signedIn's generation, and
 * a new generation gets a fresh lock, shut, even when it is the same person
 * signing back in. An unlock that was already done used to survive a sign-out
 * and sign-in of the same person that React took in one render, before it
 * ever drew the sign-in screen (Codex reviews of #651, 2026-09-25).
 */
export function PinGate({ userId, children }: { userId: string; children: React.ReactNode }) {
  return (
    <PersonsPinGate key={`${userId}:${signInGeneration()}`} userId={userId}>
      {children}
    </PersonsPinGate>
  );
}

function PersonsPinGate({ userId, children }: { userId: string; children: React.ReactNode }) {
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
  // The sign-in generation this lock was opened in. It opens for that sign-in
  // only: a lock that finds the generation moved on is shut, whichever way it
  // came to be drawn again — its own answer refreshing included, not only a
  // new key from above.
  const [openedIn, setOpenedIn] = useState(() =>
    isUnlockedInThisTab(userId) ? signInGeneration() : null,
  );
  const unlocked = openedIn === signInGeneration();
  const [waitedOut, setWaitedOut] = useState(false);
  // False once this lock is gone — signed out, or another login drew its own.
  const drawn = useRef(true);
  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
    };
  }, []);
  /** Is the check that started under `signIn` still this lock's to finish? */
  const stillOurs = (signIn: SignInMark) => drawn.current && stillSignedInAs(signIn, userId);

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
    // When the server did answer, just not with a yes or a no (a stale schema
    // cache, a token it would not take), "You're offline" would be wrong.
    const serverAnswered = (pinStatus.error as { reason?: unknown } | null)?.reason === "error";
    return (
      <div className="pin-gate">
        <h1 className="pin-gate-brand">FORGE WINDOWS</h1>
        {serverAnswered ? (
          <p className="pin-hint">{t("pin.notChecked")}</p>
        ) : (
          <>
            <p className="pin-name">{t("pin.offlineTitle")}</p>
            <p className="pin-hint">{t("pin.offlineNeverChecked")}</p>
          </>
        )}
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
   * Null means let them in; ENDED means the sign-in this check was for is over,
   * and nobody is let in or told anything.
   */
  const judge = async (value: string, signIn: SignInMark): Promise<PinProblem | null | typeof ENDED> => {
    lastTry.current = "";
    let result: Awaited<ReturnType<typeof checkMyPin>>;
    try {
      result = await checkMyPin(value);
    } catch {
      result = { ok: false, reason: "network" };
    }
    // The answer can take up to the fifteen-second request deadline to land,
    // and the person it was asked for may have signed out, or somebody else
    // signed in, by then. It used to keep a fresh offline unlock for the
    // person who had just signed out (Codex review of #651, 2026-09-25).
    if (!stillOurs(signIn)) return ENDED;
    if (result.ok) {
      // A fresh offline unlock: this PIN, for the next twelve hours — held to
      // the same sign-in, which offlinePin asks again right before it writes.
      void rememberPinForOffline(userId, value, { signIn });
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
      offline = await checkPinOffline(userId, value, { signIn });
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
    // Taken BEFORE the server is asked: the whole check — the server's answer
    // and any offline one — is held to the sign-in it began in.
    const signIn = signInMark();
    setCheckingPin(true);
    setError(null);
    let problem: PinProblem | null | typeof ENDED;
    try {
      problem = await judge(value, signIn);
    } finally {
      setCheckingPin(false);
    }
    // Asked once more right before anything is written or shown. A check
    // dropped while the same person's lock is still drawn (signed out and
    // back in before App redrew) hands the pad back empty, to type again.
    if (problem === ENDED || !stillOurs(signIn)) {
      setEntry("");
      return;
    }
    if (problem) {
      setError(problem);
      setEntry("");
    } else {
      rememberUnlockInThisTab(userId);
      // The digits have done their job; nothing keeps them.
      setEntry("");
      setOpenedIn(signIn.generation);
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

/**
 * Set, change or remove your own PIN. On Settings, where every role can reach
 * it: it sat on the Roster, supervisor-only since #610, so installers and
 * foremen could not set a PIN at all (moved 2026-09-25).
 */
export function PinSetter() {
  const t = useT();
  const queryClient = useQueryClient();
  const inputId = useId();
  // The same answer the lock reads — and keeps for a relaunch with no signal —
  // so setting or clearing a PIN here changes what the lock does next time,
  // signal or not.
  const userId = signedInUserId();
  const hasPin = usePinStatus(userId);
  const [pin, setPin] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <label className="field-label" htmlFor={inputId}>
        {t("pin.setter.label")} {hasPin.data ? t("pin.setter.isSet") : t("pin.setter.none")}
      </label>
      <div className="row-gap">
        <input
          id={inputId}
          inputMode="numeric"
          maxLength={4}
          placeholder={t("pin.setter.placeholder")}
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
          {t("pin.setter.save")}
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
            {t("pin.setter.clear")}
          </button>
        )}
      </div>
      {saved && (
        <p className="ok" style={{ fontSize: 13 }}>
          {t("pin.setter.saved")}
        </p>
      )}
    </div>
  );
}
