"""Check the actual CLI wire contract using only Python's standard library."""
import json
import re
import sys

result = json.load(sys.stdin)
assert result['schemaVersion'] == 2
assert result['status'] == 'partial'
assert result['git'] == {'available': False, 'headCommit': None, 'dirty': None}
file = result['projects'][0]['files'][0]
assert file['path'] == 'a.ts'
assert file['status'] == 'partial'
assert file['gitState'] == 'unknown'
assert re.fullmatch(r'[a-f0-9]{64}', file['contentHash'])
symbol = file['symbols'][0]
assert {key: symbol[key] for key in ('name', 'kind', 'startLine', 'endLine')} == {
    'name': 'a', 'kind': 'function', 'startLine': 1, 'endLine': 1,
}
assert symbol['parentSymbolId'] is None
assert symbol['startOffset'] == 0 and symbol['endOffset'] == 22
assert file['relationships'] == []
assert file['diagnostics'][0]['line'] == 2
assert any(item['reason'] == 'unsupported-javascript' and item['affectsCompleteness'] for item in result['omissions'])
files = {(project['id'], item['path']): item
         for project in result['projects'] for item in project['files']}
symbols = {symbol['id']: (project_id, path, symbol)
           for (project_id, path), item in files.items() for symbol in item['symbols']}
assert len(symbols) == sum(len(item['symbols']) for item in files.values())
for (project_id, path), item in files.items():
    for symbol in item['symbols']:
        assert re.fullmatch(r'[a-f0-9]{64}', symbol['id'])
        assert 0 <= symbol['startOffset'] < symbol['endOffset']
        parent = symbol['parentSymbolId']
        assert parent is None or symbols[parent][:2] == (project_id, path)
    for relation in item['relationships']:
        assert relation['kind'] in ('imports', 'references', 'calls')
        assert 0 <= relation['startOffset'] < relation['endOffset']
        assert 1 <= relation['startLine'] <= relation['endLine']
        source_id = relation['sourceSymbolId']
        assert source_id is None or symbols[source_id][:2] == (project_id, path)
        target = relation['target']
        if relation['resolution'] == 'static':
            assert relation['reason'] is None
            assert (target['projectId'], target['path']) in files
            if target['symbolId'] is not None:
                assert symbols[target['symbolId']][:2] == (target['projectId'], target['path'])
        else:
            assert relation['resolution'] in ('external', 'dynamic', 'unresolved', 'unsupported')
            assert target is None and relation['reason']
auth = next(item for (_, path), item in files.items() if path == 'auth.ts')
calls = [relation for relation in auth['relationships'] if relation['kind'] == 'calls']
assert [relation['resolution'] for relation in calls] == ['static', 'dynamic']
assert symbols[calls[0]['target']['symbolId']][2]['name'] == 'findUser'
print('contract accepted')
