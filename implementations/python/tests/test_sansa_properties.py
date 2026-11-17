"""Actual pure Python provider and exact prepared Addressing/Resolve mirrors.

The scripted mirror interprets the fixture's list-of-head-IDs protocol; a non-list
head response is a checked protocol metadata fault, not a Python iterable claim.
Real generator acquisition/next/cleanup behavior is exercised separately below.
"""
from pathlib import Path
from collections import Counter
import copy
import hashlib
import json
import unittest

from aeon.core import compile_source, CompileOptions
from aeon.sansa import parse_address, render_address, resolve_address, resolve_consumer_address, SansaPropertyAccessError
from aeon.sansa_document import namespace_from_assignment_events, namespace_from_portable_records
from aeon.portable import adapt_python_assignment_events_to_portable_aes

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "test-fixtures/sansa-properties"
PARSER = json.loads((FIXTURES / "property-parser-candidate-v1.json").read_text())
RESOLVE = json.loads((FIXTURES / "property-resolve-candidate-v1.json").read_text())
MODEL = json.loads((FIXTURES / "property-namespace-candidate-v1.json").read_text())["namespace"]


def generated(g):
    kind, count, scalar = g["kind"], g["count"], g.get("scalar", "x")
    if kind == "payload":
        payload = ("\\u{" + format(ord(scalar), "x") + "}") * count if g.get("encoding") == "escaped" else scalar * count
        return '$&key("' + payload + '")'
    if kind == "selectors":
        return "$" + '&key("x")' * count
    return '$.["@' + "x" * (count - 16) + '"]&key("x")'


def snapshot(root):
    rows, seen, pending = [], set(), [root]
    while pending:
        value = pending.pop()
        if id(value) in seen or not isinstance(value, (list, dict)):
            continue
        seen.add(id(value))
        entries = list(dict.items(value)) if isinstance(value, dict) else list(enumerate(value))
        rows.append((id(value), [(k, id(v) if isinstance(v, (dict, list)) else v) for k, v in entries]))
        pending.extend(v for _, v in entries)
    return rows


def host(input):
    bindings = {row["id"]: row for row in copy.deepcopy(MODEL["bindings"])}
    calls = Counter()
    if "wideHeads" in input:
        width = input["wideHeads"]["count"]
        heads = []
        for index in range(width):
            binding_id = "wide" + str(index)
            heads.append(binding_id)
            bindings[binding_id] = {"id": binding_id, "address": f"$.multi[{index}]", "nodeKind": "NodeHead", "tag": "right" if input["wideHeads"].get("matchAt") == "last" and index == width - 1 else "other", "children": []}
        bindings["multi"].update(heads=heads, children=heads)
    get = bindings.get
    parents = {}
    for row in bindings.values():
        for child_id in row.get("children", []) + ([row["attributeSpace"]] if row.get("attributeSpace") else []) + list(row.get("localSpaces", {}).values()):
            parents[child_id] = row

    def invoke(name, binding, fallback, at=None):
        calls[name] += 1
        for fault in input.get("faults", []):
            if fault["callback"] == name and fault["binding"] == binding["id"] and ("at" not in fault or fault["at"] == at):
                if fault["action"] == "throw":
                    raise RuntimeError("hidden fixture failure")
                return None if fault["action"] == "absent" else fault["value"]
        return fallback()

    def contains(root, binding):
        seen, pending = set(), [root]
        while pending:
            current = pending.pop()
            if current is None or id(current) in seen:
                continue
            if current is binding:
                return True
            seen.add(id(current))
            pending.extend(get(key) for key in current.get("children", []) + ([current["attributeSpace"]] if current.get("attributeSpace") else []) + list(current.get("localSpaces", {}).values()))
        return False

    def scope(binding, context):
        try:
            context["scopeRoot"] = binding
        except TypeError:
            pass
        else:
            raise AssertionError("mutable context")
        return invoke("scope", binding, lambda: "outside" if not contains(context["scopeRoot"], binding) or ("directHeadOf" in context and binding["id"] not in context["directHeadOf"].get("heads", [])) else "root" if binding is context["scopeRoot"] else "inside")

    class Heads:
        def __init__(self, owner, ids):
            self.owner, self.ids, self.index = owner, ids, 0

        def __iter__(self):
            return self

        def __next__(self):
            def following():
                if self.index >= len(self.ids):
                    raise StopIteration
                selected = get(self.ids[self.index])
                self.index += 1
                return selected
            return invoke("headNext", self.owner, following, self.index + 1)

        def close(self):
            invoke("headEarlyClose", self.owner, lambda: None)

    def heads(binding, context):
        ids = invoke("nodeHeads", binding, lambda: binding.get("heads", []))
        if type(ids) is not list:
            raise SansaPropertyAccessError("invalidMetadata")
        return Heads(binding, ids)

    properties = {"scope": scope, "key": lambda b, c: invoke("key", b, lambda: b.get("key")),
                  "nodeKind": lambda b, c: invoke("nodeKind", b, lambda: b.get("nodeKind")),
                  "nodeTag": lambda b, c: invoke("nodeTag", b, lambda: b.get("tag")), "nodeHeads": heads}
    for name in input.get("omit", []):
        properties.pop(name, None)

    def root():
        calls["root"] += 1
        return None if input.get("invalidRoot") else get(input.get("rebasedRoot", MODEL["root"]))

    def children(binding):
        calls["children"] += 1
        return [get(key) for key in binding.get("children", [])]

    return {"root": root, "contextualRoot": get(input.get("contextualRoot")), "properties": properties,
            "children": children, "parent": lambda b: parents.get(b["id"]), "name": lambda b: b.get("key", b.get("legacyName")),
            "index": lambda b: b.get("index"), "identity": lambda b: b.get("identity"),
            "attributeSpace": lambda b: get(b.get("attributeSpace")), "localSpace": lambda b, name: get(b.get("localSpaces", {}).get(name))}, calls


