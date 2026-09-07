import { useEffect, useState } from "react";
import { formatApiError } from "../lib/errors";
import { supabase } from "../lib/supabase";
import { peekCrewInvite, redeemCrewInvite, type InvitePreview } from "../lib/crewAccess";
import { usePreAuthT } from "../lib/i18n";
import {
  formatInviteCode,
  looksLikeInviteCode,
  MIN_PASSWORD_LENGTH,
  normalizeInviteCode,
  ROLE_TITLES,
  validateInvitePassword,
  type CrewRoleName,
} from "../../../supabase/functions/_shared/crewInvites";

/**
 * "You've been added to Forge Windows" — what a new crew member sees.
 *
 * Reached by tapping the link a supervisor texted them, which carries the code
 * as `?join=…` on the app's own root URL, or by typing the code by hand if the
 * link got mangled in a group chat. It renders before the sign-in screen and
 * outside the router, so it cannot depend on the GitHub Pages subpath resolving
 * a deep path.
 *
 * Designed for the actual situation: one thumb, gloves half off, a cracked
 * screen, no patience. Two things happen — we tell them who they are, and they
 * pick a password. There is no email to check (this project sends none), no
 * confirmation link, no waiting for approval. They tap once and they are in.
 */
export function JoinCrew({
  code: initialCode,
  onGiveUp,
}: {
  /** From the link. Null when they arrived here to type one in. */
  code: string | null;
  onGiveUp: () => void;
}) {
  // Pre-login, same as SignIn — reads whatever language this device (or this
  // same person, on the Sign in screen a minute ago) already picked.
  const { t } = usePreAuthT();
  const [code, setCode] = useState(initialCode ?? "");
  const [typed, setTyped] = useState(initialCode ?? "");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [checking, setChecking] = useState(Boolean(initialCode));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  // A link opened on a phone that is already signed in as somebody else — a
  // shared foreman's handset, or the owner testing the flow. Setting up a second
  // account here would silently replace their session, so say so and let them
  // choose rather than doing it behind their back.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSignedInAs(data.session?.user?.email ?? null);
    });
  }, []);

  // Look the code up as soon as we have one, so a wrong code fails now rather
  // than after they have invented a password.
  useEffect(() => {
    if (!code || !looksLikeInviteCode(code)) return;
    let cancelled = false;
    setChecking(true);
    setError(null);
    peekCrewInvite(code)
      .then((found) => {
        if (!cancelled) setPreview(found);
      })
      .catch((err) => {
        if (!cancelled) setError(formatApiError(err));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const submitCode = () => {
    const clean = normalizeInviteCode(typed);
    if (!looksLikeInviteCode(clean)) {
      setError(t("joinCrew.badCode"));
      return;
    }
    setError(null);
    setCode(clean);
  };

  const finish = async () => {
    const check = validateInvitePassword(password, confirm);
    if (!check.ok) {
      setError(check.error ?? t("joinCrew.checkPassword"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // On success this signs them in, the session changes, and App swaps this
      // screen for the app itself. There is nothing to navigate to.
      await redeemCrewInvite(code, password);
    } catch (err) {
      setError(formatApiError(err));
      setBusy(false);
    }
  };

  // Role names in the invite preview come from the shared edge-function
  // vocabulary (ROLE_TITLES), which is English only — translate the three
  // crew roles this screen can ever show rather than widening that shared
  // module for one caller.
  const ROLE_WORD_KEY = {
    installer: "joinCrew.role.installer",
    foreman: "joinCrew.role.foreman",
    supervisor: "joinCrew.role.supervisor",
    owner: "joinCrew.role.owner",
  } as const;
  const roleKey = ROLE_WORD_KEY[preview?.role as CrewRoleName];
  // An unrecognized role can only reach here if the server ever adds a fifth
  // invitable role before this table catches up — fall back to the shared
  // (English-only) title rather than showing nothing.
  const roleWord = preview
    ? roleKey
      ? t(roleKey)
      : (ROLE_TITLES[preview.role as CrewRoleName] ?? preview.role)
    : "";
  const firstName = preview?.display_name?.trim().split(/\s+/)[0] ?? "";

  return (
    <div className="signin">
      <div className="signin-brand">
        <h1>FORGE</h1>
        <div className="signin-rule">
          <span>{t("signin.tagline")}</span>
        </div>
      </div>

      {signedInAs && (
        <div className="detail-card" style={{ marginBottom: 4 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            {t("joinCrew.alreadySignedIn", { email: signedInAs })}
          </p>
          <div className="row-gap" style={{ marginTop: 10 }}>
            <button
              className="button-like"
              onClick={() => {
                void supabase.auth.signOut();
                setSignedInAs(null);
              }}
            >
              {t("joinCrew.signThatOut")}
            </button>
            <button className="link" onClick={onGiveUp}>
              {t("joinCrew.staySignedIn")}
            </button>
          </div>
        </div>
      )}

      {/* --- No code yet: they typed the app in by hand ------------------- */}
      {!code || (!preview && !checking && error) ? (
        <>
          <p className="signin-kicker">{t("joinCrew.enterCode")}</p>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            {t("joinCrew.enterCodeHelp")}
          </p>
          <input
            placeholder="ABCDE-23456"
            value={typed}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitCode()}
          />
          {error && <p className="error">{error}</p>}
          <button
            className="primary big"
            onClick={submitCode}
            disabled={!typed.trim()}
          >
            {t("joinCrew.continue")}
          </button>
          <button className="link" onClick={onGiveUp}>
            {t("joinCrew.haveLogin")}
          </button>
        </>
      ) : checking ? (
        <p className="muted">{t("joinCrew.checkingCode")}</p>
      ) : preview ? (
        <>
          <p className="signin-kicker">
            {firstName ? t("joinCrew.hiName", { name: firstName }) : t("joinCrew.beingSetUp")}
          </p>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            {preview.existing_account
              ? t("joinCrew.pickPasswordExisting", { role: roleWord })
              : t("joinCrew.pickPasswordNew", { role: roleWord })}
          </p>

          <label className="field-label" htmlFor="join-password">
            {t("joinCrew.pickPassword")}
          </label>
          <input
            id="join-password"
            type={reveal ? "text" : "password"}
            placeholder={t("joinCrew.minChars", { n: MIN_PASSWORD_LENGTH })}
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="field-label" htmlFor="join-confirm">
            {t("joinCrew.typeAgain")}
          </label>
          <input
            id="join-confirm"
            type={reveal ? "text" : "password"}
            placeholder={t("joinCrew.samePassword")}
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void finish()}
          />
          {/* Typing a password twice on a cracked screen with gloves on is where
              this flow gets abandoned. Letting them see it is the fix. */}
          <button className="link" onClick={() => setReveal((v) => !v)}>
            {reveal ? t("joinCrew.hidePassword") : t("joinCrew.showPassword")}
          </button>

          {error && <p className="error">{error}</p>}
          <button
            className="primary big"
            onClick={() => void finish()}
            disabled={busy || !password || !confirm}
          >
            {busy ? t("joinCrew.settingUp") : t("joinCrew.startWorking")}
          </button>
          <p className="signin-footnote">
            {t("joinCrew.codeWorksOnce", { code: formatInviteCode(code) })}
          </p>
        </>
      ) : (
        <>
          {error && <p className="error">{error}</p>}
          <button className="link" onClick={onGiveUp}>
            {t("joinCrew.backToSignIn")}
          </button>
        </>
      )}
    </div>
  );
}
