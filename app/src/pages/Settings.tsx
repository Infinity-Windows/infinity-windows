import { useState } from "react";
import { BackChip } from "../components/BackChip";
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
          <p className="home-greeting">Settings</p>
          <h1>Settings</h1>
        </div>
        <BackChip label="Back" />
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
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Appearance</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Light reads best in the sun; dark is easy on the eyes indoors.
          System follows your phone.
        </p>
        <div className="row-gap">
          {(["system", "light", "dark"] as const).map((t) => (
            <button
              key={t}
              className={theme === t ? "button-like active-pill" : "button-like"}
              onClick={() => {
                setTheme(t);
                applyTheme(t);
              }}
            >
              {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Warehouse sounds</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          A soft tick on a scan or check-in that goes through, a buzz on one
          that doesn't. Off by default.
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
          {sounds ? "On" : "Off"}
        </button>
      </section>

      <PermissionsSettings />
      <BuildIdentityCard />
    </div>
  );
}
