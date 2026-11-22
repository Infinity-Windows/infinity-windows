/**
 * The time to record for work started on a shift.
 *
 * The shift's clock-in is stamped by the server and the tap by the phone. A
 * phone a couple of seconds behind puts a start made right after clock-in
 * BEFORE the shift began, and Forge refuses it: "Clock in or resume your job
 * clock before starting work" (seen 2026-11-20, the device 2.6 s behind).
 * Work on a shift cannot start before the shift does, so the later of the two
 * is the start.
 */
export function workStartTime(tapMs: number, shiftClockInAt: string): string {
  const shiftStart = Date.parse(shiftClockInAt);
  return shiftStart >= tapMs ? shiftClockInAt : new Date(tapMs).toISOString();
}
