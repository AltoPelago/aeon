"""Stage-one structural reference syntax and target preservation contract."""
from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from aeon.lexer import tokenize
from aeon.parser import parse_tokens
from aeon.core import compile_source, CompileOptions
from aeon.canonical import canonicalize, CanonicalizeOptions
from aeon.portable import adapt_python_assignment_events_to_portable_aes
from aeon.sansa import parse_address

FIXTURES = ROOT.parents[1] / 'test-fixtures'


def graph(source, include_headers):
    result = compile_source(source, CompileOptions(max_attribute_depth=8))
    if result.errors:
        raise AssertionError(result.errors)
    events = adapt_python_assignment_events_to_portable_aes(result.events, header=result.header, include_headers=include_headers)['events']
    return sorted(json.dumps({k: v for k, v in event.items() if k not in {'span', 'origin'}}, sort_keys=True) for event in events)


class StructuralReferencePaths(unittest.TestCase):
    def test_shared_index_spellings_in_both_wrappers(self):
        fixtures = json.loads((FIXTURES / 'reference-path-indexes.json').read_text())
        for case in fixtures['cases']:
            for marker in ['~', '~>']:
                with self.subTest(case=case, marker=marker):
                    source = 'copy=' + marker + 'items' + case['spelling']
                    lexed = tokenize(source)
                    result = parse_tokens(source, lexed.tokens)
                    self.assertEqual(case['accept'], not (lexed.errors or result.errors))
            with self.subTest(sansa=case):
                self.assertEqual(case['accept'], parse_address('$.items' + case['spelling'])['ok'])

    def test_unsupported_reference_selection(self):
        for path in ['$', '?', '?.item', '$.items.*', '$.items.**', '$.items.^', '$.items[0..1]', '$.items:csv', '$.items#Text', '$.items%StringLiteral', '$.\\id\\', '$.\\id\\.\\name\\']:
            for marker in ['~', '~>']:
                with self.subTest(path=path, marker=marker):
                    source = 'copy=' + marker + path
                    lexed = tokenize(source)
                    parsed = parse_tokens(source, lexed.tokens)
                    self.assertTrue(lexed.errors or parsed.errors)

    def test_shared_source_vectors_and_targets(self):
        fixtures = json.loads((FIXTURES / 'reference-structural-paths.json').read_text())
        for case in fixtures['cases']:
            with self.subTest(vector=case['id']):
                result = compile_source(case['source'], CompileOptions(max_attribute_depth=8))
                self.assertEqual(case['ok'], not result.errors, result.errors)
                if not case['ok']:
                    self.assertIn(case['code'], [e.code for e in result.errors])
                    continue
                expected = [{'type': 'attr', 'key': x['attribute']} if isinstance(x, dict) else x for x in case['target']]
                references = [event['value'] for event in result.events if isinstance(event.get('value'), dict) and event['value'].get('type') in {'CloneReference', 'PointerReference'}]
                self.assertEqual([expected], [ref['path'] for ref in references])
                canonical = canonicalize(case['source'], CanonicalizeOptions(max_attribute_depth=8))
                self.assertEqual([], canonical.errors)
                self.assertEqual(canonical.text, canonicalize(canonical.text, CanonicalizeOptions(max_attribute_depth=8)).text)
                lexed = tokenize(case['source'])
                document = parse_tokens(case['source'], lexed.tokens, max_attribute_depth=8).document
                include_headers = document.header is not None
                self.assertEqual(graph(case['source'], include_headers), graph(canonical.text, include_headers))

    def test_numeric_values_and_quoted_keys_unchanged(self):
        source = 'value=1_000\nitems={"1.5"=1,"-0"=2}\na=~items.["1.5"]\nb=~items["-0"]'
        self.assertEqual([], compile_source(source).errors)

    def test_native_index_error_span_is_original_token(self):
        # Use a quoted Unicode key so lexical codepoint offsets remain meaningful.
        source = '"😀key"=1\ncopy=~items[1_000]'
        result = parse_tokens(source, tokenize(source).tokens)
        self.assertEqual(1, len(result.errors))
        error = result.errors[0]
        self.assertEqual('SYNTAX_ERROR', error.code)
        self.assertEqual('1_000', source[error.span.start.offset:error.span.end.offset])

    def test_standalone_sansa_nonreference_operators_and_bounds(self):
        for address in ['$.items.*', '$.items.**', '$.items.^', '$.items[0..2]', '$.@.unit']:
            self.assertTrue(parse_address(address)['ok'], address)
        oversized = '9' * 5000
        result = parse_address('$.items[' + oversized + ']')
        self.assertFalse(result['ok'])
        self.assertEqual('SANSA_POSITION_INDEX_LIMIT_EXCEEDED', result['errors'][0]['code'])

    def test_backtick_diagnostic_precedes_missing_bracket(self):
        for source in ['copy=~items.[``', 'copy=~items.[``]', 'copy=~items.[``\nnext=2']:
            with self.subTest(source=source):
                parsed = parse_tokens(source, tokenize(source).tokens)
                self.assertEqual(1, len(parsed.errors))
                self.assertEqual('Backtick-quoted keys are not supported in paths', str(parsed.errors[0]))
                self.assertEqual('``', source[parsed.errors[0].span.start.offset:parsed.errors[0].span.end.offset])

    def test_standalone_attribute_selectors_own_fresh_nodes(self):
        first = parse_address('$.@')['address']['selectors'][0]
        second = parse_address('$.@')['address']['selectors'][0]
        self.assertIsNot(first, second)
        first['type'] = 'modified'
        self.assertEqual('attributeSpace', second['type'])
