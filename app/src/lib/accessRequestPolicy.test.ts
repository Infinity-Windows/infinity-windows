import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WHO MAY READ AND WRITE THE ACCESS-REQUEST QUEUE, pinned to the SQL.
 *
 * Until 20260987000000 this table carried one policy for signed-in users —
 * `FOR ALL USING (true) WITH CHECK (true)` — so any installer with a browser
 * console could approve their own request or delete the queue. Nothing in the
 * app offered those taps, which is not a control.
 *
 * Two of the four replacements are load-bearing in a way a reader would not
 * guess, so they are asserted here rather than left to be re-derived:
 *
 *   SELECT is supervisor+, because the queue now carries `decision_note` —
 *   free text a supervisor types about a person the crew knows, under a sheet
 *   promising that only people who can see that screen read it.
 *
 *   UPDATE's WITH CHECK names the statuses, because rank alone does not stop a
 *   supervisor PATCHing a row to 'approved' straight at PostgREST. 'approved'
 *   means "an account now exists" and only the edge function can make that
 *   true; the failure it reproduces is the one the owner reported — a row that
 *   says approved beside a person who cannot sign in.
 *
 * Reading the SQL is the only way to test this without a database. It cannot
 * prove the policy behaves, but it does prove nobody widened it back by
 * accident, which is how it got this way the first time.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(
    HERE,
    "../../../supabase/migrations/20260987000000_remove_login_start_fresh.sql",
  ),
  "utf8",
);

/** One `create policy "name" ... ;` statement, whitespace flattened. */
function policy(name: string): string {
  const from = SQL.indexOf(`create policy "${name}" on public.access_requests`);
  expect(from, `${name} is not in the migration`).toBeGreaterThan(0);
  return SQL.slice(from, SQL.indexOf(";", from)).replace(/\s+/g, " ");
}

describe("the access-request queue's row-level security", () => {
  it("no longer carries the for-all-using-true policy", () => {
    expect(SQL).toContain(
      'drop policy if exists "authenticated full access" on public.access_requests',
    );
  });

  it("only lets a supervisor or the owner read it", () => {
    const p = policy("access_requests_select");
    expect(p).toContain("for select");
    expect(p).toContain("public.my_role_rank() >= 2");
    expect(p).toContain("not public.is_partner_user()");
  });

  it("still lets anybody signed in ASK for access", () => {
    // Somebody already inside the app asking for a different role is the same
    // request as somebody outside asking for one, and the separate `anon can
    // request` policy covers the signed-out form.
    const p = policy("access_requests_insert");
    expect(p).toContain("for insert");
    expect(p).not.toContain("my_role_rank");
  });

  it("never lets a client leave a row saying approved", () => {
    const p = policy("access_requests_update_supervisor");
    expect(p).toContain("with check");
    expect(p).toContain("status in ('denied', 'pending')");
  });

  it("only lets a supervisor or the owner delete from it", () => {
    expect(policy("access_requests_delete_supervisor")).toContain(
      "public.my_role_rank() >= 2",
    );
  });

  it("and the RPC refuses the word too, so it is said twice", () => {
    const rpc = SQL.slice(
      SQL.indexOf("create or replace function public.decide_access_request"),
    );
    expect(rpc).toContain("if p_status not in ('denied', 'pending') then");
  });
});

/**
 * The one function in the database that hands a raw email ADDRESS to a browser.
 *
 * foreman_contacts_for_me fills the To: line of the "Send a recording" mailto:.
 * It filtered on `p.active` alone — the flag a foreman toggles every morning
 * from the Roster — so one tap on the wrong row would put a removed login's
 * address into a mail composer, and after a removal that address is a tombstone
 * that can never be a mailbox. Both branches of the function must exclude a
 * removed login on the flag that cannot be toggled.
 */
describe("nobody removed ends up in a To: line", () => {
  it("filters retired_at in both branches", () => {
    const fn = SQL.slice(
      SQL.indexOf("create or replace function public.foreman_contacts_for_me"),
    );
    const body = fn.slice(0, fn.indexOf("$fn$;"));
    expect(body).toContain("p.active");
    // Once for the job the caller is standing on, once for the fallback that
    // answers with every lead in the company.
    expect(body.match(/p\.retired_at is null/g)?.length).toBe(2);
    expect(body.match(/p\.active/g)?.length).toBe(2);
  });
});
