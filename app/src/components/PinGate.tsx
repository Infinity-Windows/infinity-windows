import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { checkMyPin, myPinStatus, setMyPin } from "../lib/install/api";
import { getMyProfile } from "../lib/install/api";

const UNLOCK_KEY = "wops-pin-unlocked";

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

function initialsFrom(name: string | null | undefined): string {
  if (!name?.trim()) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Lightweight device PIN lock on top of the persisted Supabase session.
 * The PIN itself never reaches the client — status and verification are RPCs.
 */
export function PinGate({ children }: { children: React.ReactNode }) {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const hasPin = useQuery({
    queryKey: ["myPinStatus", me.data?.id],
    queryFn: myPinStatus,
    enabled: Boolean(me.data?.id),
  });
  const [entry, setEntry] = useState("");
  const [error, setError] = useState(false);
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(UNLOCK_KEY) === "1",
  );

  useEffect(() => {
    if (unlocked) sessionStorage.setItem(UNLOCK_KEY, "1");
  }, [unlocked]);

  if (me.isLoading || hasPin.isLoading) return null;
  if (!hasPin.data || unlocked) return <>{children}</>;

  const submit = async (value: string) => {
    const ok = await checkMyPin(value);
    if (ok) {
      setUnlocked(true);
      setError(false);
    } else {
      setError(true);
      setEntry("");
    }
  };

  const pushDigit = (digit: string) => {
    if (entry.length >= 4) return;
    const next = entry + digit;
    setEntry(next);
    setError(false);
    if (next.length === 4) void submit(next);
  };

  const backspace = () => {
    setEntry((v) => v.slice(0, -1));
    setError(false);
  };

  const name = me.data?.display_name ?? "Crew";

  return (
    <div className="pin-gate">
      <h1 className="pin-gate-brand">INFINITY</h1>
      <div className="pin-avatar" aria-hidden>
        {initialsFrom(name)}
      </div>
      <p className="pin-name">{name}</p>
      <p className="pin-hint">Enter your 4-digit PIN</p>
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
        aria-label="4-digit PIN"
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 4);
          setEntry(v);
          setError(false);
          if (v.length === 4) void submit(v);
        }}
      />
      {error && <p className="error">Wrong PIN — try again</p>}
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
                aria-label="Delete"
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
  const hasPin = useQuery({ queryKey: ["myPinStatus"], queryFn: myPinStatus });
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
