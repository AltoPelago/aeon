"""Development JSON-lines adapter for explicit portable AEOS entry points."""
from pathlib import Path
import copy
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from aeon.aeos import validate, validate_telex, validate_telex_records
from aeon.telex import encode_telex

failed = False
for line in sys.stdin:
    try:
        request = json.loads(line)
        before = copy.deepcopy(request)
        if request['entrypoint'] == 'legacy':
            result = validate([], request['schema'], request.get('options'))
        elif request['entrypoint'] != 'portable':
            raise ValueError('Unsupported entrypoint')
        elif request['representation'] == 'records':
            result = validate_telex_records(request['records'], request['schema'], request.get('options'))
        elif request['representation'] == 'telex':
            result = validate_telex(encode_telex(request['records']), request['schema'], request.get('options'))
        else:
            raise ValueError('Unsupported representation')
        print(json.dumps({'result':result, 'inputUnchanged':request == before}), flush=True)
    except Exception:
        print(json.dumps({'error':'adapter_failure'}), flush=True)
        failed = True
raise SystemExit(1 if failed else 0)
