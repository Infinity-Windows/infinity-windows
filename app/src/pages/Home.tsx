import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getDashboardCounts } from "../lib/api";
import { supabase } from "../lib/supabase";

export function Home() {
  const counts = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboardCounts,
  });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Warehouse</h1>
        <button className="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <div className="stat-grid">
        <Link to="/search" className="stat-card">
          <span className="stat-num">{counts.data?.total ?? "-"}</span>
          <span>windows on hand</span>
        </Link>
        <Link to="/scan" className="stat-card warn">
          <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
          <span>need putaway</span>
        </Link>
        <Link to="/projects" className="stat-card">
          <span className="stat-num">{counts.data?.staged ?? "-"}</span>
          <span>staged for jobs</span>
        </Link>
        <Link to="/search?status=damaged" className="stat-card danger">
          <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
          <span>damaged / hold</span>
        </Link>
      </div>

      <div className="action-list">
        <Link to="/scan" className="action-btn primary">
          Scan a window or slot
        </Link>
        <Link to="/receive" className="action-btn">
          Receive a delivery
        </Link>
        <Link to="/labels" className="action-btn">
          Print labels
        </Link>
        <Link to="/count" className="action-btn">
          Cycle count a rack
        </Link>
        <Link to="/catalog" className="action-btn">
          Import window catalog (CSV)
        </Link>
      </div>
    </div>
  );
}
