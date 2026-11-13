"""Explicit read-only document projection; AEOS selectors remain unadmitted."""
from pathlib import Path
import copy
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from aeon.core import CompileOptions, compile_source
from aeon.sansa import resolve_address
from aeon.sansa_document import namespace_from_assignment_events, namespace_from_portable_records, SansaNamespaceError
from aeon.portable import adapt_python_assignment_events_to_portable_aes
from aeon.telex import AEON_DOCUMENT_PROJECTION, encode_telex, parse_telex
import aeon.aeos as aeos


class SansaDocumentTests(unittest.TestCase):
    def compile(self, source):
        compiled = compile_source(source, CompileOptions(max_attribute_depth=8))
        self.assertFalse(compiled.errors, compiled.errors)
        return compiled

    def selected(self, namespace, address):
        result = resolve_address(address, namespace)
        self.assertTrue(result['ok'], result)
        return result['bindings']

    def test_native_and_wire_occurrence_kinds(self):
        cases = [
            ('group\\g\\={child\\c\\=1}', '$.\\g\\.\\c\\', '$.group.child'),
            ('items=[\\i\\=2]', '$.items.\\i\\', '$.items[0]'),
            ('node=<tag\\h\\(2)>', '$.node.\\h\\', '$.node[0]'),
            ('node\\o\\=<tag\\h\\@{unit\\u\\="cm"}(2)>', '$.node.\\h\\.@.\\u\\', '$.node[0].@.unit'),
            ('a@{meta\\m\\={child\\c\\=1}}=2', '$.a.@.\\m\\.\\c\\', '$.a.@.meta.child'),
            ('items=(\\t\\=2)', '$.items.\\t\\', '$.items[0]'),
            ('node=<tag(\\n\\=2)>', '$.node[0].\\n\\', '$.node[0][0]'),
            ('a@{unit\\u\\="cm"}=1', '$.a.@.\\u\\', '$.a.@.unit'),
            ('a@{meta\\m\\@{unit\\u\\="cm"}=1}=2', '$.a.@.\\m\\.@.\\u\\', '$.a.@.meta.@.unit'),
        ]
        for source, selector, physical in cases:
            with self.subTest(source=source):
                compiled = self.compile(source)
                records = adapt_python_assignment_events_to_portable_aes(compiled.events)['events']
                wire = parse_telex(encode_telex(records, limits={'max_attribute_depth':8}), limits={'max_attribute_depth':8}).records
                for namespace in (namespace_from_assignment_events(compiled.events, limits={'max_attribute_depth':8}), namespace_from_portable_records(records, limits={'max_attribute_depth':8}), namespace_from_portable_records(wire, limits={'max_attribute_depth':8})):
                    selected = self.selected(namespace, selector)
                    self.assertEqual([physical], [b['path'] for b in selected])
                    self.assertIs(selected[0], self.selected(namespace, physical)[0])

    def test_scope_root_and_synthetic_spaces_do_not_inherit_identity(self):
        compiled = self.compile('group\\g\\@{unit\\u\\=1}={child\\c\\=2}')
        namespace = namespace_from_assignment_events(compiled.events)
        group = self.selected(namespace, '$.group')[0]
        self.assertEqual([], self.selected(namespace, '$.\\g\\.\\g\\'))
        result = resolve_address('?.\\g\\', namespace, {'contextualRoot': group})
        self.assertTrue(result['ok']);self.assertEqual([], result['bindings'])
        self.assertEqual([], self.selected(namespace, '$.group.@.\\g\\'))
        self.assertIsNone(namespace['identity'](namespace['root']))
        self.assertIsNone(namespace['identity'](self.selected(namespace, '$.group.@')[0]))
        self.assertEqual('ObjectNode', namespace['representationKind'](self.selected(namespace, '$.group.@')[0]))
        self.assertEqual('ObjectNode', namespace['representationKind'](namespace['root']))

    def test_plane_collision_stays_separate(self):
        address = '$.["aeon:custom"]'
        records = [{'header':address,'kind':'StringLiteral','identity':'headerId','value':'header'}, {'path':address,'kind':'StringLiteral','identity':'bodyId','value':'body'}]
        for scope, present, absent in [('payload','bodyId','headerId'),('header','headerId','bodyId')]:
            ns = namespace_from_portable_records(records, scope=scope, projection=AEON_DOCUMENT_PROJECTION)
            self.assertEqual([address], [b['path'] for b in self.selected(ns, '$.\\'+present+'\\')])
            self.assertEqual([], self.selected(ns, '$.\\'+absent+'\\'))
        with self.assertRaises(ValueError):namespace_from_portable_records(records, scope='full')
        with self.assertRaises(SansaNamespaceError):namespace_from_portable_records(records, scope='header')

    def test_foreign_contextual_root_fails_before_identity_access(self):
        compiled = self.compile('group\\g\\={child\\c\\=1}')
        own = namespace_from_assignment_events(compiled.events)
        foreign = namespace_from_assignment_events(compiled.events)
        calls = []
        original = own['identity']
        own['identity'] = lambda b: (calls.append(b), original(b))[1]
        for root in (foreign['root'], self.selected(foreign, '$.group')[0]):
            for address in ('?.\\c\\', '?.missing.\\c\\'):
                result = resolve_address(address, own, {'contextualRoot': root})
                self.assertEqual('SANSA_RESOLVE_IDENTITY_SCOPE_MISMATCH', result['errors'][0]['code'])
                self.assertEqual([], result['bindings'])
        self.assertEqual([], calls)
        group = self.selected(own, '$.group')[0]
        self.assertEqual('$.group.child', resolve_address('?.\\c\\', own, {'contextualRoot': group})['bindings'][0]['path'])

    def test_native_header_body_shadowing(self):
        compiled = self.compile('aeon:header={child\\headChild\\=1}\n"aeon:child"\\bodyChild\\=2')
        for scope, present, absent in [('payload','bodyChild','headChild'),('header','headChild','bodyChild')]:
            ns = namespace_from_assignment_events(compiled.events, header=compiled.header, scope=scope)
            self.assertEqual(['$.["aeon:child"]'], [b['path'] for b in self.selected(ns, '$.\\'+present+'\\')])
            self.assertEqual([], self.selected(ns, '$.\\'+absent+'\\'))

    def test_unicode_physical_paths_are_preserved(self):
        records = [{'path':'$.["😀"]','kind':'ObjectNode','identity':'parent'}, {'path':'$.["😀"].@.["é"]','kind':'NumberLiteral','identity':'child','value':'1'}]
        ns = namespace_from_portable_records(records)
        for selector, physical in [('$.\\parent\\', '$.["😀"]'), ('$.\\parent\\.@.\\child\\', '$.["😀"].@.["é"]')]:
            selected = self.selected(ns, selector)
            self.assertEqual([physical], [b['path'] for b in selected])
            self.assertIs(selected[0], self.selected(ns, physical)[0])

    def test_unrepresentable_position_is_not_silently_dropped(self):
        records = [{'path':'$.a','kind':'ListNode'}, {'path':'$.a[1000000]','kind':'NumberLiteral','identity':'child','value':'1'}]
        with self.assertRaises(SansaNamespaceError) as caught:
            namespace_from_portable_records(records)
        self.assertEqual('SANSA_RESOLVE_UNSUPPORTED_NAMESPACE_PATH', caught.exception.code)
        self.assertEqual('$.a[1000000]', caught.exception.diagnostics[0]['path'])

    def test_reference_occurrences_keep_their_own_identity(self):
        compiled = self.compile('source\\s\\={child\\c\\=1}\ncopy\\copyId\\=~source')
        ns = namespace_from_assignment_events(compiled.events)
        self.assertEqual(['$.copy'], [b['path'] for b in self.selected(ns, '$.\\copyId\\')])
        self.assertEqual([], self.selected(ns, '$.copy.\\c\\'))
        self.assertEqual(['$.source.child'], [b['path'] for b in self.selected(ns, '$.\\s\\.\\c\\')])

    def test_snapshot_and_parent_boundary(self):
        records = [{'path':'$.a','kind':'NumberLiteral','identity':'one','value':'1'}]
        ns = namespace_from_portable_records(records)
        child = self.selected(ns, '$.\\one\\')[0]
        records[0]['identity']='two';records[0]['path']='$.b'
        self.assertIs(child, self.selected(ns, '$.\\one\\')[0])
        self.assertEqual([], self.selected(ns, '$.\\two\\'))
        self.assertEqual([], self.selected(ns, '$.^'))

    def test_invalid_documents_fail_before_projection(self):
        for records in ([{'path':'$.a','kind':'NumberLiteral','identity':'','value':'1'}], [{'path':'$.\\a\\','kind':'NumberLiteral','value':'1'}], [{'path':'$.a','kind':'NumberLiteral','identity':'same','value':'1'},{'path':'$.b','kind':'NumberLiteral','identity':'same','value':'2'}], [{'path':'$.a','kind':'NumberLiteral','value':'1'},{'path':'$.a','kind':'NumberLiteral','value':'2'}]):
            with self.assertRaises(SansaNamespaceError):namespace_from_portable_records(records)

    def test_adapter_does_not_silently_drop_unselectable_identity_metadata(self):
        ns = namespace_from_portable_records([{'path':'$.a','kind':'NumberLiteral','identity':'bad.id','value':'1'}])
        self.assertEqual('bad.id', ns['identity'](self.selected(ns, '$.a')[0]))
        result = resolve_address('$.\\absent\\', ns)
        self.assertEqual('SANSA_RESOLVE_INVALID_IDENTITY', result['errors'][0]['code'])

    def test_child_order_and_logical_budget(self):
        records = [{'path':'$.longName','kind':'NumberLiteral','identity':'long','value':'1'},{'path':'$.a','kind':'ListNode'},{'path':'$.a[1]','kind':'NumberLiteral','identity':'second','value':'2'},{'path':'$.a[0]','kind':'NumberLiteral','identity':'first','value':'1'}]
        ns = namespace_from_portable_records(records)
        self.assertEqual(['$.longName','$.a'],[b['path'] for b in self.selected(ns,'$.*')])
        self.assertEqual(['$.a[0]','$.a[1]'],[b['path'] for b in self.selected(ns,'$.a.*')])
        result=resolve_address('$.a.\\absent\\',ns,{'maxIdentityInspections':1})
        self.assertEqual('SANSA_RESOLVE_IDENTITY_LIMIT_EXCEEDED',result['errors'][0]['code'])
        self.assertEqual([],result['bindings'])

    def test_legacy_normalization_preserves_ids_and_explicit_aeos_identity(self):
        compiled=self.compile('group\\g\\@{meta\\m\\@{unit\\u\\=1}=2}=3')
        original=aeos.create_aeos_sansa_resolve_namespace;seen=[]
        def capture(events):
            seen.append(copy.deepcopy(events))
            ns=original(events)
            self.assertNotIn('identity',ns)
            return ns
        with patch.object(aeos,'create_aeos_sansa_resolve_namespace',capture):
            result=aeos.validate_events(compiled.events,{'rules':[{'selector':'$.*','constraints':{}}]})
        self.assertTrue(result['ok'],result)
        self.assertEqual('g',seen[0]['$.group']['structuralId'])
        self.assertEqual('m',seen[0]['$.group.@.meta']['structuralId'])
        self.assertEqual('u',seen[0]['$.group.@.meta.@.unit']['structuralId'])
        denied=aeos.validate_events(compiled.events,{'rules':[{'selector':'$.\\g\\','constraints':{}}]})
        self.assertTrue(denied['ok'], denied)

    def test_indexed_fallback_preserves_only_declared_element_identity(self):
        events={}
        aeos.hydrate_indexed_fallback('$.a',{'structuralId':'owner','elements':[{'type':'IntegerLiteral','value':'1','structuralId':'item'},{'type':'IntegerLiteral','value':'2'}]},None,events)
        self.assertEqual('item',events['$.a[0]']['structuralId'])
        self.assertIsNone(events['$.a[1]']['structuralId'])

if __name__=='__main__':unittest.main()
