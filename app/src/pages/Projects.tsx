import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { createProject, listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { supabase } from "../lib/supabase";
import { useUnreadCounts } from "../lib/chat/useUnreadCounts";
import { IncomingMondayJobs } from "../components/projects/IncomingMondayJobs";
import { MessagesSquare } from "lucide-react";

interface OpeningCountRow {
  project_id: string;
  status: "planned" | "assigned" | "installed";
}

export function Projects() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [jobCode, setJobCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [unitNumber, setUnitNumber] = useState("");
  const [siteState, setSiteState] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const unread = useUnreadCounts();
  const profile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const canAdd = isForemanPlus(profile.data?.role);
  const counts = useQuery({
    queryKey: ["openingCounts"],
    // NOTE: this pulls every opening row for every job with no limit or
    // pagination. It works today but won't scale forever — the real fix is
    // a server-side aggregate (counts grouped by project), not a client
    // filter over the whole table. Deferred on purpose; flagging so the
    // next reader doesn't think it was missed.
    queryFn: async (): Promise<OpeningCountRow[]> => {
      const { data, error } = await supabase
        .from("project_openings")
        .select("project_id, status");
      if (error) throw error;
      return data;
    },
  });
  const addProject = useMutation({
    mutationFn: () =>
      createProject({
        jobCode,
        name,
        address,
        customerName,
        contactPhone,
        contactEmail,
        unitNumber,
        siteState,
        startDate,
        endDate,
        notes,
      }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setAdding(false);
      setJobCode("");
      setName("");
      setAddress("");
      setCustomerName("");
      setContactPhone("");
      setContactEmail("");
      setUnitNumber("");
      setSiteState("");
      setStartDate("");
      setEndDate("");
      setNotes("");
      navigate(`/projects/${project.id}/upload`);
    },
  });

  const countFor = (projectId: string) => {
    const rows = (counts.data ?? []).filter((r) => r.project_id === projectId);
    const total = rows.length;
    const installed = rows.filter((r) => r.status === "installed").length;
    const pct = total > 0 ? Math.round((installed / total) * 100) : 0;
    return { total, installed, pct };
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Jobs</p>
          <h1>Active projects</h1>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>
      {/* Supervisors wrap jobs up from the job's own page; this is where
          they land afterwards (owner ask, 2026-08-26). */}
      {canAdd && (
        <p style={{ margin: "0 0 4px" }}>
          <Link to="/jobs/history" className="link">
            Job history →
          </Link>
        </p>
      )}
      <p className="muted">
        One hub per job — warehouse pick list, opening map, and type brain.
      </p>
      {canAdd && <IncomingMondayJobs />}
      {canAdd && (
        <div className="project-create">
          {!adding ? (
            <button type="button" className="action-btn primary" onClick={() => setAdding(true)}>
              + New project
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addProject.mutate();
              }}
            >
              <div className="row-between">
                <h2>New project</h2>
                <button type="button" className="link" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
              <div className="project-create-grid">
                <label>
                  <span className="field-label">Job code</span>
                  <input
                    value={jobCode}
                    onChange={(e) => setJobCode(e.target.value)}
                    placeholder="PECAN14"
                    autoCapitalize="characters"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Project name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Pecan Valley Town Homes — Building 14"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Customer / contact</span>
                  <input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Pecan Valley HOA · Jane Doe"
                  />
                </label>
                <label>
                  <span className="field-label">Contact phone</span>
                  <input
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="(435) 555-0173"
                  />
                </label>
                <label>
                  <span className="field-label">Contact email</span>
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="office@pecanvalley.com"
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">Site address</span>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="173 Pecan Valley Dr, Hurricane, UT 84737"
                  />
                </label>
                <label>
                  <span className="field-label">Building / unit / lot</span>
                  <input
                    value={unitNumber}
                    onChange={(e) => setUnitNumber(e.target.value)}
                    placeholder="Building 14 · Lots 173–183"
                  />
                </label>
                <label>
                  <span className="field-label">State</span>
                  <input
                    value={siteState}
                    onChange={(e) => setSiteState(e.target.value)}
                    placeholder="UT"
                    maxLength={2}
                    autoCapitalize="characters"
                  />
                </label>
                <label>
                  <span className="field-label">Scheduled start</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </label>
                <label>
                  <span className="field-label">Target completion</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">Job notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Access, gate codes, staging area, scope reminders…"
                    rows={3}
                  />
                </label>
              </div>
              {addProject.isError && <p className="error">{formatApiError(addProject.error)}</p>}
              <button
                type="submit"
                className="action-btn primary"
                disabled={addProject.isPending || !jobCode.trim() || !name.trim()}
              >
                {addProject.isPending ? "Creating…" : "Create project and add PDFs"}
              </button>
            </form>
          )}
        </div>
      )}
      <div className="home-projects">
        {projects.isLoading && <SkeletonList rows={4} />}
        {projects.isError && (
          <QueryError
            error={projects.error}
            onRetry={() => void projects.refetch()}
            label="Couldn't load jobs"
          />
        )}
        {/* If the counts query fails, countFor() quietly falls back to an empty
            list and every card would show "0 openings / 0 done" — identical to
            a job nobody has touched. Say so plainly instead of going silent,
            so a broken read is never mistaken for no work done. */}
        {!projects.isLoading && !projects.isError && counts.isError && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Progress unavailable — job list below is current, but "openings done" counts couldn't load.
          </p>
        )}
        {!projects.isLoading &&
          !projects.isError &&
          (projects.data ?? []).map((p) => {
          const c = countFor(p.id);
          const chatUnread = unread.data?.[p.id] ?? 0;
          const pctColor =
            c.pct >= 80 ? "var(--ok)" : c.pct >= 40 ? "var(--accent)" : "var(--warn)";
          return (
            <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project">
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.name || p.job_code}
                    </span>
                    {chatUnread > 0 && (
                      <span className="chat-badge" title={`${chatUnread} unread message${chatUnread > 1 ? "s" : ""}`}>
                        <MessagesSquare size={11} aria-hidden />
                        {chatUnread}
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.job_code}
                    {p.address ? ` · ${p.address}` : ""}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: 15,
                    color: c.total > 0 ? pctColor : "var(--muted)",
                    flex: "none",
                  }}
                >
                  {c.total > 0 ? `${c.pct}%` : "—"}
                </span>
              </div>
              {c.total > 0 && (
                <div className="points-tier-bar" aria-hidden>
                  <div
                    className="points-tier-fill"
                    style={{ width: `${c.pct}%`, background: pctColor }}
                  />
                </div>
              )}
              <div className="home-project-meta">
                <span>
                  <i className="dot-info" /> {c.total} openings
                </span>
                <span>
                  <i className="dot-ok" /> {c.installed} done
                </span>
              </div>
            </Link>
          );
        })}
        {!projects.isLoading && !projects.isError && projects.data?.length === 0 && (
          <EmptyState
            icon={<LayoutGrid size={22} />}
            title="No active jobs yet"
            message={
              canAdd
                ? "Create your first job to start tracking installs, photos, and time."
                : "Jobs will show up here once your office adds them."
            }
          />
        )}
      </div>
    </div>
  );
}
