import { clientWithToken, supabase } from "../supabase";
import { stillSignedInAs, type SignInMark } from "../signedIn";
import { parseUnitContributorsReply, UnitContributorsUnavailableError, type UnitContributorsReply } from "./protocol";

export interface UnitContributorsScope {
  projectId: string;
  unitId: string;
  /** From the independently fresh authorized unit basis, never this reply. */
  unitIncarnation: string;
}
function canonicalId(value: unknown): string {
  if (typeof value !== "string"
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(value)?.[0] !== value) {
    throw new UnitContributorsUnavailableError();
  }
  return value.toLowerCase();
}

/** One read under the original current login and caller's live admission.
 * Names and hours never enter a durable cache or a retry/fallback path. */
export async function fetchUnitContributors(scope: UnitContributorsScope,
  login: SignInMark, admission: () => boolean): Promise<UnitContributorsReply> {
  try {
    const projectId = canonicalId(scope.projectId), unitId = canonicalId(scope.unitId);
    const unitIncarnation = scope.unitIncarnation, mark = { ...login };
    if (typeof unitIncarnation !== "string" || unitIncarnation.length > 40
      || /^(0|[1-9][0-9]{0,39})$/.exec(unitIncarnation)?.[0] !== unitIncarnation
      || BigInt(unitIncarnation) > 9223372036854775807n) throw new UnitContributorsUnavailableError();
    const current = () => !!mark.userId && stillSignedInAs(mark, mark.userId)
      && navigator.onLine !== false && admission();
    if (!current()) throw new UnitContributorsUnavailableError();
    const { data: session, error: sessionError } = await supabase.auth.getSession();
    if (!current() || sessionError || !session.session?.access_token
      || session.session.user.id !== mark.userId) throw new UnitContributorsUnavailableError();
    const client = clientWithToken(session.session.access_token);
    if (!current()) throw new UnitContributorsUnavailableError();
    const { data, error } = await client.rpc("work_unit_contributors_read", {
      p_project_id: projectId, p_unit_id: unitId, p_protocol_version: 1,
    });
    if (!current() || error) throw new UnitContributorsUnavailableError();
    return parseUnitContributorsReply(data, { actorId: mark.userId!, projectId, unitId, unitIncarnation });
  } catch { throw new UnitContributorsUnavailableError(); }
}
