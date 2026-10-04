import { clientWithToken, supabase } from "../supabase";
import { signInMark, stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { parseUnitFactSnapshot, UnitObservationUnavailableError, type UnitFactSnapshot } from "./model";

/** Fresh permission projection only. Callers must never persist this response. */
export async function fetchUnitFactSnapshot(unitId: string, expectedLogin?: SignInMark): Promise<UnitFactSnapshot> {
  try {
    uuid(unitId);
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new UnitObservationUnavailableError();
    const mark = expectedLogin ?? signInMark(), who = mark.userId;
    if (!who || !stillSignedInAs(mark, who)) throw new UnitObservationUnavailableError();
    const { data: auth, error: authError } = await supabase.auth.getSession();
    const session = auth.session;
    if (authError || !session?.access_token || session.user.id !== who || !stillSignedInAs(mark, who)) throw new UnitObservationUnavailableError();
    const { data, error } = await clientWithToken(session.access_token).rpc("work_unit_fact_current_read", { p_unit_id: unitId });
    if (!stillSignedInAs(mark, who) || error) throw new UnitObservationUnavailableError();
    return parseUnitFactSnapshot(data, unitId);
  } catch { throw new UnitObservationUnavailableError(); }
}
