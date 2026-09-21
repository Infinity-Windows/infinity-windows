import { describe,it,expect } from 'vitest';
import { buildTimeReport, completeReportRows, parseReportScope, reportBounds, type ReportShift, type ReportScope } from '../../../supabase/functions/_shared/askReporting.ts';
import { jobTimeReport } from './jobTimeReport';
import { askReportCsv, askReportPdf, reportRows } from './askReportExports';
import { isOperationalAsk } from './askRouting';
const person='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
const job='20000000-0000-4000-8000-000000000001';
const scope:ReportScope={from:'2026-09-01',through:'2026-09-15',timeZone:'America/Denver',profileIds:null,projectIds:null,groupBy:'employee',includeProjects:false};
const now=Date.parse('2026-09-15T20:00:00Z');
const shift=(extra:Partial<ReportShift>={}):ReportShift=>({id:'s1',profile_id:person,project_id:job,cost_code_id:null,clock_in_at:'2026-09-01T13:00:00Z',clock_out_at:'2026-09-01T21:30:00Z',break_seconds:1800,break_started_at:null,status:'submitted',created_at:'2026-09-01T13:00:00Z',injured:null,time_confirmed:null,profiles:{display_name:'Alex'},projects:{job_code:'DONE',name:'Completed job'},...extra});
describe('AI reports use the same labor arithmetic as the app',()=>{
 it('reconciles finished, running, unassigned, voided and unresolved clocks',()=>{
  const rows=[shift(),shift({id:'s2',project_id:null}),shift({id:'s3',status:'voided'}),shift({id:'s4',status:'open',clock_in_at:'2026-09-15T15:00:00Z',clock_out_at:null,break_seconds:0,break_started_at:'2026-09-15T19:30:00Z'}),shift({id:'s5',status:'needs_finish',clock_out_at:null}),shift({id:'s6',status:'open',clock_out_at:null})];
  const report=buildTimeReport(rows,scope,now,'r',2);const existing=jobTimeReport(rows,now);
  expect(report.totals.recordedHours).toBe(existing.recordedHours);expect(report.totals.runningHours).toBe(existing.runningHours);expect(report.totals.unresolvedCount).toBe(existing.unresolvedCount);
  expect(report.totals).toMatchObject({recordedHours:16,runningHours:4.5,unassignedHours:8,unresolvedCount:2,recordedCount:2,unapprovedCount:2});
  expect(reportRows(report)).toHaveLength(2);expect(reportRows(report)[1][3]).toBe('16.0000');
 });
 it('keeps completed jobs and distinct employees with the same name',()=>{
  const r=buildTimeReport([shift(),shift({id:'s2',profile_id:other})],scope,now,'r',2);
  expect(r.people).toHaveLength(2);expect(r.groups).toHaveLength(2);expect(reportRows(r)).toHaveLength(3);expect(r.jobs[0].name).toContain('Completed job');
 });
 it('filters jobs without silently including unassigned time and rejects duplicate rows',()=>{
  const r=buildTimeReport([shift(),shift({id:'s2',project_id:null})],{...scope,projectIds:[job]},now,'r',1);
  expect(r.totals.recordedHours).toBe(8);expect(r.totals.unassignedHours).toBe(0);
  expect(()=>buildTimeReport([shift(),shift()],scope,now,'r',2)).toThrow('changed');
 });
 it('uses caller identity for an installer and refuses another person',()=>{
  expect(parseReportScope(scope,scope.timeZone,person,0).profileIds).toEqual([person]);
  expect(()=>parseReportScope({...scope,profileIds:[other]},scope.timeZone,person,0)).toThrow('own hours');
  expect(()=>parseReportScope({...scope,projectIds:['x),or(id.not.is.null']},scope.timeZone,person,2)).toThrow('valid people');
 });
 it('requires explicit valid filters and calendar dates',()=>{
  for(const invalid of [{...scope,from:'2026-02-30'}, {...scope,from:null}, {...scope,through:'2026-08-01'}, {...scope,profileIds:[]}, {...scope,groupBy:'all'}])expect(()=>parseReportScope(invalid,scope.timeZone,person,2)).toThrow();
  expect(()=>parseReportScope(scope,'bad/timezone',person,2)).toThrow();
  expect(reportBounds({...scope,from:null,through:null})).toEqual({since:null,until:null});
 });
 it('selects inclusive Denver dates and 23/25-hour DST days',()=>{
  expect(reportBounds(scope)).toEqual({since:'2026-09-01T06:00:00.000Z',until:'2026-09-16T06:00:00.000Z'});
  for(const [day,hours] of [['2026-03-08',23],['2026-11-01',25]] as const){const b=reportBounds({...scope,from:day,through:day});expect((Date.parse(b.until!)-Date.parse(b.since!))/3600000).toBe(hours);}
 });
 it('loads more than 1000 records even when the server returns small pages',async()=>{
  const rows=Array.from({length:1207},(_,i)=>({id:String(i)}));const offsets:number[]=[];
  const loaded=await completeReportRows(async offset=>{offsets.push(offset);return{data:rows.slice(offset,offset+300),error:null,count:rows.length}});
  expect(loaded).toHaveLength(1207);expect(offsets).toEqual([0,300,600,900,1200]);
 });
 it('never turns a failed/moving/capped query into a partial total',async()=>{
  await expect(completeReportRows(async()=>({data:[],error:{message:'private error'},count:null}))).rejects.toThrow('could not be read');
  await expect(completeReportRows(async()=>({data:[],error:null,count:4}))).rejects.toThrow('incomplete');
  await expect(completeReportRows(async offset=>({data:[{id:'duplicate'}],error:null,count:offset?3:2}))).rejects.toThrow('changed');
  await expect(completeReportRows(async()=>({data:[{id:'duplicate'}],error:null,count:2}))).rejects.toThrow('changed');
  await expect(completeReportRows(async()=>({data:[],error:null,count:10001}))).rejects.toThrow('too large');
 });
 it('exports the exact snapshot, omits projects on request, and escapes formulas',async()=>{
  const r=buildTimeReport([shift({profiles:{display_name:'=DANGER'},note:'Private job note'})],scope,now,'r',2);
  const csv=askReportCsv(r);expect(csv).toContain("'=DANGER");expect(csv).toContain('8.0000');expect(csv).not.toContain('Completed job');expect(csv).not.toContain('Private job note');
  const {PDFDocument}=await import('pdf-lib');const bytes=await askReportPdf(r);const pdf=await PDFDocument.load(bytes);expect(pdf.getPageCount()).toBe(1);
 });
 it('routes reports and follow-ups to fresh tools in English and Spanish',()=>{
  for(const q of ['export my timecards','How many hours?','Resumen de la obra','muéstrame mis horas'])expect(isOperationalAsk(q)).toBe(true);
  expect(isOperationalAsk('What about Carol?',true)).toBe(true);expect(isOperationalAsk('What is flashing?')).toBe(false);
 });
});
