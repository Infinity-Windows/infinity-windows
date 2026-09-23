// Disposable SQL checks for the learning write-up and named review. No network,
// no production database: the real Hex-Portal and learning-review migrations over
// stubs of the platform (auth, storage, profiles, jobs, field requests).
//   PGLITE_MODULE=/path/to/pglite/dist/index.js node scripts/verify-hex-learning-review.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const arg = process.argv.find((a) => a.startsWith("--pglite="));
const { PGlite } = await import(arg?.slice(9) ?? process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
process.on("uncaughtException", (e) => { console.error("FAILED after [" + globalThis.lastCheck + "]:", e.message, e.actual !== undefined ? JSON.stringify({ actual: e.actual, expected: e.expected }) : ""); process.exit(1); });
const check = (name) => { globalThis.lastCheck = name; };
const db = new PGlite();
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon,service_role;
create table profiles(id uuid primary key,role text,display_name text not null,is_partner boolean default false,active boolean default true,retired_at timestamptz,access_revoked_at timestamptz,is_test boolean default false);
create table projects(id uuid primary key,job_code text,name text,deleted_at timestamptz,is_test boolean default false);
create table sandbox_projects(project_id uuid primary key);
create table custom_work_units(id uuid primary key,project_id uuid references projects on delete cascade,label text);
create table ai_field_requests(id uuid primary key,profile_id uuid not null references profiles on delete cascade,conversation_id uuid,input_kind text,transcript text,sent_at timestamptz default now(),audio_path text);
create table app_release_notes(id text primary key,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);
create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select on storage.objects to authenticated;
create function role_rank(p_role text) returns int language sql immutable as $$select case p_role when 'owner' then 3 when 'big_boss' then 3 when 'supervisor' then 2 when 'admin' then 2 when 'foreman' then 1 when 'lead' then 1 else 0 end$$;
create function my_role_rank() returns int language sql stable security definer as $$select role_rank((select role from profiles where id=auth.uid()))$$;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$select coalesce((select role in ('supervisor','owner','admin','big_boss') from profiles where id=p),false)$$;
create function custom_work_internal() returns boolean language sql stable security definer as $$select auth.uid() is not null and not is_partner_user() and exists(select 1 from profiles where id=auth.uid() and retired_at is null and access_revoked_at is null and role in ('installer','foreman','supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
-- Restated from 20261024000000_ai_field_operations.sql.
create function _ai_job_visible(p_job uuid, p_uid uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from projects p where p.id = p_job and p.deleted_at is null and (
    case when is_test_profile(p_uid) then is_sandbox_project(p.id) else not coalesce(p.is_test, false) or _is_supervisor(p_uid) end))$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
grant select on profiles,projects to authenticated;
`);
await db.exec(await migration("20261022000000_hex_portal_learning.sql"));
await db.exec(await migration("20261026000000_hex_learning_review.sql"));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), F = id(3), F2 = id(4), L = id(5), S = id(6), O = id(7), P = id(8), R = id(9), X = id(10), OFF = id(11), T = id(12), M1 = id(13), M2 = id(14), S2 = id(15);
for (const [who, role, name] of [[A, "installer", "Ana Author"], [B, "installer", "Ben Other"], [F, "foreman", "Frank Lopez"], [F2, "foreman", "Fay Second"],
  [L, "lead", "Lee Lead"], [S, "supervisor", "Sam Super"], [O, "owner", "Owen Owner"], [P, "foreman", "Pat Partner"], [R, "foreman", "Rae Retired"],
  [X, "foreman", "Rex Revoked"], [OFF, "foreman", "Olga Offsite"], [T, "foreman", "Test Foreman"], [M1, "supervisor", "Maria Diaz"], [M2, "foreman", "maria  diaz"], [S2, "admin", "Sue Second"]]) {
  await db.query("insert into profiles(id,role,display_name) values($1,$2,$3)", [who, role, name]);
}
await db.query("update profiles set is_partner=true where id=$1", [P]);
await db.query("update profiles set retired_at=now() where id=$1", [R]);
await db.query("update profiles set access_revoked_at=now() where id=$1", [X]);
await db.query("update profiles set active=false where id=$1", [OFF]);
await db.query("update profiles set is_test=true where id=$1", [T]);
const JOB = id(100), OTHERJOB = id(101), UNIT = id(200), FAR_UNIT = id(201);
await db.query("insert into projects(id,job_code,name) values($1,'DECK','Synthetic deck'),($2,'LODGE','Synthetic lodge')", [JOB, OTHERJOB]);
await db.query("insert into custom_work_units values($1,$2,'16'),($3,$4,'9')", [UNIT, JOB, FAR_UNIT, OTHERJOB]);
const REQ_A = id(300), REQ_B = id(301), REQ_A2 = id(302), REQ_A3 = id(303), REQ_A_ELSEWHERE = id(304), CONV_A = id(350), CONV_A_OTHER = id(351), CONV_B = id(352);
const memo = (who, req) => `${who}/${req}/memo.webm`;
const AUDIO_A = memo(A, REQ_A), AUDIO_B = memo(B, REQ_B), AUDIO_A2 = memo(A, REQ_A2), AUDIO_A3 = memo(A, REQ_A3), AUDIO_A_ELSEWHERE = memo(A, REQ_A_ELSEWHERE);
// Three voice answers in one Ask conversation build one write-up; a fourth from
// another conversation must never ride along.
for (const [req, who, conv, words, audio] of [[REQ_A, A, CONV_A, "Unit 16 sill pan leaked", AUDIO_A], [REQ_B, B, CONV_B, "Other words", AUDIO_B],
  [REQ_A2, A, CONV_A, "It cost about 45 minutes", AUDIO_A2], [REQ_A3, A, CONV_A, "Actually the lesson is fold the corner first", AUDIO_A3],
  [REQ_A_ELSEWHERE, A, CONV_A_OTHER, "Unrelated chat about lunch", AUDIO_A_ELSEWHERE]]) {
  await db.query("insert into ai_field_requests(id,profile_id,conversation_id,input_kind,transcript,audio_path) values($1,$2,$3,'voice',$4,$5)", [req, who, conv, words, audio]);
  await db.query("insert into storage.objects values('ai-field-memos',$1)", [audio]);
}
const contract = JSON.parse(await readFile(new URL("./fixtures/hex-learning-contract.json", import.meta.url), "utf8"));


async function as(who) { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [who === "service" ? "" : who ?? ""]); await db.exec(who === "service" ? "set role service_role" : who === "anon" ? "set role anon" : "set role authenticated"); }
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const val = async (sql, params) => Object.values(await one(sql, params))[0];
const raw = async (sql, params) => { await db.exec("reset role"); return val(sql, params); };
const count = async (sql, params) => Number(await raw(sql, params));
const CASE_A = id(400), CASE_B = id(401), CASE_S = id(402), REVIEW = id(500), REVIEW_S = id(510), REVIEW_B = id(520);
let n = 1000; const action = () => id(++n);
const complete = { issue: "Sill pan leaked at unit 16", what_happened: "Water tested after flashing; corner leaked", impact: "Re-flashed the sill", impact_minutes: 45, lesson_learned: "Check the corner fold before tape", preventive_action: "Add corner check to the flashing step" };
// Every mutation names the signed-in actor; `me` is set by as().
let me = null;
const login = async (who) => { me = who; await as(who); };
const save = (a, expected, content, extra = {}) => db.query("select hex_learning_save_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r",
  [extra.review ?? REVIEW, a, extra.case ?? CASE_A, expected, content === null ? null : JSON.stringify(content), extra.request ?? null, extra.unit ?? null, extra.via ?? "form", "actor" in extra ? extra.actor : me, extra.sources ?? null]).then((x) => x.rows[0].r);
const submit = (a, expected, reviewer, review = REVIEW, actor = me) => db.query("select hex_learning_submit($1,$2,$3,$4,$5) as r", [review, a, expected, reviewer, actor]).then((x) => x.rows[0].r);
const decide = (a, expected, decision, { note = "", oversight = false, to = null, review = REVIEW, actor = me } = {}) =>
  db.query("select hex_learning_decide($1,$2,$3,$4,$5,$6,$7,$8) as r", [review, a, expected, decision, note, oversight, to, actor]).then((x) => x.rows[0].r);
const reassign = (a, expected, reviewer, reason, review = REVIEW, actor = me) => db.query("select hex_learning_reassign($1,$2,$3,$4,$5,$6) as r", [review, a, expected, reviewer, reason, actor]).then((x) => x.rows[0].r);
const withdraw = (a, expected, reason, review = REVIEW, actor = me) => db.query("select hex_learning_withdraw($1,$2,$3,$4,$5) as r", [review, a, expected, reason, actor]).then((x) => x.rows[0].r);
const packet = (c, rev, ev) => db.query("select hex_portal_review_packet($1,$2,$3) as p", [c, rev, ev]).then((x) => x.rows[0].p);
const page = (project = JOB, { after = null, caseId = null, limit = 31 } = {}) => db.query("select hex_portal_approved_cases($1,$2,$3,$4) as p", [project, after, caseId, limit]).then((x) => x.rows[0].p);
const exported = async (project = JOB) => (await page(project)).items;
const recordDelivery = (args) => db.query("select hex_learning_record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9) as s",
  [args.caseId ?? CASE_A, args.revision, args.event, args.fingerprint, args.caller ?? A, args.outcome, args.receipt ?? null, args.at ?? null, args.error ?? null]).then((x) => x.rows[0].s);
const events = () => count("select count(*) from hex_learning_review_events where review_id=$1", [REVIEW]);

check("cases are saved as ordinary Hex-Portal evidence");
await login(A); await db.query("select hex_portal_save_case($1,$2,'16','What happened at unit 16?','Original Ask answer','[]')", [CASE_A, JOB]);
await login(B); await db.query("select hex_portal_save_case($1,$2,'','Other question','Other answer','[]')", [CASE_B, JOB]);
await login(S); await db.query("select hex_portal_save_case($1,$2,'','Supervisor question','Answer','[]')", [CASE_S, JOB]);

check("null and invalid inputs are refused on every public function");
await login(B);
await assert.rejects(db.query("select hex_learning_list(null)"), /Invalid list/, "NULL scope must not fall into oversight");
await assert.rejects(db.query("select hex_learning_list('everything')"), /Invalid list/);
await assert.rejects(db.query("select hex_learning_list('oversight')"), /oversight/);
await assert.rejects(db.query("select hex_learning_get(null)"), /unavailable/);
await assert.rejects(db.query("select hex_learning_reviewers(null,'x')"), /Invalid reviewer search/);
await assert.rejects(db.query("select hex_learning_reviewers($1,'x',null,null)", [JOB]), /Invalid reviewer search/);
await assert.rejects(db.query("select hex_learning_reviewers($1,'x',null,'approve')", [JOB]), /Invalid reviewer search/);
await login(A);
for (const bad of [[null, 0, complete], [action(), null, complete], [action(), 0, null]]) {
  await assert.rejects(bad[0] === null ? db.query("select hex_learning_save_draft($1,null,$2,0,$3,null,null,'form',$4)", [REVIEW, CASE_A, JSON.stringify(complete), A]) : save(bad[0], bad[1], bad[2]), /Invalid write-up/);
}
await assert.rejects(submit(action(), 1, null), /Choose who reviews/);
await assert.rejects(decide(action(), 1, null), /Invalid decision/);
await assert.rejects(reassign(action(), 1, null, "x"), /Invalid reassignment/);
await assert.rejects(withdraw(action(), null, "x"), /Invalid withdrawal/);
await assert.rejects(packet(null, 1, id(9)), /Invalid packet/);
await assert.rejects(packet(CASE_A, null, id(9)), /Invalid packet/);
await assert.rejects(packet(CASE_A, 1, null), /Invalid packet/);
await assert.rejects(db.query("select hex_portal_withdrawal_packet(null,$1)", [id(9)]), /Invalid withdrawal/);

check("actor binding: another or missing actor changes nothing");
await assert.rejects(save(action(), 0, complete, { actor: B }), /another sign-in/);
await assert.rejects(save(action(), 0, complete, { actor: null }), /another sign-in/);
assert.equal(await count("select count(*) from hex_learning_reviews"), 0);

check("draft: created, retried and replayed without a second history row");
await login(A);
const first = action();
let r = await save(first, 0, { issue: "Sill pan leaked", unknown: ["impact"] }, { request: REQ_A, unit: UNIT, via: "ask" });
assert.equal(r.state, "draft"); assert.equal(r.revision, 1); assert.deepEqual(r.missing, ["what_happened", "lesson_learned", "preventive_action"]);
assert.equal((await save(first, 0, { issue: "Sill pan leaked", unknown: ["impact"] }, { request: REQ_A, unit: UNIT, via: "ask" })).revision, 1);
assert.equal(await events(), 1);
await login(A);
await assert.rejects(save(first, 0, { issue: "Different words" }, { request: REQ_A, unit: UNIT }), /already used for something different/);
await assert.rejects(save(action(), 0, { issue: "Second tab" }), /changed on another screen/);
await assert.rejects(save(action(), 1, { issue: "Changed source" }, { request: REQ_B }), /cannot be changed/);
await assert.rejects(save(action(), 1, { issue: "Both", unknown: ["issue"] }), /both answered and Unknown/);
await assert.rejects(save(action(), 1, { issue: "x", payroll_hours: 3 }), /Unknown write-up field/);
await assert.rejects(save(action(), 1, { issue: "x", impact_minutes: 1.5 }), /whole numbers/);

check("source ownership: case, request and unit");
await login(B);
await assert.rejects(save(action(), 0, { issue: "Hijack" }, { review: id(501) }), /Only the person who saved this case/);
await assert.rejects(save(action(), 0, { issue: "Mine" }, { review: id(502), case: CASE_B, request: REQ_A }), /Only your own message/);
await assert.rejects(save(action(), 0, { issue: "Mine" }, { review: id(503), case: CASE_B, unit: FAR_UNIT }), /not on this job/);
await login(A);
await assert.rejects(save(action(), 0, { issue: "Two write-ups" }, { review: id(504) }), /already has a write-up/);

check("submit refuses missing headings");
await assert.rejects(submit(action(), 1, F), /Answer or mark Unknown: what_happened, lesson_learned, preventive_action/);

check("every contributing message is kept, same author and conversation only");
await assert.rejects(save(action(), 1, complete, { sources: [REQ_A, REQ_A_ELSEWHERE] }), /same Ask conversation/);
await assert.rejects(save(action(), 1, complete, { sources: [REQ_A, REQ_B] }), /your own messages/);
await assert.rejects(save(action(), 1, complete, { sources: [REQ_A, null] }), /Invalid message reference/);
r = await save(action(), 1, complete, { sources: [REQ_A, REQ_A2, REQ_A3] });
assert.equal(r.revision, 2); assert.deepEqual(r.missing, []);
assert.deepEqual(await raw("select source_request_ids from hex_learning_reviews where id=$1", [REVIEW]), [REQ_A, REQ_A2, REQ_A3]);
await login(A);
assert.equal((await save(action(), 2, complete, { sources: [REQ_A3] })).revision, 3, "a later save naming fewer keeps every earlier source");
assert.deepEqual(await raw("select source_request_ids from hex_learning_reviews where id=$1", [REVIEW]), [REQ_A, REQ_A2, REQ_A3]);
assert.equal(await count("select count(*) from ai_field_requests where profile_id=$1 and transcript in ('Unit 16 sill pan leaked','It cost about 45 minutes','Actually the lesson is fold the corner first')", [A]), 3, "original transcripts untouched");
await login(A);

check("reviewer candidates: exact names, aliases, access and minimal identity");
let found = await val("select hex_learning_reviewers($1,'  FRANK   lopez ')", [JOB]);
assert.equal(found.status, "exact"); assert.equal(found.match.id, F); assert.deepEqual(Object.keys(found.match).sort(), ["exact", "id", "name", "role"]);
found = await val("select hex_learning_reviewers($1,'maria diaz')", [JOB]);
assert.equal(found.status, "choose"); assert.equal(found.match, null); assert.equal(found.choices.filter((c) => c.exact).length, 2);
assert.equal((await val("select hex_learning_reviewers($1,'frank')", [JOB])).status, "choose");
assert.equal((await val("select hex_learning_reviewers($1,'nobody here')", [JOB])).status, "none");
const everyone = (await val("select hex_learning_reviewers($1,'')", [JOB])).choices.map((c) => c.id).sort();
assert.deepEqual(everyone, [F, F2, L, S, O, OFF, M1, M2, S2].sort(), "foremen, lead alias, supervisors, admin alias, owner and Off-today count; installers, partner, retired, revoked, test and self do not");
assert.equal((await val("select hex_learning_reviewers($1,'')", [JOB])).choices.find((c) => c.id === S2).role, "supervisor");

check("submit: exact eligible reviewer only");
for (const bad of [B, A, P, R, X, T]) await assert.rejects(submit(action(), 3, bad), /cannot review|own write-up/);
await assert.rejects(submit(action(), 2, F), /changed on another screen/);
const send = action();
r = await submit(send, 3, F);
assert.equal(r.state, "submitted"); assert.equal(r.revision, 4); assert.equal(r.reviewer.id, F); assert.equal(r.reviewer.can_approve, false);
assert.equal((await submit(send, 3, F)).revision, 4);
assert.equal(await events(), 4);

check("the named reviewer gets one in-app notice per submitted revision, and every contributing recording");
const waiting = async (who) => { await login(who); return (await val("select hex_learning_waiting()")).map((x) => `${x.id}@${x.revision}`); };
assert.deepEqual(await waiting(F), [`${REVIEW}@4`]);
await login(A); await submit(send, 3, F);
assert.deepEqual(await waiting(F), [`${REVIEW}@4`], "a retried send is the same notice");
assert.deepEqual(await waiting(F2), []); assert.deepEqual(await waiting(S), []);
const audioOf = async (who) => { await as(who); return (await db.query("select name from storage.objects order by name")).rows.map((x) => x.name); };
assert.deepEqual(await audioOf(F), [AUDIO_A, AUDIO_A2, AUDIO_A3].sort(), "all three contributing memos, not the unrelated conversation");
await login(F);
const fdetail = await val("select hex_learning_get($1)", [REVIEW]);
assert.deepEqual(fdetail.sources.map((x) => x.id), [REQ_A, REQ_A2, REQ_A3]);
assert.deepEqual(fdetail.sources.map((x) => x.transcript), ["Unit 16 sill pan leaked", "It cost about 45 minutes", "Actually the lesson is fold the corner first"]);
await login(A); await assert.rejects(save(action(), 4, complete), /sent for review/);

check("nothing unapproved is exported");
await login(S); assert.deepEqual(await exported(), []);
await login(A); await assert.rejects(exported(), /supervisor or owner/);
await login(S); await assert.rejects(exported(null), /Invalid export/);
for (const limit of [0, 32, null]) await assert.rejects(page(JOB, { limit }), /Invalid export/);
await assert.rejects(page(JOB, { after: CASE_A, caseId: CASE_A }), /Invalid export/);
assert.deepEqual(await page(JOB), { items: [], nextCursor: null });

check("a foreman reviews but never gives final approval");
await login(F);
await assert.rejects(decide(action(), 4, "approve"), /Only a supervisor or owner can approve/);
await assert.rejects(decide(action(), 4, "approve", { oversight: true }), /Only a supervisor or owner/);
await assert.rejects(decide(action(), 4, "forward", { to: B }), /Choose a current supervisor/);
await assert.rejects(decide(action(), 4, "forward", { to: A }), /Choose a current supervisor/);
await assert.rejects(decide(action(), 4, "forward", { to: F2 }), /Choose a current supervisor/);
await assert.rejects(decide(action(), 4, "forward", { to: null }), /Choose a current supervisor/);
await assert.rejects(decide(action(), 4, "approve", { actor: S }), /another sign-in/, "a supervisor's id under a foreman's session is refused");
const forwardFound = await val("select hex_learning_reviewers($1,'',$2,'forward')", [JOB, REVIEW]);
assert.ok(forwardFound.choices.every((c) => c.role !== "foreman") && forwardFound.choices.some((c) => c.id === S), "forward choices are supervisors and owners only");
await login(F2); await assert.rejects(decide(action(), 4, "request_changes", { note: "x" }), /not assigned to you/);
await login(F);
const fwd = action();
r = await decide(fwd, 4, "forward", { to: S, note: "Looks right; please approve" });
assert.equal(r.state, "submitted"); assert.equal(r.reviewer.id, S); assert.equal(r.revision, 5); assert.equal(r.reviewer.can_approve, true);
assert.equal((await decide(fwd, 4, "forward", { to: S, note: "Looks right; please approve" })).revision, 5, "forward retry is the same forward");
assert.equal((await val("select hex_learning_list('assigned')")).length, 1, "the forwarding foreman still sees how it ends");
assert.deepEqual(await waiting(F), [], "forwarded: the foreman's notice is gone");
assert.deepEqual(await waiting(S), [`${REVIEW}@5`], "the exact named supervisor is notified");

check("recording: only the current named reviewer gains a read, only of that recording");
const audio = async (who) => { await as(who); return (await db.query("select name from storage.objects order by name")).rows.map((x) => x.name); };
assert.deepEqual(await audio(F), [], "forwarded away: no recording");
assert.deepEqual(await audio(F2), []);
assert.deepEqual(await audio(B), [AUDIO_B]);
assert.deepEqual((await audio(S)).sort(), [AUDIO_A, AUDIO_B, AUDIO_A2, AUDIO_A3, AUDIO_A_ELSEWHERE].sort(), "supervisors already read every memo (unchanged)");

check("who may read");
await login(B); await assert.rejects(db.query("select hex_learning_get($1)", [REVIEW]), /unavailable/);
await login(F2); await assert.rejects(db.query("select hex_learning_get($1)", [REVIEW]), /unavailable/);
await login(S);
const detail = await val("select hex_learning_get($1)", [REVIEW]);
assert.deepEqual(detail.sources.map((x) => x.audio_path), [AUDIO_A, AUDIO_A2, AUDIO_A3]); assert.equal(detail.case.answer, "Original Ask answer"); assert.equal(detail.history.length, 5);
assert.equal(detail.viewer.is_reviewer, true); assert.equal(detail.viewer.can_approve, true); assert.equal(detail.last_note, "Looks right; please approve");
await login(F); assert.equal((await val("select hex_learning_get($1)", [REVIEW])).viewer.can_approve, false);
assert.equal((await db.query("select * from hex_portal_cases")).rows.length, 0, "case table RLS is not widened for foremen");
await login(P); await assert.rejects(db.query("select hex_learning_list('mine')"), /crew access/);

check("supervisor approval of the exact revision, pending delivery");
await login(S);
await assert.rejects(decide(action(), 4, "approve"), /changed on another screen/);
await db.exec("reset role"); await db.query("update profiles set role='foreman' where id=$1", [S]);
await login(S); await assert.rejects(decide(action(), 5, "approve"), /Only a supervisor or owner can approve/, "a demoted supervisor cannot approve");
await db.exec("reset role"); await db.query("update profiles set role='supervisor' where id=$1", [S]);
await login(S);
r = await decide(action(), 5, "approve");
assert.equal(r.state, "approved"); assert.equal(r.approved_revision, 6); assert.equal(r.delivery.status, "pending"); assert.equal(r.delivery.receipt_id, null);
const approval = r.approval_event_id;
await login(S2); await assert.rejects(decide(action(), 6, "approve", { oversight: true }), /waiting for review/, "one approval, no competing second");
assert.equal(await count("select count(*) from hex_learning_deliveries"), 1);
await db.exec("reset role"); const history = (await db.query("select action from hex_learning_review_events where review_id=$1 order by revision", [REVIEW])).rows.map((x) => x.action);
assert.deepEqual(history, ["draft_saved", "draft_saved", "draft_saved", "submitted", "forwarded", "approved"]);
assert.equal(approval, await raw("select id from hex_learning_review_events where review_id=$1 and revision=6", [REVIEW]));

check("the review packet: exact approval, current authorised caller, stable fingerprint");
await login(A);
const pa = await packet(CASE_A, 6, approval);
assert.deepEqual(Object.keys(pa).sort(), Object.keys(contract.reviewPacket).sort(), "the SQL packet has exactly the pinned contract keys");
assert.deepEqual(Object.keys(pa.sections).sort(), Object.keys(contract.reviewPacket.sections).sort());
assert.deepEqual(pa.selfReportedImpact, { minutes: 45, costCents: null }); assert.deepEqual(pa.unknownFields, []); assert.equal(pa.unitLabel, "16");
assert.equal(pa.reviewerRole, "supervisor");
assert.equal(pa.callerId, A); assert.equal(pa.deliveryAuthorized, true); assert.equal(pa.reviewerId, S); assert.equal(pa.status, "approved");
assert.match(pa.revisionFingerprint, /^[0-9a-f]{64}$/);
assert.deepEqual(pa.sections, { issue: complete.issue, whatHappened: complete.what_happened, impact: complete.impact, lessonLearned: complete.lesson_learned, preventiveAction: complete.preventive_action });
assert.ok(!JSON.stringify(pa).includes("memo.webm") && !JSON.stringify(pa).includes("Original Ask answer") && !JSON.stringify(pa).includes("Ana Author"), "no recording, source answer or names");
await login(F); const pf = await packet(CASE_A, 6, approval); assert.equal(pf.callerId, F); assert.equal(pf.revisionFingerprint, pa.revisionFingerprint, "fingerprint excludes the caller");
await login(S2); assert.equal((await packet(CASE_A, 6, approval)).revisionFingerprint, pa.revisionFingerprint);
await login(F2); await assert.rejects(packet(CASE_A, 6, approval), /unavailable to you/);
await login(B); await assert.rejects(packet(CASE_A, 6, approval), /unavailable to you/);
await login(A); await assert.rejects(packet(CASE_A, 5, approval), /not current/); await assert.rejects(packet(CASE_A, 6, id(999)), /not current/);
await as("anon"); await assert.rejects(packet(CASE_A, 6, approval), /permission denied/);
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=now() where id=$1", [A]);
await login(A); await assert.rejects(packet(CASE_A, 6, approval), /crew access/, "revoked caller");
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id=$1", [A]);
await db.exec("reset role"); await db.query("update profiles set retired_at=now() where id=$1", [S]);
await login(A); await assert.rejects(packet(CASE_A, 6, approval), /not current/, "retired approver voids the packet");
await login(S2); assert.deepEqual(await exported(), [], "and the export");
await db.exec("reset role"); await db.query("update profiles set retired_at=null where id=$1", [S]);
await login(S2); const ex = await exported(); assert.equal(ex.length, 1); assert.equal(ex[0].revisionFingerprint, pa.revisionFingerprint); assert.equal(ex[0].callerId, S2);

check("delivery is recorded only from an exact receipt, by the service");
await login(A); await assert.rejects(recordDelivery({ revision: 6, event: approval, fingerprint: pa.revisionFingerprint, outcome: "delivered", receipt: "x", at: new Date().toISOString() }), /permission denied/);
await as("service");
const base = { revision: 6, event: approval, fingerprint: pa.revisionFingerprint };
await assert.rejects(recordDelivery({ ...base, fingerprint: "0".repeat(64), outcome: "delivered", receipt: "r", at: new Date().toISOString() }), /not current/);
await assert.rejects(recordDelivery({ ...base, outcome: "delivered" }), /receipt/);
await assert.rejects(recordDelivery({ ...base, outcome: null }), /Invalid delivery record/);
assert.equal(await recordDelivery({ ...base, outcome: "needs_link" }), "needs_link");
await login(A); r = await val("select hex_learning_get($1)", [REVIEW]); assert.equal(r.delivery.status, "needs_link"); assert.equal(r.delivery.receipt_id, null);
await as("service");
assert.equal(await recordDelivery({ ...base, outcome: "failed", error: "receiver_timeout" }), "failed");
const at = "2026-09-23T18:00:00.000Z";
assert.equal(await recordDelivery({ ...base, outcome: "delivered", receipt: "hex-receipt-1", at }), "delivered");
assert.equal(await recordDelivery({ ...base, outcome: "delivered", receipt: "hex-receipt-1", at }), "delivered", "identical receipt is idempotent");
await assert.rejects(recordDelivery({ ...base, outcome: "delivered", receipt: "hex-receipt-2", at }), /different receipt/);
assert.equal(await recordDelivery({ ...base, outcome: "failed", error: "late" }), "delivered", "a later failure never un-delivers");
await login(A); r = await val("select hex_learning_get($1)", [REVIEW]);
assert.equal(r.delivery.status, "delivered"); assert.equal(r.delivery.receipt_id, "hex-receipt-1"); assert.equal(r.delivery.attempts, 3);

check("withdrawal: supervisor/owner only, immediate, durable, never resurrected");
const evidenceBefore = await count("select count(*) from hex_portal_cases where id=$1 and answer='Original Ask answer' and question='What happened at unit 16?'", [CASE_A]);
await login(F); await assert.rejects(withdraw(action(), 6, "Wrong"), /Only a supervisor or owner can withdraw/);
await login(A); await assert.rejects(withdraw(action(), 6, "Mine"), /Only a supervisor or owner can withdraw/);
await login(S2); await assert.rejects(withdraw(action(), 6, "  "), /Say why/);
await assert.rejects(withdraw(action(), 5, "Stale"), /changed on another screen/);
const wd = action();
r = await withdraw(wd, 6, "Manufacturer changed the sill pan detail");
assert.equal(r.state, "withdrawn"); assert.equal(r.withdrawal.status, "pending"); assert.equal(r.withdrawal.receipt_id, null);
assert.equal((await withdraw(wd, 6, "Manufacturer changed the sill pan detail")).revision, 7, "withdraw retry is the same withdrawal");
const withdrawalEvent = r.withdrawal.withdrawal_event_id;
assert.equal(withdrawalEvent, await raw("select id from hex_learning_review_events where review_id=$1 and action='withdrawn'", [REVIEW]));
await login(S2); assert.deepEqual(await exported(), [], "export invalidated at once");
await login(A); await assert.rejects(packet(CASE_A, 6, approval), /not current/, "packet invalidated at once");
await as("service"); await assert.rejects(recordDelivery({ ...base, outcome: "delivered", receipt: "hex-receipt-1", at }), /withdrawn/, "old delivery replay refused");
await login(S2); await assert.rejects(decide(action(), 7, "approve", { oversight: true }), /waiting for review/, "no path back to approved");
await login(A); await assert.rejects(save(action(), 7, complete), /sent for review/);
await login(S2);
const wp = await val("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent]);
assert.deepEqual(Object.keys(wp).sort(), Object.keys(contract.withdrawalPacket).sort(), "the SQL withdrawal proof has exactly the pinned contract keys");
assert.equal(wp.callerId, S2); assert.equal(wp.callerRole, "supervisor");
assert.equal(wp.withdrawnByRole, "supervisor");
assert.equal(wp.withdrawalAuthorized, true); assert.equal(wp.revisionFingerprint, pa.revisionFingerprint); assert.equal(wp.withdrawnBy, S2);
await assert.rejects(db.query("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, approval]), /not current/);
await login(F); await assert.rejects(db.query("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent]), /supervisor or owner/);
await login(A); await assert.rejects(db.query("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent]), /supervisor or owner/);
await as("service");
const recW = (outcome, receipt = null, when = null, caller = S2) => db.query("select hex_learning_record_withdrawal($1,$2,$3,$4,$5,$6,null) as s", [CASE_A, withdrawalEvent, caller, outcome, receipt, when]).then((x) => x.rows[0].s);
assert.equal(await recW("failed"), "failed");
await login(A); assert.equal((await val("select hex_learning_get($1)", [REVIEW])).withdrawal.status, "failed");

check("pending removal still completes after the withdrawer and the approver leave");
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=now() where id = any($1)", [[S2, S]]);
await login(M1);
const wp2 = await val("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent]);
assert.equal(wp2.withdrawnBy, S2, "history kept"); assert.equal(wp2.withdrawnByRole, "supervisor"); assert.equal(wp2.withdrawnAt, wp.withdrawnAt);
// The live profile may be purged by normal retention; the minimum opaque
// withdrawal marker must survive without copying name, contact or memo data.
await db.exec("reset role"); await db.query("delete from profiles where id=$1", [S2]);
await login(M1);
const wpPurged = await val("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent]);
assert.equal(wpPurged.withdrawnBy, S2); assert.equal(wpPurged.withdrawnByRole, "supervisor");
assert.equal(wpPurged.callerId, M1); assert.equal(wpPurged.callerRole, "supervisor");
assert.equal(await raw("select withdrawn_by from hex_learning_reviews where id=$1", [REVIEW]), null, "live profile link was purged");
await as("service");

assert.equal(wp2.callerId, M1); assert.equal(wp2.callerRole, "supervisor");
await login(O); assert.equal((await val("select hex_portal_withdrawal_packet($1,$2)", [CASE_A, withdrawalEvent])).callerRole, "owner");
await as("service");
await assert.rejects(recW("failed", null, null, S2), /current supervisor or owner/, "the departed withdrawer cannot record");
await assert.rejects(recW("failed", null, null, F), /current supervisor or owner/, "a foreman cannot record removal");
await assert.rejects(recW("removed", null, null, M1), /receipt/);
assert.equal(await recW("removed", "rm-1", at, M1), "removed");
assert.equal(await recW("removed", "rm-1", at, M1), "removed");
assert.equal(await recW("removed", "rm-1", at, S2), "removed", "an identical recorded tombstone is acknowledged, never erased");
await assert.rejects(recW("removed", "rm-2", at, M1), /different receipt/);
await db.exec("reset role"); await db.query("insert into profiles(id,role,display_name) values($1,'admin','Sue Second')", [S2]);
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id = any($1)", [[S2, S]]);
await login(A); r = await val("select hex_learning_get($1)", [REVIEW]);
assert.equal(r.withdrawal.status, "removed"); assert.equal(r.withdrawal.receipt_id, "rm-1"); assert.equal(r.delivery.receipt_id, "hex-receipt-1", "delivery history is kept, not rewritten");
assert.equal(await count("select count(*) from hex_portal_cases where id=$1 and answer='Original Ask answer' and question='What happened at unit 16?'", [CASE_A]), evidenceBefore);
assert.equal(await count("select count(*) from ai_field_requests where id=$1 and transcript='Unit 16 sill pan leaked'", [REQ_A]), 1);
assert.equal(await count("select count(*) from storage.objects where name=$1", [AUDIO_A]), 1, "original evidence untouched");

check("oversight approval by an owner is recorded as oversight");
await login(S);
await save(action(), 0, complete, { review: REVIEW_S, case: CASE_S });
await submit(action(), 1, M1, REVIEW_S);
await login(O); r = await decide(action(), 2, "approve", { oversight: true, review: REVIEW_S });
assert.equal(r.state, "approved"); assert.equal(r.decided_as_oversight, true); assert.equal(r.decided_by.id, O);

check("own approval: only an explicit current supervisor/owner, only the exact displayed revision (issues/08)");
const CASE_F = id(403), REVIEW_F = id(530), CASE_SELF = id(404), REVIEW_SELF = id(540);
await login(F2); await db.query("select hex_portal_save_case($1,$2,'','Foreman question','Answer','[]')", [CASE_F, OTHERJOB]);
await save(action(), 0, complete, { review: REVIEW_F, case: CASE_F });
await assert.rejects(submit(action(), 1, F2, REVIEW_F), /own write-up/, "a foreman cannot name themselves");
assert.ok(!(await val("select hex_learning_reviewers($1,'')", [OTHERJOB])).choices.some((c) => c.id === F2), "nor find themselves");
await submit(action(), 1, F, REVIEW_F);
await assert.rejects(decide(action(), 2, "approve", { oversight: true, review: REVIEW_F }), /own write-up/, "a foreman never approves their own");
await login(S); await db.query("select hex_portal_save_case($1,$2,'','Supervisor own lesson','Answer','[]')", [CASE_SELF, OTHERJOB]);
r = await save(action(), 0, complete, { review: REVIEW_SELF, case: CASE_SELF });
assert.equal(r.state, "draft", "saving never approves anything, even for a supervisor");
assert.ok((await val("select hex_learning_reviewers($1,'sam')", [OTHERJOB])).choices.some((c) => c.id === S), "a supervisor can find themselves");
r = await submit(action(), 1, S, REVIEW_SELF);
assert.equal(r.state, "submitted"); assert.equal(r.reviewer.id, S); assert.equal(r.reviewer.can_approve, true);
assert.equal((await val("select hex_learning_get($1)", [REVIEW_SELF])).viewer.can_approve, true);
await assert.rejects(decide(action(), 1, "approve", { review: REVIEW_SELF }), /changed on another screen/, "a stale own preview is refused");
await db.exec("reset role"); await db.query("update profiles set role='foreman' where id=$1", [S]);
await login(S); await assert.rejects(decide(action(), 2, "approve", { review: REVIEW_SELF }), /own write-up|Only a supervisor or owner/, "a changed role is refused");
await db.exec("reset role"); await db.query("update profiles set role='supervisor' where id=$1", [S]);
await login(S); r = await decide(action(), 2, "approve", { review: REVIEW_SELF });
assert.equal(r.state, "approved"); assert.equal(r.decided_by.id, S); assert.equal(r.decided_as_oversight, false);
const own = await packet(CASE_SELF, 3, r.approval_event_id);
assert.equal(own.reviewerId, S); assert.equal(own.authorId, S); assert.equal(own.reviewerRole, "supervisor");

check("recovery: a stuck write-up is reassigned by a supervisor with a reason");
await login(B);
await save(action(), 0, complete, { review: REVIEW_B, case: CASE_B });
await submit(action(), 1, F2, REVIEW_B);
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=now() where id=$1", [F2]);
await login(B); r = await val("select hex_learning_get($1)", [REVIEW_B]);
assert.equal(r.reviewer.available, false, "the author is told the reviewer cannot act");
await login(L); await assert.rejects(reassign(action(), 2, L, "Frank is away", REVIEW_B), /Only a supervisor or owner/);
await login(S); await assert.rejects(reassign(action(), 2, L, " ", REVIEW_B), /Say why/);
await assert.rejects(reassign(action(), 2, B, "x", REVIEW_B), /cannot review/);
const reassignChoices = await val("select hex_learning_reviewers($1,'',$2,'reassign')", [JOB, REVIEW_B]);
assert.ok(reassignChoices.choices.some((c) => c.id === L) && !reassignChoices.choices.some((c) => c.id === B));
r = await reassign(action(), 2, L, "Fay's access was removed", REVIEW_B);
assert.equal(r.reviewer.id, L); assert.equal(r.revision, 3);
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id=$1", [F2]);
await login(F2); await assert.rejects(decide(action(), 3, "request_changes", { note: "x", review: REVIEW_B }), /not assigned/);
await login(L); r = await decide(action(), 3, "request_changes", { note: "Add the tape brand", review: REVIEW_B });
assert.equal(r.state, "changes_requested"); assert.equal(r.last_note, "Add the tape brand");
assert.equal((await raw("select action from hex_learning_review_events where review_id=$1 and revision=3", [REVIEW_B])), "reassigned");
assert.equal((await raw("select oversight from hex_learning_review_events where review_id=$1 and revision=3", [REVIEW_B])), true);

check("approved export pages by caseId with a lookahead row, and exact lookup");
// Numeric-only Impact and an explicit Unknown must survive into the packet.
await login(B); await save(action(), 4, { issue: complete.issue, what_happened: complete.what_happened, impact_cost_cents: 1250, preventive_action: "Name the tape brand", unknown: ["lesson_learned"] }, { review: REVIEW_B, case: CASE_B }); await submit(action(), 5, L, REVIEW_B);
await login(L); await decide(action(), 6, "forward", { to: S, review: REVIEW_B });
await login(S); r = await decide(action(), 7, "approve", { review: REVIEW_B });
assert.equal(r.state, "approved");
await login(S2);
const ordered = [CASE_B, CASE_S].sort();
let p1 = await page(JOB, { limit: 1 });
assert.equal(p1.items.length, 1); assert.equal(p1.items[0].caseId, ordered[0]); assert.equal(p1.nextCursor, ordered[0]);
let p2 = await page(JOB, { after: p1.nextCursor, limit: 1 });
assert.equal(p2.items.length, 1); assert.equal(p2.items[0].caseId, ordered[1]); assert.equal(p2.nextCursor, null, "no lost tail, no phantom page");
assert.equal((await page(JOB, { limit: 2 })).nextCursor, null);
assert.deepEqual((await page(JOB, { caseId: CASE_B })).items.map((x) => x.caseId), [CASE_B]);
assert.deepEqual((await page(JOB, { caseId: CASE_A })).items, [], "withdrawn case is absent from exact lookup");
assert.equal((await page(JOB, { caseId: CASE_S })).items[0].reviewerRole, "owner");

check("packet keeps explicit Unknown and numeric-only Impact, and binds the snapshot");
await login(B); const pb = await packet(CASE_B, 8, (await val("select hex_learning_get($1)", [REVIEW_B])).approval_event_id);
assert.equal(pb.sections.impact, null); assert.deepEqual(pb.selfReportedImpact, { minutes: null, costCents: 1250 });
assert.equal(pb.sections.lessonLearned, null); assert.deepEqual(pb.unknownFields, ["lessonLearned"]); assert.equal(pb.unitLabel, null);
for (const [k, v] of Object.entries(pb.sections)) {
  if (v === null) assert.ok(pb.unknownFields.includes(k) || (k === "impact" && (pb.selfReportedImpact.minutes !== null || pb.selfReportedImpact.costCents !== null)), `null ${k} must be Unknown or numeric impact`);
}
// Tampering with the stored snapshot (sources or words) voids the approval.
await db.exec("reset role"); await db.query("update hex_learning_review_events set source_request_ids = array[$2::uuid] where review_id=$1 and revision=8", [REVIEW_B, REQ_B]);
await login(B); await assert.rejects(packet(CASE_B, 8, pb.approvalEventId), /not current/, "a changed source list breaks the fingerprint");
await db.exec("reset role"); await db.query("update hex_learning_review_events set source_request_ids = '{}' where review_id=$1 and revision=8", [REVIEW_B]);
await login(B); assert.equal((await packet(CASE_B, 8, pb.approvalEventId)).revisionFingerprint, pb.revisionFingerprint);

check("the receipt recorder re-authorises inside its own transaction");
await as("service");
const baseB = { caseId: CASE_B, revision: 8, event: pb.approvalEventId, fingerprint: pb.revisionFingerprint, caller: B };
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=now() where id=$1", [S]);
await as("service"); await assert.rejects(recordDelivery({ ...baseB, outcome: "delivered", receipt: "d-b", at }), /not current/, "approver revoked after the proof read");
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id=$1", [S]); await db.query("update profiles set access_revoked_at=now() where id=$1", [B]);
await as("service"); await assert.rejects(recordDelivery({ ...baseB, outcome: "delivered", receipt: "d-b", at }), /can no longer deliver/, "caller revoked after the proof read");
await assert.rejects(recordDelivery({ ...baseB, caller: F2, outcome: "delivered", receipt: "d-b", at }), /can no longer deliver/, "the service role cannot name an unrelated caller");
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id=$1", [B]);
assert.equal(await count("select count(*) from hex_learning_deliveries where review_id=$1 and status='delivered'", [REVIEW_B]), 0);

check("a Hexcore-side removal is terminal for delivery");
await as("service");
assert.equal(await recordDelivery({ ...baseB, outcome: "delivered", receipt: "d-b", at }), "delivered");
await assert.rejects(recordDelivery({ ...baseB, outcome: "removed_remote" }), /receipt/);
assert.equal(await recordDelivery({ ...baseB, outcome: "removed_remote", receipt: "rm-b", at }), "removed_remote");
assert.equal(await recordDelivery({ ...baseB, outcome: "delivered", receipt: "d-b", at }), "removed_remote", "no retry re-adds it");
await login(B); r = await val("select hex_learning_get($1)", [REVIEW_B]);
assert.equal(r.delivery.status, "removed_remote"); assert.equal(r.viewer.can_retry, false); assert.equal(r.state, "approved", "review state and delivery state stay separate");
await assert.rejects(packet(CASE_B, 8, pb.approvalEventId), /not current/, "no longer offered for delivery");
await login(S2); assert.deepEqual((await page(JOB, { caseId: CASE_B })).items, [], "no longer exported as current");

check("approved export: at most 30 per page, the 31st only looks ahead, 65 cases, 60-case tail, exact lookup and revoked approver");
const JOB65 = id(110);
await db.exec("reset role"); await db.query("insert into projects(id,job_code,name) values($1,'P65','Synthetic paging job')", [JOB65]);
const many = [];
for (let i = 0; i < 65; i++) {
  const c = id(2000 + i), rv = id(3000 + i);
  await login(B); await db.query("select hex_portal_save_case($1,$2,'','Paging case','Answer','[]')", [c, JOB65]);
  await save(action(), 0, complete, { review: rv, case: c }); await submit(action(), 1, S, rv);
  await login(S); await decide(action(), 2, "approve", { review: rv });
  many.push(c);
}
many.sort();
await login(S2);
const walk = async () => { const seen = []; let after = null, pages = 0;
  do { const pg = await page(JOB65, { after }); assert.ok(pg.items.length <= 30); seen.push(...pg.items.map((x) => x.caseId)); pages++;
       if (pg.nextCursor) assert.equal(pg.nextCursor, pg.items.at(-1).caseId, "cursor is the last RETURNED case"); after = pg.nextCursor; } while (after);
  return { seen, pages }; };
let w65 = await walk(); assert.deepEqual(w65.seen, many); assert.equal(w65.pages, 3);
assert.equal((await page(JOB65)).items.length, 30, "default p_limit 31 returns 30");
assert.equal((await page(JOB65, { limit: 5 })).items.length, 5);
assert.deepEqual((await page(JOB65, { caseId: many[30] })).items.map((x) => x.caseId), [many[30]], "exact lookup of the 31st");
for (const c of many.slice(60)) { const rv = await raw("select id from hex_learning_reviews where case_id=$1", [c]); await login(S2); await withdraw(action(), 3, "Paging tail", rv); }
await login(S2); const w60 = await walk(); assert.deepEqual(w60.seen, many.slice(0, 60)); assert.equal(w60.pages, 2, "exactly 60: no phantom third page");
const second = await page(JOB65, { after: many[29] }); assert.equal(second.items.length, 30); assert.equal(second.nextCursor, null);
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=now() where id=$1", [S]);
await login(S2); assert.deepEqual(await page(JOB65), { items: [], nextCursor: null }, "revoked final approver empties the export");
await db.exec("reset role"); await db.query("update profiles set access_revoked_at=null where id=$1", [S]);

check("no raw table access");
await login(A);
for (const t of ["hex_learning_reviews", "hex_learning_review_events", "hex_learning_deliveries", "hex_learning_withdrawals"]) await assert.rejects(db.query(`select * from ${t}`), /permission denied/);
await as("anon");
for (const f of ["hex_learning_list('mine')", `hex_portal_approved_cases('${JOB}'::uuid)`]) await assert.rejects(db.query(`select ${f}`), /permission denied/);

check("retention: a deleted job takes its write-ups, history, deliveries and withdrawals");
await db.exec("reset role"); await db.query("delete from projects where id = any($1)", [[JOB, JOB65, OTHERJOB]]);
for (const t of ["hex_learning_reviews", "hex_learning_review_events", "hex_learning_deliveries", "hex_learning_withdrawals"]) assert.equal(await count(`select count(*) from ${t}`), 0, t);

await db.close();
console.log("Hex learning review: null-safe RPCs, actor binding, every contributing source, exact reviewers, notices, foreman forward without approval, supervisor-only approval, contract-pinned packet/fingerprint, 30-item export paging, receipt re-authorisation, terminal Hexcore removal, removal after staff leave, recovery, recording scope and retention passed.");
