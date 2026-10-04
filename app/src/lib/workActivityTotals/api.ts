import { clientWithToken, supabase } from "../supabase";
import { signInMark, stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { parseTotalsReply, TotalsUnavailableError, type TotalsReply } from "./protocol";

/** Read-only, original login and live surface bound. No cache/zero fallback. */
export async function fetchActivityTotals(projectId: string, unitId: string | null,
  login: SignInMark = signInMark(), admission: () => boolean = () => true): Promise<TotalsReply> {
  try {
    const project = uuid(projectId).toLowerCase(), unit = unitId === null ? null : uuid(unitId).toLowerCase(), mark = { ...login };
    const current = () => !!mark.userId && stillSignedInAs(mark, mark.userId) && navigator.onLine !== false && admission();
    if (!current()) throw new TotalsUnavailableError();
    const { data: session, error: sessionError } = await supabase.auth.getSession();
    if (!current() || sessionError || !session.session?.access_token || session.session.user.id !== mark.userId) throw new TotalsUnavailableError();
    const client = clientWithToken(session.session.access_token);
    if (!current()) throw new TotalsUnavailableError();
    const { data, error } = await client.rpc("work_activity_totals_read", { p_project_id: project, p_unit_id: unit });
    if (!current() || error) throw new TotalsUnavailableError();
    return parseTotalsReply(data, project, unit, mark.userId!);
  } catch { throw new TotalsUnavailableError(); }
}
