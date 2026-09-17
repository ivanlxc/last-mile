"""Deterministic reference guards, used by fixtures. JSON Schema runs before these.
These guards check IDs, versions, context ownership and counts, NOT free-text truth.
"""
def require(ok,code):
    if not ok: raise ValueError(code)
def evidence_key(x): return (x['instanceId'],x['revision'])
def guard_advisor_input(inp):
    require(inp['priorAnalysis'] is None,'PRIOR_ANALYSIS_DISABLED_IN_REFERENCE_PROFILE')
    evidence=set(map(evidence_key,inp['evidence']))
    require(len(evidence)==len(inp['evidence']),'DUPLICATE_EVIDENCE')
    require(all(e['sceneId']==inp['sceneId'] for e in inp['evidence']),'WRONG_SCENE_EVIDENCE')
    for e in inp['evidence']:
        for edge in e['knownSourceEdges']:
            require(evidence_key(edge['fromRef']) in evidence and evidence_key(edge['toRef']) in evidence,'PROVENANCE_ENDPOINT_NOT_UPLOADED')
            if edge['relation']!='possibly_related':
                require(edge['findingRef'] is not None,'PROVENANCE_WITHOUT_FINDING')
            if edge['findingRef'] is not None:
                require(evidence_key(edge['findingRef']) in evidence,'PROVENANCE_FINDING_NOT_UPLOADED')
                finding=next(x for x in inp['evidence'] if evidence_key(x)==evidence_key(edge['findingRef']))
                require(finding['observationType'] in ('provenance_finding','correction'),'REFERENCE_IS_NOT_PROVENANCE_FINDING')
    require(set(map(evidence_key,inp['question']['selectedEvidenceRefs']))<=evidence,'QUESTION_REFERENCE_NOT_UPLOADED')
    return True
def guard_advice(inp,out):
    guard_advisor_input(inp)
    require(out['sessionId']==inp['sessionId'] and out['inputHash']==inp['inputHash'],'ADVICE_INPUT_MISMATCH')
    allow={('evidence',e['instanceId'],e['revision']) for e in inp['evidence']}
    allow|={('background',e['backgroundId'],e['revision']) for e in inp['backgrounds']}
    allow|={('statement',e['statementId'],e['revision']) for e in inp['statements']}
    claims={c['claimId']:c for c in out['claims']}
    require(len(claims)==len(out['claims']),'DUPLICATE_CLAIM_ID')
    for c in out['claims']:
        for r in c['citations']:require((r['kind'],r['refId'],r['revision']) in allow,'CITATION_NOT_IN_MANIFEST')
    action=out['recommendation']['actionId']
    require(action is None or action in {a['actionId'] for a in inp['publicTask']['actions']},'ACTION_NOT_PUBLIC')
    for cid in out['recommendation']['claimRefs']:require(cid in claims,'UNKNOWN_CLAIM_REF')
    targets={(c['channel'],t) for c in inp['publicTask']['channelCapabilities'] for t in c['publicTargetIds']}
    for p in out['investigationSuggestions']:
        require((p['channel'],p['publicTargetId']) in targets,'UNKNOWN_INVESTIGATION_TARGET')
        for cid in p['claimRefs']:require(cid in claims,'UNKNOWN_CLAIM_REF')
    return True

