// A call for hands finds helpers where they already are (owner ask,
// 2026-08-18): while a summon is live it rides the landing pages — My Work
// for installers, Home for foremen — not only the window's own sheet.
// Tapping a row lands on that sheet, where Answer clocks you on. The strip
// renders nothing when nothing is live, so most days it does not exist.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile } from "../../lib/install/api";
import {
  listAllLiveSummons,
  summonStripLine,
} from "../../lib/install/summons";

export function LiveSummonsStrip() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const live = useQuery({
    queryKey: ["liveSummonsAll"],
    queryFn: listAllLiveSummons,
    // Pushes announce a new summon; this keeps the strip honest for anyone
    // already sitting on the page.
    refetchInterval: 30_000,
  });
  const rows = live.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-label="Live summons" style={{ display: "grid", gap: 8 }}>
      {rows.map((s) => {
        const mine = Boolean(me.data?.id && s.requested_by === me.data.id);
        const open = s.status === "open";
        return (
          <Link
            key={s.id}
            to={`/projects/${s.project_id}/opening/${s.opening_id}`}
            className="find-row"
            style={{
              border: `1px solid ${open ? "var(--danger)" : "var(--border)"}`,
              borderRadius: 12,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong className={open ? "error" : "muted"}>
                {open ? "SUMMON" : "Summon covered"}
              </strong>{" "}
              <span>{summonStripLine(s, mine)}</span>
            </div>
            {open && !mine && (
              <span className="button-like active-pill" aria-hidden>
                Answer
              </span>
            )}
          </Link>
        );
      })}
    </section>
  );
}
