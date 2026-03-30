#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import itertools
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_FMT_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "fmt"]
PY_FMT_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "fmt"]
RUST_FMT_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "fmt"]
TS_INSPECT_CMD = ["node", str(ROOT / "implementations" / "typescript" / "packages" / "cli" / "dist" / "main.js"), "inspect"]
PY_INSPECT_CMD = [str(ROOT / "implementations" / "python" / "bin" / "aeon-python"), "inspect"]
RUST_INSPECT_CMD = [str(ROOT / "implementations" / "rust" / "target" / "debug" / "aeon-rust"), "inspect"]
DEFAULT_SEEDS = ROOT / "stress-tests" / "snippets" / "whitespace-seeds.aeon-cases"
MUTATION_TOKENS = "@:{}=<>()[],"


@dataclass(frozen=True)
class Mutation:
    index: int
    token: str
    label: str
    before: str
    after: str


@dataclass(frozen=True)
class InspectResult:
    accepted: bool
    output: str


@dataclass(frozen=True)
class FmtResult:
    code: int
    stdout: str
    stderr: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate whitespace/newline mutations for structural AEON snippets and compare implementations.",
    )
    parser.add_argument(
        "--mode",
        choices=["transport", "strict", "custom"],
        default="strict",
        help="Behavior mode header to inject when a seed does not declare one (default: strict).",
    )
    parser.add_argument(
        "--seeds-file",
        default=str(DEFAULT_SEEDS),
        help="Seed corpus file split by --- delimiters.",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=1,
        help="How many structural token mutations to combine per variant (default: 1).",
    )
    parser.add_argument(
        "--max-variants",
        type=int,
        default=400,
        help="Maximum generated variants per seed, including the baseline (default: 400).",
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help="On mismatch, print concise output only.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
    )
    return parser.parse_args()


def split_cases(raw: str) -> list[str]:
    cases: list[str] = []
    current: list[str] = []
    for line in raw.splitlines():
        if line.strip() == "---":
            snippet = "\n".join(current).strip()
            if snippet:
                cases.append(snippet + "\n")
            current = []
            continue
        current.append(line)
    snippet = "\n".join(current).strip()
    if snippet:
        cases.append(snippet + "\n")
    return cases


def apply_mode(snippet: str, mode: str) -> str:
    stripped = snippet.lstrip()
    if stripped.startswith("aeon:mode") or stripped.startswith("aeon:header"):
        return snippet
    return f'aeon:mode = "{mode}"\n{snippet}'


def implementation_available(name: str) -> bool:
    if name == "typescript":
        return Path(TS_FMT_CMD[1]).is_file()
    if name == "python":
        return Path(PY_FMT_CMD[0]).is_file() and Path(PY_FMT_CMD[0]).stat().st_mode & 0o111 != 0
    if name == "rust":
        return Path(RUST_FMT_CMD[0]).is_file() and Path(RUST_FMT_CMD[0]).stat().st_mode & 0o111 != 0
    return False


def inspect_command(name: str) -> list[str]:
    if name == "typescript":
        return TS_INSPECT_CMD
    if name == "python":
        return PY_INSPECT_CMD
    if name == "rust":
        return RUST_INSPECT_CMD
    raise ValueError(f"unknown implementation: {name}")


def fmt_command(name: str) -> list[str]:
    if name == "typescript":
        return TS_FMT_CMD
    if name == "python":
        return PY_FMT_CMD
    if name == "rust":
        return RUST_FMT_CMD
    raise ValueError(f"unknown implementation: {name}")


