// Post-deploy smoke for Forge AI field operations — sandbox only.
//
// Signs in as the authorised TEST FOREMAN, refuses to continue unless that
// login is a test profile and the named job is the automation sandbox, then
// checks the deployed contract. The default creates only synthetic AI audit
// messages/receipts; no job, unit, timer or payroll changes. `--write` adds one
// idempotent sandbox unit (label AI-SMOKE-1). It never creates a job (that
// would notify real supervisors), never touches payroll, never starts a timer.
// One default run makes ONE paid Ask call; `--no-ask` skips it.
// Never prints keys, tokens or passwords.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… FORGE_SMOKE_EMAIL=… FORGE_SMOKE_PASSWORD=… \
//   FORGE_SANDBOX_PROJECT_ID=… node scripts/smoke-ai-field-sandbox.mjs [--write] [--no-ask]
// (Resolve @supabase/supabase-js from app/node_modules, e.g. `ln -sfn app/node_modules node_modules`.)
import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is required.`); process.exit(2); } return v; };
const url = need("SUPABASE_URL"), anon = need("SUPABASE_ANON_KEY"), email = need("FORGE_SMOKE_EMAIL"), password = need("FORGE_SMOKE_PASSWORD");
const sandbox = need("FORGE_SANDBOX_PROJECT_ID");
const write = process.argv.includes("--write"), ask = !process.argv.includes("--no-ask");
const uuidFrom = (s) => { const h = createHash("sha256").update(s).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`ok  ${msg}`); };

const { data: auth, error: authError } = await sb.auth.signInWithPassword({ email, password });
if (authError || !auth.user) { console.error("Sign-in failed."); process.exit(1); }
const me = auth.user.id;
try {
  // Guard rails first: never run against a real person or a real job.
  const { data: profile } = await sb.from("profiles").select("id,role,is_test").eq("id", me).single();
  ok(profile?.is_test === true, "signed in as a test profile");
  ok(["foreman", "supervisor", "owner"].includes(profile?.role), "test login is foreman or above");
  const { data: fenced } = await sb.rpc("is_sandbox_project", { p_project_id: sandbox });
  ok(fenced === true, "named job is the automation sandbox");

  // Read contract.
  const { data: version, error: vErr } = await sb.rpc("ai_field_clock_version");
  ok(!vErr && Number.isSafeInteger(version?.epoch), "ai_field_clock_version returns an epoch");
  const { data: ctx, error: cErr } = await sb.rpc("ai_field_context", { p_job: sandbox, p_search: "" });
  ok(!cErr && ctx?.job?.id === sandbox, "ai_field_context reads the sandbox job");
  ok(Array.isArray(ctx?.units) && typeof ctx?.unit_counts?.total === "number", "units and whole-job counts present");
  const { data: jobs } = await sb.rpc("ai_field_context", { p_job: null, p_search: "" });
  ok((jobs?.jobs ?? []).every((j) => j.id === sandbox), "test login sees only the sandbox job");

  // Fence: a test login cannot create a real job (and so notifies nobody).
  const rid = crypto.randomUUID();
  const begun = await sb.rpc("ai_field_begin", { p_id: rid, p_input_kind: "text", p_transcript: "smoke: create job (must refuse)", p_sent_at: new Date().toISOString(), p_expected_epoch: version.epoch, p_audio_path: null, p_client: {} });
  ok(!begun.error, "ai_field_begin accepts a text request");
  const job = await sb.rpc("ai_field_command", { p_request: rid, p_key: "job:smoke", p_action: "create_job", p_data: { name: "AI smoke job", location: "Nowhere 1" } });
  ok(!!job.error, "test login cannot create a job");

  if (write) {
    // One request per day; the unit itself is found by its label, so repeated
    // runs reuse AI-SMOKE-1 instead of making another.
    const wid = uuidFrom(`ai-smoke-unit:${me}:${sandbox}:${new Date().toISOString().slice(0, 10)}`);
    const sentAt = new Date().toISOString();
    const wb = await sb.rpc("ai_field_begin", { p_id: wid, p_input_kind: "text", p_transcript: "smoke: sandbox unit AI-SMOKE-1", p_sent_at: sentAt, p_expected_epoch: null, p_audio_path: null, p_client: {} });
    if (wb.error) {
      console.log("Today's smoke unit request already exists; skipping the write.");
    } else {
      const unit = await sb.rpc("ai_field_command", { p_request: wid, p_key: "unit:smoke", p_action: "save_unit", p_data: { project_id: sandbox, unit_id: null, opening_id: null, label: "AI-SMOKE-1", type_label: "Fixed window", facts: { material: "Aluminum" } } });
      ok(!unit.error && ["created", "unchanged", "details_added"].includes(unit.data?.outcome), "sandbox unit AI-SMOKE-1 saved or reused");
    }
  }

  if (ask) {
    const request = crypto.randomUUID();
    const { data, error } = await sb.functions.invoke("ask", {
      body: { question: "What units are on my job?", history: [], timeZone: "America/Denver",
        field: { actor_id: me, request_id: request, conversation_id: crypto.randomUUID(), input_kind: "text", sent_at: new Date().toISOString(), clock_version: version.epoch, clock_pending_sync: false, audio_path: null } },
    });
    ok(!error && typeof data?.answer === "string" && data.answer.length > 0, "Ask answered");
    ok(data?.field?.request_id === request, "Ask returned the field request id");
    ok((data?.field?.receipts ?? []).every((r) => !["create_job", "start_unit", "start_idle", "stop_work", "crew_record"].includes(r.action)), "a question changed nothing");
    // Actor binding: a message naming another account is refused before anything is saved.
    const other = await sb.functions.invoke("ask", { body: { question: "What units are on my job?", history: [], field: { actor_id: crypto.randomUUID(), request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), input_kind: "text", sent_at: new Date().toISOString(), clock_version: version.epoch, clock_pending_sync: false, audio_path: null } } });
    ok(!!other.error, "a message captured under another account is refused");
  }
  console.log(`${passed} sandbox smoke checks passed.${write ? "" : " (read-only)"}${ask ? " One paid Ask call was made." : ""}`);
} finally {
  await sb.auth.signOut();
}
