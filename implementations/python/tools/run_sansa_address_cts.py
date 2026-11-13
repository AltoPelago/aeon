"""Direct API CTS runner; candidate suites require explicit selection."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parents[1] / "scripts"))

from aeon.sansa import parse_address, render_address
from repo_paths import get_aeonite_cts_root
from run_sansa_resolve_cts import read_arg, read_json


def main() -> int:
    name = "sansa-child-identity-parser-cts.v1.next.json" if "--child-identity" in sys.argv else "sansa-address-parser-cts.v1.json"
    manifest_path = read_arg("--cts") or get_aeonite_cts_root() / "sansa" / "v1" / name
    manifest = read_json(manifest_path)
    passed = failed = 0
    for reference in manifest["suites"]:
        suite = read_json(manifest_path.parent / reference["file"])
        for case in suite["tests"]:
            expected = case["expected"]
            result = parse_address(case["input"]["source"])
            errors = []
            if result["ok"] != expected["ok"]:
                errors.append("ok mismatch")
            elif result["ok"]:
                address = result["address"]
                for key, actual in [("canonical", address["canonical"]), ("exact", address["isExact"]), ("root", address["root"]["kind"])]:
                    if key in expected and actual != expected[key]:
                        errors.append(f"{key} mismatch: {actual!r}")
                if "selectors" in expected and [step["type"] for step in address["selectors"]] != expected["selectors"]:
                    errors.append("selectors mismatch")
                if "qualifierTerms" in expected and [term["name"] for term in (address.get("qualifierExpression") or {}).get("terms", [])] != expected["qualifierTerms"]:
                    errors.append("qualifier terms mismatch")
                if parse_address(render_address(address)).get("address") != address:
                    errors.append("render/parse replay mismatch")
            elif expected.get("error") and result["errors"][0]["code"] != expected["error"]:
                errors.append("diagnostic mismatch")
            if not result["ok"] and "index" in expected and result["errors"][0].get("index") != expected["index"]:
                errors.append("diagnostic index mismatch")
            if errors:
                failed += 1
                print(f"FAIL {case['id']}: {errors}")
            else:
                passed += 1
                print(f"PASS {case['id']}")
    print(f"Summary: pass={passed} fail={failed}")
    return int(failed != 0)


if __name__ == "__main__":
    raise SystemExit(main())
