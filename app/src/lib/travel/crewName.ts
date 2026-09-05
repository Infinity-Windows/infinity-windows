/**
 * Split a display name into the part that carries the weight and the rest.
 *
 * The crew picker sets the first word in 600 and the rest in 400, so a grid of
 * names is scannable by first name — which is what a supervisor building a trip
 * is actually looking for — without turning the whole chip into bold soup.
 *
 * Casing is left exactly as the database has it. The roster really does hold
 * "Antonio miguel" and "Tyson antonio diaz", and title-casing them here would
 * be this screen quietly inventing a spelling that the People page, the roster,
 * timecards and every push notification would still disagree with. If those
 * names should read differently, they get fixed once where they are typed.
 */
export function splitName(displayName: string): { first: string; rest: string } {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", rest: "" };
  return { first: parts[0], rest: parts.slice(1).join(" ") };
}
