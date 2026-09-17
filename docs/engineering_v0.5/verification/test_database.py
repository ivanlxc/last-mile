#!/usr/bin/env python3
"""Executable SQLite design tests. No game server, model calls or network."""
from pathlib import Path
import hashlib,json,sqlite3,unittest,uuid,sys,time
ROOT=Path(__file__).resolve().parents[1]
MIGRATION=ROOT/'database/001_initial.sql'
SEED=ROOT/'database/fixtures/reference_seed.sql'
IDS=json.loads((ROOT/'database/fixtures/ids.json').read_text())

def uid(): return str(uuid.uuid4())
def sha(value):return hashlib.sha256(value.encode()).hexdigest()
def new_db():
 c=sqlite3.connect(':memory:',isolation_level=None);c.row_factory=sqlite3.Row
 c.executescript(MIGRATION.read_text());c.executescript(SEED.read_text());return c

def insert(c,table,**kw):
 c.execute('INSERT INTO '+table+'('+','.join(kw)+') VALUES('+','.join('?' for _ in kw)+')',tuple(kw.values()))

def ledger(c,s,account,kind='spend',amount=1,parent=None,operation=None):
 row=c.execute('SELECT * FROM quota_accounts WHERE session_id=? AND account_id=?',(s,account)).fetchone()
 if kind=='reserve': bucket='available';d=(-amount,amount,0)
 elif kind=='release':bucket='reserved';d=(amount,-amount,0)
 elif kind=='refund':bucket='spent';d=(amount,0,-amount)
 elif parent:bucket='reserved';d=(0,-amount,amount)
 else:bucket='available';d=(-amount,0,amount)
 entry=uid()
 insert(c,'quota_ledger',session_id=s,entry_id=entry,account_id=account,operation_id=operation or uid(),entry_kind=kind,source_bucket=bucket,amount=amount,delta_available=d[0],delta_reserved=d[1],delta_spent=d[2],account_version_before=row['account_version'],parent_entry_id=parent,reason_code='SQL_TEST',mission_ms=0,created_at_ms=1000)
 return entry

def evidence(c,which='s1',scene='E1',role='analyst',instance=None,revision=1,body='synthetic observation',investigation=None,acquired=0,supersedes=None):
 s=IDS['sessions'][which]['sessionId'];instance=instance or uid();raw=json.dumps({'body':body,'scope':'synthetic SQL fixture'},sort_keys=True)
 insert(c,'evidence_instances',session_id=s,instance_id=instance,revision=revision,scene_id=scene,owner_role=role,private_definition_id='fixture_only',observation_type='directObservation',acquired_mission_ms=acquired,acquisition_investigation_id=investigation,supersedes_instance_id=supersedes[0] if supersedes else None,supersedes_revision=supersedes[1] if supersedes else None,public_payload_json=raw,payload_hash=sha(raw))
 return instance,revision

def report(c,ref,which='s1',scene='E1',role='analyst',charge=None):
 cfg=IDS['sessions'][which];s=cfg['sessionId'];e=c.execute('SELECT * FROM evidence_instances WHERE session_id=? AND instance_id=? AND revision=?',(s,*ref)).fetchone()
 charge=charge or ledger(c,s,cfg['accounts'][scene+':'+role+':report']);rid=uid()
 insert(c,'reports',session_id=s,report_id=rid,scene_id=scene,sender_role=role,source_instance_id=ref[0],source_revision=ref[1],actor_binding_id=cfg['actors'][role],charge_entry_id=charge,reported_mission_ms=max(0,e['acquired_mission_ms']),immutable_payload_json=e['public_payload_json'],immutable_payload_hash=e['payload_hash'])
 return rid,ref[1]

def upload(c,rr,which='s1',scene='E1',charge=None):
 cfg=IDS['sessions'][which];s=cfg['sessionId'];up=uid();charge=charge or ledger(c,s,cfg['accounts'][scene+':commander:upload'])
 insert(c,'uploads',session_id=s,upload_id=up,scene_id=scene,report_id=rr[0],report_revision=rr[1],charge_entry_id=charge,authorization_binding_id=cfg['actors']['commander'],uploaded_mission_ms=0)
 return up

def task(c,role='analyst',which='s1',resource=None):
 cfg=IDS['sessions'][which];s=cfg['sessionId'];t=uid();r=ledger(c,s,cfg['accounts']['E1:'+role+':report'],'reserve')
 resource=resource or ('drone' if role=='analyst' else 'localAgency')
 insert(c,'task_requests',session_id=s,task_id=t,scene_id='E1',commander_binding_id=cfg['actors']['commander'],target_role=role,task_kind='investigate_and_report',topic_id='public-topic',target_id='N01',option_id='option-'+resource,report_reservation_id=r,accepted_mission_ms=0,due_mission_ms=30000,created_at_ms=1000)
 charge=ledger(c,s,cfg['accounts'][resource]);i=uid()
 insert(c,'investigations',session_id=s,investigation_id=i,task_id=t,scene_id='E1',role=role,option_id='option-'+resource,resource_key=resource,resource_charge_id=charge,accepted_mission_ms=0,due_mission_ms=30000)
 return t,i,r

