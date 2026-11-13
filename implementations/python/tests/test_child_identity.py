"""Read-only candidate vectors; no implicit admission into AEOS or references."""
from pathlib import Path
import copy
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from aeon.sansa import parse_address, render_address, resolve_address
from aeon.core import compile_source

FIXTURES = Path(__file__).parent / 'fixtures' / 'child-identity'

def load(name):
    return json.loads((FIXTURES / name).read_text())


def adapter(name='identity-basic'):
    fixture = copy.deepcopy(next(n for n in load('13-child-identity-resolve.json')['fixtures']['namespaces'] if n['id'] == name))
    nodes, parents, calls = {}, {}, []
    def visit(node, parent=None):
        nodes[node['address']] = node
        if parent is not None:
            parents[id(node)] = parent
        for child in node.get('children', []):
            visit(child, node)
        if node.get('attributeSpace') is not None:
            visit(node['attributeSpace'])
        for space in node.get('localSpaces', {}).values():
            visit(space)
    visit(fixture['root'])
    namespace = dict(root=fixture['root'], children=lambda b: b.get('children', []), attributeSpace=lambda b: b.get('attributeSpace'), localSpace=lambda b, n: b.get('localSpaces', {}).get(n))
    if fixture.get('supportsIdentity'):
        def identity(binding):
            calls.append(binding)
            return binding.get('identity')
        namespace['identity'] = identity
    if fixture.get('supportsParentTraversal'):
        namespace['parent'] = lambda b: parents.get(id(b))
    return namespace, nodes, calls


