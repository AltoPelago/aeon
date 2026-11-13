#!/usr/bin/env python3
"""Build an offline pure-Python wheel and verify an isolated installed consumer.

Run with a supported interpreter with pip, setuptools>=68 and wheel available.
No registry access, package publication or implementation source import fallback.
"""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONSUMER = r'''
from pathlib import Path
import json, sys
import aeon
from aeon.core import compile_source, CompileOptions
from aeon.canonical import canonicalize, CanonicalizeOptions
from aeon.portable import adapt_python_assignment_events_to_portable_aes
from aeon.sansa import parse_address
assert Path(aeon.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), aeon.__file__
vectors=json.loads(Path('vectors.json').read_text())
def graph(source, headers):
    result=compile_source(source, CompileOptions(max_attribute_depth=8))
    assert not result.errors, result.errors
    events=adapt_python_assignment_events_to_portable_aes(result.events,header=result.header,include_headers=headers)['events']
    return sorted(json.dumps({k:v for k,v in event.items() if k not in {'span','origin'}},sort_keys=True) for event in events)
for case in vectors['cases']:
    result=compile_source(case['source'],CompileOptions(max_attribute_depth=8))
    assert case['ok']==(not result.errors), (case['id'],result.errors)
    if not case['ok']:
        assert case['code'] in [e.code for e in result.errors], case['id']
        continue
    refs=[e['value'] for e in result.events if isinstance(e.get('value'),dict) and e['value'].get('type') in {'CloneReference','PointerReference'}]
    target=[{'type':'attr','key':x['attribute']} if isinstance(x,dict) else x for x in case['target']]
    assert [ref['path'] for ref in refs]==[target], case['id']
    canonical=canonicalize(case['source'],CanonicalizeOptions(max_attribute_depth=8))
    assert not canonical.errors, (case['id'],canonical.errors)
    assert canonical.text==canonicalize(canonical.text,CanonicalizeOptions(max_attribute_depth=8)).text
    assert graph(case['source'],result.header is not None)==graph(canonical.text,result.header is not None), case['id']
indexes=json.loads(Path('indexes.json').read_text())
for case in indexes['cases']:
    assert parse_address('$.items'+case['spelling'])['ok']==case['accept'], case
    from aeon.lexer import tokenize
    from aeon.parser import parse_tokens
    for marker in ['~','~>']:
        source='copy='+marker+'items'+case['spelling'];lexed=tokenize(source);parsed=parse_tokens(source,lexed.tokens)
        assert (not(lexed.errors or parsed.errors))==case['accept'], case
print(json.dumps({'status':'pass','python':sys.version,'module':aeon.__file__,'vectors':len(vectors['cases']),'indexes':len(indexes['cases'])}))
'''

def main():
    dest=Path(tempfile.mkdtemp(prefix='aeon-python-reference-wheel-'))
    env={key:value for key,value in os.environ.items() if key not in {'PYTHONPATH','PYTHONHOME'}}
    def run(args, **kwargs):
        return subprocess.run(args,env=env,check=True,**kwargs)
    run([sys.executable,'-m','pip','wheel','--no-index','--no-build-isolation','--no-deps','--wheel-dir',str(dest/'wheels'),str(ROOT/'implementations/python')])
    wheel,=list((dest/'wheels').glob('*.whl'))
    run([sys.executable,'-m','venv',str(dest/'venv')])
    python=dest/'venv/bin/python'
    run([str(python),'-m','pip','install','--no-index','--no-deps',str(wheel)])
    (dest/'consumer.py').write_text(CONSUMER)
    for source,target in [('reference-structural-paths.json','vectors.json'),('reference-path-indexes.json','indexes.json')]:
        (dest/target).write_bytes((ROOT/'test-fixtures'/source).read_bytes())
    result=run([str(python),'-I',str(dest/'consumer.py')],cwd=dest,capture_output=True,text=True)
    report={'status':'pass','publication':False,'network':False,'wheel':str(wheel),'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest(),'consumer':json.loads(result.stdout),'artifacts':str(dest)}
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
