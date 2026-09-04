import { BackChip } from "../components/BackChip";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Settings2, X } from "lucide-react";
import {
  dismissKeys,
  fingerprint,
  listDismissedKeys,
} from "../lib/notificationDismissals";
import { notifyLocal } from "../lib/permissions/notifyLocal";
import {
  getMyProfile,
  listAccessRequests,
  listMemosToConfirm,
} from "../lib/install/api";
import { listInstalledForQc } from "../lib/ops";
import { listMyTimecardEdits, listShiftsToApprove } from "../lib/timeclock";
import { isSupervisorPlus, isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listProjects, listReorderNeeds } from "../lib/api";
import { listVehicles } from "../lib/vehicles/api";
import { serviceBadge } from "../lib/vehicles/service";
import { vehicleTitle } from "../lib/vehicles/display";
import { listAssignments, horizonRange, listMyPublished } from "../lib/schedule/api";
import { conflictBannerEntries } from "../lib/schedule/conflicts";
import { addDaysISO } from "../lib/schedule/dates";
import { buildPublishDigests, digestMessage } from "../lib/schedule/notify";
import { listTrips } from "../lib/travel/api";
import { tripPublishMessage } from "../lib/travel/notify";
import { tripPhase } from "../lib/travel/status";
import { listMyMentions } from "../lib/chat/api";
import { useT } from "../lib/i18n";

interface Note {
  id: string;
  dot: "info" | "ok" | "warn";
  title: string;
  sub: string;
  to: string;
  /**
   * Content fingerprint. id+fp is the dismissal key: clearing hides THIS
   * occurrence for good, while new content (new punches, a changed badge)
   * mints a new key and the row comes back.
   */
  fp?: string;
}

/** id + content fingerprint — the durable dismissal identity of a row. */
function noteKey(n: Note): string {
  return n.fp ? `${n.id}::${n.fp}` : n.id;
}

