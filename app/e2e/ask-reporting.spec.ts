import { expect,test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { useSupabaseFixtures } from './support/supabaseFixtures';
import { buildTimeReport,type ReportShift } from '../../supabase/functions/_shared/askReporting';
const person='10000000-0000-4000-8000-000000000001';
const shift:ReportShift={id:'s1',profile_id:person,project_id:null,cost_code_id:null,clock_in_at:'2026-09-01T13:00:00Z',clock_out_at:'2026-09-01T21:30:00Z',break_seconds:1800,break_started_at:null,status:'submitted',created_at:'2026-09-01T13:00:00Z',injured:null,time_confirmed:null,profiles:{display_name:'Alex Rivera'}};
const report=buildTimeReport([shift],{from:'2026-09-01',through:'2026-09-15',timeZone:'America/Denver',profileIds:null,projectIds:null,groupBy:'employee',includeProjects:false},Date.parse('2026-09-21T20:00:00Z'),'report-fixture',2);
for(const width of [390,1440])test(`hours report and snapshot downloads at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:960});await useSupabaseFixtures(page,{role:'owner'});
 let requests=0;
 await page.route('**/functions/v1/ask',async route=>{requests++;const body=route.request().postDataJSON();expect(body.timeZone).toBeTruthy();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({answer:'Recorded time is 8 hours after breaks. The report includes unassigned time.',sources:[],artifacts:[report]})});});
 await page.goto('/ask');const input=page.locator('.ask-input input');await input.fill('Export September 1 through September 15, 2026 hours without projects');await input.press('Enter');
 const card=page.getByRole('region',{name:'Hours report'});await expect(card).toBeVisible();await expect(card).toContainText('8.00h');await expect(card).toContainText('Alex Rivera');await expect(card).toContainText('All jobs, including unassigned time');expect(requests).toBe(1);
 const download=page.waitForEvent('download');await card.getByRole('button',{name:'Download CSV'}).click();const file=await download;const csv=await readFile((await file.path())!,'utf8');expect(csv).toContain('8.0000');expect(csv).not.toContain('Project Number');
 const pdfDownload=page.waitForEvent('download');await card.getByRole('button',{name:'Download PDF'}).click();const pdf=await pdfDownload;await pdf.saveAs(`e2e/test-results/ask-report-${width}.pdf`);const bytes=await readFile((await pdf.path())!);expect(bytes.subarray(0,4).toString()).toBe('%PDF');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:`e2e/test-results/ask-report-${width}.png`,fullPage:true});
});
test('offline operational question never displays a cached total',async({page,context})=>{
 await useSupabaseFixtures(page,{role:'foreman'});await page.goto('/ask');await expect(page.locator('.ask-input input')).toBeVisible();await context.setOffline(true);const input=page.locator('.ask-input input');await input.fill('How many hours did our crew work?');await input.press('Enter');await expect(page.locator('.ask-thread')).toContainText('Connect to the internet');await expect(page.locator('.ask-report')).toHaveCount(0);
});
test('installer can reach the server for a permitted personal report',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});await page.route('**/functions/v1/ask',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({answer:'Your recorded hours.',artifacts:[{...report,accessScope:'self',scope:{...report.scope,profileIds:[person]}}]})}));await page.goto('/ask');const input=page.locator('.ask-input input');await input.fill('Show my hours September 1-15, 2026');await input.press('Enter');await expect(page.getByRole('region',{name:'Hours report'})).toContainText('Your time');
});
