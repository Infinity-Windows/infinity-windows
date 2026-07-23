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
import { listProjects, listReorderNeeds } from "../lib/api";
import { listVehicles } from "../lib/vehicles/api";
import { serviceBadge } from "../lib/vehicles/service";
import { vehicleTitle } from "../lib/vehicles/display";
import { listAssignments, horizonRange } from "../lib/schedule/api";
import { conflictBannerEntries } from "../lib/schedule/conflicts";

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

  // Supervisor+ only: surface signals already computed elsewhere so the office
  // sees fleet, warehouse and scheduling problems without hunting for them.
  // Each query degrades to an empty list on error (React Query catches throws)
  // so a single failing source never blanks the page.
  const todayISO = new Date().toISOString().slice(0, 10);

  const vehicles = useQuery({
    queryKey: ["notifVehicles"],
    queryFn: listVehicles,
    enabled: admin,
  });

  const activeProjects = useQuery({
    queryKey: ["notifReorderProjects"],
    queryFn: listProjects,
    enabled: admin,
  });
  const projectIds = (activeProjects.data ?? []).map((p) => p.id);
  const reorder = useQuery({
    queryKey: ["notifReorder", projectIds.join(",")],
    enabled: admin && projectIds.length > 0,
    queryFn: async () => {
      const rows = await Promise.all(
        (activeProjects.data ?? []).map(async (p) => {
          try {
            const needs = await listReorderNeeds(p.id);
            const total = needs.reduce(
              (sum, n) => sum + n.missing_count + n.damaged_count,
              0,
            );
            return { project: p, total };
          } catch {
            return { project: p, total: 0 };
          }
        }),
      );
      return rows.filter((r) => r.total > 0);
    },
  });

  const conflicts = useQuery({
    queryKey: ["notifScheduleConflicts", todayISO],
    enabled: admin,
    queryFn: async () => {
      const { from, to } = horizonRange(todayISO);
      const list = await listAssignments(from, to);
      return conflictBannerEntries(
        list.map((a) => ({
          id: a.id,
          start_date: a.start_date,
          end_date: a.end_date,
          members: a.members.map((m) => ({ profile_id: m.profile_id })),
        })),
      );
    },
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

  for (const v of vehicles.data ?? []) {
    const badge = serviceBadge({
      todayISO,
      nextServiceDate: v.next_service_date,
      odometer: v.odometer,
    });
    if (!badge) continue;
    notes.push({
      id: `vehicle-${v.id}`,
      dot: badge.tone === "overdue" ? "warn" : "info",
      title: `${vehicleTitle(v)} — ${badge.label}`,
      sub: "Schedule fleet service",
      to: `/vehicles/${v.id}`,
    });
  }

  for (const r of reorder.data ?? []) {
    notes.push({
      id: `reorder-${r.project.id}`,
      dot: "warn",
      title: `${r.project.job_code}: ${r.total} unit${r.total > 1 ? "s" : ""} to reorder`,
      sub: "Damaged or missing — reorder to keep the crew moving",
      to: `/projects/${r.project.id}?tab=warehouse`,
    });
  }

  const conflictPeople = new Set((conflicts.data ?? []).map((c) => c.profileId)).size;
  if (conflictPeople > 0) {
    notes.push({
      id: "schedule-conflicts",
      dot: "warn",
      title: `${conflictPeople} crew double-booked`,
      sub: "Overlapping schedule assignments — resolve before publishing",
      to: "/scheduling",
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
