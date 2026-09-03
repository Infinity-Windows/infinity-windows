// The first-login language choice: a full-screen, two-button question shown
// once, before anything else, to a person who has never picked a language on
// this device (LanguageProvider.needsChoice). Choosing writes it to the profile
// and dismisses; a person who already has a choice never sees this again.
//
// Big and plain on purpose — this is the first thing a new crew member meets, on
// a phone, often in bright sun. English is highlighted as the default so a tap
// on the obvious button is never wrong, and Español is exactly as easy to hit.

import { useLanguage } from "../lib/i18n";
import type { Lang } from "../lib/i18n";

export function FirstRunLanguagePicker() {
  const { t, setLang, needsChoice } = useLanguage();
  if (!needsChoice) return null;

  const choose = (lang: Lang) => () => setLang(lang);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("picker.heading")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 4000,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: "24px max(24px, env(safe-area-inset-left)) 24px max(24px, env(safe-area-inset-right))",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ fontSize: 30, margin: "0 0 8px", color: "var(--text)" }}>
          {t("picker.heading")}
        </h1>
        <p style={{ color: "var(--muted)", margin: "0 0 28px", fontSize: 15 }}>
          {t("picker.help")}
        </p>
        <div style={{ display: "grid", gap: 14 }}>
          {/* English default: the highlighted button, but no more than one tap
              ahead of Español. */}
          <button
            type="button"
            className="primary big"
            style={{ width: "100%", padding: "18px 20px", fontSize: 20 }}
            onClick={choose("en")}
          >
            {t("picker.english")}
          </button>
          <button
            type="button"
            className="button-like big"
            style={{ width: "100%", padding: "18px 20px", fontSize: 20 }}
            onClick={choose("es")}
          >
            {t("picker.spanish")}
          </button>
        </div>
      </div>
    </div>
  );
}
