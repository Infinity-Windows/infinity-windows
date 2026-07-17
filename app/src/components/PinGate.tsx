import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getMyProfile, setMyPin } from "../lib/install/api";

const UNLOCK_KEY = "wops-pin-unlocked";

/**
 * Lightweight device PIN lock on top of the persisted Supabase session.
 * If the signed-in user has set a PIN, require it once per browser session.
 * Not a replacement for auth — the real session already logged in.
 */
export function PinGate({ children }: { children: React.ReactNode }) {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const [entry, setEntry] = useState("");
  const [error, setError] = useState(false);
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(UNLOCK_KEY) === "1",
  );

  useEffect(() => {
    if (unlocked) sessionStorage.setItem(UNLOCK_KEY, "1");
  }, [unlocked]);

  if (me.isLoading) return null;
  const pin = me.data?.pin;
  if (!pin || unlocked) return <>{children}</>;

  const submit = (value: string) => {
    if (value === pin) {
      setUnlocked(true);
      setError(false);
    } else {
      setError(true);
      setEntry("");
    }
  };

  return (
    <div className="pin-gate">
      <h1>Infinity</h1>
      <p className="muted">
        {me.data?.display_name ? `${me.data.display_name} · ` : ""}enter your 4-digit PIN
      </p>
      <input
        className="pin-input"
        inputMode="numeric"
        maxLength={4}
        value={entry}
        autoFocus
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 4);
          setEntry(v);
          if (v.length === 4) submit(v);
        }}
      />
      {error && <p className="error">Wrong PIN — try again</p>}
    </div>
  );
}

/** Small self-service control to set/clear your PIN (used on the Crew screen). */
export function PinSetter() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const [pin, setPin] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <label className="field-label">
        Your quick-unlock PIN {me.data?.pin ? "(set)" : "(none)"}
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
          }}
        >
          Save PIN
        </button>
        {me.data?.pin && (
          <button
            className="button-like"
            onClick={async () => {
              await setMyPin("");
              setSaved(false);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {saved && <p className="ok" style={{ fontSize: 13 }}>PIN saved.</p>}
    </div>
  );
}
