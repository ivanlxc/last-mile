"""Deterministic post-projection context assembly. Callers must supply allowlisted views.
Never pass a session/world/database object to this function.
"""
import copy,hashlib,json
from contract_guards import guard_advisor_input

def canonical_json(value):
    # Contract uses integers, strings, arrays, booleans and null; no floating numbers.
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def input_hash(value):
    x=copy.deepcopy(value);x.pop('inputHash',None)
    return hashlib.sha256(canonical_json(x).encode('utf-8')).hexdigest()
def assemble_advisor_input(*,session_id,scene_id,context_version,public_task,backgrounds,evidence,statements,question):
    if len(evidence)>5:raise ValueError('UPLOAD_MANIFEST_TOO_LARGE')
    # Reference profile does not recycle model-written text as a new evidence source.
    payload={'schemaVersion':'0.5','sessionId':session_id,'sceneId':scene_id,'inputHash':'0'*64,
             'contextVersion':context_version,'publicTask':copy.deepcopy(public_task),
             'backgrounds':copy.deepcopy(backgrounds),'evidence':copy.deepcopy(evidence),
             'statements':copy.deepcopy(statements[-12:]),'question':copy.deepcopy(question),'priorAnalysis':None}
    payload['inputHash']=input_hash(payload);guard_advisor_input(payload)
    return payload
