#!/usr/bin/env python3
"""Validate this documentation kit, not the proposed desktop application.

Standard library only. Schema checker deliberately supports just the Draft-07
keywords used by these contracts; use a conformant validator in the app repo.
"""
from pathlib import Path
from copy import deepcopy
import argparse, csv, datetime, hashlib, json, re, sqlite3, uuid

ROOT = Path(__file__).resolve().parents[1]

class Invalid(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise Invalid(message)

def check(value, schema, root=None, path='$'):
    root = schema if root is None else root
    if '$ref' in schema:
        require(schema['$ref'].startswith('#/'), 'only local refs supported')
        target=root
        for part in schema['$ref'][2:].split('/'):
            target=target[part.replace('~1','/').replace('~0','~')]
        return check(value,target,root,path)
    for sub in schema.get('allOf',[]):
        check(value,sub,root,path)
    for keyword in ('oneOf','anyOf'):
        if keyword in schema:
            count=0
            for sub in schema[keyword]:
                try:
                    check(value,sub,root,path);count+=1
                except Invalid:
                    pass
            require(count==1 if keyword=='oneOf' else count>=1, f'{path}: {keyword}')
    if 'if' in schema:
        try:
            check(value,schema['if'],root,path)
            condition=True
        except Invalid:
            condition=False
        check(value,schema.get('then' if condition else 'else',{}),root,path)
    if 'type' in schema:
        types=schema['type'] if isinstance(schema['type'],list) else [schema['type']]
        predicates={
            'object':lambda x:isinstance(x,dict),'array':lambda x:isinstance(x,list),
            'string':lambda x:isinstance(x,str),'integer':lambda x:isinstance(x,int) and not isinstance(x,bool),
            'number':lambda x:isinstance(x,(float,int)) and not isinstance(x,bool),
            'boolean':lambda x:isinstance(x,bool),'null':lambda x:x is None,
        }
        require(any(predicates[t](value) for t in types),f'{path}: type')
    if 'const' in schema: require(value==schema['const'],f'{path}: const')
    if 'enum' in schema: require(value in schema['enum'],f'{path}: enum')
    if isinstance(value,dict):
        for name in schema.get('required',[]): require(name in value,f'{path}: missing {name}')
        props=schema.get('properties',{})
        if schema.get('additionalProperties') is False:
            require(not (set(value)-set(props)),f'{path}: unknown fields {set(value)-set(props)}')
        for name,sub in props.items():
            if name in value: check(value[name],sub,root,path+'.'+name)
    if isinstance(value,list):
        if 'minItems' in schema: require(len(value)>=schema['minItems'],f'{path}: minItems')
        if 'maxItems' in schema: require(len(value)<=schema['maxItems'],f'{path}: maxItems')
        if schema.get('uniqueItems'):
            require(len({json.dumps(x,sort_keys=True,ensure_ascii=False) for x in value})==len(value),f'{path}: uniqueItems')
        if 'items' in schema:
            for i,item in enumerate(value): check(item,schema['items'],root,f'{path}[{i}]')
    if isinstance(value,str):
        if 'minLength' in schema: require(len(value)>=schema['minLength'],f'{path}: minLength')
        if 'maxLength' in schema: require(len(value)<=schema['maxLength'],f'{path}: maxLength')
        if 'pattern' in schema: require(re.search(schema['pattern'],value) is not None,f'{path}: pattern')
        if schema.get('format')=='uuid':
            try: uuid.UUID(value)
            except ValueError as exc: raise Invalid(f'{path}: uuid') from exc
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        if 'minimum' in schema: require(value>=schema['minimum'],f'{path}: minimum')
        if 'maximum' in schema: require(value<=schema['maximum'],f'{path}: maximum')

def check_schema_supported(schema):
    known={'$schema','$id','title','description','default','type','properties','required','additionalProperties','items','definitions','$ref','allOf','anyOf','oneOf','if','then','else','const','enum','minimum','maximum','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','format'}
    require(not(set(schema)-known),f'Unsupported schema keywords: {set(schema)-known}')
    for sub in schema.get('properties',{}).values(): check_schema_supported(sub)
    for sub in schema.get('definitions',{}).values(): check_schema_supported(sub)
    for key in ['allOf','anyOf','oneOf']:
        for sub in schema.get(key,[]): check_schema_supported(sub)
    for key in ['if','then','else','items']:
        if key in schema: check_schema_supported(schema[key])

def load(name): return json.loads((ROOT/name).read_text(encoding='utf-8'))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--report',type=Path)
    args=parser.parse_args()
    checks=[]
    def passed(name): checks.append({'check':name,'status':'PASS'})
    for path in ROOT.rglob('*.json'):
        json.loads(path.read_text(encoding='utf-8'))
    passed('JSON syntax for every JSON artifact')
    schemas={name:load('contracts/'+name+'.schema.json') for name in ['profiles','proxies','sync-event','sync-session']}
    for schema in schemas.values(): check_schema_supported(schema)
    passed('Schema keyword coverage in the included subset checker')
    samples=[('profiles','profiles'),('proxies','proxies'),('sync-session','sync-session'),('event-click','sync-event'),('event-text','sync-event')]
    for file_name,schema_name in samples:
        check(load('examples/'+file_name+'.json'),schemas[schema_name])
        passed('Positive contract fixture: '+file_name)
    negatives=[]
    p=load('examples/profiles.json');p[0]['proxy_id']=None;negatives.append(('required proxy missing',p,'profiles'))
    p=load('examples/profiles.json');p[0]['proxy_mode']='direct';negatives.append(('direct with proxy assignment',p,'profiles'))
    p=load('examples/profiles.json');p[0]['user_data_dir']='../../outside';negatives.append(('arbitrary data dir',p,'profiles'))
    p=load('examples/proxies.json');p[0]['password']='do-not-store';negatives.append(('plaintext proxy password',p,'proxies'))
    p=load('examples/proxies.json');p[0]['port']=65536;negatives.append(('invalid proxy port',p,'proxies'))
    p=load('examples/proxies.json');p[2]['auth_kind']='basic';negatives.append(('SOCKS HTTP auth kind',p,'proxies'))
    p=load('examples/sync-session.json');p['follower_profile_ids']*=2;negatives.append(('duplicate followers',p,'sync-session'))
    p=load('examples/event-click.json');p['seq']=0;negatives.append(('invalid sequence',p,'sync-event'))
    p=load('examples/event-click.json');p['payload']['eval']='alert(1)';negatives.append(('arbitrary eval payload',p,'sync-event'))
    p=load('examples/event-text.json');p['payload']['inserted_text']='x'*16385;negatives.append(('oversized text',p,'sync-event'))
    p=load('examples/event-click.json');p['target']={'kind':'coordinate','region_key':'viewport','u':1.1,'v':0.5,'viewport':{'width':1024,'height':768},'geometry_revision':1,'zoom':1};p['type']='pointer.gesture';p['payload']={'gesture_id':p['event_id'],'phase':'down','button':'left','buttons':1,'modifiers':0,'dt_ms':0};negatives.append(('out of bounds coordinate',p,'sync-event'))
    p=load('examples/event-click.json');p['type']='navigate';p['target']=None;p['payload']={'action':'open','url':'javascript:alert(1)'};negatives.append(('unsafe navigation scheme',p,'sync-event'))
    for label,data,schema in negatives:
        try: check(data,schemas[schema])
        except Invalid: passed('Negative contract fixture rejected: '+label)
        else: raise AssertionError('Invalid sample accepted: '+label)

    profiles=load('examples/profiles.json');proxies=load('examples/proxies.json');session=load('examples/sync-session.json')
    profile_ids={x['id'] for x in profiles};proxy_ids={x['id'] for x in proxies}
    require(len(profile_ids)==len(profiles),'duplicate profile IDs')
    require(len(proxy_ids)==len(proxies),'duplicate proxy IDs')
    require(all(x['proxy_id'] in proxy_ids for x in profiles if x['proxy_mode']=='required'),'dangling proxy ref')
    require(session['master_profile_id'] in profile_ids,'unknown master')
    require(session['master_profile_id'] not in session['follower_profile_ids'],'master also follower')
    require(set(session['follower_profile_ids'])<=profile_ids,'unknown follower')
    for name in ['proxy_import.csv','variables.csv']:
        with (ROOT/'examples'/name).open(encoding='utf-8',newline='') as f:
            rows=list(csv.DictReader(f))
        require(len(rows)==3 and all(None not in row for row in rows),'CSV column mismatch')
        if name=='variables.csv': require({r['profile_id'] for r in rows}==profile_ids,'variable mapping mismatch')
    t=load('examples/event-text.json')['payload']
    require(t['range_end']>=t['range_start'],'text range inverted')
    require(t['selection_after_end']==len(t['inserted_text'].encode('utf-16-le'))//2,'UTF16 example mismatch')
    passed('Cross-file IDs, sample CSV mappings and Unicode offsets')

    db=sqlite3.connect(':memory:',isolation_level=None)
    db.executescript((ROOT/'contracts/migrations/001_initial.sql').read_text(encoding='utf-8'))
    require(db.execute('PRAGMA foreign_keys').fetchone()[0]==1,'FK disabled')
    for p in proxies:
        db.execute('INSERT INTO proxies VALUES (?,?,?,?,?,?,?,?)',(p['id'],p['label'],p['scheme'],p['host'],p['port'],p['auth_kind'],p['secret_ref'],p['config_revision']))
    # The column count is checked by SQLite; timestamps use fake fixture time.
    for p in profiles:
        db.execute('INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?,?,?)',(p['id'],p['name'],p['group'],p['proxy_mode'],p['proxy_id'],json.dumps(p['preset']),p['start_url'],p['config_revision'],'2026-10-29','2026-10-29',None))
    passed('SQLite migration and valid fixture inserts')

    def sql_reject(label,statement,parameters=()):
        db.execute('SAVEPOINT negative')
        rejected=False
        try: db.execute(statement,parameters)
        except sqlite3.IntegrityError: rejected=True
        finally:
            db.execute('ROLLBACK TO negative');db.execute('RELEASE negative')
        require(rejected,'SQL invalid accepted: '+label)
        passed('SQLite constraint: '+label)
    sql_reject('required proxy cannot become null','UPDATE profiles SET proxy_id=NULL WHERE id=?',(profiles[0]['id'],))
    sql_reject('referenced proxy cannot be deleted','DELETE FROM proxies WHERE id=?',(proxies[0]['id'],))
    sql_reject('invalid port','UPDATE proxies SET port=0 WHERE id=?',(proxies[0]['id'],))
    for sid in ['session-a','session-b']:
        db.execute('INSERT INTO sync_sessions VALUES (?,?,?,?,?,?,?,?,?)',(sid,1,profiles[0]['id'],'DRAFT','dom','strict','{}',1,'2026-10-29'))
    db.execute('INSERT INTO sync_members VALUES (?,?,?,?,?)',('session-a',profiles[0]['id'],'MASTER','main',1))
    sql_reject('one active session per profile','INSERT INTO sync_members VALUES (?,?,?,?,?)',('session-b',profiles[0]['id'],'MASTER','main',1))
    sql_reject('one active master per session','INSERT INTO sync_members VALUES (?,?,?,?,?)',('session-a',profiles[1]['id'],'MASTER','main',1))
    delivery=('session-a',1,'event-a',profiles[1]['id'],1,'dom.click','DISPATCHING','unverified','2026-10-29',None,None,'trace-a')
    db.execute('INSERT INTO sync_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',delivery)
    sql_reject('delivery dedup key','INSERT INTO sync_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',delivery)
    sql_reject('sequence unique per follower','INSERT INTO sync_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',(*delivery[:2],'event-b',*delivery[3:]))
    db.close()

    with (ROOT/'qa/acceptance.csv').open(encoding='utf-8',newline='') as f: cases=list(csv.DictReader(f))
    require(len({x['test_id'] for x in cases})==len(cases),'duplicate tests')
    covered=set()
    for row in cases:
        covered.update(row['requirement_ids'].split(';'))
        require(row['status']=='NOT_RUN','application tests must not be falsely marked run')
        require(all(row[k] for k in ['preconditions','steps','expected_result']),'missing acceptance details')
    require({f'FR-{i:02d}' for i in range(1,19)}<=covered,'FR traceability incomplete')
    passed('40 acceptance rows and FR-01…FR-18 coverage; application tests remain NOT_RUN')
    links=0
    for md in ROOT.rglob('*.md'):
        text=md.read_text(encoding='utf-8')
        require(text.count('```')%2==0,'unclosed code fence '+str(md))
        for target in re.findall(r'\]\(([^)]+)\)',text):
            if target.startswith(('https://','http://','#')):continue
            require((md.parent/target.split('#')[0]).exists(),'broken local link '+target)
            links+=1
    passed(f'Markdown fence balance and {links} local links')
    matrix=load('config/version-matrix.template.json')
    bench=load('qa/benchmark-report-template.json')
    require(matrix['status']=='REQUIRES_G0_VALIDATION' and bench['status']=='NOT_RUN','template status misleading')
    require(all(v is None for v in bench['metrics'].values()),'invented benchmark values')
    passed('Version and benchmark templates explicitly unmeasured')
    report={
      'status':'PASS','scope':'Documentation/contract consistency only; subset schema checker, not a full Draft-07 certification',
      'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'checks':checks,'check_count':len(checks),'schema_count':4,'positive_contract_samples':len(samples),'negative_contract_samples':len(negatives),
      'acceptance_case_count':len(cases),'application_tests_run':0,'browser_or_proxy_tests_run':0,
      'notes':['No desktop app, installer, proxy provider or Windows behavior was executed by this check.','Use a standards-compliant schema validator and real browser test suite during implementation.']}
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['status','scope','check_count','schema_count','positive_contract_samples','negative_contract_samples','acceptance_case_count','application_tests_run']},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
