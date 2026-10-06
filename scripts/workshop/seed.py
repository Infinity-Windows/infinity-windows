#!/usr/bin/env python3
"""Seed newly generated Auth identities and invented records in the exact workshop.

No production queries, email invitations, row copies or reset commands.
Credentials are saved in ~/.config/forge-workshop/accounts.json with mode 600.
"""
from __future__ import annotations
import json
import os
import secrets
import subprocess
import tempfile
import uuid
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from manage import stage_query, target, ROOT, PRIVATE

PEOPLE=[('owner','Workshop Owner'),('supervisor','Workshop Supervisor'),('foreman','Workshop Foreman'),('installer-one','Workshop Installer One'),('installer-two','Workshop Installer Two')]

def admin(method,path,payload=None,service='auth'):
    ref=target(json.loads((ROOT/'workshop/manifest.json').read_text()))
    key=(PRIVATE/'admin-key').read_text().strip()
    if not key.startswith('sb_secret_'):raise ValueError('Expected workshop secret API key, never a browser key')
    with tempfile.NamedTemporaryFile('w',dir=PRIVATE,delete=False) as c:c.write('header = "apikey: '+key+'"\nheader = "Authorization: Bearer '+key+'"\nheader = "Content-Type: application/json"\n');conf=Path(c.name)
    body=None
    if payload is not None:
        with tempfile.NamedTemporaryFile('w',dir=PRIVATE,delete=False) as b:json.dump(payload,b);body=Path(b.name)
    out=PRIVATE/'last-auth-admin-response.json';out.touch(mode=0o600,exist_ok=True);os.chmod(out,0o600)
    try:
        if service not in ('auth','storage'):raise ValueError('Unknown workshop service')
        prefix='auth/v1/admin' if service=='auth' else 'storage/v1'
        cmd=['curl','--silent','--show-error','--config',str(conf),'-X',method,f'https://{ref}.supabase.co/{prefix}/{path}','--output',str(out),'--write-out','%{http_code}']
        if body:cmd.extend(['--data-binary','@'+str(body)])
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=60)
        if r.returncode or r.stdout not in ('200','201'):raise RuntimeError(f'Workshop Auth admin failed: HTTP {r.stdout}; private response saved')
        return json.loads(out.read_text())
    finally:
        conf.unlink(missing_ok=True)
        if body:body.unlink(missing_ok=True)

def lit(value):
    return "'"+str(value).replace("'","''")+"'"