def manifest(c,which='s1',scene='E1',uploads=(),version=None):
 cfg=IDS['sessions'][which];s=cfg['sessionId'];m=uid()
 version=version if version is not None else c.execute('SELECT COALESCE(MAX(context_version),0)+1 FROM input_manifests WHERE session_id=?',(s,)).fetchone()[0]
 raw=json.dumps({'uploadedIds':list(uploads),'fixtureContext':version},sort_keys=True);ih=sha(raw)
 owned=not c.in_transaction
 if owned:c.execute('BEGIN IMMEDIATE')
 try:
  for u in uploads:insert(c,'input_manifest_members',session_id=s,manifest_id=m,upload_id=u)
  insert(c,'input_manifests',session_id=s,manifest_id=m,scene_id=scene,inbox_version=len(uploads),context_version=version,context_epoch=uid(),background_hash='b'*64,input_hash=ih,permitted_input_json=raw,created_at_ms=1000)
  if owned:c.commit()
 except Exception:
  if owned:c.rollback()
  raise
 return m,version,ih,len(uploads)

def advisor(c,which='s1',uploads=(),mode='live_model'):
 cfg=IDS['sessions'][which];m,v,h,iv=manifest(c,which,uploads=uploads);j=uid()
 insert(c,'agent_jobs',session_id=cfg['sessionId'],job_id=j,agent_role='advisor',scene_id='E1',manifest_id=m,status='queued',mode=mode,input_hash=h,config_hash='c'*64,input_version=v,inbox_version=iv,context_version=v,deadline_at_ms=9000,created_at_ms=1000,updated_at_ms=1000)
 return j

def seal(c,which='s1',settle=True,activate=True):
 cfg=IDS['sessions'][which];s=cfg['sessionId'];z=uid();zh=sha(z);owned=not c.in_transaction
 if owned:c.execute('BEGIN IMMEDIATE')
 try:
  if settle:
   c.execute("UPDATE investigations SET status='cancelled',finished_mission_ms=0 WHERE session_id=? AND status IN ('queued','running')",(s,))
   c.execute("UPDATE task_requests SET status='cancelled',completed_at_ms=1000 WHERE session_id=? AND status IN ('accepted','running')",(s,))
   c.execute("UPDATE operations SET status='cancelled',completed_at_ms=1000 WHERE session_id=? AND status IN ('accepted','running')",(s,))
   c.execute("UPDATE agent_jobs SET status='cancelled',updated_at_ms=1000 WHERE session_id=? AND agent_role='advisor' AND status IN ('queued','running')",(s,))
   reserves=c.execute("SELECT l.* FROM quota_ledger l WHERE l.session_id=? AND l.entry_kind='reserve'",(s,)).fetchall()
   for r in reserves:
    used=c.execute('SELECT COALESCE(SUM(amount),0) FROM quota_ledger WHERE session_id=? AND parent_entry_id=?',(s,r['entry_id'])).fetchone()[0]
    if used<r['amount']:ledger(c,s,r['account_id'],'release',r['amount']-used,r['entry_id'])
  st=c.execute('SELECT * FROM sessions WHERE session_id=?',(s,)).fetchone();seq=st['last_event_seq']+1;v=st['state_version']+1
  insert(c,'events',session_id=s,seq=seq,event_id=uid(),kind='session.terminated',mission_ms=st['mission_ms'],state_version=v,actor_kind='rules',payload_json='{}',recorded_at_ms=1000)
  insert(c,'terminal_seals',session_id=s,seal_id=z,sealed_hash=zh,terminal_lifecycle='abandoned',terminal_seq=seq,terminal_state_version=v,terminal_mission_ms=st['mission_ms'],outcome_json='{"kind":"abandoned"}',immutable_behavior_json='{"decisions":[]}',content_hash=st['content_hash'],policy_hash=st['policy_hash'],sealed_at_ms=1000)
  if activate:c.execute("UPDATE sessions SET lifecycle='abandoned',phase='terminal',terminal_seal_id=?,state_version=?,updated_at_ms=1000 WHERE session_id=?",(z,v,s))
  if owned:c.commit()
 except Exception:
  if owned:c.rollback()
  raise
 return zh


def named_sql(filename,name):
 text=(ROOT/'database'/filename).read_text()
 return text.split('-- name: '+name+'\n',1)[1].split('-- end',1)[0]

def run_template(c,name,bindings):
 chunk=''
 try:
  for line in named_sql('transactions.sql',name).splitlines(True):
   chunk+=line
   if sqlite3.complete_statement(chunk):c.execute(chunk,bindings);chunk=''
 except Exception:
  if c.in_transaction:c.rollback()
  raise

