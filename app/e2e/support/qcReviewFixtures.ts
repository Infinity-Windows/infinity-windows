import type { Page } from "@playwright/test";
import { json } from "./specHelpers";

export interface QcFixtureOpening {
  id: string; project_id: string; opening_code: string;
  label?: string | null; assigned_window_id?: string | null; work_ended_at?: string | null;
  window_types?: { type_code?: string | null } | null;
  projects?: { job_code?: string | null; name?: string | null } | null;
  qc?: { status: string; note?: string | null } | null;
}

// Browser-side RPC replay. The database harness independently checks real SQL;
// these fixtures let browser tests observe selection, paging and retry behavior.
export async function installQcReviewFixtures(page: Page, openings: QcFixtureOpening[], onDecision?: () => void) {
  const units = openings.map((o, i) => ({
    id: o.id, projectId: o.project_id, openingCode: o.opening_code, label: o.label ?? null,
    assignedWindowId: o.assigned_window_id ?? null, typeCode: o.window_types?.type_code ?? null,
    workEndedAt: o.work_ended_at === undefined ? `2026-09-30T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` : o.work_ended_at,
    qcStatus: o.qc?.status ?? "pending", qcNote: o.qc?.note ?? null,
    reviewerId: null as string | null, reviewedAt: null as string | null,
    reviewVersion: o.qc ? `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` : "none",
    matchesFilter: true,
  }));
  const state = {
    failJobs: false, failQueue: false, failSave: false, loseNextReceipt: false, staleNextSave: false,
    jobsReads: [] as Record<string, unknown>[], reads: [] as Record<string, unknown>[], writes: [] as Record<string, unknown>[], commits: 0,
    units,
  };
  const receipts = new Map<string, { args: string; id: string }>();
  const failure = (route: Parameters<typeof json>[0], code = "503", message = "Could not find a function in schema cache: private_fixture_failure") =>
    route.fulfill({ status: code === "40001" ? 409 : 503, contentType: "application/json", body: JSON.stringify({ code, message }) });
  const cursor = (u: typeof units[number]) => ({ endedAt: u.workEndedAt, id: u.id });
  const ordered = (a: typeof units[number], b: typeof units[number]) => (a.workEndedAt ?? "~").localeCompare(b.workEndedAt ?? "~") || a.id.localeCompare(b.id);
  await page.route("**/rest/v1/rpc/qc_review_jobs", route => {
    const args = route.request().postDataJSON() ?? {};
    state.jobsReads.push(args);
    if (state.failJobs) return failure(route);
    const search = String(args.p_search ?? "").trim().toLowerCase();
    const eligibleJobs = [...new Set(openings.map(o => o.project_id))].map(id => {
      const o = openings.find(row => row.project_id === id)!;
      const own = units.filter(u => u.projectId === id);
      return { id, jobCode: o.projects?.job_code ?? "JOB", name: o.projects?.name ?? o.projects?.job_code ?? "Job",
        newCount: own.filter(u => u.qcStatus === "pending").length,
        callbackCount: own.filter(u => u.qcStatus === "callback").length,
        queueCount: own.filter(u => u.qcStatus !== "passed").length };
    });
    let jobs = eligibleJobs.filter(j => (j.name + " " + j.jobCode).toLowerCase().includes(search))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
    const totalCount = jobs.length;
    if (args.p_after) jobs = jobs.filter(j => j.name.toLowerCase() > args.p_after.name || (j.name.toLowerCase() === args.p_after.name && j.id > args.p_after.id));
    const limit = args.p_limit ?? 50;
    const rows = jobs.slice(0, limit);
    return json(route, { rows, totalCount, selected: eligibleJobs.find(j => j.id === args.p_selected_project_id) ?? null, hasMore: jobs.length > limit,
      nextCursor: jobs.length > limit && rows.length ? { name: rows.at(-1)!.name.toLowerCase(), id: rows.at(-1)!.id } : null });
  });
  await page.route("**/rest/v1/rpc/qc_review_page", route => {
    const args = route.request().postDataJSON() ?? {};
    state.reads.push(args);
    if (state.failQueue) return failure(route);
    const search = String(args.p_search ?? "").trim().toLowerCase();
    const matches = (u: typeof units[number]) => u.projectId === args.p_project_id && u.qcStatus !== "passed"
      && (args.p_filter !== "callbacks" || u.qcStatus === "callback")
      && (args.p_filter !== "new" || u.qcStatus === "pending")
      && (u.openingCode + " " + (u.label ?? "")).toLowerCase().includes(search);
    const all = units.filter(matches).sort(ordered);
    const offsetAfter = args.p_after ? all.findIndex(u => ordered(u, { ...u, workEndedAt: args.p_after.endedAt, id: args.p_after.id }) > 0) : 0;
    const endBefore = args.p_before ? all.findIndex(u => ordered(u, { ...u, workEndedAt: args.p_before.endedAt, id: args.p_before.id }) >= 0) : all.length;
    const limit = args.p_limit ?? 50;
    const start = args.p_before ? Math.max(0, (endBefore < 0 ? all.length : endBefore) - limit) : Math.max(0, offsetAfter < 0 ? all.length : offsetAfter);
    const rows = all.slice(start, args.p_before ? (endBefore < 0 ? all.length : endBefore) : start + limit);
    const selected = units.find(u => u.id === args.p_selected_opening_id && u.projectId === args.p_project_id);
    return json(route, { rows: rows.map(u => ({ ...u, matchesFilter: true })), totalCount: all.length,
      hasNext: start + rows.length < all.length, hasPrevious: start > 0,
      nextCursor: rows.length ? cursor(rows.at(-1)!) : null, previousCursor: rows.length ? cursor(rows[0]) : null,
      selected: selected ? { ...selected, matchesFilter: matches(selected) } : null });
  });
  await page.route("**/rest/v1/rpc/record_qc_review_decision", route => {
    const args = route.request().postDataJSON() ?? {};
    state.writes.push(args);
    const existing = receipts.get(args.p_decision_id);
    if (existing) return existing.args === JSON.stringify(args) ? json(route, existing.id) : failure(route, "23505", "request reused");
    if (state.failSave) return failure(route);
    const unit = units.find(u => u.id === args.p_opening_id && u.projectId === args.p_project_id);
    if (!unit) return failure(route, "22023", "unit unavailable");
    if (state.staleNextSave || unit.reviewVersion !== args.p_expected_review_version) {
      state.staleNextSave = false;
      unit.qcStatus = "callback";
      unit.reviewVersion = "30000000-0000-4000-8000-999999999998";
      return failure(route, "40001", "This QC review changed. Refresh the unit before deciding again.");
    }
    unit.qcStatus = args.p_status;
    unit.reviewVersion = `30000000-0000-4000-8000-${String(++state.commits + 1000).padStart(12, "0")}`;
    unit.reviewedAt = "2026-10-01T16:00:00.000Z";
    receipts.set(args.p_decision_id, { args: JSON.stringify(args), id: args.p_decision_id });
    onDecision?.();
    if (state.loseNextReceipt) { state.loseNextReceipt = false; return failure(route); }
    return json(route, args.p_decision_id);
  });
  return state;
}
