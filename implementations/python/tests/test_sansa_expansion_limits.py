from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from aeon.sansa import parse_address, resolve_address


class ExpansionLimits(unittest.TestCase):
    def test_lazy_expansion_text_and_ast_is_bounded_before_materialization(self):
        for width in [32, 96]:
            for selector in ['$.*', '$.**']:
                for parsed in [False, True]:
                    for limit in [0, 1, width]:
                        with self.subTest(width=width, selector=selector, parsed=parsed, limit=limit):
                            root = {'path': '$'}
                            children = [{'path': f'$[{i}]'} for i in range(width)]
                            calls = {'yielded': 0, 'closed': 0}
                            def iterate(binding):
                                if binding is not root:
                                    return
                                try:
                                    for child in children:
                                        calls['yielded'] += 1
                                        yield child
                                finally:
                                    calls['closed'] += 1
                            address = parse_address(selector)['address'] if parsed else selector
                            result = resolve_address(address, {'root': root, 'children': iterate}, {'maxBindings': limit})
                            self.assertEqual(min(width, limit + 1), calls['yielded'])
                            self.assertEqual(1, calls['closed'])
                            if limit < width:
                                self.assertFalse(result['ok'])
                                self.assertEqual([], result['bindings'])
                                error = result['errors'][0]
                                self.assertEqual('SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED', error['code'])
                                self.assertEqual(limit, error['limit'])
                                self.assertEqual(limit + 1, error['observed'])
                                self.assertEqual(0, error['selectorIndex'])
                            else:
                                self.assertTrue(result['ok'])
                                self.assertEqual(children, result['bindings'])
                                for expected, actual in zip(children, result['bindings']):
                                    self.assertIs(expected, actual)

    def test_throwing_tail_is_not_requested_after_cardinality_failure(self):
        for selector in ['$.*', '$.**']:
            with self.subTest(selector=selector):
                root = {'path': '$'}
                calls = {'reads': 0, 'closed': 0}
                def iterate(binding):
                    if binding is not root:
                        return
                    try:
                        calls['reads'] += 1
                        yield {'path': '$[0]'}
                        calls['reads'] += 1
                        yield {'path': '$[1]'}
                        calls['reads'] += 1
                        raise AssertionError('tail must not execute')
                    finally:
                        calls['closed'] += 1
                result = resolve_address(selector, {'root': root, 'children': iterate}, {'maxBindings': 1})
                self.assertFalse(result['ok'])
                self.assertEqual([], result['bindings'])
                self.assertEqual(2, result['errors'][0]['observed'])
                self.assertEqual({'reads': 2, 'closed': 1}, calls)

    def test_success_preserves_depth_first_order_identity_and_repeated_occurrences(self):
        leaf = {'path': '$.a.leaf'}
        a = {'path': '$.a', 'children': [leaf]}
        b = {'path': '$.b'}
        result = resolve_address('$.**', {'root': {'path': '$', 'children': [a, b, a]}}, {'maxBindings': 5})
        self.assertTrue(result['ok'])
        self.assertEqual(['$.a', '$.a.leaf', '$.b', '$.a', '$.a.leaf'], [row['path'] for row in result['bindings']])
        for expected, actual in zip([a, leaf, b, a, leaf], result['bindings']):
            self.assertIs(expected, actual)

    def test_shared_allowance_across_parents_stops_current_iterator(self):
        a = {'path': '$[0]'}
        b = {'path': '$[1]'}
        root = {'path': '$', 'children': [a, b]}
        reads, closed = [], []
        def iterate(binding):
            if binding is root:
                yield from root['children']
                return
            try:
                for i in range(4):
                    reads.append(binding['path'])
                    yield {'path': f'{binding["path"]}[{i}]'}
            finally:
                closed.append(binding['path'])
        result = resolve_address('$.*.*', {'root': root, 'children': iterate}, {'maxBindings': 2})
        self.assertFalse(result['ok'])
        self.assertEqual(1, result['errors'][0]['selectorIndex'])
        self.assertEqual(3, result['errors'][0]['observed'])
        self.assertEqual(['$[0]'] * 3, reads)
        self.assertEqual(['$[0]'], closed)

    def test_all_active_iterators_close_even_if_inner_close_throws(self):
        root, a = {'path': '$'}, {'path': '$.a'}
        closed = []
        failure = RuntimeError('inner close')
        def iterate(binding):
            if binding is not root and binding is not a:
                return
            try:
                if binding is root:
                    yield a
                    yield {'path': '$.b'}
                else:
                    yield {'path': '$.a[0]'}
                    yield {'path': '$.a[1]'}
            finally:
                closed.append(binding['path'])
                if binding is a:
                    raise failure
        with self.assertRaises(RuntimeError) as caught:
            resolve_address('$.**', {'root': root, 'children': iterate}, {'maxBindings': 2})
        self.assertIs(failure, caught.exception)
        self.assertEqual(['$.a', '$'], closed)

    def test_tiny_limit_avoids_unselected_deep_tail(self):
        calls = []
        root = {'depth': 0}
        def children(binding):
            calls.append(binding['depth'])
            return [{'depth': binding['depth'] + 1}] if binding['depth'] < 2048 else []
        result = resolve_address('$.**', {'root': root, 'children': children}, {'maxBindings': 1})
        self.assertFalse(result['ok'])
        self.assertEqual(2, result['errors'][0]['observed'])
        self.assertEqual([0, 1], calls)


if __name__ == '__main__':
    unittest.main()