def main():
    PRIVATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    marker=stage_query('select project_ref from public.workshop_environment where id=true;',PRIVATE/'seed-marker.json')
    assert marker==[{'project_ref':'magcghmnbjiukidyalxd'}], 'Missing workshop identity marker'
    path=PRIVATE/'accounts.json'
    accounts=json.loads(path.read_text()) if path.exists() else []
    existing=admin('GET','users?per_page=100').get('users',[])
    expected={slug+'@forge-workshop.invalid' for slug,_ in PEOPLE}
    if any(u['email'] not in expected for u in existing):raise RuntimeError('Unexpected Auth identity in workshop; refusing to mix it with seed')
    for slug,name in PEOPLE:
        email=slug+'@forge-workshop.invalid';role=slug if not slug.startswith('installer-') else 'installer'
        row=next((a for a in accounts if a['email']==email),None)
        if not row:
            if any(u['email']==email for u in existing):raise RuntimeError('Seed user exists but local credential is missing; explicit recovery required')
            password=secrets.token_urlsafe(24)
            user=admin('POST','users',{'email':email,'password':password,'email_confirm':True,'user_metadata':{'display_name':name}})
            row={'email':email,'password':password,'id':user['id'],'role':role,'display_name':name};accounts.append(row)
            path.write_text(json.dumps(accounts,indent=2)+'\n');path.chmod(0o600)
    profiles=',\n'.join('('+','.join(lit(a[k]) for k in ('id','display_name','role'))+',false,false,\'new\')' for a in accounts)
    owner=next(a['id'] for a in accounts if a['role']=='owner')
    job1='fb000000-0000-4000-8000-000000000001';job2='fb000000-0000-4000-8000-000000000002'
    code1='fc000000-0000-4000-8000-000000000001';code2='fc000000-0000-4000-8000-000000000002'
    window='fd000000-0000-4000-8000-000000000001';opening='fe000000-0000-4000-8000-000000000042'
    today=datetime.now(ZoneInfo('America/Denver')).date()
    talks=',\n'.join('('+','.join([lit(uuid.uuid5(uuid.NAMESPACE_URL,'forge-workshop-talk:'+str(today+timedelta(days=d)))),lit('Workshop practice briefing'),lit('Practice record only. These jobs and employees are invented. Use this talk to test signing and offline recovery; it is not a real workplace safety briefing.'),lit(today+timedelta(days=d))])+')' for d in range(7))
    assignment='f9000000-0000-4000-8000-000000000001'
    members=',\n'.join('('+','.join([lit(assignment),lit(a['id']),lit(a['role'])])+')' for a in accounts if a['role'] in ('foreman','installer'))
    sql=f"""BEGIN;
INSERT INTO public.profiles(id,display_name,role,is_test,is_partner,ui_design) VALUES {profiles}
 ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,ui_design=excluded.ui_design;
INSERT INTO public.company_settings(id,new_design_r1_enabled) VALUES(1,true)
 ON CONFLICT(id) DO UPDATE SET new_design_r1_enabled=true;
INSERT INTO public.projects(id,job_code,name,address,is_test) VALUES
 ({lit(job1)},'WKDESERT','Workshop — Desert Windows','Invented practice site',false),
 ({lit(job2)},'WKSTAGE','Workshop — Supplier and Staging','Invented practice yard',false)
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.cost_codes(id,code,label) VALUES
 ({lit(code1)},'WK100','Workshop window installation'),({lit(code2)},'WK200','Workshop pickup and staging')
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.project_cost_codes(project_id,cost_code_id) VALUES
 ({lit(job1)},{lit(code1)}),({lit(job2)},{lit(code2)}) ON CONFLICT DO NOTHING;
INSERT INTO public.window_types(id,type_code,name,width_in,height_in) VALUES
 ({lit(window)},'WKFIX60','Workshop fixed window — 20 sq ft',60,48) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.project_openings(id,project_id,opening_code,window_type_id,label,ro_width_in,ro_height_in)
 VALUES({lit(opening)},{lit(job1)},'42',{lit(window)},'Workshop Unit 42',60,48) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts)
 VALUES('fa000000-0000-4000-8000-000000000042',{lit(job1)},{lit(opening)},{lit(owner)},'Workshop Unit 42','Fixed window',
 '{{"width_in":60,"height_in":48,"material":"aluminum","frame_count":1,"leaf_count":0}}'::jsonb)
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.safety_talks(id,title,body,talk_date) VALUES {talks} ON CONFLICT(id) DO NOTHING;
INSERT INTO public.schedule_assignments(id,project_id,start_date,end_date,status,created_by,published_at,note)
 VALUES({lit(assignment)},{lit(job1)},{lit(today)},{lit(today+timedelta(days=6))},'published',{lit(owner)},now(),'Workshop practice crew; invented schedule')
 ON CONFLICT(id) DO NOTHING;
INSERT INTO public.schedule_assignment_members(assignment_id,profile_id,role) VALUES {members} ON CONFLICT DO NOTHING;
COMMIT;"""
    (PRIVATE/'seed-records.sql').write_text(sql);(PRIVATE/'seed-records.sql').chmod(0o600)
    stage_query(sql,PRIVATE/'seed-result.json')
    buckets=admin('GET','bucket',service='storage')
    for bucket in ('plansets','install-media','toolbox-records'):
        if not any(b['id']==bucket for b in buckets):admin('POST','bucket',{'id':bucket,'name':bucket,'public':False},service='storage')
    print(f'Workshop seed completed: {len(accounts)} newly generated identities, 2 invented jobs and 1 unit')
if __name__=='__main__':main()
