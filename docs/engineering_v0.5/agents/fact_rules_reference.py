"""Executable reference for documented feature rules; not a game engine or validated test.
Feature extraction MUST follow LLD from immutable human-visible snapshots.
No outcome, hidden truth, model correctness or NPC optimization is accepted here.
"""
DIMENSIONS=('complacency','distrust','overCaution','calibratedTrust')
FIELDS={'contextId','sceneId','controllerKind','kind','adviceShownBefore','adviceHasAction',
'recommendationLegal','chosenMatchesAdvice','visibleGapPresent','availableRelevantCheckCount',
'checkKnownAffordable','adequateVisibleAdviceSupport','visibleCurrentCounterEvidence',
'costDisplayed','checkLowValueByPublicRule','checkRefreshesExpiredEvidence','reasonCodes',
'usedEvidenceInReason','acknowledgedLimitation','comparedKnownCosts','technicalIssue',
'coverageComplete','unobservedCommunication'}

def classify_context(f):
    if set(f)!=FIELDS: raise ValueError('FEATURE_FIELDS_MISMATCH')
    if f['controllerKind'] not in ('human','npc'): raise ValueError('CONTROLLER_KIND')
    result={d:{'eligible':False,'support':False,'counterevidence':False,'excluded':False} for d in DIMENSIONS}
    if f['controllerKind']!='human' or f['technicalIssue'] or not f['coverageComplete']:
        for r in result.values():r['excluded']=True
        return result
    reason=set(f['reasonCodes']); route=f['kind']=='route_decision'
    reason_unknown='no_reason' in reason
    visible_advice=route and f['adviceShownBefore'] and f['adviceHasAction'] and f['recommendationLegal']
    r=result['complacency']
    r['eligible']=bool(visible_advice and f['visibleGapPresent'] and f['availableRelevantCheckCount']>0 and f['checkKnownAffordable'])
    r['excluded']=f['unobservedCommunication'] or reason_unknown
    r['counterevidence']=r['eligible'] and ('accepted_uncertainty_for_time' in reason or f['usedEvidenceInReason'])
    r['support']=bool(r['eligible'] and not r['excluded'] and not r['counterevidence'] and f['chosenMatchesAdvice'] and 'ai_said_so' in reason)
    r=result['distrust']
    r['eligible']=bool(visible_advice and f['adequateVisibleAdviceSupport'])
    r['excluded']=f['unobservedCommunication'] or reason_unknown
    r['counterevidence']=r['eligible'] and (f['visibleCurrentCounterEvidence'] or bool(reason&{'accepted_uncertainty_for_time','evidence_supported'}))
    r['support']=bool(r['eligible'] and not r['excluded'] and not r['counterevidence'] and not f['chosenMatchesAdvice'] and 'prior_ai_error_only' in reason)
    r=result['overCaution']
    r['eligible']=bool(f['kind'] in ('investigation_request','wait') and f['costDisplayed'] and f['checkKnownAffordable'] and f['checkLowValueByPublicRule'])
    r['excluded']=f['unobservedCommunication'] or f['checkRefreshesExpiredEvidence'] or reason_unknown
    r['counterevidence']=r['eligible'] and ('new_question' in reason or f['checkRefreshesExpiredEvidence'])
    r['support']=bool(r['eligible'] and not r['excluded'] and not r['counterevidence'] and 'no_new_question' in reason)
    r=result['calibratedTrust']
    r['eligible']=bool(route and f['usedEvidenceInReason'] and f['acknowledgedLimitation'] and f['comparedKnownCosts'])
    r['excluded']=reason_unknown
    r['counterevidence']=r['eligible'] and bool(reason&{'ai_said_so','prior_ai_error_only'})
    r['support']=bool(r['eligible'] and not r['excluded'] and not r['counterevidence'] and bool(reason&{'evidence_supported','accepted_uncertainty_for_time'}))
    return result

def aggregate(features):
    rows=[(f,classify_context(f)) for f in features]
    out={}
    for d in DIMENSIONS:
        eligible=[f for f,r in rows if r[d]['eligible']]
        # Keep the first chronological supported context per scene; do not inflate with clicks.
        support={}
        for f,r in rows:
            if r[d]['support']:support.setdefault(f['sceneId'],f['contextId'])
        n=len(support)
        level='not_assessable' if not eligible else 'not_observed' if n==0 else 'observed_once' if n==1 else 'repeated_observation'
        out[d]={'eligibleOpportunities':len(eligible),'supportContextRefs':list(support.values()),'supportLevel':level}
    return out