class PropertyVectors(unittest.TestCase):
    pass


def parser_vector(vector):
    def run(self):
        input, expected = vector["input"], vector["expected"]
        source = input.get("source") if "source" in input else generated(input["generate"])
        result = parse_address(source, input.get("options", {}).get("parse"))
        self.assertEqual(result["ok"], expected["ok"])
        if result["ok"]:
            self.assertEqual(result["address"]["isExact"], expected["isExact"])
            if "canonical" in expected:
                self.assertEqual(result["address"]["canonical"], expected["canonical"])
            self.assertEqual(render_address(result["address"]), result["address"]["canonical"])
        else:
            for field in ["error", "limitKind", "limit", "observed"]:
                if field in expected:
                    self.assertEqual(result["errors"][0].get("code" if field == "error" else field), expected[field], field)
    return run


def resolve_vector(vector):
    def run(self):
        input, expected = vector["input"], vector["expected"]
        namespace, calls = host(input)
        ast = copy.deepcopy(input.get("ast"))
        getter_calls = [0]
        if "generate" in input:
            g = input["generate"]
            ast = parse_address('$&key("x")')["address"]
            if g["kind"] == "payload":
                ast["selectors"][0]["value"] = g.get("scalar", "x") * g["count"]
            elif g["kind"] == "selectors":
                ast["selectors"] = [{"type": "propertyFilter", "property": "key", "value": "x"} for _ in range(g["count"])]
            else:
                ast["selectors"].insert(0, {"type": "member", "name": "@" + "x" * (g["count"] - 16), "quoted": True})
        if input.get("astFault") == "cycle":
            term = {"type": "QualifierTerm", "name": "a", "arguments": [], "parameters": []}
            term["parameterGroups"] = [[term]]
            ast["qualifierExpression"] = {"type": "QualifierExpression", "terms": [term]}
        if input.get("astFault") == "accessor":
            class Accessor(dict):
                def get(self, key, default=None):
                    if key == "value":
                        getter_calls[0] += 1
                    return super().get(key, default)
            ast["selectors"][-1] = Accessor(ast["selectors"][-1])
        before = snapshot(ast)
        result = resolve_address(ast if ast is not None else input["source"], namespace, input.get("options"))
        self.assertEqual(snapshot(ast), before, "input unchanged")
        observed = {"ok": result["ok"], "bindings": [b["id"] for b in result["bindings"]], "addresses": [b["address"] for b in result["bindings"]],
                    "calls": calls, "astGetterCalls": getter_calls[0], "inputUnchanged": True}
        if not result["ok"]:
            observed.update(result["errors"][0], error=result["errors"][0]["code"])
        for field, value in expected.items():
            self.assertIn(field, {"ok", "bindings", "addresses", "calls", "error", "limit", "observed", "budget", "selectorIndex", "causeCode", "astGetterCalls", "inputUnchanged"})
            if field == "calls":
                for name, count in value.items():
                    self.assertEqual(calls[name], count, name)
            else:
                self.assertEqual(observed.get(field), value, field)
    return run


for vector in PARSER["tests"]:
    setattr(PropertyVectors, "test_" + vector["id"].replace("-", "_"), parser_vector(vector))
