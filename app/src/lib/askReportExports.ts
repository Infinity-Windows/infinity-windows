import type { TimeReportArtifact } from '../../../supabase/functions/_shared/askReporting.ts';
import { dateInZone } from '../../../supabase/functions/_shared/askReporting.ts';
import { shiftHours } from '../../../supabase/functions/_shared/timeMath.ts';
import { buildTimeEntryRows } from './timeEntryExport';
export function reportRows(report: TimeReportArtifact): string[][] {
  if (report.scope.includeProjects) return buildTimeEntryRows(report.rows, report.scope.timeZone, '', report.scope.groupBy === 'job');
  const days = new Map<string, { name: string; id: string; day: string; hours: number; entries: number; unapproved: number }>();
  for (const s of report.rows) {
    if (!s.clock_out_at || s.status === 'voided' || !Number.isFinite(shiftHours(s))) continue;
    const day = dateInZone(s.clock_in_at, report.scope.timeZone);
    const key = `${s.profile_id}:${day}`;
    const row = days.get(key) ?? { name: s.profiles?.display_name ?? s.profile_id, id:s.profile_id, day, hours:0, entries:0, unapproved:0 };
    row.hours += shiftHours(s); row.entries++; row.unapproved += s.status === 'approved' ? 0 : 1;
    days.set(key,row);
  }
  return [['Employee ID','Employee','Day','Hours (decimal)','Entries','Unapproved entries','Time zone'],
    ...[...days.values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id) || a.day.localeCompare(b.day)).map(r=>[r.id,r.name,r.day,r.hours.toFixed(4),String(r.entries),String(r.unapproved),report.scope.timeZone])];
}
function csvCell(value: string): string {
  const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g,'""')}"` : safe;
}
export function askReportCsv(report: TimeReportArtifact): string {
  return '\uFEFF' + reportRows(report).map(row=>row.map(csvCell).join(',')).join('\r\n');
}
/** A file generated from the exact card snapshot, with no second database query. */
export async function askReportPdf(report: TimeReportArtifact): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.12,.1,.09), muted = rgb(.42,.39,.36), red = rgb(.95,.22,.13);
  let page = pdf.addPage([612,792]); let y = 0;
  const clean = (s:string) => s.replace(/[–—]/g,'-').replace(/[^\x20-\x7E\xA0-\xFF\n]/g,'?');
  const line = (text:string,size=10,font=regular,color=ink) => { page.drawText(clean(text),{x:38,y,size,font,color}); y -= size + 5; };
  const startPage = () => {
    page.drawRectangle({x:0,y:728,width:612,height:64,color:ink});
    page.drawText('FORGE WINDOWS & DOORS',{x:38,y:757,size:16,font:bold,color:rgb(1,1,1)});
    page.drawRectangle({x:0,y:724,width:612,height:4,color:red}); y=702;
    line('Timecard report',17,bold);
    line(`${report.scope.from ?? 'All time'}${report.scope.through ? ' through '+report.scope.through : ''} | ${report.scope.timeZone}`,10);
  };
  const wrapped = (text:string, size=10) => {
    const words = clean(text).split(/\s+/); let current='';
    for (const word of words) {
      if (regular.widthOfTextAtSize(current+' '+word,size)>532 && current) { if(y<55){page=pdf.addPage([612,792]);startPage();} line(current,size);current=''; }
      // Long unbroken notes/IDs wrap rather than overflow the page.
      for (const char of word) { if(regular.widthOfTextAtSize(current+char,size)>532){if(y<55){page=pdf.addPage([612,792]);startPage();}line(current,size);current='';}current+=char; }
      current+=' ';
    }
    if(current){if(y<55){page=pdf.addPage([612,792]);startPage();}line(current.trim(),size);}
  };
  startPage();
  line(`Recorded: ${report.totals.recordedHours.toFixed(2)} hours after breaks`,12,bold);
  wrapped(`Running: ${report.totals.runningHours.toFixed(2)} hours (excluded from export). Unresolved: ${report.totals.unresolvedCount}. Unapproved finished entries: ${report.totals.unapprovedCount}. Suspect timestamps: ${report.totals.suspectCount}.`);
  wrapped(`People: ${report.scope.profileIds ? report.people.map(p=>p.name).join(', ') || 'Selected people; no entries' : 'All permitted crew'}. Jobs: ${report.scope.projectIds ? report.jobs.map(j=>j.name).join(', ') || 'Selected jobs; no entries' : 'All jobs, including unassigned time'}.`);
  line(`Snapshot: ${report.generatedAt}`,8,regular,muted);
  line(`Report ID: ${report.id}`,8,regular,muted);
  wrapped('Clock-in dates determine inclusion. These are recorded hours, not payroll approval or an overtime calculation.',9);
  y-=8;
  const [headers,...rows] = reportRows(report);
  // Detailed cards keep long job names and descriptions readable on portrait paper.
  for (const row of rows) {
    if(y<160){page=pdf.addPage([612,792]);startPage();}
    page.drawLine({start:{x:38,y},end:{x:574,y},thickness:.5,color:rgb(.8,.78,.76)});y-=16;
    if(!report.scope.includeProjects){ line(`${row[1]} | ${row[2]}`,11,bold);line(`${Number(row[3]).toFixed(2)} hours | ${row[4]} entries | ${row[5]} unapproved`); }
    else for(let i=0;i<headers.length;i++) if(row[i]) wrapped(`${headers[i]}: ${row[i]}`, i<3 ? 10 : 9);
    y-=8;
  }
  for (const [i,p] of pdf.getPages().entries()) p.drawText(`${i+1} / ${pdf.getPageCount()}`,{x:535,y:25,size:8,font:regular,color:muted});
  return pdf.save();
}