def guard_evaluation(inp,out):
    require(all(out[k]==inp[k] for k in ('sessionId','sealedHash','rubricVersion')),'EVALUATION_INPUT_MISMATCH')
    contexts={c['contextId']:c for c in inp['contexts']};facts={f['factId']:f for f in inp['facts']}
    require(len(contexts)==len(inp['contexts']) and len(facts)==len(inp['facts']),'DUPLICATE_CONTEXT_OR_FACT')
    for c in contexts.values():
        require(c['subjectBindingId']==inp['subjectBindingId'],'WRONG_EVALUATION_SUBJECT')
        require(c['chosenActionId'] in c['legalActionIds'],'CHOSEN_ACTION_NOT_LEGAL')
        require((c['displayedAdviceId'] is None)==(c['displayedAdviceAtMs'] is None),'ADVICE_RECEIPT_INCOMPLETE')
        require(c['displayedAdviceAtMs'] is None or c['displayedAdviceAtMs']<=c['cutoffMissionMs'],'FUTURE_ADVICE')
    def fact(fid,cid=None):
        require(fid in facts,'UNKNOWN_FACT_REF');f=facts[fid]
        require(f['contextId'] in contexts,'UNKNOWN_FACT_CONTEXT');c=contexts[f['contextId']]
        require(cid is None or f['contextId']==cid,'FACT_CONTEXT_MISMATCH')
        require(fid in c['factRefs'],'FACT_NOT_IN_CONTEXT')
        require(f['availableAtMissionMs']<=c['cutoffMissionMs'] and f['cutoffMissionMs']==c['cutoffMissionMs'],'FUTURE_FACT')
        require(c['subjectBindingId']==inp['subjectBindingId'],'WRONG_EVALUATION_SUBJECT')
        require(set(map(evidence_key,f['evidenceRefs']))<=set(map(evidence_key,c['playerVisibleRefs'])),'FACT_EVIDENCE_NOT_VISIBLE')
        return f
    # Validate input facts too: a model cannot launder a bad fact by omitting its citation.
    for fid in facts:fact(fid)
    supported=0
    for d,r in out['dimensions'].items():
        b=inp['bounds'][d]
        require(b['eligibleOpportunities']==len(b['eligibleContextRefs']),'BOUND_OPPORTUNITY_COUNT_MISMATCH')
        require(set(b['eligibleContextRefs'])<=set(contexts),'UNKNOWN_ELIGIBLE_CONTEXT')
        require(all(a['contextId'] in b['eligibleContextRefs'] for a in b['supportCandidates']),'INELIGIBLE_SUPPORT_CANDIDATE')
        require(r['eligibleOpportunities']==b['eligibleOpportunities'],'OPPORTUNITY_COUNT_MISMATCH')
        require(r['supportLevel'] in b['allowedSupportLevels'],'SUPPORT_ABOVE_BOUND')
        candidates={a['contextId']:set(a['factRefs']) for a in b['supportCandidates']}
        picked=r['supportContextRefs'];pickedfacts=set(r['supportFactRefs'])
        require(len(picked)==len(set(picked)) and set(picked)<=set(candidates),'SUPPORT_CONTEXT_NOT_CANDIDATE')
        require(len(picked)<=r['eligibleOpportunities'],'MORE_SUPPORT_THAN_OPPORTUNITIES')
        for cid in picked:
            require(cid in contexts,'UNKNOWN_CONTEXT')
            selected=pickedfacts&candidates[cid]
            require(bool(selected),'CONTEXT_WITHOUT_SUPPORT_FACT')
            for fid in selected:fact(fid,cid)
        require(pickedfacts<=set().union(*(candidates[x] for x in picked)) if picked else not pickedfacts,'UNBOUND_SUPPORT_FACT')
        scenes=[contexts[cid]['sceneId'] for cid in picked]
        require(len(scenes)==len(set(scenes)),'REPEATED_SAME_SCENE')
        n=len(picked)
        expected='not_assessable' if r['eligibleOpportunities']==0 else 'not_observed' if n==0 else 'observed_once' if n==1 else 'repeated_observation'
        require(r['supportLevel']==expected,'SUPPORT_LEVEL_COUNT_MISMATCH')
        require(set(r['counterevidenceRefs'])<=set(b['counterevidenceRefs']),'COUNTEREVIDENCE_NOT_ALLOWED')
        for fid in r['counterevidenceRefs']:fact(fid)
        supported+=n>0
    expected='insufficient_evidence' if not supported else 'limited_pattern' if supported==1 else 'mixed'
    require(out['overallPattern']==expected and expected in inp['allowedOverallPatterns'],'OVERALL_PATTERN_MISMATCH')
    for m in out['keyMoments']:
        require(m['contextId'] in contexts,'UNKNOWN_CONTEXT')
        for fid in m['factRefs']:fact(fid,m['contextId'])
    for a in out['nextAttempts']:
        for fid in a['basisRefs']:fact(fid)
    return True

def readonly_tool(name,args,inp,*,stale=False,remaining_steps=2):
    if stale:return {'ok':False,'code':'STALE_JOB'}
    if remaining_steps<=0:return {'ok':False,'code':'TOOL_BUDGET_EXHAUSTED'}
    if name=='readUploadedEvidence':
        val=next((e for e in inp['evidence'] if evidence_key(e)==evidence_key(args['evidenceRef'])),None)
    elif name=='readBackgroundRecord':
        val=next((b for b in inp['backgrounds'] if b['backgroundId']==args['backgroundId'] and b['revision']==args['revision']),None)
    elif name=='listPublicActions':val=inp['publicTask']['actions']
    elif name=='listChannelCapabilities':val=inp['publicTask']['channelCapabilities']
    else:val=None
    return {'ok':True,'value':val} if val is not None else {'ok':False,'code':'REFERENCE_NOT_AUTHORIZED'}
