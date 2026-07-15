import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";

const GITHUB_TOKEN = Deno.env.get("GITHUB_VAULT_TOKEN") ?? "";
const GITHUB_REPO = Deno.env.get("GITHUB_VAULT_REPO") ?? "taylorhorizon/window-ops-app";
const GITHUB_BRANCH = Deno.env.get("GITHUB_VAULT_BRANCH") ?? "master";

function encodeBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

async function commitFile(path: string, content: string, message: string) {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_VAULT_TOKEN secret is not set");
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const existing = await fetch(`${api}?ref=${GITHUB_BRANCH}`, { headers });
  let sha: string | undefined;
  if (existing.status === 200) {
    const body = await existing.json();
    sha = body.sha;
  }
  const res = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: encodeBase64(content),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub commit failed: ${res.status} ${await res.text()}`);
  }
  return path;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [windows, counts, projects] = await Promise.all([
      supabase
        .from("windows")
        .select(
          "window_id, status, received_at, window_types(type_code, name), locations(address), projects(job_code)",
        ),
      supabase
        .from("cycle_counts")
        .select("*, locations(address)")
        .gte("started_at", new Date(Date.now() - 7 * 864e5).toISOString()),
      supabase
        .from("projects")
        .select("id, job_code, name, project_windows(quantity, window_type_id)")
        .eq("status", "active"),
    ]);

    for (const r of [windows, counts, projects]) {
      if (r.error) throw r.error;
    }

    const units = windows.data ?? [];
    const inbound = units.filter((w) => w.status === "inbound");
    const damaged = units.filter((w) => w.status === "damaged");
    const staleCutoff = Date.now() - 90 * 864e5;
    const stale = units.filter(
      (w) =>
        w.status === "in_warehouse" &&
        !w.projects &&
        new Date(w.received_at).getTime() < staleCutoff,
    );

    const discrepancies = (counts.data ?? []).flatMap((c) =>
      ((c.discrepancies as { window_id?: string; issue?: string }[]) ?? []).map(
        (d) => ({ ...d, address: c.locations?.address }),
      ),
    );

    const shortJobs = (projects.data ?? [])
      .map((p) => {
        const needed = (p.project_windows ?? []).reduce(
          (s: number, n: { quantity: number }) => s + n.quantity,
          0,
        );
        const have = units.filter(
          (w) => w.projects?.job_code === p.job_code && w.status !== "installed",
        ).length;
        const installed = units.filter(
          (w) => w.projects?.job_code === p.job_code && w.status === "installed",
        ).length;
        return { job: p.job_code, name: p.name, needed, have, installed };
      })
      .filter((j) => j.have + j.installed < j.needed);

    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      `# Warehouse report — ${today}`,
      "",
      `- Windows on hand: ${units.filter((w) => !["installed", "loaded"].includes(w.status)).length}`,
      `- Awaiting putaway: ${inbound.length}`,
      `- Damaged/hold: ${damaged.length}`,
      `- Cycle counts this week: ${(counts.data ?? []).length} (${discrepancies.length} discrepancies)`,
      "",
      "## Needs attention",
      "",
    ];

    if (inbound.length) {
      lines.push("### Windows never put away");
      for (const w of inbound) {
        lines.push(`- ${w.window_id} (${w.window_types?.name})`);
      }
      lines.push("");
    }
    if (discrepancies.length) {
      lines.push("### Cycle count discrepancies");
      for (const d of discrepancies) {
        lines.push(`- ${d.window_id}: ${d.issue} at ${d.address}`);
      }
      lines.push("");
    }
    if (shortJobs.length) {
      lines.push("### Jobs short on windows");
      for (const j of shortJobs) {
        lines.push(
          `- ${j.job}: has ${j.have + j.installed}/${j.needed} (${j.name})`,
        );
      }
      lines.push("");
    }
    if (stale.length) {
      lines.push("### Stale stock (unassigned > 90 days)");
      for (const w of stale) {
        lines.push(
          `- ${w.window_id} at ${w.locations?.address ?? "?"} since ${w.received_at.slice(0, 10)}`,
        );
      }
      lines.push("");
    }
    if (
      !inbound.length &&
      !discrepancies.length &&
      !shortJobs.length &&
      !stale.length
    ) {
      lines.push("Nothing. Warehouse is clean.");
    }

    const path = `vault/reports/warehouse-${today}.md`;
    await commitFile(path, lines.join("\n") + "\n", `vault: weekly report ${today}`);

    return jsonResponse({ ok: true, path }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
