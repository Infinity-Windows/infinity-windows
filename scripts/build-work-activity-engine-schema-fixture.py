#!/usr/bin/env python3
"""Collect exact installed shape and source expression candidates, offline only.
No connection, no deployment and no operational data. The paired verifier must
compile/hash candidates against PostgreSQL before calling any expression matched.
"""
from pathlib import Path
import argparse, hashlib, importlib.util, json, re
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--schema-evidence',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();root=Path(__file__).resolve().parents[1];evidence=a.schema_evidence
shape=json.loads((evidence/'ENGINE-INSTALLED-SHAPE.json').read_text())
# PostgreSQL sequence bounds exceed JavaScript safe integers. Preserve the exact
# catalog integers as decimal strings before handing metadata to the JS verifier.
for sequence in shape['sequences']:
 for key in ('start','increment','minimum','maximum','cache'):
  assert type(sequence[key]) is int, (sequence['name'],key)
  sequence[key]=str(sequence[key])
closure=json.loads((evidence/'ENGINE-CUTOVER-CLOSURE-EVIDENCE.json').read_text())
supp=json.loads((evidence/'ENGINE-INSTALLED-SUPPLEMENT.json').read_text())
authority=json.loads((evidence/'ENGINE-INSTALLED-AUTHORITY.json').read_text())
configs=json.loads((evidence/'ENGINE-INSTALLED-CONFIG.json').read_text())
installed={(f['name'],f['identity']):f for f in supp['functions']}
overrides={(f['name'],f['identity']):f for f in authority['functions']}
config={(f['name'],f['identity']):f for f in configs['functions']}
loader=importlib.util.spec_from_file_location('dry_run',root/'scripts/db_dry_run.py');dry=importlib.util.module_from_spec(loader);loader.loader.exec_module(dry)
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
functions=[]
for f in closure['sourceExpectedFunctions']:
 x=f['expectedSource'];key=(f['name'],f['installedIdentity'])
 if not x:continue
 if key in overrides:
  definition=overrides[key]['definition'];body=overrides[key]['body'];source='installed-authority:'+f['identityTypes']
 else:
  text=(root/'supabase/migrations'/x['source']).read_text();header=x['sourceHeader'];at=text.index(header);tail=text[at+len(header):]
  m=re.match(r'\s*(\$[a-z0-9_]*\$)',tail,re.I);assert m
  body=tail[m.end():].split(m[1])[0];definition=header+' '+m[1]+body+m[1]+';';source=x['source']+':'+str(x['line'])
 assert sha(body)==installed[key]['bodySha256'],f['identityTypes']+' installed body drift'
 functions.append(dict(name=f['name'],arguments=f['installedIdentity'],identity=f['identityTypes'],definition=definition,
   bodySha256=sha(body),source=source,installed=installed[key],config=config[key]))

def balanced(text,start):
 assert text[start]=='('
 depth=0;i=start;quote=None
 while i<len(text):
  c=text[i]
  if quote:
   if c==quote:
    if i+1<len(text) and text[i+1]==quote:i+=2;continue
    quote=None
   elif c=='\\':i+=2;continue
  elif c in "'\"":quote=c
  elif c=='(':depth+=1
  elif c==')':
   depth-=1
   if depth==0:return text[start+1:i],i+1
  i+=1
 return None,None

