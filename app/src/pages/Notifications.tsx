import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { notifyLocal } from "../lib/permissions/notifyLocal";
import {
  getMyProfile,
  listAccessRequests,
  listMemosToConfirm,
} from "../lib/install/api";
import { listInstalledForQc } from "../lib/ops";
import { listShiftsToApprove } from "../lib/timeclock";
import { isSupervisorPlus, isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

interface Note {
  id: string;
  dot: "info" | "ok" | "warn";
  title: string;
  sub: string;
  to: string;
}

export function Notifications() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const admin = isSupervisorPlus(effectiveRole);
  const id = me.data?.id;

  const memos = useQuery({
    queryKey: ["memosToConfirm", id],
    queryFn: () => listMemosToConfirm(id!),
    enabled: Boolean(id),
  });
  const qc = useQuery({
    queryKey: ["qcInstalled"],
    queryFn: listInstalledForQc,
    enabled: lead,
  });
  const shifts = useQuery({
    queryKey: ["shiftsToApprove"],
    queryFn: listShiftsToApprove,
    enabled: lead,
  });
  const requests = useQuery({
    queryKey: ["accessRequests"],
    queryFn: listAccessRequests,
    enabled: admin,
  });

  const notes: Note[] = [];

  for (const m of memos.data ?? []) {
    notes.push({
      id: `memo-${m.id}`,
      dot: "info",
      title: "Confirm your install memo",
      sub: "AI filled the fields — review and confirm",
      to: "/review",
    });
  }

  const pendingQc = (qc.data ?? []).filter((r) => !r.qc || r.qc.status !== "passed");
  if (pendingQc.length > 0) {
    notes.push({
      id: "qc",
      dot: "warn",
      title: `${pendingQc.length} install${pendingQc.length > 1 ? "s" : ""} awaiting QC`,
      sub: "Sign off passes and callbacks",
      to: "/qc",
    });
  }

  if ((shifts.data ?? []).length > 0) {
    notes.push({
      id: "shifts",
      dot: "warn",
      title: `${shifts.data!.length} timecard${shifts.data!.length > 1 ? "s" : ""} to approve`,
      sub: "Review submitted shifts",
      to: "/clock",
    });
  }

  const pendingReq = (requests.data ?? []).filter((r) => r.status === "pending");
  if (pendingReq.length > 0) {
    notes.push({
      id: "requests",
      dot: "info",
      title: `${pendingReq.length} access request${pendingReq.length > 1 ? "s" : ""}`,
      sub: "Approve or deny new crew",
      to: "/admin",
    });
  }

  // Local-notification seam: mirror the in-app "what needs you" list to a device
  // notification. No-op unless the user granted notifications; deduped by tag so
  // each distinct item only pings once per session. This is a real client-side
  // hook (no server events) — when web push lands it will deliver the same
  // {title, body, tag, url} shape from the server instead. See notifyLocal.ts.
  const noteSignature = notes.map((n) => n.id).join("|");
  useEffect(() => {
    for (const n of notes) {
      void notifyLocal({ title: n.title, body: n.sub, tag: `needs-you-${n.id}`, url: n.to });
    }
  }, [noteSignature]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Notifications</p>
          <h1>What needs you</h1>
        </div>
        <button type="button" className="back-chip" aria-label="Back" onClick={() => navigate(-1)}>
          ‹
        </button>
      </header>

      <Link to="/settings" className="notif-settings-link">
        <Settings2 size={16} aria-hidden />
        <span>Notifications &amp; location settings</span>
        <span className="muted" aria-hidden>›</span>
      </Link>

      {notes.length === 0 ? (
        <p className="muted">You're all caught up.</p>
      ) : (
        <div className="notif-list">
          {notes.map((n) => (
            <Link key={n.id} to={n.to} className="notif-row">
              <i className={n.dot === "ok" ? "dot-ok" : n.dot === "warn" ? "dot-warn" : "dot-info"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{n.title}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{n.sub}</div>
              </div>
              <span className="muted">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
