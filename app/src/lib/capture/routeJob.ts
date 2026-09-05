// Which job the person is LOOKING AT, read off the address bar.
//
// WHY THIS BEATS THE OPEN SHIFT. The Capture button rides every screen, so it
// opens over whatever a person happens to be on — and on a job screen, that
// screen is a better answer than the timesheet. A foreman clocked into job B
// who walks over to job A, opens A's page and taps Capture is capturing for A:
// the screen is a choice they just made, the open shift is a guess about where
// they are standing. The shift is still the fallback for every screen that is
// not about one job (Today, the warehouse, the office), which is most of them.
//
// WHY A REGEX AND NOT A ROUTER HOOK. `useMatch` needs one call per pattern and
// there are nine job routes; this reads the path once. Horizon's capture sheet
// does the same thing for the same reason.
//
// WHY THE UUID TEST. `/projects` has non-id children — a future `/projects/new`
// would otherwise be read as a job called "new" and every capture on it would
// be filed to a job that does not exist. Every project id in this app is a
// uuid, so anything that is not one is not a job.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The job in this path, or null when the path is not about one.
 *
 * Covers both shapes the route table uses: `/projects/<id>/…` (the job hub and
 * its eight children) and `/studio/j/<id>` (the studio's job view). The one
 * deliberate omission is `/studio/p/<id>`, whose id is a PLANSET, not a job.
 */
export function projectIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const candidate =
    parts[0] === "projects"
      ? parts[1]
      : parts[0] === "studio" && parts[1] === "j"
        ? parts[2]
        : undefined;
  return candidate && UUID.test(candidate) ? candidate : null;
}
