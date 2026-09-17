"""Deterministic display fallback. Never masquerades as a live model answer."""
from contract_guards import guard_advice, guard_evaluation
DIMENSIONS=('complacency','distrust','overCaution','calibratedTrust')
def advisor_fallback(inp):
    # Abstention: no automatic route selection and no unseen facts.
    out={'sessionId':inp['sessionId'],'inputHash':inp['inputHash'],
         'summary':'当前使用离线资料检查模板。请直接核对已上传卡片的观察范围和限制。',
         'claims':[],'recommendation':{'actionId':None,'rationale':'模板不生成路线建议；请结合你实际掌握的资料与成本作出选择。','claimRefs':[],'conditions':[]},
         'uncertainties':['模板没有推断当前世界状态，未获知指挥官私有时间、伤情和资源。'],
         'investigationSuggestions':[],'changeSummary':'离线模板，不是模型分析。'}
    guard_advice(inp,out);return out

def evaluator_fallback(inp):
    contexts={c['contextId']:c for c in inp['contexts']}; facts={f['factId']:f for f in inp['facts']}
    dims={}; moments=[]; supported=0
    for key in DIMENSIONS:
        b=inp['bounds'][key];seen=set();picked=[];ids=[]
        for c in b['supportCandidates']:
            scene=contexts[c['contextId']]['sceneId']
            if scene in seen:continue
            seen.add(scene);picked.append(c['contextId']);ids.extend(c['factRefs'])
        count=len(picked)
        level='not_assessable' if b['eligibleOpportunities']==0 else 'not_observed' if not count else 'observed_once' if count==1 else 'repeated_observation'
        if level not in b['allowedSupportLevels']:
            picked=[];ids=[];level='not_assessable' if b['eligibleOpportunities']==0 else 'not_observed'
        supported+=bool(picked)
        dims[key]={'supportLevel':level,'eligibleOpportunities':b['eligibleOpportunities'],'supportContextRefs':picked,'supportFactRefs':list(dict.fromkeys(ids)),
                   'counterevidenceRefs':b['counterevidenceRefs'],
                   'explanation':('规则在当时记录中找到可引用的观察。' if picked else '当前记录不足以支持本维度的行为观察。'),
                   'uncertainties':['离线规则摘要；自报与操作不证明真实动机，也不是心理诊断。']}
        if picked and len(moments)<4:
            selected=[f for f in ids if facts[f]['contextId']==picked[0]]
            moments.append({'contextId':picked[0],'factRefs':selected,'explanation':'可查看这些当时记录；不使用后来才公开的信息或最终结局。'})
    out={'sessionId':inp['sessionId'],'sealedHash':inp['sealedHash'],'rubricVersion':inp['rubricVersion'],
         'summary':'这是确定性规则生成的本局观察摘要，供复盘使用。',
         'overallPattern':'insufficient_evidence' if not supported else 'limited_pattern' if supported==1 else 'mixed',
         'dimensions':dims,'keyMoments':moments,'nextAttempts':[],
         'limitations':['离线模板，不是独立模型评价。','本游戏行为规则未经心理测量验证，不代表稳定人格或真实行动能力。']}
    guard_evaluation(inp,out);return out