# These are candidate fragments, never trusted merely because regex found one.
# Actual source path/line is retained; installation requires actual catalog hash.
checks=[];defaults=[];indexes=[];views=[];policies=[]
for file in sorted((root/'supabase/migrations').glob('*.sql')):
 if file.name>'20261108400000_work_activity_engine_substrate.sql':continue
 text=file.read_text();table_mentions=list(re.finditer(r'\b(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+if\s+exists)?)\s+(?:public\.)?([a-z_][a-z0-9_]*)',text,re.I))
 def provenance(at):return dict(source=file.name,line=text.count('\n',0,at)+1)
 def near_table(at):
  found=[m for m in table_mentions if m.start()<at]
  return found[-1][1].lower() if found else None
 for m in re.finditer(r'\bcheck\s*\(',text,re.I):
  expr,end=balanced(text,m.end()-1)
  if expr is not None and len(expr)<=20000:checks.append(dict(table=near_table(m.start()),expression=expr,**provenance(m.start())))
 for m in re.finditer(r'\bdefault\s+',text,re.I):
  start=m.end();i=start;depth=0;quote=None
  while i<len(text):
   c=text[i]
   if quote:
    if c==quote:
     if i+1<len(text) and text[i+1]==quote:i+=2;continue
     quote=None
    elif c=='\\':i+=2;continue
   elif c in "'\"":quote=c
   elif c=='(':depth+=1
   elif c==')':
    if depth==0:break
    depth-=1
   elif depth==0 and c in ',;\n':break
   i+=1
  expression=re.split(r'\s+(?:not\s+null|check\s*\(|references\s|primary\s+key|unique\b|constraint\s)',text[start:i],maxsplit=1,flags=re.I)[0].strip()
  if expression and len(expression)<=2000:defaults.append(dict(table=near_table(m.start()),expression=expression,**provenance(m.start())))
 for kind,pattern,target in [
  ('index',r'^\s*create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)',indexes),
  ('view',r'^\s*create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z_][a-z0-9_]*)',views),
  ('policy',r'^\s*create\s+policy\s+("(?:[^"]|"")+"|[a-z_][a-z0-9_]*)',policies)]:
  for m in re.finditer(pattern,text,re.I|re.M):
   tail=text[m.start():];statements=dry.split_statements(tail)
   if not statements:continue
   st=statements[0];sql=tail[st.code_start:st.end].strip()
   relation=re.search(r'\bon\s+(?:public\.)?([a-z_][a-z0-9_]*)',sql,re.I) if kind=='policy' else None
   target.append(dict(name=m[1].strip('"'),table=relation[1].lower() if relation else None,sql=sql,**provenance(m.start())))
# Generated auth column is provider-owned. Its candidate is explicitly marked
# as a known expression hypothesis and MUST match the installed hash to be used.
checks.append(dict(table='users',expression='email_change_confirm_status >= 0 AND email_change_confirm_status <= 2',source='provider CHECK hypothesis matched only by installed hash',line=0))
for expression in ('NULL::character varying', "''::character varying"):
 defaults.append(dict(table='users',expression=expression,source='provider default hypothesis matched only by installed hash',line=0))
provider_candidates=[dict(table='users',expression='LEAST(email_confirmed_at, phone_confirmed_at)',source='provider generated-column hypothesis',line=0)]
out=dict(formatVersion=1,activation=False,scope='Installed structural evidence and untrusted source expression candidates; no reconstruction claim yet.',
 shape=shape,shapeFileSha256=hashlib.sha256((evidence/'ENGINE-INSTALLED-SHAPE.json').read_bytes()).hexdigest(),
 sourceParentsSha256={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((root/'supabase/migrations').glob('*.sql')) if f.name<='20261108400000_work_activity_engine_substrate.sql'},
 evidenceFilesSha256={name:hashlib.sha256((evidence/name).read_bytes()).hexdigest() for name in ['ENGINE-INSTALLED-SHAPE.json','ENGINE-INSTALLED-SUPPLEMENT.json','ENGINE-INSTALLED-AUTHORITY.json','ENGINE-INSTALLED-CONFIG.json','ENGINE-CUTOVER-CLOSURE-EVIDENCE.json']},
 functions=functions,schemas=configs['schemas'],triggers=supp['triggers'],knownPolicies=supp['policies'],checks=checks,defaults=defaults,
 indexes=indexes,views=views,policies=policies,providerCandidates=provider_candidates)
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(out,separators=(',',':'))+'\n')
print(json.dumps(dict(functions=len(functions),checkCandidates=len(checks),defaultCandidates=len(defaults),indexCandidates=len(indexes),viewCandidates=len(views),policyCandidates=len(policies),artifactSha256=hashlib.sha256(a.output.read_bytes()).hexdigest())))
