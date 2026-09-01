// Wave S, S4: the STG Windows & Doors shell — a builder/GC login's entire
// app. Clean on purpose (THE WALL #5 + spec): a text wordmark, two tabs,
// nothing else. No values strip, no bottom crew bar, no menu drawer — a
// partner never sees a single crew-facing word anywhere in here, including
// the internal company name (this file, and everything under pages/stg/,
// says "STG Windows & Doors" and never "Forge Windows").
import { useState } from "react";
import { LogOut } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { ScrollTabs } from "../../components/nav/ScrollTabs";
import { StgJobProgress } from "./StgJobProgress";
import { StgCalendarTab } from "./StgCalendarTab";

type StgTab = "progress" | "calendar";
const TABS: { id: StgTab; label: string }[] = [
  { id: "progress", label: "Job progress" },
  { id: "calendar", label: "Calendar" },
];

export function StgApp() {
  const [tab, setTab] = useState<StgTab>("progress");

  return (
    <div className="page stg-app">
      <header className="row-between" style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 19, margin: 0, fontWeight: 700 }}>STG Windows &amp; Doors</h1>
        <button
          type="button"
          className="capture-close"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void supabase.auth.signOut()}
        >
          <LogOut size={18} />
        </button>
      </header>

      {/* Same tab-row component/CSS the project hub uses (hub-tabs/hub-tab) —
          reused for consistency, not a sign this imports any crew screen. */}
      <ScrollTabs className="hub-tabs" label="STG sections" activeId={tab}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "hub-tab active" : "hub-tab"}
            data-tab-active={tab === t.id}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </ScrollTabs>

      <div style={{ marginTop: 16 }}>
        {tab === "progress" ? <StgJobProgress /> : <StgCalendarTab />}
      </div>
    </div>
  );
}