for vector in RESOLVE["tests"]:
    setattr(PropertyVectors, "test_" + vector["id"].replace("-", "_"), resolve_vector(vector))


class ActualDocumentProperties(unittest.TestCase):
    def test_address_literals_compile_and_round_trip_without_reference_admission(self):
        from aeon.canonical import canonicalize
        from aeon.telex import encode_telex, parse_telex
        fixture = json.loads((ROOT / "test-fixtures/property-address-literals.json").read_text())
        for address, expected in zip(fixture["addresses"], fixture["canonical"]):
            source = f'p:sansa={address}// outside\nx=1'
            compiled = compile_source(source)
            self.assertFalse(compiled.errors)
            self.assertEqual(compiled.events[0]["value"]["canonical"], expected)
            canonical = canonicalize(source)
            self.assertFalse(canonical.errors)
            self.assertEqual(canonicalize(canonical.text).text, canonical.text)
            records = adapt_python_assignment_events_to_portable_aes(compiled.events)["events"]
            self.assertEqual(next(record["value"] for record in records if record.get("path") == "$.p"), expected)
            wire = parse_telex(encode_telex(records)).records
            self.assertEqual(next(record["value"] for record in wire if record.get("path") == "$.p"), expected)
            for marker in ["~", "~>"]:
                denied = compile_source(f'copy={marker}{address}')
                self.assertTrue(denied.errors)
                self.assertEqual(denied.events, [])

    def test_shared_sdk_vectors_from_native_events_and_portable_records(self):
        fixture = json.loads((ROOT / "test-fixtures/property-resolve-sdk.json").read_text())
        compiled = compile_source(fixture["source"], CompileOptions(max_attribute_depth=8))
        self.assertFalse(compiled.errors)
        records = adapt_python_assignment_events_to_portable_aes(compiled.events, header=compiled.header, include_headers=True)["events"]
        for namespace in [namespace_from_assignment_events(compiled.events, header=compiled.header), namespace_from_portable_records(records, projection="aeon.document.v1")]:
            for case in fixture["cases"]:
                options = {}
                if "context" in case:
                    options["contextualRoot"] = resolve_address(case["context"], namespace)["bindings"][0]
                if "limit" in case:
                    options["maxPropertyInspections"] = case["limit"]
                for input in [case["address"], parse_address(case["address"])["address"]]:
                    with self.subTest(address=case["address"], parsed=type(input) is dict):
                        result = resolve_address(input, namespace, options)
                        if "code" in case:
                            self.assertFalse(result["ok"])
                            self.assertEqual(result["errors"][0]["code"], case["code"])
                            self.assertEqual(result["bindings"], [])
                        else:
                            self.assertTrue(result["ok"], result)
                            self.assertEqual([b["path"] for b in result["bindings"]], case["paths"])
                            for binding in result["bindings"]:
                                self.assertIs(binding, resolve_address(binding["path"], namespace)["bindings"][0])

    def test_frozen_mirror_bytes(self):
        expected = {
            "property-parser-candidate-v1.json": "84aac40fa4360a7fccfa16f820195edef5f0fe8938ad6d689a7c43c7477d25e0",
            "property-resolve-candidate-v1.json": "724ea13d00ccf53c23cee502fa7f858925f2ef4b1e0e591759750e18d4290ec2",
            "property-namespace-candidate-v1.json": "7261bc7219b49e8f8c03b2b43e931ac611fafd2fc3e48b28dd3e51f2e4072b16",
        }
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(), digest)

    def test_snapshot_authority_and_foreign_contexts(self):
        source = 'value = <tag("hello")>'
        def host():
            return namespace_from_assignment_events(compile_source(source).events)
        namespace, foreign = host(), host()
        value = resolve_address('$.value', namespace)["bindings"][0]
        head = resolve_address('$.value[0]', namespace)["bindings"][0]
        value.update(name="forged", info={"type": "Other", "nodeTag": "forged"}, children=[])
        head["info"].update(type="Other", nodeTag="forged")
        selected = resolve_address('$.*&key("value")&tag("tag")', namespace)
        self.assertTrue(selected["ok"])
        self.assertIs(selected["bindings"][0], value)
        for context in [foreign["root"], {"path": "$.value", "name": "value"}]:
            result = resolve_address('?&tag("tag")', namespace, {"contextualRoot": context})
            self.assertEqual(result["errors"][0]["code"], "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION")
            self.assertEqual(result["bindings"], [])

    def test_header_plane_and_closed_aeos_rules(self):
        import aeon.aeos as aeos
        from aeon.telex import AEON_DOCUMENT_PROJECTION
        records = [{"header": '$.["aeon:title"]', "kind": "StringLiteral", "value": "header"},
                   {"path": '$.["aeon:title"]', "kind": "StringLiteral", "value": "body"}]
        header = namespace_from_portable_records(records, scope="header", projection=AEON_DOCUMENT_PROJECTION)
        body = namespace_from_portable_records(records, projection=AEON_DOCUMENT_PROJECTION)
        selected = resolve_address('$.*&key("aeon:title")', header)
        self.assertTrue(selected["ok"])
        foreign = resolve_address('$.*&key("aeon:title")', body)["bindings"][0]
        denied = resolve_address('?&key("x")', header, {"contextualRoot": foreign})
        self.assertEqual(denied["errors"][0]["code"], "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION")
        for field in ["selector", "path"]:
            from unittest.mock import patch
            with patch.object(aeos, "create_aeos_sansa_resolve_namespace", side_effect=AssertionError("denied before construction")):
                result = aeos.validate([], {"rules": [{field: '$.missing&key("x")', "constraints": {}}]})
            self.assertFalse(result["ok"])
        reads = []
        result = resolve_consumer_address('$&key("x")', {"root": lambda: reads.append(1)})
        self.assertFalse(result["ok"])
        self.assertEqual(reads, [])

    def test_whole_set_fallbacks_and_policy_precede_reads(self):
        reads = []
        class Binding(dict):
            def get(self, key, default=None):
                if key == "parent":
                    reads.append(key)
                return super().get(key, default)
        root = {"children": []}
        child, missing = Binding(parent=root), {}
        properties = {"scope": lambda b, c: "root" if b is c["scopeRoot"] else "inside",
                      "key": lambda b, c: "x"}
        namespace = {"root": root, "properties": properties}
        for rows in [[child, missing], [missing, child]]:
            root["children"] = rows
            reads.clear()
            result = resolve_address('$.*.^&key("x")', namespace)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["bindings"], [])
            self.assertEqual(reads, ["parent"])
        root["children"] = [child, root]
        reads.clear()
        result = resolve_address('$.*.^&key("x")', namespace, {"failOnParentFromEffectiveRoot": True})
        self.assertEqual(result["errors"][0]["code"], "SANSA_RESOLVE_BOUNDARY_ESCAPE_FORBIDDEN")
        self.assertEqual(reads, [])
        for field in ["attributes", "attributeSpace"]:
            root["children"] = [{field: {"children": []}}, {}]
            result = resolve_address('$.*.@&key("x")', namespace)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["bindings"], [])

    def test_repeated_handle_occurrence_frames_and_limits(self):
        leaf, first, second = {}, {}, {}
        a, b = {"space": first}, {"space": second}
        root = {"children": [a, b]}
        observed = []
        def scope(binding, context):
            observed.append(context["scopeRoot"])
            return "root" if binding is context["scopeRoot"] else "inside" if binding is leaf and (context["scopeRoot"] is first or context["scopeRoot"] is second) else "outside"
        ns = {"root": root, "children": lambda binding: root["children"] if binding is root else [leaf] if binding is first or binding is second else [],
              "attributeSpace": lambda binding: binding["space"], "properties": {"scope": scope, "key": lambda b, c: "leaf"}}
        result = resolve_address('$.*.@.*&key("leaf")', ns, {"maxPropertyInspections": 2})
        self.assertTrue(result["ok"], result)
        self.assertEqual([id(x) for x in result["bindings"]], [id(leaf), id(leaf)])
        self.assertIs(observed[0], first)
        self.assertIs(observed[1], second)
        observed.clear()
        result = resolve_address('$.*.@.*&key("leaf")', ns, {"maxPropertyInspections": 1})
        self.assertEqual(result["errors"][0]["observed"], 2)
        self.assertEqual(result["bindings"], [])
        self.assertEqual(len(observed), 1)
        observed.clear()
        result = resolve_address('$.*.@.*&key("leaf")', ns, {"maxBindings": 1})
        self.assertEqual(result["errors"][0]["code"], "SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED")
        self.assertEqual(observed, [])

    def test_real_generators_close_and_stop_before_unbudgeted_metadata(self):
        for width in [64, 128]:
            for mode in ["limit", "early", "terminal", "nextFault", "cleanupFault"]:
                with self.subTest(width=width, mode=mode):
                    root, head, counts = {}, {}, Counter()
                    def scope(binding, context):
                        counts["scope"] += 1
                        return "root" if binding is root else "inside"
                    def heads(binding, context):
                        try:
                            for _ in range(2 if mode == "terminal" else width):
                                counts["next"] += 1
                                if mode == "nextFault":
                                    raise ValueError("secret")
                                yield head
                            counts["next"] += 1
                        finally:
                            counts["close"] += 1
                            if mode == "cleanupFault":
                                raise ValueError("secret cleanup")
                    def tag(binding, context):
                        counts["tag"] += 1
                        return "x" if mode in {"early", "cleanupFault"} else "other"
                    ns = {"root": root, "properties": {"scope": scope, "nodeKind": lambda b, c: "NodeLiteral" if b is root else "NodeHead", "nodeTag": tag, "nodeHeads": heads}}
                    result = resolve_address('$&tag("x")', ns, {"maxPropertyInspections": 3})
                    self.assertLessEqual(counts["next"], 3)
                    self.assertLessEqual(counts["tag"], 2)
                    self.assertEqual(counts["close"], 1)
                    self.assertEqual(result["ok"], mode in {"early", "terminal"})
                    if mode == "limit":
                        self.assertEqual((counts["next"], counts["tag"], counts["scope"]), (3, 2, 3))
                        self.assertEqual(result["errors"][0]["observed"], 4)
                    if mode in {"nextFault", "cleanupFault"}:
                        self.assertEqual(result["errors"][0]["code"], "SANSA_RESOLVE_PROPERTY_ADAPTER_ERROR")
                        self.assertNotIn("secret", json.dumps(result))

    def test_checked_faults_do_not_coerce_arbitrary_exceptions(self):
        root, child = {}, {}
        reads = []
        class Evil(SansaPropertyAccessError):
            @property
            def kind(self):
                reads.append(1)
                raise ValueError("secret")
            def __init__(self):
                Exception.__init__(self)
        def raise_error(cause):
            raise cause
        ns = {"root": root, "children": lambda b: [child], "properties": {"scope": lambda b, c: "inside", "key": lambda b, c: None}}
        for cause, code in [(SansaPropertyAccessError("invalidMetadata"), "SANSA_RESOLVE_INVALID_PROPERTY_METADATA"),
                            (SansaPropertyAccessError("scopeViolation"), "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION"),
                            (Evil(), "SANSA_RESOLVE_PROPERTY_ADAPTER_ERROR"),
                            (SansaPropertyAccessError.__new__(SansaPropertyAccessError), "SANSA_RESOLVE_PROPERTY_ADAPTER_ERROR")]:
            ns["properties"]["key"] = lambda b, c: raise_error(cause)
            result = resolve_address('$.*&key("x")', ns)
            self.assertEqual(result["errors"][0]["code"], code)
            self.assertEqual(result["bindings"], [])
        self.assertEqual(reads, [])

    def test_iter_acquisition_type_error_is_checked_adapter_fault(self):
        class Broken:
            def __iter__(self):
                raise TypeError("secret")
        root = {}
        ns = {"root": root, "properties": {"scope": lambda b, c: "root", "nodeKind": lambda b, c: "NodeLiteral", "nodeTag": lambda b, c: "x", "nodeHeads": lambda b, c: Broken()}}
        result = resolve_address('$&tag("x")', ns)
        self.assertEqual(result["errors"][0]["code"], "SANSA_RESOLVE_PROPERTY_ADAPTER_ERROR")

    def test_deep_qualifier_paths_are_iterative_and_forged_flags_are_ignored(self):
        for depth in [32, 6000]:
            source = '$&key("x"):' + 'a<' * depth + 'b' + '>' * depth
            result = parse_address(source)
            self.assertTrue(result["ok"])
            ast = result["address"]
            ast.update(canonical="$.forged", isExact=True)
            self.assertEqual(render_address(ast), source)
            root = {}
            resolved = resolve_address(ast, {"root": root, "properties": {"scope": lambda b, c: "root", "key": lambda b, c: self.fail("root key exposed")}})
            self.assertTrue(resolved["ok"], resolved)
            self.assertEqual(resolved["bindings"], [])

    def test_reentrant_calls_get_fresh_private_allowances(self):
        root, child = {}, {}
        options = {"maxPropertyInspections": 1}
        ns = {"root": root, "children": lambda b: [child]}
        def key(binding, context):
            inner = resolve_address('$&key("hidden")', ns, options)
            self.assertTrue(inner["ok"], inner)
            self.assertEqual(inner["bindings"], [])
            return "x"
        ns["properties"] = {"scope": lambda b, c: "root" if b is root else "inside", "key": key}
        self.assertIs(resolve_address('$.*&key("x")', ns, options)["bindings"][0], child)
        self.assertEqual(options, {"maxPropertyInspections": 1})


if __name__ == "__main__":
    unittest.main()
