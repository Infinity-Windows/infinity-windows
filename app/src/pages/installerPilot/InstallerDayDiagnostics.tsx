import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getRealProfile } from "../../lib/install/api";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/errors";

/** Development-only, authenticated Owner SELECTs. No work hook or write API. */
async function inspect() {
  const actor = await getRealProfile();
  if (actor?.role !== "owner") throw new Error("Owner access is required for this database inspection.");
  const results = await Promise.allSettled([
    supabase.from("projects").select("id,job_code,name,status,is_test,deleted_at,deleted_by,created_at", { count: "exact" }).order("job_code").range(0,499),
    supabase.from("profiles").select("id,display_name,role,is_test,retired_at,access_revoked_at").eq("is_test", true),
  ]);
  const labels = ["Projects including trash", "Test accounts"];
  const reads = results.map((result, i) => {
    if (result.status === "rejected") return { label: labels[i], error: formatApiError(result.reason), rows: [], count: null };
    const value = result.value;
    return { label: labels[i], error: value.error ? formatApiError(value.error) : null, rows: value.data ?? [], count: "count" in value ? value.count : null };
  });
  const projects = reads[0].rows as unknown as { id: string; job_code: string; name: string; status: string; is_test: boolean; deleted_at: string | null; deleted_by: string | null; created_at: string }[];
  const relevant = projects.filter(p => p.is_test || p.deleted_at || /zztest|automation|sandbox/i.test(`${p.job_code} ${p.name}`));
  const candidates = await Promise.all(relevant.filter(p => p.is_test && !p.deleted_at).map(async p => {
    const [sandbox, openings] = await Promise.all([
      supabase.rpc("is_sandbox_project", { p_project_id: p.id }),
      supabase.from("project_openings").select("id", { count: "exact", head: true }).eq("project_id", p.id),
    ]);
    return { project: p.job_code, sandbox: sandbox.error ? formatApiError(sandbox.error) : sandbox.data, openings: openings.error ? formatApiError(openings.error) : openings.count };
  }));
  return { checkedAt: new Date().toISOString(), projectRead: { ...reads[0], rows: undefined }, zztestMatches: projects.filter(p => /zztest/i.test(`${p.job_code} ${p.name}`)), relevantProjects: relevant, accounts: reads[1], candidates };
}

export function InstallerDayDiagnostics() {
  const result = useQuery({ queryKey: ["installerDayOwnerDiagnostics"], queryFn: inspect, retry: false });
  return <main className="page"><h1>ZZTEST · read-only database inspection</h1><p>Live Owner-authorized reads. Includes trash. No assignments, timers, account changes or project changes.</p><Link to="/installer-day">Back to walkthrough</Link>{result.error ? <p role="alert">{formatApiError(result.error)}</p> : result.data ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(result.data, null, 2)}</pre> : <p role="status">Reading project and test-account records…</p>}</main>;
}
