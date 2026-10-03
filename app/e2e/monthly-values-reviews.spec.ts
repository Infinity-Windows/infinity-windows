// Fixture-only 390px review workflow. No real employee scores or API key.
import { expect, test } from '@playwright/test';
import { useSupabaseFixtures, TEST_USER } from './support/supabaseFixtures';
import { hideWrongProjectBanner } from './support/specHelpers';
import { createHash } from 'node:crypto';

const assignmentId = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) => ({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
const task = {
  assignment_id: assignmentId, period_start: '2026-10-01',
  subject_id: '22222222-2222-4222-8222-222222222222', subject_name: 'Fixture coworker',
  reason: 'dealt', solo: false, status: 'pending', submitted_at: null, rubric_version: 1,
};

test.use({viewport: {width:390, height:844}, deviceScaleFactor:2});

for (const language of ['en','es'] as const) {
  test(`${language}: Settings reaches reviews; all eight scores and matched receipt on phone`, async ({page}) => {
    await useSupabaseFixtures(page, {role:'installer', language});
    await hideWrongProjectBanner(page);
    let accepted = false;
    const requests: Record<string, unknown>[] = [];
    await page.route('**/rest/v1/rpc/values_my_tasks', route => route.fulfill(json([
      {...task, status: accepted ? 'submitted' : 'pending', submitted_at: accepted ? '2026-10-03T20:00:00Z' : null},
    ])));
    await page.route('**/rest/v1/rpc/values_my_owed_count', route => route.fulfill(json(accepted ? 0 : 1)));
    await page.route('**/rest/v1/rpc/values_my_summary', route => route.fulfill(json({
      subjectId:TEST_USER.id, windowStart:'2026-07-01', windowEnd:'2026-10-03',
      mirror:{}, allTime:{}, quarters:[],
    })));
    await page.route('**/rest/v1/rpc/values_submit', async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const scores = body.p_scores as {slug:string;score:number}[];
      const comment = typeof body.p_comment === 'string' ? body.p_comment.replace(/^ +| +$/g, '') || null : null;
      const canonical = `forge-values-submit/v1\nassignment=${body.p_assignment_id}\nrequest=${body.p_request_id}\nrubric=${body.p_rubric_version}\n` +
        [...scores].sort((a,b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0).map(x => `${x.slug}=${x.score}\n`).join('') +
        `comment=${comment === null ? 'null' : 'hex:'+Buffer.from(comment, 'utf8').toString('hex')}\n`;
      accepted = true;
      return route.fulfill(json({receipt:{
        encodingVersion:'forge-values-submit/v1', submissionId:'33333333-3333-4333-8333-333333333333',
        assignmentId, requestId:body.p_request_id, rubricVersion:1,
        digest:createHash('sha256').update(canonical).digest('hex'), acceptedAt:'2026-10-03T20:00:00Z',
        quarterStart:'2026-10-01', cutoffAt:'2027-01-10T07:00:00Z', quarterEligibility:'eligible_before_cutoff',
      }, replay:false}));
    });
    await page.goto('/settings');
    const open = page.getByRole('link', {name: language==='en' ? 'Open reviews' : 'Abrir revisiones', exact:true});
    await expect(open).toBeVisible();
    await open.click();
    await page.getByRole('button', {name:/Fixture coworker/}).click();
    const submit = page.getByRole('button', {name:language==='en' ? 'Submit review' : 'Enviar revisión', exact:true});
    await expect(submit).toBeDisabled();
    // Each value has an independent radio/button group; do not preselect a
    // default score and do not satisfy the UI by sending fake data directly.
    const groups = page.locator('[role=group]').filter({has:page.getByRole('button', {name:'7', exact:true})});
    await expect(groups).toHaveCount(8);
    for (let i=0;i<8;i++) await groups.nth(i).getByRole('button', {name:'7', exact:true}).click();
    await expect(submit).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:`e2e/__screenshots__/values-${language}-phone.png`, fullPage:true});
    await submit.click();
    await expect.poll(() => accepted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].p_scores).toHaveLength(8);
    await expect(page.getByText(language==='en' ? 'Review submitted.' : 'Revisión enviada.', {exact:true})).toBeVisible();
    await page.getByRole('button', {name:language==='en' ? 'Back to list' : 'Volver a la lista', exact:true}).click();
    await expect(page.getByText(language==='en' ? 'All caught up' : 'Todo al día', {exact:true})).toBeVisible();
    const saved = await page.evaluate(async ({ownerId, assignmentId}) => {
      const db = await new Promise<IDBDatabase>((resolve,reject) => {
        const r=indexedDB.open('wops-write-outbox'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
      });
      const rows = await new Promise<unknown[]>((resolve,reject) => {
        const r=db.transaction('metadata').objectStore('metadata').getAll();
        r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
      }); db.close();
      return rows.filter(x => (x as {id:string}).id.startsWith('values-draft/v1/')).map(x => JSON.parse((x as {meta:string}).meta)).find((d) => d.ownerId===ownerId && d.assignmentId===assignmentId) as {status:string;receipt:{receipt:{assignmentId:string}}};
    }, {ownerId:TEST_USER.id, assignmentId});
    expect(saved.status).toBe('accepted');
    expect(saved.receipt.receipt.assignmentId).toBe(assignmentId);
  });
}

for (const language of ['en','es'] as const) {
  test(`${language}: owner phone matrix shows coverage, stays off and hides cached private rows offline`, async ({page, context}) => {
    await useSupabaseFixtures(page, {role:'owner', language});
    await hideWrongProjectBanner(page);
    let activationWrites = 0;
    await page.route('**/rest/v1/rpc/values_set_scheduler_enabled', route => {
      activationWrites++;
      return route.fulfill(json(false));
    });
    await page.route('**/rest/v1/rpc/values_owner_report', route => route.fulfill(json({
      periodStart:'2026-10-01', schedulerEnabled:false,
      people:[{
        userId:'22222222-2222-4222-8222-222222222222', name:'Fixture coworker',
        mirror:{}, owedCount:1, suspended:false, retired:false,
        asRater:{assigned:3, accepted:2, late:1, pending:1, canceled:0, suspended:0},
        coverage:{expectedReceived:2, actualReceived:1, missingCoverage:true},
        received:[{raterName:'Fixture reviewer', raterClass:'worker', solo:false,
          periodStart:'2026-10-01', scores:{}, comment:'Fixture confidential evidence'}],
      }],
    })));
    await page.goto('/values/owner');
    await expect(page.getByRole('heading', {name:language==='en' ? 'Owner review matrix' : 'Matriz de revisión del dueño', exact:true})).toBeVisible();
    await expect(page.getByText(language==='en' ? 'Scheduling is OFF' : 'La programación está DESACTIVADA', {exact:true})).toBeVisible();
    await expect(page.getByText(language==='en' ? 'As a reviewer this period' : 'Como evaluador este período', {exact:true})).toBeVisible();
    await expect(page.getByText(/Fixture coworker/, {exact:true})).toBeVisible();
    await expect(page.getByText(language==='en' ? /Coverage missing/ : /Falta cobertura/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:`e2e/__screenshots__/values-owner-${language}-phone.png`, fullPage:true});
    await page.locator('details summary').click();
    await expect(page.getByText(/Fixture confidential evidence/)).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(/Fixture confidential evidence/)).toHaveCount(0);
    await expect(page.getByRole('heading', {name:'Fixture coworker', exact:true})).toHaveCount(0);
    expect(activationWrites).toBe(0);
  });
}
