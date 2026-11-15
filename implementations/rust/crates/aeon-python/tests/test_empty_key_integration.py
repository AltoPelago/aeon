from __future__ import annotations

import json
import unittest

from altopelago import aeon
from altopelago.aeon import pytonic


class EmptyKeyIntegrationTests(unittest.TestCase):
    def test_empty_reference_targets_survive_source_and_telex(self):
        source = '""={""="İ😀"}\ncopy=~[""].[""]'
        for result in [aeon.load_text(source), aeon.load_telex_text(aeon.compile_to_telex(source).decode())]:
            self.assertTrue(result.ok)
            self.assertEqual({"": {"": "İ😀"}, "copy": "İ😀"}, result.document)
        loaded = aeon.load_text(source)
        self.assertEqual({"": "İ😀"}, loaded.require('$.[""]'))
        self.assertEqual("İ😀", loaded.require('$.[""].[""]'))
        self.assertFalse(aeon.load_text('""=1\n""=2').ok)

    def test_identity_aliases_keep_empty_structural_paths(self):
        doc = pytonic.loads('""\\root\\={""\\leaf\\="İ😀"}')
        self.assertEqual('$.[""].[""]', doc[''][''].address)
        selected = doc.query('from $.\\root\\\nselect .\\leaf\\')
        self.assertTrue(selected.ok, selected.errors)
        self.assertEqual(['$.[""].[""]'], [binding.address for binding in selected.results[0].value])
        lower = doc.query('from $.\\root\\.\\leaf\\\nselect lower(.)')
        self.assertTrue(lower.ok, lower.errors)
        self.assertEqual('i\u0307😀', lower.results[0].value.decoded)

    def test_aeos_unicode_units_and_empty_attribute_targets(self):
        source = '""@{""="é"}="😀"'
        cases = [
            ({"min_length": 2, "max_length": 2}, True, None),
            ({"max_length": 1}, False, '$.[""]'),
            ({"attributes": {"": {"min_length": 1, "max_length": 1}}}, True, None),
            ({"attributes": {"": {"max_length": 0}}}, False, '$.[""].@.[""]'),
        ]
        for constraints, expected_ok, expected_path in cases:
            schema = {"schema_id": "empty.unicode", "schema_version": "1",
                      "rules": [{"path": '$.[""]', "constraints": constraints}]}
            for load in [lambda: aeon.load_text(source, schema=json.dumps(schema)),
                         lambda: aeon.load_telex_text(aeon.compile_to_telex(source).decode(), schema=json.dumps(schema))]:
                result = load()
                self.assertEqual(expected_ok, result.ok, result.validation_errors)
                if expected_path is not None:
                    self.assertEqual(expected_path, result.validation_errors[0]["path"])