def template_bindings(c,cfg):
 st=c.execute('SELECT * FROM sessions WHERE session_id=?',(cfg['sessionId'],)).fetchone()
 b={k:uid() for k in ['task_id','investigation_id','reservation_id','resource_charge_id','event_id','snapshot_id','request_id','report_charge_id','instance_id','report_id','public_record_id','manifest_id','context_epoch','job_id','upload_charge_id','operation_id','seal_id','provider_request_key']}
 b.update(session_id=cfg['sessionId'],run_epoch=cfg['runEpoch'],expected_version=st['state_version'],base_event_seq=st['last_event_seq'],scene_id='E1',commander_binding_id=cfg['actors']['commander'],npc_binding_id=cfg['actors']['analyst'],target_role='analyst',topic_id='fixture-topic',target_id='N01',option_id='fixture-drone',resource_key='drone',report_account_id=cfg['accounts']['E1:analyst:report'],resource_account_id=cfg['accounts']['drone'],upload_account_id=cfg['accounts']['E1:commander:upload'],mission_ms=st['mission_ms'],due_mission_ms=30000,now_ms=1000,anchor_ms=5000,event_data_json='{}',public_event_json='{}',public_event_type='task.updated',snapshot_hash=sha('{}'),snapshot_json='{}',command_hash=sha('synthetic-command'),response_json='{}',private_definition_id='fixture-only',observation_type='directObservation',observed_mission_ms=30000,card_json='{}',card_hash=sha('{}'),report_view_json='{}',statement_refs_json='[]',background_hash='b'*64,input_hash=sha('{}'),advisor_input_json='{}',agent_mode='live_model',config_hash='c'*64,job_deadline_at_ms=9000,operation_kind='wait',action_id='WAIT',private_plan_json='{}',public_progress_json='{}',release_entries_json='[]',terminal_lifecycle='abandoned',termination_reason='USER_ABANDON',sealed_hash='d'*64,outcome_json='{}',behavior_json='{}',evidence_revision=1)
 return b