def run_inspect(impl: str, source: str, name: str) -> InspectResult:
    command = inspect_command(impl)
    with tempfile.TemporaryDirectory(prefix="aeon-whitespace-inspect-") as tmpdir:
        fixture = Path(tmpdir) / name
        fixture.write_text(source, encoding="utf-8")
        completed = subprocess.run(
            [*command, str(fixture), "--json"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        return InspectResult(False, output)
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return InspectResult(False, output)
    errors = parsed.get("errors")
    return InspectResult(isinstance(errors, list) and not errors, output)


def run_fmt(impl: str, source: str, name: str) -> FmtResult:
    command = fmt_command(impl)
    with tempfile.TemporaryDirectory(prefix="aeon-whitespace-fmt-") as tmpdir:
        fixture = Path(tmpdir) / name
        fixture.write_text(source, encoding="utf-8")
        completed = subprocess.run(
            [*command, str(fixture)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
    return FmtResult(completed.returncode, completed.stdout, completed.stderr)


def status_label(enabled: bool, label: str) -> str:
    colors = {"PASS": "32", "FAIL": "31"}
    return f"\033[{colors.get(label, '0')}m{label}\033[0m" if enabled else label


def render_diff(left: str, right: str, left_label: str, right_label: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            left.splitlines(),
            right.splitlines(),
            fromfile=left_label,
            tofile=right_label,
            lineterm="",
        )
    )


def structural_mutations(seed: str) -> list[Mutation]:
    variants = [
        ("space-before", " ", ""),
        ("space-after", "", " "),
        ("space-around", " ", " "),
        ("newline-before", "\n", ""),
        ("newline-after", "", "\n"),
        ("newline-around", "\n", "\n"),
    ]
    mutations: list[Mutation] = []
    for index, token in enumerate(seed):
        if token not in MUTATION_TOKENS:
            continue
        for label, before, after in variants:
            mutations.append(Mutation(index=index, token=token, label=label, before=before, after=after))
    return mutations


def apply_mutations(seed: str, mutations: tuple[Mutation, ...]) -> str:
    output = seed
    for mutation in sorted(mutations, key=lambda item: item.index, reverse=True):
        output = (
            output[:mutation.index]
            + mutation.before
            + output[mutation.index]
            + mutation.after
            + output[mutation.index + 1:]
        )
    return output


def generate_variants(seed: str, depth: int, max_variants: int) -> list[tuple[str, str]]:
    base = seed.rstrip("\n")
    all_mutations = structural_mutations(base)
    variants: list[tuple[str, str]] = [("baseline", base + "\n")]
    seen = {base + "\n"}
    if depth < 1:
        return variants

    for current_depth in range(1, depth + 1):
        for combo in itertools.combinations(all_mutations, current_depth):
            indices = {mutation.index for mutation in combo}
            if len(indices) != len(combo):
                continue
            mutated = apply_mutations(base, combo).rstrip("\n") + "\n"
            if mutated in seen:
                continue
            seen.add(mutated)
            description = ", ".join(
                f"{mutation.token}@{mutation.index + 1}:{mutation.label}" for mutation in combo
            )
            variants.append((description, mutated))
            if len(variants) >= max_variants:
                return variants
    return variants


def summarize_acceptance(results: dict[str, InspectResult]) -> str:
    parts = []
    for impl, result in results.items():
        parts.append(f"{impl}={'ok' if result.accepted else 'fail'}")
    return ", ".join(parts)


def main() -> int:
    args = parse_args()
    color = not args.no_color and sys.stdout.isatty()
    implementations = [name for name in ("typescript", "python", "rust") if implementation_available(name)]
    if len(implementations) < 2:
        print("Need at least two available implementations to compare whitespace mutations.", file=sys.stderr)
        return 2

    seeds = split_cases(Path(args.seeds_file).read_text(encoding="utf-8"))
    if not seeds:
        print(f"No seeds found in {args.seeds_file}", file=sys.stderr)
        return 2

    total = 0
    mismatches = 0

    for seed_index, seed in enumerate(seeds, start=1):
        variants = generate_variants(seed, args.depth, args.max_variants)
        for variant_index, (label, variant) in enumerate(variants, start=1):
            total += 1
            source = apply_mode(variant, args.mode)
            inspect_results = {
                impl: run_inspect(impl, source, f"seed-{seed_index}-variant-{variant_index}.aeon")
                for impl in implementations
            }
            accepted = {impl for impl, result in inspect_results.items() if result.accepted}
            if accepted and accepted != set(implementations):
                mismatches += 1
                print(f"{status_label(color, 'FAIL')}  seed {seed_index} variant {variant_index}: {label}")
                print(f"  acceptance mismatch: {summarize_acceptance(inspect_results)}")
                print("  snippet:")
                for line in variant.rstrip("\n").splitlines():
                    print(f"    {line}")
                if not args.brief:
                    for impl in implementations:
                        if inspect_results[impl].accepted:
                            continue
                        print(f"  {impl} output:")
                        for line in inspect_results[impl].output.strip().splitlines()[:40]:
                            print(f"    {line}")
                continue

            if accepted != set(implementations):
                continue

            fmt_results = {
                impl: run_fmt(impl, source, f"seed-{seed_index}-variant-{variant_index}.aeon")
                for impl in implementations
            }
            baseline_impl = implementations[0]
            baseline = fmt_results[baseline_impl]
            if baseline.code != 0:
                mismatches += 1
                print(f"{status_label(color, 'FAIL')}  seed {seed_index} variant {variant_index}: {label}")
                print(f"  formatting failed for {baseline_impl}")
                print("  snippet:")
                for line in variant.rstrip("\n").splitlines():
                    print(f"    {line}")
                if not args.brief:
                    for line in baseline.stderr.strip().splitlines()[:40]:
                        print(f"    {line}")
                continue

            mismatch_impl = next(
                (
                    impl
                    for impl in implementations[1:]
                    if fmt_results[impl].code != 0 or fmt_results[impl].stdout != baseline.stdout
                ),
                None,
            )
            if mismatch_impl is None:
                continue

            mismatches += 1
            print(f"{status_label(color, 'FAIL')}  seed {seed_index} variant {variant_index}: {label}")
            print("  snippet:")
            for line in variant.rstrip("\n").splitlines():
                print(f"    {line}")
            if not args.brief:
                mismatch = fmt_results[mismatch_impl]
                if mismatch.code != 0:
                    print(f"  {mismatch_impl} fmt failed:")
                    for line in mismatch.stderr.strip().splitlines()[:40]:
                        print(f"    {line}")
                else:
                    print(render_diff(baseline.stdout, mismatch.stdout, baseline_impl, mismatch_impl))

    print()
    print(f"Whitespace mutation summary: total={total} mismatches={mismatches} clean={total - mismatches}")
    return 1 if mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
