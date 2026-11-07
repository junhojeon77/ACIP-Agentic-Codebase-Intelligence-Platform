"""Check the actual CLI wire contract using only Python's standard library."""
import json
import re
import sys

result = json.load(sys.stdin)
assert result['schemaVersion'] == 1
assert result['status'] == 'partial'
assert result['git'] == {'available': False, 'headCommit': None, 'dirty': None}
file = result['projects'][0]['files'][0]
assert file['path'] == 'a.ts'
assert file['status'] == 'partial'
assert file['gitState'] == 'unknown'
assert re.fullmatch(r'[a-f0-9]{64}', file['contentHash'])
assert file['symbols'] == [{'name': 'a', 'kind': 'function', 'startLine': 1, 'endLine': 1}]
assert file['diagnostics'][0]['line'] == 2
assert any(item['reason'] == 'unsupported-javascript' and item['affectsCompleteness'] for item in result['omissions'])
print('contract accepted')
