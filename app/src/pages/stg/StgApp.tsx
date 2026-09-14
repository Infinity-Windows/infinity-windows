// Wave S, S4: the STG Windows & Doors shell — a builder/GC login's entire
// app. Clean on purpose (THE WALL #5 + spec): a text wordmark, three tabs,
// nothing else. No values strip, no bottom crew bar, no menu drawer — a
// partner never sees a single crew-facing word anywhere in here, including
// the internal company name (this file, and everything under pages/stg/,
// says "STG Windows & Doors" and never "Forge Windows").
import { useState } from "react";
import { LogOut } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { ScrollTabs } from "../../components/nav/ScrollTabs";
import { useIsPartnerUser } from "../../lib/stg";
import { QueryError } from "../../components/ui/States";
import { Link } from "react-router-dom";
import { StgWarehouse } from "./StgWarehouse";
import { StgJobProgress } from "./StgJobProgress";
import { StgCalendarTab } from "./StgCalendarTab";

type StgTab = "progress" | "calendar" | "warehouse";
const TABS: { id: StgTab; label: string }[] = [
  { id: "progress", label: "Job progress" },
  { id: "calendar", label: "Calendar" },
  { id: "warehouse", label: "Warehouse" },
];

export function StgApp() {
  const identity = useIsPartnerUser();
  const [tab, setTab] = useState<StgTab>("progress");

  if (identity.isLoading) return <div className="page">Checking your login…</div>;
  if (identity.isError) return <div className="page"><QueryError error={identity.error} onRetry={() => identity.refetch()} /></div>;
  if (!identity.data) return <div className="page"><h1>STG Windows &amp; Doors</h1><p>This portal requires a builder login. Your current account is a crew account.</p><p>An owner can invite a separate builder login and grant its jobs under Account → Builder logins. Opening this page does not preview or change your role.</p><Link to="/account">Return to Account</Link></div>;
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
        {tab === "progress" ? <StgJobProgress /> : tab === "calendar" ? <StgCalendarTab /> : <StgWarehouse />}
      </div>
    </div>
  );
}
