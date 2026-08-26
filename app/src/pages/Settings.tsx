import { useState } from "react";
import { BackChip } from "../components/BackChip";
import { BuildIdentityCard } from "../components/BuildIdentityCard";
import { PermissionsSettings } from "../components/permissions/PermissionsSettings";

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

      <PermissionsSettings />
      <BuildIdentityCard />
    </div>
  );
}