export function Notifications() {
  const qcClient = useQueryClient();
  const t = useT();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const admin = isSupervisorPlus(effectiveRole);
  const id = me.data?.id;
  const todayISO = new Date().toISOString().slice(0, 10);

  const memos = useQuery({
    queryKey: ["memosToConfirm", id],
    queryFn: () => listMemosToConfirm(id!),
    enabled: Boolean(id),
  });
  // @-mentions are the durable in-app signal for everyone — supervisors/owners
  // only get pushed on a mention, so this is where they see them. All roles.
  const mentions = useQuery({
    queryKey: ["chatMentions", id],
    queryFn: () => listMyMentions(),
    enabled: Boolean(id),
  });
  // Publish digests are the durable in-app echo of the schedule/travel pushes:
  // the field crew who were scheduled or booked on a trip. Batched (one row for
  // the whole schedule; one per trip) to mirror the push behaviour, never a row
  // per edit. Recipients follow the same crew-membership rule the pushes use.
  const scheduleTo = addDaysISO(todayISO, 42);
  const myPublished = useQuery({
    queryKey: ["mySchedule", id, todayISO, scheduleTo],
    queryFn: () => listMyPublished(id!, todayISO, scheduleTo),
    enabled: Boolean(id),
  });
  const trips = useQuery({
    queryKey: ["trips"],
    queryFn: listTrips,
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
  // K4: changes SOMEBODY ELSE made to my own punches, last 30 days. Every
  // role — this is the one notification that is about a person's own pay.
  const myEditsSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const myTimecardEdits = useQuery({
    queryKey: ["myTimecardEdits", id],
    queryFn: () => listMyTimecardEdits(id!, myEditsSince),
    enabled: Boolean(id),
  });

  // Supervisor+ only: surface signals already computed elsewhere so the office
  // sees fleet, warehouse and scheduling problems without hunting for them.
  // Each query degrades to an empty list on error (React Query catches throws)
  // so a single failing source never blanks the page.
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

  for (const item of mentions.data ?? []) {
    const author = item.message.author_name ?? "Someone";
    const body = item.message.body.trim();
    const snippet = body.length > 90 ? `${body.slice(0, 89)}…` : body;
    notes.push({
      id: `mention-${item.message.id}`,
      dot: "info",
      title: `${author} mentioned you · ${item.jobLabel}`,
      sub: snippet || "Open the job chat",
      to: `/projects/${item.projectId}?tab=chat`,
    });
  }

  // One batched row for the whole published schedule (mirrors the digest push),
  // built from the same per-person publish digest the push uses.
  if (id && (myPublished.data ?? []).length > 0) {
    const digest = buildPublishDigests(myPublished.data ?? []).find(
      (d) => d.profileId === id,
    );
    if (digest && digest.assignmentIds.length > 0) {
      const msg = digestMessage(digest.assignmentIds.length);
      notes.push({
        id: "schedule-published",
        dot: "info",
        title: msg.title,
        sub: msg.body,
        to: "/my-schedule",
        fp: fingerprint([...digest.assignmentIds].sort()),
      });
    }
  }

  // One row per published trip the viewer is crew on (mirrors the per-trip push;
  // skip past trips). Recipient rule matches how the travel push picks crew.
  for (const t of trips.data ?? []) {
    if (t.status !== "published") continue;
    if (!id || !t.crew.some((c) => c.profile_id === id)) continue;
    if (tripPhase(t.start_date, t.end_date, todayISO) === "past") continue;
    const msg = tripPublishMessage(t.destination || t.name);
    notes.push({
      id: `trip-${t.id}`,
      dot: "info",
      title: msg.title,
      sub: msg.body,
      to: `/travel/${t.id}`,
      fp: fingerprint([t.start_date ?? "", t.end_date ?? ""]),
    });
  }

  // One line, however many edits — the same batching the schedule digest uses.
  // Keyed by the edit ids, so a NEW change after this was cleared shows up
  // again instead of staying hidden behind an old dismissal.
  const editRows = myTimecardEdits.data ?? [];
  if (editRows.length > 0) {
    notes.push({
      id: "timecard-edits",
      dot: "warn",
      title: t("notif.timecardChanged.title"),
      sub:
        editRows.length === 1
          ? t("notif.timecardChanged.subOne")
          : t("notif.timecardChanged.subMany", { count: editRows.length }),
      to: "/timecard",
      fp: fingerprint(editRows.map((e) => e.id).sort()),
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
      fp: fingerprint(pendingQc.map((r) => r.id).sort()),
    });
  }

  if ((shifts.data ?? []).length > 0) {
    notes.push({
      id: "shifts",
      dot: "warn",
      title: `${shifts.data!.length} timecard${shifts.data!.length > 1 ? "s" : ""} to approve`,
      sub: "Review submitted shifts",
      to: "/team-timecards",
      fp: fingerprint(shifts.data!.map((r) => r.id).sort()),
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
      fp: fingerprint(pendingReq.map((r) => r.id).sort()),
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
      fp: fingerprint([badge.label]),
    });
  }

  for (const r of reorder.data ?? []) {
    notes.push({
      id: `reorder-${r.project.id}`,
      dot: "warn",
      title: `${r.project.job_code}: ${r.total} unit${r.total > 1 ? "s" : ""} to reorder`,
      sub: "Damaged or missing — reorder to keep the crew moving",
      to: `/projects/${r.project.id}?tab=warehouse`,
      fp: fingerprint([r.total]),
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
      fp: fingerprint([...new Set((conflicts.data ?? []).map((c) => c.profileId))].sort()),
    });
  }

  // Seen-once-then-gone (owner call, 2026-08-11): rows the person cleared
  // stay cleared — per person, server-stored, keyed by content so a NEW
  // occurrence still shows up.
  const dismissed = useQuery({
    queryKey: ["notifDismissed", id],
    queryFn: () => listDismissedKeys(id!),
    enabled: Boolean(id),
  });
  const dismiss = useMutation({
    mutationFn: (keys: string[]) => dismissKeys(id!, keys),
    onSuccess: () => void qcClient.invalidateQueries({ queryKey: ["notifDismissed", id] }),
  });
  const visible = notes.filter((n) => !(dismissed.data?.has(noteKey(n)) ?? false));

  // Local-notification seam: mirror the in-app "what needs you" list to a device
  // notification. No-op unless the user granted notifications; deduped by tag so
  // each distinct item only pings once per session. This is a real client-side
  // hook (no server events) — when web push lands it will deliver the same
  // {title, body, tag, url} shape from the server instead. See notifyLocal.ts.
  const noteSignature = visible.map((n) => n.id).join("|");
  useEffect(() => {
    for (const n of visible) {
      void notifyLocal({ title: n.title, body: n.sub, tag: `needs-you-${n.id}`, url: n.to });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteSignature]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Notifications</p>
          <h1>What needs you</h1>
        </div>
        <BackChip label="Back" />
      </header>

      <Link to="/settings" className="notif-settings-link">
        <Settings2 size={16} aria-hidden />
        <span>Notifications &amp; location settings</span>
        <span className="muted" aria-hidden>›</span>
      </Link>

      {visible.length > 0 && (
        <div className="row-gap" style={{ justifyContent: "flex-end", marginBottom: 6 }}>
          <button
            className="button-like"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate(visible.map(noteKey))}
          >
            {dismiss.isPending ? "Clearing…" : "Clear all"}
          </button>
        </div>
      )}
      {visible.length === 0 ? (
        <p className="muted">You're all caught up.</p>
      ) : (
        <div className="notif-list">
          {visible.map((n) => (
            <Link key={n.id} to={n.to} className="notif-row">
              <i className={n.dot === "ok" ? "dot-ok" : n.dot === "warn" ? "dot-warn" : "dot-info"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{n.title}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{n.sub}</div>
              </div>
              <button
                type="button"
                className="notif-clear"
                aria-label={`Clear "${n.title}"`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dismiss.mutate([noteKey(n)]);
                }}
              >
                <X size={14} aria-hidden />
              </button>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
