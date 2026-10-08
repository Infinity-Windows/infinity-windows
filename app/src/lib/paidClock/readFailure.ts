/** Transport loss is the only failed read that may retain last-observed
 * display/authorship evidence. A SQL/identity refusal always invalidates it. */
export function isPaidClockTransportFailure(error:unknown):boolean {
  const o=error && typeof error==="object"?error as {code?:unknown;name?:unknown;message?:unknown}:null;
  if(typeof o?.code==="string" && o.code.length>0)return false;
  return error instanceof TypeError || o?.name==="AbortError" || typeof o?.message==="string" &&
    /failed to fetch|networkerror|network request failed|load failed|transport timeout|request timed out/i.test(o.message);
}
