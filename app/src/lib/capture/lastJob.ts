// The last job somebody captured to, remembered on their own device.
//
// WHY THIS IS A SEPARATE KEY. `infinity.storage.lastJob` already exists, twice
// (TagPackages, Supplies), and it means something narrower: the job a
// WAREHOUSE action was for. Capture is a different question asked in a
// different place, and quietly sharing one key would let tagging a package in
// the yard change which job a photo defaults to at a house across town.
//
// WHY IT IS A CHIP AND NOT A DEFAULT. The open shift still wins: a person
// standing on a job clocked into it, and that beats what they did last time.
// This only fills the gap where there is no shift — the office, a Saturday, a
// phone that never clocked in — and even then it is offered with its reason
// on it ("Last time") rather than silently applied.
//
// Every read and write is wrapped. A private window, a locked-down browser or
// a full quota all throw on plain localStorage access — the same reason
// FarFromJobPrompt wraps its own reads. A device that cannot remember simply
// does not get the chip.

const KEY = "infinity.capture.lastJob";

/** The last job captured to on this device, or null if there is none. */
export function readLastCaptureJob(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Remember this job as the last one captured to. Never throws. */
export function writeLastCaptureJob(projectId: string | null): void {
  try {
    if (!projectId) return;
    localStorage.setItem(KEY, projectId);
  } catch {
    /* a device that cannot remember just does not get the chip */
  }
}
