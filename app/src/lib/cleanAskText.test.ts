import {describe,expect,it} from 'vitest';
import {cleanAskText} from './cleanAskText';
describe('plain Ask replies',()=>{
 it('cleans the hours answer without changing figures or job names',()=>{
  expect(cleanAskText('## Hours\n\n- **Sep 21:** 7.64 recorded hours\n- **Total recorded:** **11.22 hours**\n\nOn **ESH-18 — Richardson Brothers_Estates at Sand Hollow 18**.'))
   .toBe('Hours\n\n• Sep 21: 7.64 recorded hours\n• Total recorded: 11.22 hours\n\nOn ESH-18 — Richardson Brothers_Estates at Sand Hollow 18.');
 });
 it('keeps negative values, arithmetic, paths and literal HTML as text',()=>{
  const text='-1.25 hours; 2 * 3 = 6; job_code_18; /jobs/abc\n<script>alert(1)</script>';
  expect(cleanAskText(text)).toBe(text);
 });
 it('preserves link destinations, lists and code contents without formatting markers',()=>{
  expect(cleanAskText('**Summary**\n* *Ready*\n1. Review\n[Job](https://example.com/job)\n```text\n8.00h\n```'))
   .toBe('Summary\n• Ready\n1. Review\nJob (https://example.com/job)\n8.00h');
 });
});
