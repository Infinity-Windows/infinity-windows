import { expect, test, type Page } from '@playwright/test';
import { useSupabaseFixtures as loadSupabaseFixtures, TEST_USER } from './support/supabaseFixtures';
import { hideWrongProjectBanner, json } from './support/specHelpers';

const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const at=(hour:number,day=0)=>{ const d=new Date();d.setDate(d.getDate()+day);d.setHours(hour,0,13,0);return d.toISOString(); };
async function loadTimecardFixtures(page:Page, role:'installer'|'foreman'|'supervisor'|'owner'='foreman', language:'en'|'es'='en') {
  await loadSupabaseFixtures(page,{role,language}); await hideWrongProjectBanner(page);
  const people=[{id:TEST_USER.id,display_name:'Reviewing Manager',role},{id:id(1),display_name:'Installer Alex',role:'installer'},
    {id:id(2),display_name:'Foreman Casey',role:'foreman'},{id:id(3),display_name:'Supervisor Sam',role:'supervisor'},
    {id:id(4),display_name:'Owner Morgan',role:'owner'},{id:id(5),display_name:'Offsite Installer',role:'installer',active:false}]
    .map(p=>({active:true,language,skill_level:3,...p}));
  let rows=people.flatMap((p,i)=>[0,1].map(k=>({id:id(100+i*2+k),profile_id:p.id,project_id:id(20+k),cost_code_id:id(30),
    clock_in_at:at(7+k*2),clock_out_at:at(9+k*2),break_seconds:31,break_started_at:null,status:'submitted',note:k===0?'Existing job details':null,
    edited_at:null as string | null,created_at:at(7),injured:false,time_confirmed:true,
    projects:{job_code:`JOB${k+1}`,name:`Fixture job ${k+1}`},cost_codes:{code:'1',label:'Installation'},profiles:{display_name:p.display_name}})));
  const edits:Record<string,unknown>[]=[],approvals:Record<string,unknown>[]=[],pushes:unknown[]=[];
  await page.route('**/rest/v1/profiles**',r=>{const target=new URL(r.request().url()).searchParams.get('id')?.slice(3);return json(r,target?people.find(p=>p.id===target):people,people.length);});
  await page.route('**/rest/v1/projects**',r=>json(r,[0,1].map(k=>({id:id(20+k),job_code:`JOB${k+1}`,name:`Fixture job ${k+1}`})),2));
  await page.route('**/rest/v1/cost_codes**',r=>json(r,[{id:id(30),code:'1',label:'Installation',active:true}],1));
  await page.route('**/rest/v1/time_shifts**',r=>{
    const u=new URL(r.request().url());let filtered=rows;
    for(const key of ['profile_id','status','clock_out_at']) for(const query of u.searchParams.getAll(key)) {
      if(query.startsWith('eq.')) filtered=filtered.filter(s=>String(s[key as keyof typeof s])===query.slice(3));
      if(query==='is.null') filtered=filtered.filter(s=>s[key as keyof typeof s]==null);
      if(query==='neq.voided') filtered=filtered.filter(s=>s.status!=='voided');
      if(query.startsWith('in.')) filtered=filtered.filter(s=>query.slice(4,-1).split(',').includes(String(s[key as keyof typeof s])));
    }
    for(const query of u.searchParams.getAll('clock_in_at')) {
      if(query.startsWith('gte.'))filtered=filtered.filter(s=>s.clock_in_at>=query.slice(4));
      if(query.startsWith('lt.'))filtered=filtered.filter(s=>s.clock_in_at<query.slice(3));
    }
    return json(r,r.request().headers().accept?.includes('pgrst.object')?filtered[0]??null:filtered,filtered.length);
  });
  await page.route('**/rest/v1/rpc/edit_shift_with_description',r=>{
    const body=r.request().postDataJSON();edits.push(body);
    rows=rows.map(s=>s.id===body.p_shift_id?{...s,note:body.p_description,edited_at:new Date().toISOString()}:s);
    return json(r,rows.find(s=>s.id===body.p_shift_id));
  });
  await page.route('**/rest/v1/rpc/approve_timecard_week',r=>{
    const body=r.request().postDataJSON();approvals.push(body);let changed=0;
    rows=rows.map(s=>{if(s.profile_id===body.p_profile_id&&s.clock_in_at>=body.p_start&&s.clock_in_at<body.p_end&&s.status==='submitted'){changed++;return {...s,status:'approved'};}return s;});
    return json(r,changed);
  });
  await page.route('**/functions/v1/send-push',r=>{pushes.push(r.request().postDataJSON());return json(r,{ok:true});});
  return {edits,approvals,pushes,rows};
}