class DatabaseDesignTests(unittest.TestCase):
 def setUp(self):
  self.c=new_db();self.a=IDS['sessions']['s1'];self.b=IDS['sessions']['s2'];self.s=self.a['sessionId']
 def tearDown(self):self.c.close()
 def forbidden(self,fn,contains=None):
  with self.assertRaises(sqlite3.IntegrityError) as e:fn()
  if contains:self.assertIn(contains,str(e.exception))
 def balance(self,key):
  return tuple(self.c.execute('SELECT available,reserved,spent FROM quota_accounts WHERE session_id=? AND account_id=?',(self.s,self.a['accounts'][key])).fetchone())
 def test_01_migration_and_seed_integrity(self):
  self.assertEqual(self.c.execute('PRAGMA user_version').fetchone()[0],1)
  self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])
  self.assertEqual(self.c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
 def test_02_review_profile_cannot_start_normal(self):
  self.forbidden(lambda:insert(self.c,'sessions',session_id=uid(),run_epoch=uid(),launch_id=IDS['launchId'],mode='normal',content_hash=IDS['contentHash'],policy_hash=IDS['policyHash'],private_case_id='fixture',created_at_ms=1000,updated_at_ms=1000),'POLICY_NOT_APPROVED')
 def test_03_cross_session_command_binding_rejected(self):
  self.forbidden(lambda:insert(self.c,'commands',session_id=self.s,request_id=uid(),run_epoch=self.a['runEpoch'],binding_id=self.b['actors']['commander'],command_kind='task',payload_hash='a'*64,accepted_state_version=1,response_status=202,response_json='{}',accepted_at_ms=1000),'FOREIGN KEY')
 def test_04_resource_scope_never_scene_reset(self):
  self.assertEqual([self.balance(k)[0] for k in ['satellite','drone','localAgency','witness']],[2,3,3,2])
  self.forbidden(lambda:insert(self.c,'quota_accounts',session_id=self.s,account_id=uid(),quota_scope='scene',scene_id='E2',role='analyst',resource='drone',capacity=3,available=3),'CHECK')
  self.forbidden(lambda:insert(self.c,'quota_accounts',session_id=self.s,account_id=uid(),quota_scope='session',role='analyst',resource='drone',capacity=3,available=3),'UNIQUE')
 def test_05_ledger_prevents_negative_and_direct_mutation(self):
  a=self.a['accounts']['drone'];ledger(self.c,self.s,a,amount=3)
  self.forbidden(lambda:ledger(self.c,self.s,a),'QUOTA_EXHAUSTED')
  self.forbidden(lambda:self.c.execute('UPDATE quota_accounts SET available=1,spent=2 WHERE session_id=? AND account_id=?',(self.s,a)),'QUOTA_DIRECT_UPDATE')
  self.assertEqual(self.balance('drone'),(0,0,3))
 def test_06_reserve_consume_release_and_parent_limit(self):
  a=self.a['accounts']['E1:analyst:report'];r=ledger(self.c,self.s,a,'reserve',2)
  ledger(self.c,self.s,a,'spend',1,r);ledger(self.c,self.s,a,'release',1,r)
  self.assertEqual(self.balance('E1:analyst:report'),(2,0,1))
  self.forbidden(lambda:ledger(self.c,self.s,a,'release',1,r))
 def test_07_refund_links_actual_spend_once(self):
  a=self.a['accounts']['drone'];e=ledger(self.c,self.s,a)
  ledger(self.c,self.s,a,'refund',1,e);self.assertEqual(self.balance('drone'),(3,0,0))
  self.forbidden(lambda:ledger(self.c,self.s,a,'refund',1,e))
 def test_08_transaction_failure_rolls_back_budget(self):
  self.c.execute('BEGIN IMMEDIATE');ledger(self.c,self.s,self.a['accounts']['drone'])
  try:insert(self.c,'actor_bindings',session_id=self.s,binding_id=uid(),role='commander',controller_kind='human',created_at_ms=1000)
  except sqlite3.IntegrityError:self.c.rollback()
  self.assertEqual(self.balance('drone'),(3,0,0))
 def test_09_two_roles_parallel_one_each(self):
  task(self.c,'analyst');task(self.c,'liaison')
  self.assertEqual(self.c.execute("SELECT COUNT(*) FROM investigations WHERE session_id=? AND status='running'",(self.s,)).fetchone()[0],2)
  self.c.execute('BEGIN IMMEDIATE')
  self.forbidden(lambda:task(self.c,'analyst'),'UNIQUE');self.c.rollback()
  self.assertEqual(self.balance('drone'),(2,0,1))
 def test_10_observation_requires_finished_investigation(self):
  t,i,r=task(self.c)
  self.forbidden(lambda:evidence(self.c,investigation=i,acquired=30000),'EVIDENCE_NOT_OBSERVED')
  self.c.execute("UPDATE investigations SET status='completed',finished_mission_ms=30000 WHERE session_id=? AND investigation_id=?",(self.s,i))
  self.forbidden(lambda:evidence(self.c,investigation=i,acquired=29999),'EVIDENCE_NOT_OBSERVED')
  evidence(self.c,investigation=i,acquired=30000)
 def test_11_evidence_immutable_and_session_isolated(self):
  e=evidence(self.c)
  self.forbidden(lambda:self.c.execute('UPDATE evidence_instances SET payload_hash=? WHERE session_id=? AND instance_id=?',('f'*64,self.s,e[0])),'IMMUTABLE')
  self.forbidden(lambda:self.c.execute('DELETE FROM evidence_instances WHERE session_id=?',(self.s,)),'IMMUTABLE')
  self.forbidden(lambda:evidence(self.c,which='s2',revision=2,supersedes=e),'FOREIGN KEY')
 def test_12_corrected_version_spends_new_report_and_upload(self):
  e1=evidence(self.c);r1=report(self.c,e1);upload(self.c,r1)
  e2=evidence(self.c,instance=e1[0],revision=2,body='explicit correction',supersedes=e1);r2=report(self.c,e2);upload(self.c,r2)
  self.assertEqual(self.balance('E1:analyst:report'),(1,0,2));self.assertEqual(self.balance('E1:commander:upload'),(3,0,2))
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM evidence_instances WHERE instance_id=?',(e1[0],)).fetchone()[0],2)
 def test_13_report_snapshot_cannot_replace_body_or_role(self):
  e=evidence(self.c);charge=ledger(self.c,self.s,self.a['accounts']['E1:liaison:report'])
  self.forbidden(lambda:report(self.c,e,role='liaison',charge=charge),'REPORT_SOURCE_MISMATCH')
  good=report(self.c,e)
  self.forbidden(lambda:self.c.execute('UPDATE reports SET immutable_payload_json=? WHERE report_id=?',('{"body":"changed"}',good[0])),'IMMUTABLE')
 def test_14_duplicate_report_and_upload_do_not_create_new_unit(self):
  e=evidence(self.c);r=report(self.c,e);u=upload(self.c,r)
  self.c.execute('BEGIN IMMEDIATE');self.forbidden(lambda:report(self.c,e));self.c.rollback()
  self.c.execute('BEGIN IMMEDIATE');self.forbidden(lambda:upload(self.c,r));self.c.rollback()
  self.assertEqual(self.balance('E1:analyst:report'),(2,0,1));self.assertEqual(self.balance('E1:commander:upload'),(4,0,1))
 def test_15_upload_cannot_reference_other_session_report(self):
  r=report(self.c,evidence(self.c,which='s2'),which='s2')
  self.c.execute('BEGIN IMMEDIATE');self.forbidden(lambda:upload(self.c,r),'UPLOAD_REPORT_NOT_RECEIVED');self.c.rollback()
  self.assertEqual(self.balance('E1:commander:upload'),(5,0,0))
 def test_16_five_uploads_limit_and_batch_rollback(self):
  for role,count in [('analyst',3),('liaison',2)]:
   for _ in range(count):upload(self.c,report(self.c,evidence(self.c,role=role),role=role))
  r=report(self.c,evidence(self.c,role='liaison'),role='liaison')
  self.c.execute('BEGIN IMMEDIATE');self.forbidden(lambda:upload(self.c,r),'QUOTA_EXHAUSTED');self.c.rollback()
  self.assertEqual(self.balance('E1:commander:upload'),(0,0,5))
 def test_17_manifest_members_are_frozen(self):
  u=upload(self.c,report(self.c,evidence(self.c)));m,v,h,iv=manifest(self.c,uploads=[u])
  self.forbidden(lambda:insert(self.c,'input_manifest_members',session_id=self.s,manifest_id=m,upload_id=u),'MANIFEST_ALREADY_FINALIZED')
  self.forbidden(lambda:self.c.execute('UPDATE input_manifests SET input_hash=? WHERE manifest_id=?',('e'*64,m)),'IMMUTABLE')
 def test_18_manifest_cannot_import_previous_scene(self):
  u=upload(self.c,report(self.c,evidence(self.c)))
  self.forbidden(lambda:manifest(self.c,scene='E2',uploads=[u]),'MANIFEST_SCENE_MISMATCH')
 def test_19_one_active_advisor(self):
  j=advisor(self.c)
  self.forbidden(lambda:advisor(self.c),'UNIQUE')
  self.c.execute("UPDATE agent_jobs SET status='superseded' WHERE session_id=? AND job_id=?",(self.s,j))
  advisor(self.c)
 def test_20_two_attempts_and_immutable_attempt_history(self):
  j=advisor(self.c);self.c.execute("UPDATE agent_jobs SET status='running' WHERE job_id=?",(j,))
  for n in [1,2]:
   insert(self.c,'agent_attempts',session_id=self.s,job_id=j,attempt_no=n,request_key=uid(),sent_at_ms=1000)
   self.c.execute("UPDATE agent_attempts SET status='timeout',finished_at_ms=9000 WHERE job_id=? AND attempt_no=?",(j,n))
  self.forbidden(lambda:insert(self.c,'agent_attempts',session_id=self.s,job_id=j,attempt_no=3,request_key=uid(),sent_at_ms=10000),'ATTEMPT_NOT_ALLOWED')
  self.forbidden(lambda:self.c.execute("UPDATE agent_attempts SET status='succeeded' WHERE job_id=? AND attempt_no=1",(j,)),'ATTEMPT_FINAL')
 def test_21_advisor_session_budget_is_thirty_actual_attempts(self):
  for _ in range(15):
   j=advisor(self.c);self.c.execute("UPDATE agent_jobs SET status='running' WHERE job_id=?",(j,))
   for n in [1,2]:
    insert(self.c,'agent_attempts',session_id=self.s,job_id=j,attempt_no=n,request_key=uid(),sent_at_ms=1000)
    self.c.execute("UPDATE agent_attempts SET status='failed',finished_at_ms=1001 WHERE job_id=? AND attempt_no=?",(j,n))
   self.c.execute("UPDATE agent_jobs SET status='failed' WHERE job_id=?",(j,))
  j=advisor(self.c);self.c.execute("UPDATE agent_jobs SET status='running' WHERE job_id=?",(j,))
  self.forbidden(lambda:insert(self.c,'agent_attempts',session_id=self.s,job_id=j,attempt_no=1,request_key=uid(),sent_at_ms=1000),'ADVISOR_SESSION_CALL_LIMIT')
 def test_22_seal_requires_settled_work(self):
  task(self.c)
  self.forbidden(lambda:seal(self.c,settle=False),'SEAL_HAS_UNSETTLED')
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM terminal_seals').fetchone()[0],0)
 def test_23_seal_must_activate_session_in_same_transaction(self):
  self.forbidden(lambda:seal(self.c,activate=False),'FOREIGN KEY')
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM terminal_seals').fetchone()[0],0)
 def test_24_terminal_barrier_and_resource_release(self):
  task(self.c);seal(self.c)
  self.assertEqual(self.balance('drone'),(2,0,1));self.assertEqual(self.balance('E1:analyst:report'),(3,0,0))
  self.forbidden(lambda:evidence(self.c),'SESSION_TERMINAL')
  self.forbidden(lambda:ledger(self.c,self.s,self.a['accounts']['drone']),'SESSION_TERMINAL')
  self.forbidden(lambda:self.c.execute('UPDATE sessions SET mission_ms=mission_ms+1 WHERE session_id=?',(self.s,)),'SESSION_TERMINAL')
 def test_25_evaluator_requires_own_seal(self):
  args=dict(session_id=self.s,job_id=uid(),agent_role='evaluator',seal_hash='a'*64,status='queued',mode='live_model',input_hash='d'*64,config_hash='e'*64,input_version=1,evaluator_input_json='{"facts":[]}',deadline_at_ms=21000,created_at_ms=1000,updated_at_ms=1000)
  self.forbidden(lambda:insert(self.c,'agent_jobs',**args),'EVALUATOR_REQUIRES_SEAL')
  args['seal_hash']=seal(self.c);insert(self.c,'agent_jobs',**args)
  self.forbidden(lambda:insert(self.c,'agent_jobs',**{**args,'job_id':uid()}),'UNIQUE')
 def test_26_event_and_public_cursor_are_separate(self):
  insert(self.c,'view_events',session_id=self.s,view_role='commander',cursor=1,source_seq=1,event_type='session.started',public_payload_json='{}')
  insert(self.c,'view_events',session_id=self.s,view_role='analyst',cursor=1,source_seq=1,event_type='scene.available',public_payload_json='{}')
  self.forbidden(lambda:insert(self.c,'view_events',session_id=self.s,view_role='commander',cursor=3,source_seq=1,event_type='x',public_payload_json='{}'),'VIEW_CURSOR_CONFLICT')
  self.forbidden(lambda:insert(self.c,'events',session_id=self.s,seq=3,event_id=uid(),kind='x',mission_ms=0,state_version=1,actor_kind='system',payload_json='{}',recorded_at_ms=1000),'EVENT_SEQUENCE_CONFLICT')
 def test_27_command_idempotency_key_is_unique_per_session(self):
  req=uid();args=dict(session_id=self.s,request_id=req,run_epoch=self.a['runEpoch'],binding_id=self.a['actors']['commander'],command_kind='task',payload_hash='d'*64,accepted_state_version=1,response_status=202,response_json='{"taskId":"prior"}',accepted_at_ms=1000)
  insert(self.c,'commands',**args)
  stored=self.c.execute('SELECT payload_hash,response_json FROM commands WHERE session_id=? AND request_id=?',(self.s,req)).fetchone()
  self.assertEqual(stored['response_json'],'{"taskId":"prior"}')
  self.forbidden(lambda:insert(self.c,'commands',**{**args,'payload_hash':'e'*64}),'UNIQUE')
 def test_28_late_attempt_diagnostic_cannot_change_seal(self):
  j=advisor(self.c);self.c.execute("UPDATE agent_jobs SET status='running' WHERE job_id=?",(j,))
  insert(self.c,'agent_attempts',session_id=self.s,job_id=j,attempt_no=1,request_key=uid(),sent_at_ms=1000)
  z=seal(self.c)
  self.c.execute("UPDATE agent_attempts SET status='timeout',finished_at_ms=9000 WHERE session_id=? AND job_id=? AND attempt_no=1",(self.s,j))
  insert(self.c,'diagnostic_records',session_id=self.s,diagnostic_id=uid(),category='late_callback',job_id=j,attempt_no=1,recorded_at_ms=10000,payload_json='{"discarded":true}')
  self.assertEqual(self.c.execute('SELECT sealed_hash FROM terminal_seals WHERE session_id=?',(self.s,)).fetchone()[0],z)
  self.forbidden(lambda:self.c.execute("UPDATE agent_jobs SET status='succeeded',result_json='{}' WHERE job_id=?",(j,)))
 def test_29_display_receipt_requires_visible_record(self):
  rid=uid();insert(self.c,'public_records',session_id=self.s,public_record_id=rid,revision=1,view_role='commander',record_kind='briefing',source_seq=1,public_payload_json='{}')
  args=dict(session_id=self.s,receipt_id=uid(),binding_id=self.a['actors']['analyst'],public_record_id=rid,record_revision=1,receipt_kind='displayed',recorded_mission_ms=0,received_at_ms=1000)
  self.forbidden(lambda:insert(self.c,'display_receipts',**args),'DISPLAY_NOT_VISIBLE')
  insert(self.c,'display_receipts',**{**args,'binding_id':self.a['actors']['commander']})
 def test_30_catchup_commit_survives_failed_command(self):
  self.c.execute('BEGIN IMMEDIATE')
  insert(self.c,'events',session_id=self.s,seq=2,event_id=uid(),kind='evidence.expired',mission_ms=60000,state_version=2,actor_kind='rules',payload_json='{}',recorded_at_ms=61000)
  self.c.execute('UPDATE sessions SET mission_ms=60000,state_version=2 WHERE session_id=?',(self.s,));self.c.commit()
  self.c.execute('BEGIN IMMEDIATE');expected=1
  actual=self.c.execute('SELECT state_version FROM sessions WHERE session_id=?',(self.s,)).fetchone()[0]
  if actual!=expected:self.c.rollback()
  self.assertEqual(self.c.execute('SELECT mission_ms,last_event_seq FROM sessions WHERE session_id=?',(self.s,)).fetchone()[:],(60000,2))


 def test_31_all_task_kinds_share_active_role_slot(self):
  task(self.c);self.c.execute('BEGIN IMMEDIATE')
  r=ledger(self.c,self.s,self.a['accounts']['E1:analyst:report'],'reserve')
  self.forbidden(lambda:insert(self.c,'task_requests',session_id=self.s,task_id=uid(),scene_id='E1',commander_binding_id=self.a['actors']['commander'],target_role='analyst',task_kind='request_report',topic_id='public-topic',target_id='N01',report_reservation_id=r,accepted_mission_ms=0,due_mission_ms=1000,created_at_ms=1000),'UNIQUE')
  self.c.rollback();self.assertEqual(self.balance('E1:analyst:report'),(2,1,0))
 def test_32_named_accept_and_complete_investigation(self):
  b=template_bindings(self.c,self.a);run_template(self.c,'accept_investigation',b)
  self.assertEqual(self.balance('drone'),(2,0,1));self.assertEqual(self.balance('E1:analyst:report'),(2,1,0))
  b.update(expected_version=2,mission_ms=30000,now_ms=31000,event_id=uid(),snapshot_id=uid(),request_id=None,public_event_type='report.received')
  run_template(self.c,'complete_investigation',b)
  self.assertEqual(self.balance('E1:analyst:report'),(2,0,1))
  self.assertEqual(self.c.execute('SELECT status FROM task_requests WHERE task_id=?',(b['task_id'],)).fetchone()[0],'completed')
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM reports WHERE session_id=?',(self.s,)).fetchone()[0],1)
 def test_33_named_upload_batch_atomic_and_per_card_events(self):
  rr=[report(self.c,evidence(self.c)) for _ in range(2)]
  b=template_bindings(self.c,self.a);refs=[{'uploadId':uid(),'reportId':r[0],'revision':r[1]} for r in rr]
  b.update(refs_json=json.dumps(refs),upload_events_json=json.dumps([{'eventId':uid(),'data':{}} for _ in refs]))
  run_template(self.c,'upload_batch',b)
  self.assertEqual(self.balance('E1:commander:upload'),(3,0,2))
  self.assertEqual(self.c.execute('SELECT state_version,inbox_version,assistant_context_version,last_event_seq FROM sessions WHERE session_id=?',(self.s,)).fetchone()[:],(2,1,1,3))
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM input_manifest_members WHERE manifest_id=?',(b['manifest_id'],)).fetchone()[0],2)
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM agent_jobs WHERE session_id=?',(self.s,)).fetchone()[0],1)
 def test_34_named_template_stale_precondition_has_no_effect(self):
  b=template_bindings(self.c,self.a);b['expected_version']=999
  self.forbidden(lambda:run_template(self.c,'accept_investigation',b),'CHECK')
  self.assertEqual(self.balance('drone'),(3,0,0));self.assertFalse(self.c.in_transaction)
 def test_35_named_wait_preserves_investigation(self):
  t,i,r=task(self.c);b=template_bindings(self.c,self.a);run_template(self.c,'accept_operation',b)
  self.assertEqual(self.c.execute('SELECT status FROM investigations WHERE investigation_id=?',(i,)).fetchone()[0],'running')
  self.assertEqual(self.balance('E1:analyst:report'),(2,1,0))
  self.assertEqual(self.c.execute('SELECT mission_ms,phase FROM sessions WHERE session_id=?',(self.s,)).fetchone()[:],(0,'resolving'))
 def test_36_named_leave_cancels_without_channel_refund(self):
  t,i,r=task(self.c);b=template_bindings(self.c,self.a)
  b.update(operation_kind='action',action_id='E1_ROUTE',release_entries_json=json.dumps([{'entryId':uid(),'parentEntryId':r,'amount':1}]))
  run_template(self.c,'accept_operation',b)
  self.assertEqual(self.c.execute('SELECT status FROM investigations WHERE investigation_id=?',(i,)).fetchone()[0],'cancelled')
  self.assertEqual(self.balance('E1:analyst:report'),(3,0,0));self.assertEqual(self.balance('drone'),(2,0,1))
 def test_37_named_seal_settles_two_roles_and_freezes(self):
  r1=task(self.c)[2];r2=task(self.c,role='liaison')[2];b=template_bindings(self.c,self.a)
  b['release_entries_json']=json.dumps([{'entryId':uid(),'parentEntryId':r,'amount':1} for r in (r1,r2)])
  run_template(self.c,'seal_session',b)
  self.assertEqual(self.c.execute('SELECT lifecycle,terminal_seal_id FROM sessions WHERE session_id=?',(self.s,)).fetchone()[:],('abandoned',b['seal_id']))
  self.assertEqual(self.balance('E1:analyst:report'),(3,0,0));self.assertEqual(self.balance('E1:liaison:report'),(3,0,0))
  self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])
 def test_38_named_claim_budget_reserved_before_network(self):
  j=advisor(self.c);b=template_bindings(self.c,self.a);b['job_id']=j
  run_template(self.c,'claim_model_attempt',b)
  row=self.c.execute('SELECT status,attempt_no FROM agent_attempts WHERE job_id=?',(j,)).fetchone()
  self.assertEqual(row[:],('sending',1));self.assertFalse(self.c.in_transaction)
 def test_39_named_report_request_has_due_time(self):
  e=evidence(self.c);b=template_bindings(self.c,self.a);b['due_mission_ms']=1000
  run_template(self.c,'accept_report_request',b)
  b.update(expected_version=2,instance_id=e[0],mission_ms=999,now_ms=2000,request_id=None,event_id=uid(),snapshot_id=uid())
  self.forbidden(lambda:run_template(self.c,'complete_report_request',b),'CHECK')
  b['mission_ms']=1000;run_template(self.c,'complete_report_request',b)
  self.assertEqual(self.balance('drone'),(3,0,0));self.assertEqual(self.balance('E1:analyst:report'),(2,0,1))
 def test_40_named_queries_and_reconciliation(self):
  task(self.c);rr=report(self.c,evidence(self.c,role='liaison'),role='liaison');upload(self.c,rr)
  b=template_bindings(self.c,self.a)
  self.assertEqual(self.c.execute(named_sql('queries.sql','quota_reconciliation'),b).fetchall(),[])
  rows=self.c.execute(named_sql('queries.sql','commander_report_cards'),b).fetchall();self.assertEqual(len(rows),1);self.assertEqual(rows[0]['uploaded'],1)
  plans=[r[3] for r in self.c.execute('EXPLAIN QUERY PLAN '+named_sql('queries.sql','due_investigations'),b)]
  self.assertTrue(any('ix_investigation_due' in q for q in plans),plans)


 def test_41_new_launch_can_read_history_not_resume_gameplay(self):
  seal(self.c);launch=uid();insert(self.c,'launches',launch_id=launch,token_hash='e'*64,started_at_ms=2000)
  args=dict(launch_id=launch,session_id=self.s,binding_id=self.a['actors']['commander'],granted_at_ms=2000)
  insert(self.c,'launch_session_access',**args,capability='commander.read')
  insert(self.c,'launch_session_access',**args,capability='evaluation.request')
  self.forbidden(lambda:insert(self.c,'launch_session_access',**args,capability='commander.command'),'GAMEPLAY_ACCESS_ORIGINAL_LAUNCH_ONLY')
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM actor_bindings WHERE session_id=?',(self.s,)).fetchone()[0],3)
 def test_42_postgame_audit_requires_exact_active_seal(self):
  aid=uid();payload={'auditId':aid,'sessionId':self.s,'sealedHash':'a'*64,'createdAt':'2026-09-16T00:00:00Z','eventType':'export.queued','data':{}}
  args=dict(session_id=self.s,diagnostic_id=aid,category='postgame_audit',recorded_at_ms=1000,payload_json=json.dumps(payload))
  self.forbidden(lambda:insert(self.c,'diagnostic_records',**args),'POSTGAME_AUDIT_SEAL_MISMATCH')
  z=seal(self.c);payload['sealedHash']=z;args['payload_json']=json.dumps(payload)
  before=self.c.execute('SELECT last_event_seq FROM sessions WHERE session_id=?',(self.s,)).fetchone()[0]
  insert(self.c,'diagnostic_records',**args)
  self.assertEqual(self.c.execute('SELECT last_event_seq FROM sessions WHERE session_id=?',(self.s,)).fetchone()[0],before)
  self.forbidden(lambda:insert(self.c,'diagnostic_records',**{**args,'diagnostic_id':uid()}),'POSTGAME_AUDIT_SEAL_MISMATCH')


 def test_43_content_version_uuid_mapping_is_required_unique_immutable(self):
  row=self.c.execute(named_sql('queries.sql','session_content_version'),{'session_id':self.s}).fetchone()
  self.assertEqual(row['content_version_id'],IDS['contentVersionId']);self.assertEqual(str(uuid.UUID(row['content_version_id'])),row['content_version_id'])
  self.assertNotEqual(row['content_version_id'],IDS['contentHash'])
  args=dict(content_hash='f'*64,schema_version='0.5',registry_json='{}',created_at_ms=1000)
  self.forbidden(lambda:insert(self.c,'content_versions',**args),'NOT NULL')
  self.forbidden(lambda:insert(self.c,'content_versions',**args,content_version_id=IDS['contentVersionId']),'UNIQUE')
  self.forbidden(lambda:self.c.execute('UPDATE content_versions SET content_version_id=? WHERE content_hash=?',(uid(),IDS['contentHash'])),'IMMUTABLE')
  insert(self.c,'content_versions',**args,content_version_id=uid())

if __name__=='__main__':
 started=time.time();suite=unittest.defaultTestLoader.loadTestsFromTestCase(DatabaseDesignTests)
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 report={'sqliteVersion':sqlite3.sqlite_version,'migrationSha256':sha(MIGRATION.read_text()),'fixtureSha256':sha(SEED.read_text()),'testsRun':result.testsRun,'failures':[{'test':str(t),'traceback':tb} for t,tb in result.failures+result.errors],'passed':result.wasSuccessful(),'elapsedSeconds':round(time.time()-started,3),'scope':'SQLite schema, transactions, invariants and synthetic SQL fixtures only; not game/API/model validation.'}
 (ROOT/'verification/database_test_results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 sys.exit(0 if result.wasSuccessful() else 1)
