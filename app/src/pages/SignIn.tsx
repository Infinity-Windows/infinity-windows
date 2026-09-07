import { useEffect, useState } from "react";
import { formatApiError } from "../lib/errors";
import {
  cooldownLabel,
  passwordResetRedirectUrl,
  RESET_EMAIL_COOLDOWN_SEC,
  resetEmailRefusal,
} from "../lib/passwordReset";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { submitAccessRequest, setMyLanguage } from "../lib/install/api";
import { usePreAuthT } from "../lib/i18n";

/**
 * There is no "create your own account" here any more.
 *
 * Anyone with an email address used to be able to sign themselves up, which
 * put them straight into the crew directory and the twenty-odd screens an
 * installer can reach. Self-signup is now switched off in the project's auth
 * settings, so the only way in is: request access, a supervisor or the owner
 * approves it on the Admin screen, and that approval creates the login and
 * hands them a one-time password. Leaving the old button here would just show
 * everyone "Signups not allowed for this instance".
 */
type Mode = "signin" | "request";

export function SignIn({
  initialMode = "signin",
  initialNotice = null,
  onHaveInviteCode,
}: {
  initialMode?: Mode;
  /** A plain sentence about how they landed here — e.g. an expired reset link. */
  initialNotice?: string | null;
  /**
   * For someone a supervisor added on the Crew access screen. They were texted a
   * link, but chat apps mangle links, so they can type the code instead. This is
   * not self-signup: without a valid code it goes nowhere.
   */
  onHaveInviteCode?: () => void;
}) {
  // No LanguageProvider exists yet at this point — it only mounts once there
  // is a session (App.tsx). usePreAuthT reads the same per-device cache the
  // provider uses, so the very first thing on this screen respects a choice
  // made here before, or on another pre-login screen (JoinCrew).
  const { lang, t, setLang: pickLang, hadNoChoice } = usePreAuthT();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialNotice);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Access request fields
  const [reqName, setReqName] = useState("");
  const [reqEmail, setReqEmail] = useState("");
  const [reqPhone, setReqPhone] = useState("");
  const [reqRole, setReqRole] = useState("installer");
  const [requested, setRequested] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError(error.message);
    } else if (hadNoChoice) {
      // First time this device has ever recorded a language pick — write it
      // to the profile now, the same RPC Settings uses, so the choice isn't
      // lost the instant the LanguageProvider mounts and the profile (which
      // always carries SOME value, defaulting to English) wins the resolve.
      void setMyLanguage(lang).catch(() => {});
    }
    setBusy(false);
  };

  // The Reset button rests after each send (and after a pace refusal), with
  // a live countdown — tapping sooner only burns the mailer's quota. A
  // timeout chain, not an interval: each tick schedules the next.
  const [resetWait, setResetWait] = useState(0);
  useEffect(() => {
    if (resetWait <= 0) return;
    const t = setTimeout(() => setResetWait((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resetWait]);

  const resetPassword = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError(t("signin.enterEmailFirst"));
      setBusy(false);
      return;
    }
    // The app lives under a base path on GitHub Pages — bare origin was a 404
    // page, which is where every reset email used to land (owner report,
    // 2026-08-18). The helper joins origin + BASE_URL; App.tsx handles the
    // recovery landing with the Set-new-password screen.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      {
        redirectTo: passwordResetRedirectUrl(
          window.location.origin,
          import.meta.env.BASE_URL,
        ),
      },
    );
    if (resetError) {
      // Pace refusals get plain words and a rest matched to the refusal;
      // real errors show as themselves.
      const refusal = resetEmailRefusal(resetError.message);
      if (refusal) {
        setError(refusal.line);
        setResetWait(refusal.waitSec);
      } else {
        setError(resetError.message);
      }
    } else {
      setInfo(t("signin.resetSent"));
      setResetWait(RESET_EMAIL_COOLDOWN_SEC);
    }
    setBusy(false);
  };

  const submitRequest = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await submitAccessRequest({
        name: reqName,
        email: reqEmail || undefined,
        phone: reqPhone || undefined,
        requested_role: reqRole,
      });
      setRequested(true);
    } catch (e) {
      setError(formatApiError(e));
    }
    setBusy(false);
  };

  return (
    <div className="signin">
      <div className="signin-brand">
        <h1>FORGE</h1>
        <div className="signin-rule">
          <span>{t("signin.tagline")}</span>
        </div>
      </div>

      {/* Usable before login and with no JavaScript beyond a plain click
          handler — a segmented control, not a dropdown or a CSS trick. Above
          the form on purpose: a person's first choice on this screen is what
          language everything below it reads in. */}
      <div
        role="group"
        aria-label={t("settings.language.heading")}
        className="signin-lang-switch"
        style={{ display: "flex", gap: 8, margin: "0 0 16px" }}
      >
        {(["en", "es"] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={lang === l ? "button-like active-pill" : "button-like"}
            style={{ flex: 1, minHeight: 48, fontSize: 16 }}
            aria-pressed={lang === l}
            onClick={() => pickLang(l)}
          >
            {l === "en" ? t("picker.english") : t("picker.spanish")}
          </button>
        ))}
      </div>

      {!supabaseConfigured && <p className="error">{t("signin.notConfigured")}</p>}

      {mode === "request" ? (
        requested ? (
          <div className="signin-done">
            <div className="signin-done-check">✓</div>
            <p
              className="ok"
              style={{ margin: 0, fontWeight: 600, fontSize: 16 }}
            >
              {t("signin.requestSubmitted.title")}
            </p>
            <p
              className="muted"
              style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}
            >
              {t("signin.requestSubmitted.body")}
            </p>
            <button
              className="secondary"
              onClick={() => {
                setMode("signin");
                setRequested(false);
              }}
            >
              {t("signin.backToStart")}
            </button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
              {t("signin.requestIntro")}
            </p>
            <input
              placeholder={t("signin.fullName")}
              value={reqName}
              onChange={(e) => setReqName(e.target.value)}
            />
            {/* Required, not optional: the email IS the login. Approving a
                request with no email cannot create an account, which is how
                approvals used to end in nothing happening. */}
            <input
              type="email"
              placeholder={t("signin.email")}
              value={reqEmail}
              onChange={(e) => setReqEmail(e.target.value)}
            />
            <input
              placeholder={t("signin.phone")}
              value={reqPhone}
              onChange={(e) => setReqPhone(e.target.value)}
            />
            <label className="field-label">{t("signin.roleLabel")}</label>
            <select
              value={reqRole}
              onChange={(e) => setReqRole(e.target.value)}
            >
              <option value="installer">{t("signin.role.installer")}</option>
              <option value="foreman">{t("signin.role.foreman")}</option>
              <option value="supervisor">{t("signin.role.supervisor")}</option>
            </select>
            {error && <p className="error">{error}</p>}
            <button
              className="primary big"
              onClick={submitRequest}
              disabled={busy || !reqName.trim() || !reqEmail.trim()}
            >
              {busy ? t("signin.submitting") : t("signin.submitRequest")}
            </button>
            <button
              className="link"
              onClick={() => {
                setMode("signin");
                setError(null);
              }}
            >
              {t("signin.backToSignIn")}
            </button>
          </>
        )
      ) : (
        <>
          <p className="signin-kicker">{t("signin.kicker")}</p>
          <input
            type="email"
            placeholder={t("signin.email")}
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder={t("signin.password")}
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signIn()}
          />
          {error && <p className="error">{error}</p>}
          {info && <p className="muted">{info}</p>}
          <button className="primary big" onClick={signIn} disabled={busy}>
            {busy ? t("signin.signingIn") : t("signin.signIn")}
          </button>
          {onHaveInviteCode && (
            <button className="link" onClick={onHaveInviteCode}>
              {t("signin.haveCode")}
            </button>
          )}
          <button
            className="link"
            onClick={resetPassword}
            disabled={busy || resetWait > 0}
          >
            {resetWait > 0
              ? t("signin.resetWait", { wait: cooldownLabel(resetWait) })
              : t("signin.resetPassword")}
          </button>
          <button
            className="link"
            onClick={() => {
              setMode("request");
              setError(null);
              setInfo(null);
            }}
          >
            {t("signin.requestAccess")}
          </button>
          <p className="signin-footnote">{t("signin.footnote")}</p>
        </>
      )}
    </div>
  );
}
