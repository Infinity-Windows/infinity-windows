import {describe,it,expect} from 'vitest';
import {parseNewJob} from '../../../supabase/functions/_shared/askActions';
describe('job proposal details',()=>{
 it('normalizes supplied data but never invents optional fields',()=>{
  expect(parseNewJob({name:' Example job ',jobCode:'example 1'},1)).toMatchObject({name:'Example job',jobCode:'EXAMPLE-1',address:null,startDate:null,projectedHours:null});
 });
 it('respects the existing supervisor-only labor target rule',()=>{
  expect(()=>parseNewJob({name:'Job',jobCode:'JOB'},0)).toThrow('foreman');
  expect(()=>parseNewJob({name:'Job',jobCode:'JOB',projectedHours:200},1)).toThrow('supervisor');
  expect(parseNewJob({name:'Job',jobCode:'JOB',projectedHours:200,goalHours:180},2).goalHours).toBe(180);
 });
 it('rejects invalid dates, targets and contact details',()=>{
  for(const extra of [{startDate:'2026-02-30'},{startDate:'2026-10-05',endDate:'2026-10-04'},{goalHours:-1},{goalHours:NaN},{contactEmail:'invalid'},{jobCode:'!!!'}])expect(()=>parseNewJob({name:'Job',jobCode:'JOB',...extra},2)).toThrow();
 });
});
