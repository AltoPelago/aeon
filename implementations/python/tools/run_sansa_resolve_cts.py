from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from aeon.sansa import resolve_address
from repo_paths import get_aeonite_cts_root


def main() -> int:
    cts_path = read_arg("--cts")
    if cts_path is None:
        cts_path = get_aeonite_cts_root() / "sansa" / "v1" / "sansa-resolve-cts.v1.json"

    manifest = read_json(cts_path)
    passed = 0
    failed = 0

    print("Running SANSA Resolve CTS against Python aeon.sansa")

    for suite_ref in manifest.get("suites", []):
        suite_file = suite_ref.get("file") if isinstance(suite_ref, dict) else None
        if not isinstance(suite_file, str):
            failed += 1
            suite_id = suite_ref.get("id", "<unknown suite>") if isinstance(suite_ref, dict) else "<unknown suite>"
            print(f"FAIL {suite_id}: missing suite file", file=sys.stderr)
            continue

        suite = read_json(cts_path.parent / suite_file)
        namespaces = build_namespaces(suite.get("fixtures", {}).get("namespaces", []))
        suite_title = suite.get("title", suite_ref.get("id", suite_file) if isinstance(suite_ref, dict) else suite_file)
        print(f"\n--- Suite: {suite_title} ---")

        tests = suite.get("tests", [])
        if not isinstance(tests, list):
            continue
        for test in tests:
            if not isinstance(test, dict):
                failed += 1
                print("FAIL <invalid test>: test must be an object", file=sys.stderr)
                continue
            failures = run_test(test, namespaces)
            if failures:
                failed += 1
                print(f"FAIL {test.get('id')}", file=sys.stderr)
                for failure in failures:
                    print(f"  - {failure}", file=sys.stderr)
            else:
                passed += 1
                print(f"PASS {test.get('id')}")

    print(f"\nSummary: pass={passed} fail={failed}")
    return 1 if failed else 0


def run_test(test: dict[str, object], namespaces: dict[str, dict[str, object]]) -> list[str]:
    input_data = test.get("input")
    expected = test.get("expected")
    if not isinstance(input_data, dict) or not isinstance(expected, dict):
        return ["test must include input and expected objects"]

    namespace_id = input_data.get("namespace")
    fixture = namespaces.get(namespace_id) if isinstance(namespace_id, str) else None
    if fixture is None:
        return [f"unknown namespace fixture: {namespace_id}"]

    source = input_data.get("source")
    if not isinstance(source, str):
        return ["missing input.source"]

    options: dict[str, object] = {}
    contextual_root_address = input_data.get("contextualRoot")
    if isinstance(contextual_root_address, str):
        by_address = fixture["by_address"]
        if not isinstance(by_address, dict) or contextual_root_address not in by_address:
            return [f"unknown contextualRoot binding: {contextual_root_address}"]
        options["contextualRoot"] = by_address[contextual_root_address]

    namespace = fixture["namespace"]
    if not isinstance(namespace, dict):
        return [f"invalid namespace fixture: {namespace_id}"]

    failures: list[str] = []
    result = resolve_address(source, namespace, options)
    expected_ok = expected.get("ok") is True

    if result.get("ok") is not expected_ok:
        failures.append(f"ok mismatch: expected {expected_ok}, got {result.get('ok')}")

    if result.get("ok") is not True:
        errors = result.get("errors")
        first = errors[0] if isinstance(errors, list) and errors else {}
        if isinstance(first, dict) and isinstance(expected.get("error"), str):
            actual_code = first.get("code")
            if actual_code != expected["error"]:
                failures.append(f"error mismatch: expected {expected['error']}, got {actual_code}")
        if isinstance(expected.get("selectorIndex"), int):
            actual_selector_index = first.get("selectorIndex") if isinstance(first, dict) else None
            if actual_selector_index != expected["selectorIndex"]:
                failures.append(f"selectorIndex mismatch: expected {expected['selectorIndex']}, got {actual_selector_index}")
        return failures

    expected_addresses = expected.get("addresses")
    if isinstance(expected_addresses, list):
        bindings = result.get("bindings")
        actual_addresses = [
            binding.get("address") if isinstance(binding, dict) else None
            for binding in bindings
        ] if isinstance(bindings, list) else []
        compare_array(expected_addresses, actual_addresses, "addresses", failures)

    return failures


def build_namespaces(entries: object) -> dict[str, dict[str, object]]:
    output: dict[str, dict[str, object]] = {}
    if not isinstance(entries, list):
        return output

    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not isinstance(entry.get("root"), dict):
            continue
        root = entry["root"]
        if entry.get("supportsParentTraversal") is True:
            attach_parent_links(root)
        by_address: dict[str, object] = {}
        index_binding_tree(root, by_address)
        namespace = {
            "root": root,
            "children": lambda binding: binding.get("children", []) if isinstance(binding, dict) else [],
            "attributeSpace": lambda binding: binding.get("attributeSpace") if isinstance(binding, dict) else None,
        }
        if entry.get("supportsParentTraversal") is True:
            namespace["parent"] = lambda binding: binding.get("parent") if isinstance(binding, dict) else None
        if entry.get("supportsLocalSpaces") is True:
            namespace["localSpace"] = lambda binding, name: binding.get("localSpaces", {}).get(name) if isinstance(binding, dict) else None
        output[entry["id"]] = {
            "by_address": by_address,
            "namespace": namespace,
        }

    return output


def attach_parent_links(binding: object, parent: object | None = None) -> None:
    if not isinstance(binding, dict):
        return
    if parent is not None:
        binding["parent"] = parent
    children = binding.get("children")
    if isinstance(children, list):
        for child in children:
            attach_parent_links(child, binding)
    for space_name in ("attributeSpace", "attributes"):
        space = binding.get(space_name)
        if isinstance(space, dict):
            attach_parent_links(space, binding)
    local_spaces = binding.get("localSpaces")
    if isinstance(local_spaces, dict):
        for local_space in local_spaces.values():
            attach_parent_links(local_space, binding)


def index_binding_tree(binding: object, output: dict[str, object]) -> None:
    if not isinstance(binding, dict):
        return
    address = binding.get("address")
    if isinstance(address, str):
        output[address] = binding
    children = binding.get("children")
    if isinstance(children, list):
        for child in children:
            index_binding_tree(child, output)
    index_binding_tree(binding.get("attributeSpace"), output)
    index_binding_tree(binding.get("attributes"), output)
    local_spaces = binding.get("localSpaces")
    if isinstance(local_spaces, dict):
        for local_space in local_spaces.values():
            index_binding_tree(local_space, output)


def compare_array(expected: list[object], actual: list[object], label: str, failures: list[str]) -> None:
    if len(expected) != len(actual):
        failures.append(f"{label} length mismatch: expected {len(expected)}, got {len(actual)}")
        return
    for index, expected_value in enumerate(expected):
        if expected_value != actual[index]:
            failures.append(f"{label}[{index}] mismatch: expected {expected_value!r}, got {actual[index]!r}")


def read_arg(name: str) -> Path | None:
    try:
        index = sys.argv.index(name)
    except ValueError:
        return None
    if index + 1 >= len(sys.argv):
        return None
    return Path(sys.argv[index + 1]).resolve()


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