class ChildIdentityTests(unittest.TestCase):
    def test_embedding_and_canonical_target_preservation(self):
        from aeon.api import load_text, aeon_to_telex, load_telex_text
        from aeon.lexer import tokenize
        from aeon.canonical import canonicalize
        from aeon.portable import adapt_python_assignment_events_to_portable_aes
        def graph(compiled):
            records = adapt_python_assignment_events_to_portable_aes(compiled.events, header=compiled.header, include_headers=False)['events']
            return sorted(json.dumps({k: v for k, v in record.items() if k not in {'span', 'origin'}}, sort_keys=True) for record in records)
        for case in load('embedding-candidate.json')['tests']:
            with self.subTest(case=case['id']):
                tokens = tokenize(case['source'])
                self.assertFalse(tokens.errors)
                self.assertEqual([t.value for t in tokens.tokens if t.kind == 'SANSA_ADDRESS'], case['addresses'])
                self.assertEqual(sum(t.kind == 'STRUCTURAL_IDENTITY' for t in tokens.tokens), case['headIdentities'])
                compiled = compile_source(case['source'])
                self.assertFalse(compiled.errors, compiled.errors)
                canonical = canonicalize(case['source'])
                self.assertFalse(canonical.errors, canonical.errors)
                replay = compile_source(canonical.text)
                self.assertFalse(replay.errors)
                self.assertEqual(graph(compiled), graph(replay))
                self.assertEqual(canonical.text, canonicalize(canonical.text).text)
                direct = load_text(case['source'])
                wire = load_telex_text(aeon_to_telex(case['source']))
                self.assertTrue(direct.ok, direct.compile_errors)
                self.assertTrue(wire.ok, wire.errors)
                self.assertEqual(direct.document, wire.document)

    def test_parser_vectors(self):
        for case in load('12-child-identity-parser.json')['tests']:
            with self.subTest(case=case['id']):
                result = parse_address(case['input']['source'])
                expected = case['expected']
                self.assertEqual(result['ok'], expected['ok'], result)
                if result['ok']:
                    address = result['address']
                    self.assertEqual(address['canonical'], expected['canonical'])
                    self.assertEqual(address['isExact'], expected['exact'])
                    self.assertEqual(address, parse_address(render_address(address))['address'])
                else:
                    for field, key in [('code', 'error'), ('index', 'index')]:
                        if key in expected:
                            self.assertEqual(result['errors'][0][field], expected[key])

    def test_resolve_vectors(self):
        for case in load('13-child-identity-resolve.json')['tests']:
            with self.subTest(case=case['id']):
                options = dict(case['input'])
                namespace, nodes, calls = adapter(options.pop('namespace'))
                source = options.pop('source')
                if 'contextualRoot' in options:
                    options['contextualRoot'] = nodes[options['contextualRoot']]
                self.check_result(resolve_address(source, namespace, options), case['expected'], calls, nodes)

    def check_result(self, result, expected, calls, nodes):
        self.assertEqual(result['ok'], expected['ok'], result)
        self.assertEqual(len(calls), expected['identityCalls'])
        if result['ok']:
            self.assertEqual([b['address'] for b in result['bindings']], expected['addresses'])
            for binding in result['bindings']:
                self.assertIs(binding, nodes[binding['address']])
        else:
            self.assertEqual(result['bindings'], [])
            self.assertEqual(result['errors'][0]['code'], expected['error'])
            for field in ('selectorIndex', 'identity', 'limit', 'observed'):
                if field in expected:
                    self.assertEqual(result['errors'][0].get(field), expected[field], field)

    def test_existing_binding_option_compatibility(self):
        namespace, nodes, _ = adapter()
        for value in (None, -1, True, 1.5, '1', 9_007_199_254_740_992):
            result = resolve_address('$.group', namespace, {'maxBindings': value})
            self.assertTrue(result['ok'], result)
            self.assertIs(result['bindings'][0], nodes['$.group'])
            identity = resolve_address('$.\\group1\\', namespace, {'maxBindings': value})
            self.assertEqual(identity['errors'][0]['code'], 'SANSA_RESOLVE_INVALID_BINDING_LIMIT')
        self.assertTrue(resolve_address('$', namespace, {'maxBindings': 0})['ok'])

    def test_ast_vectors(self):
        for case in load('ast-candidate.json')['tests']:
            with self.subTest(case=case['id']):
                namespace, nodes, calls = adapter()
                self.check_result(resolve_address(case['address'], namespace), case['expected'], calls, nodes)

    def test_lazy_budget_closes_iterator(self):
        counts = dict(pulls=0, reads=0, closes=0)
        def children(_):
            try:
                while True:
                    counts['pulls'] += 1
                    if counts['pulls'] > 3:
                        raise AssertionError('unbounded enumeration')
                    yield {}
            finally:
                counts['closes'] += 1
        def identity(_):
            counts['reads'] += 1
        result = resolve_address('$.\\missing\\', dict(root={'address': '$'}, children=children, identity=identity), {'maxIdentityInspections': 2})
        self.assertEqual(result['errors'][0]['code'], 'SANSA_RESOLVE_IDENTITY_LIMIT_EXCEEDED')
        self.assertEqual(result['errors'][0]['observed'], 3)
        self.assertEqual(counts, dict(pulls=3, reads=2, closes=1))

    def test_default_budget(self):
        for size in (10000, 10001):
            calls = []
            namespace = dict(root={'address': '$'}, children=lambda _: ({} for i in range(size)), identity=lambda b: calls.append(b))
            result = resolve_address('$.\\missing\\', namespace)
            self.assertEqual(result['ok'], size == 10000)
            self.assertEqual(len(calls), 10000)

    def test_opaque_identity_does_not_enable_selection(self):
        result = resolve_address('$.\\x\\', {'root': {'children': [{'identity': 'x', 'name': 'x'}]}})
        self.assertEqual(result['errors'][0]['code'], 'SANSA_RESOLVE_UNSUPPORTED_IDENTITY')

    def test_ast_size_checked_before_selector_iteration(self):
        class TooMany(list):
            def __iter__(self):
                raise AssertionError('oversized caller list must not be traversed')
        namespace, _, calls = adapter()
        base = parse_address('$.\\group1\\')['address']
        base['selectors'] = TooMany(base['selectors'] * 1025)
        self.assertEqual(resolve_address(base, namespace)['errors'][0]['code'], 'SANSA_RESOLVE_INVALID_ADDRESS')
        self.assertFalse(calls)

    def test_bounded_caller_ast(self):
        namespace, _, calls = adapter()
        base = parse_address('$.\\group1\\')['address']
        cyclic = {'terms': []}
        cyclic['terms'].append(cyclic)
        for change in ({'selectors': base['selectors'] * 1025}, {'qualifierExpression': cyclic}, {'selectors': [dict(type='member', name='a' * 65537)] + base['selectors']}):
            result = resolve_address({**base, **change}, namespace)
            self.assertEqual(result['errors'][0]['code'], 'SANSA_RESOLVE_INVALID_ADDRESS')
        self.assertEqual(calls, [])

    def test_reorder_retains_occurrence_and_move_out_misses(self):
        namespace, nodes, _ = adapter()
        group, selected = nodes['$.group'], nodes['$.group[0]']
        group['children'].reverse()
        self.assertIs(resolve_address('$.group.\\item1\\', namespace)['bindings'][0], selected)
        group['children'].remove(selected)
        self.assertEqual(resolve_address('$.group.\\item1\\', namespace)['bindings'], [])

    def test_aeos_selector_identity_and_required_prefix_miss(self):
        from aeon.aeos import validate_events
        compiled = compile_source('group\\group1\\ = 1')
        self.assertFalse(compiled.errors)
        for selector in ('$.\\group1\\', '$.missing.\\group1\\'):
            result = validate_events(compiled.events, {'rules': [{'selector': selector, 'constraints': {'required': True}}]})
            if selector == '$.\\group1\\':
                self.assertTrue(result['ok'], result)
            else:
                self.assertFalse(result['ok'])
                self.assertIn('missing_required_field', [e['code'] for e in result['errors']])

    def test_reference_identity_still_rejected(self):
        for sigil in ('~', '~>'):
            result = compile_source('group\\group1\\ = 1\ncopy = ' + sigil + '$.\\group1\\')
            self.assertTrue(result.errors)

if __name__ == '__main__':
    unittest.main()
