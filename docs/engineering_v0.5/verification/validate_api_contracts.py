#!/usr/bin/env python3
"""Offline structural contract checks. No game runtime/HTTP behavior is tested."""
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse, unquote
import json
import sys
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from openapi_spec_validator import validate

ROOT=Path(__file__).resolve().parents[1]
results=[]
def load(uri):
    parsed=urlparse(uri)
    if parsed.scheme!='file':raise ValueError('Network reference is not allowed: '+uri)
    path=Path(unquote(parsed.path)).resolve()
    if not path.is_relative_to(ROOT):raise ValueError('Reference escapes bundle: '+str(path))
    return json.loads(path.read_text())
def retrieve(uri):return Resource.from_contents(load(uri))
registry=Registry(retrieve=retrieve)

def pointer(doc,fragment):
    if not fragment:return doc
    if not fragment.startswith('/'):raise ValueError('Only local JSON pointers supported: '+fragment)
    for part in fragment[1:].split('/'):
        part=part.replace('~1','/').replace('~0','~')
        doc=doc[int(part)] if isinstance(doc,list) else doc[part]
    return doc

def walk(value):
    yield value
    if isinstance(value,dict):
        for child in value.values():yield from walk(child)
    elif isinstance(value,list):
        for child in value:yield from walk(child)

schemas=list((ROOT/'contracts').glob('*.schema.json'))+[ROOT/'agents'/'contracts.schema.json']
for path in schemas:
    data=json.loads(path.read_text())
    Draft202012Validator.check_schema(data)
    for item in walk(data):
        if isinstance(item,dict) and '$ref'in item:
            uri,frag=urldefrag(urljoin(path.as_uri(),item['$ref']))
            pointer(load(uri),frag)
        if isinstance(item,dict) and item.get('type')=='object':
            assert item.get('additionalProperties') is False, (path.name,'open object',item)
    results.append({'check':'schema_closed_and_refs','file':str(path.relative_to(ROOT)),'passed':True})

oas_path=ROOT/'api'/'openapi.json';oas=json.loads(oas_path.read_text())
assert oas['openapi']=='3.1.1'
validate(oas,base_uri=oas_path.as_uri())
results.append({'check':'openapi_spec_validator','version':'3.1.1','passed':True})

def check_instance(schema_uri,value):
    v=Draft202012Validator({'$ref':schema_uri},registry=registry,format_checker=FormatChecker())
    return list(v.iter_errors(value))

total=negative=0
for fixture in sorted((ROOT/'contracts'/'fixtures').glob('*-cases.json')):
    for case in json.loads(fixture.read_text())['cases']:
        uri=urljoin((ROOT/'contracts'/'').as_uri()+'/',case['schema'])
        errors=check_instance(uri,case['instance'])
        if bool(errors)==case['valid']:
            text='; '.join(str(e.message)for e in errors[:3])
            raise AssertionError(f"{fixture.name}:{case['name']}: expected valid={case['valid']}; {text}")
        total+=1;negative+=not case['valid']
results.append({'check':'fixture_schema_validity','cases':total,'negative':negative,'passed':True})

op_count=examples=0
for route,pathitem in oas['paths'].items():
    for method,op in pathitem.items():
        if method not in ['get','post']:continue
        op_count+=1
        assert op.get('operationId') and op.get('responses') and op.get('x-authorization')
        if method=='post':
            assert op['requestBody']['required'] is True
            refs=[p.get('$ref','')for p in op['parameters']]
            assert '#/components/parameters/IdempotencyKey' in refs
            assert '{sessionId}'not in route or '#/components/parameters/RunEpoch'in refs
        media=list(op.get('requestBody',{}).get('content',{}).values())
        for response in op['responses'].values():
            if '$ref'in response:
                uri,frag=urldefrag(urljoin(oas_path.as_uri(),response['$ref']))
                response=pointer(load(uri),frag)
            media+=list(response.get('content',{}).values())
        for m in media:
            if 'x-event-schema'in m:
                data_line=next(l[6:]for l in m['example'].splitlines()if l.startswith('data: '))
                schema_uri=urljoin(oas_path.as_uri(),m['x-event-schema']['$ref'])
                errors=check_instance(schema_uri,json.loads(data_line))
            elif '$ref'in m['schema']:
                schema_uri=urljoin(oas_path.as_uri(),m['schema']['$ref'])
                errors=check_instance(schema_uri,m['example'])
            else:continue
            assert not errors, (method,route,[e.message for e in errors[:2]])
            examples+=1
assert op_count==23,op_count
results.append({'check':'endpoint_auth_idempotency_and_examples','operations':op_count,'examples':examples,'passed':True})

report={'scope':'Static schemas, closed shapes, local refs, OpenAPI, request/response/SSE examples only. NOT runtime game/API tests.','results':results}
output=ROOT/'verification'/'api-contract-results.json'
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
