/** Availability (profiles.active) is not login access. Off-site crew may ask AI. */
export function askProfileAllowed(partner:unknown,profile:{retired_at:unknown;access_revoked_at:unknown}|null,failed:boolean):boolean {
 return !failed && partner===false && profile!==null && profile.retired_at===null && profile.access_revoked_at===null;
}
