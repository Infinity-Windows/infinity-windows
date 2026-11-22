import type { ActivityRow } from "./activityRows";

// Read-only evidence reviewed directly in Supabase on 2026-10-28.
// These are documentation intervals, NOT replacement work dates or durations.
// Exact person/interval matching also handles documentation filed under another job.
export const documentationTimecards = [
 {id:"a0ea5d8c-5c80-4091-81de-6ee089d8d134",person:"f4781448-af31-4603-bcb8-15703dfc051a",start:"2026-10-07T03:19:20.567Z",end:"2026-10-07T03:25:00Z",note:"Recording logs after the fact, not trying to log more hours. So I delete them"},
 {id:"b9cc966a-c8a3-4202-813e-81f1847c9d9c",person:"f4781448-af31-4603-bcb8-15703dfc051a",start:"2026-10-07T06:49:25.999Z",end:"2026-10-07T07:17:30.643Z",note:"Clocked in to log finished units, for past jobs, because it requires me to be on the clock to do so"},
 {id:"1621aed9-068b-4d65-8d9f-4ac3ad824230",person:"f4781448-af31-4603-bcb8-15703dfc051a",start:"2026-10-08T06:38:02.119Z",end:"2026-10-08T07:37:50.648Z",note:"Logging past installs for HC24"},
 {id:"226e83b4-3c40-4c20-a6da-19adad70609b",person:"f4781448-af31-4603-bcb8-15703dfc051a",start:"2026-10-09T18:02:35.095Z",end:"2026-10-09T18:20:39.799Z",note:"Logging units for crew"},
] as const;
export const reviewedOpeningFlags = (openingId:string) => openingId === "16dbca7f-4e60-4f34-a0a8-224a38ab9b03"
 ? ["Duration unreliable", "Worker unconfirmed", "Actual work date unknown"] : [];
export function documentationEvidence(row:ActivityRow) {
 const start=Date.parse(row.started),end=Date.parse(row.ended);
 return documentationTimecards.find(card=>card.person===row.personId && start>=Date.parse(card.start) && start<Date.parse(card.end) &&
  // Phase submission can happen much later. Ordinary timers must fit the
  // documentation shift; allow only 2 seconds for server close sequencing.
  (row.sourceTable === "opening_phases" || end<=Date.parse(card.end)+2000));
}