for(const [width,language] of [[375,'en'],[390,'es'],[1280,'en']] as const) {
  test(`description survives save/reopen and clear at ${width}px ${language}`,async({page})=>{
    await page.setViewportSize({width,height:844});const f=await loadTimecardFixtures(page,'foreman',language);await page.goto('/timecard');
    const editName=language==='es'?'Editar':'Edit';
    await page.getByRole('button',{name:editName,exact:true}).first().click();
    const description=page.getByLabel(language==='es'?'Descripción del día / proyecto (opcional)':'Day / project description (optional)');
    await expect(description).toHaveValue('Existing job details');
    const note='Installed storefront frames.\nDelayed by missing glass. '+ 'Extra detail '.repeat(45);
    await description.fill(note);await page.getByPlaceholder('e.g. forgot to clock out').fill('Added job details');
    await expect(page.getByRole('button',{name:'Delete punch',exact:true})).toHaveCount(0);
    const box=await description.boundingBox();expect(box!.width).toBeLessThan(width);expect(box!.height).toBeGreaterThan(90);
    await page.locator(".shift-editor").screenshot({path:`/tmp/forge-timecard-description-${width}-${language}.png`});
    await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(description).toHaveCount(0);
    expect(f.edits).toHaveLength(1);expect(f.edits[0]).toMatchObject({p_description:note.trim(),p_note:'Added job details',p_break_seconds:31,p_clock_in_at:f.rows[0].clock_in_at,p_clock_out_at:f.rows[0].clock_out_at});
    await page.getByRole('button',{name:editName,exact:true}).first().click();await expect(description).toHaveValue(note.trim());
    await description.fill('');await page.getByPlaceholder('e.g. forgot to clock out').fill('Removed duplicate details');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(description).toHaveCount(0);expect(f.edits.at(-1)?.p_description).toBeNull();
    await page.getByRole('button',{name:editName,exact:true}).first().click();await expect(description).toHaveValue('');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  });
}

test('foreman approves one whole week per person and cannot edit or approve higher roles',async({page})=>{
  const f=await loadTimecardFixtures(page);await page.goto('/team-timecards');
  const card=(name:string)=>page.locator('.tcx-person-review').filter({has:page.locator('.tcx-row-name').filter({hasText:name})});
  for(const name of ['Reviewing Manager','Installer Alex','Foreman Casey','Offsite Installer']) await expect(card(name).getByRole('button',{name:'Approve week',exact:true})).toBeVisible();
  for(const name of ['Supervisor Sam','Owner Morgan']) await expect(card(name).getByRole('button',{name:'Approve week',exact:true})).toHaveCount(0);
  await card('Installer Alex').getByRole('button',{name:'Approve week',exact:true}).click();
  await expect(card('Installer Alex').getByText('Week approved',{exact:true})).toBeVisible();expect(f.approvals).toHaveLength(1);
  expect(f.approvals[0].p_expected).toHaveLength(2);
  await expect.poll(()=>f.pushes.length).toBe(1);
  await card('Installer Alex').locator('.tcx-row').click();
  await expect(page.getByRole('button',{name:'Edit',exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'Back to the team'}).click();
  await page.locator('.tcx-roster').screenshot({path:'/tmp/forge-weekly-roster-phone.png'});
  await card('Foreman Casey').locator('.tcx-row').click();await expect(page.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Approve week',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Back to the team'}).click();
  await card('Supervisor Sam').locator('.tcx-row').click();await expect(page.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Approve week',exact:true})).toHaveCount(0);
});

test('supervisor approves everyone and selected week is retained in the detail view',async({page})=>{
  await page.setViewportSize({width:1280,height:900});await loadTimecardFixtures(page,'supervisor');await page.goto('/team-timecards');
  await expect(page.getByRole('button',{name:'Approve week',exact:true})).toHaveCount(6);
  await page.getByRole('button',{name:'Previous',exact:true}).click();
  const label=await page.locator('button[title="Jump back to now"]').innerText();
  await page.locator('.tcx-row').filter({hasText:'Supervisor Sam'}).click();
  await expect(page.locator('.tcx-panel button[title]')).toHaveText(label);
  await expect(page.getByRole('button',{name:'Approve week',exact:true})).toHaveCount(0);
});

test('installer can read saved descriptions but cannot edit or approve',async({page})=>{
  await loadTimecardFixtures(page,'installer');await page.goto('/timecard');
  await expect(page.getByText('Note: Existing job details',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Approve week',exact:true})).toHaveCount(0);
});

test('a refused weekly save shows an error without claiming approval',async({page})=>{
  await loadTimecardFixtures(page);await page.route('**/rest/v1/rpc/approve_timecard_week',r=>r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'This timecard changed. Refresh it and review the week again.'})}));
  await page.goto('/timecard');await page.getByRole('button',{name:'Approve week',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('This timecard changed');await expect(page.getByText('Week approved',{exact:true})).toHaveCount(0);
});
