import { useState } from "react";
import { BackChip } from "../components/BackChip";
import { Link } from "react-router-dom";
import { BuildIdentityCard } from "../components/BuildIdentityCard";
import { PermissionsSettings } from "../components/permissions/PermissionsSettings";
import { playSuccessTone, setSoundsEnabled, soundsEnabled } from "../lib/sound";
import { useLanguage } from "../lib/i18n";
import type { Lang } from "../lib/i18n";

type ThemeChoice = "system" | "light" | "dark";

function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem("infinity.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Applies the choice instantly and keeps the browser chrome color honest. */
function applyTheme(t: ThemeChoice) {
  try {
    if (t === "system") {
      localStorage.removeItem("infinity.theme");
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem("infinity.theme", t);
      document.documentElement.dataset.theme = t;
    }
    const dark =
      t === "dark" ||
      (t === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#1a1512" : "#f6f1ea");
  } catch {
    // Storage can be blocked; the choice just won't survive a reload.
  }
}

/** Settings hub. For now it hosts the Notifications & location controls (p1-10). */
export function Settings() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [sounds, setSounds] = useState<boolean>(soundsEnabled);
  const { lang, setLang, t } = useLanguage();

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("settings.pageTitle")}</p>
          <h1>{t("settings.pageTitle")}</h1>
        </div>
        <BackChip label={t("settings.back")} />
      </header>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("settings.language.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {t("settings.language.help")}
        </p>
        <div className="row-gap">
          {(["en", "es"] as const).map((l: Lang) => (
            <button
              key={l}
              className={lang === l ? "button-like active-pill" : "button-like"}
              // Takes effect immediately: setLang flips the whole app's language
              // and persists it to the profile in the same tap.
              onClick={() => setLang(l)}
            >
              {l === "en" ? t("picker.english") : t("picker.spanish")}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("settings.appearance.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {t("settings.appearance.help")}
        </p>
        <div className="row-gap">
          {(["system", "light", "dark"] as const).map((choice) => (
            <button
              key={choice}
              className={theme === choice ? "button-like active-pill" : "button-like"}
              onClick={() => {
                setTheme(choice);
                applyTheme(choice);
              }}
            >
              {choice === "system"
                ? t("settings.appearance.system")
                : choice === "light"
                  ? t("settings.appearance.light")
                  : t("settings.appearance.dark")}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("settings.sounds.heading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {t("settings.sounds.help")}
        </p>
        <button
          className={sounds ? "button-like active-pill" : "button-like"}
          onClick={() => {
            const next = !sounds;
            setSounds(next);
            setSoundsEnabled(next);
            // The click that turns it on IS the user gesture the browser
            // wants before it will play anything — the same tap doubles as
            // proof the phone's audio actually works.
            if (next) playSuccessTone();
          }}
        >
          {sounds ? t("settings.sounds.on") : t("settings.sounds.off")}
        </button>
      </section>

      <PermissionsSettings />
      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("settings.diagnostics.heading")}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{t("settings.diagnostics.help")}</p>
        <Link to="/diagnostics" className="action-btn" data-testid="open-diagnostics">
          {t("settings.diagnostics.open")}
        </Link>
      </section>
      <BuildIdentityCard />
    </div>
  );
}
