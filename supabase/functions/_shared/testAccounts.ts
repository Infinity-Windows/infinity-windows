/**
 * Is this caller an automation/test login?
 *
 * `profiles.is_test` marks a login that belongs to a script rather than a
 * person (see docs/test-account.md). Those accounts exist so a screen can be
 * opened and checked, and they are constrained everywhere else:
 * 20260730120000 keeps their work out of the company's numbers, and
 * 20260730220000 confines their writes to the sandbox job.
 *
 * The one thing that is not a database write, and so cannot be confined by a
 * trigger or a policy, is creating a login: that happens through an edge
 * function on the service-role key, past RLS entirely. So the endpoints that
 * can mint an account ask this question and refuse.
 *
 * It is read on the SERVICE-ROLE key against a user id from a verified JWT,
 * never from the request body — same rule as the caller's role.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type ServiceClient = ReturnType<typeof createClient>;

/** The sentence a refused test login is shown. Plain English, on purpose. */
export const TEST_ACCOUNT_REFUSED =
  "This is a test login. It cannot give anybody access to the app.";

export async function isTestAccount(
  supabase: ServiceClient,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabase
    .from("profiles")
    .select("is_test")
    .eq("id", userId)
    .maybeSingle();
  // Fail closed on an error would lock the owner out of his own crew screen if
  // this column were ever unreadable; fail open is safe here because the role
  // ladder above is the primary control and the database has its own guard on
  // crew_invites underneath.
  if (error) return false;
  return (data as { is_test?: boolean } | null)?.is_test === true;
}
