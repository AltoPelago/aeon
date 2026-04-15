#!/usr/bin/env python3
"""Stage a fuzz artifact for shared stress-test review.

Run from repo root.
Examples:
  python3 ./scripts/stress-promote-artifact.py \
    --artifact implementations/rust/fuzz/artifacts/token_parse/oom-... \
    --slug token-parse-oom-2026-04-15
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INBOX_ROOT = ROOT / "stress-tests" / "inbox" / "fuzz-artifacts"
TRIAGE_SCRIPT = ROOT / "scripts" / "stress-fuzz-artifacts.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage a fuzz artifact into the stress-test inbox.")
    parser.add_argument("--artifact", required=True, help="Artifact file to stage.")
    parser.add_argument("--slug", required=True, help="Stable directory name to create under the inbox.")
    parser.add_argument(
        "--status",
        default="needs-reduction-review",
        help="Initial triage status to write into metadata.",
    )
    parser.add_argument(
        "--promotion-target",
        default="undecided",
        help="Initial intended promotion target (for example edge, domain/addressing, cts-core, implementation-only).",
    )
    parser.add_argument(
        "--notes",
        default="",
        help="Optional short notes string to write into metadata.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Per-implementation timeout passed through to stress-fuzz-artifacts.py.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be created without writing files.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    artifact = Path(args.artifact).resolve()
    if not artifact.is_file():
        print(f"Artifact does not exist: {artifact}", file=sys.stderr)
        return 2

    destination_dir = INBOX_ROOT / args.slug
    destination_artifact = destination_dir / f"artifact{artifact.suffix or '.bin'}"
    destination_meta = destination_dir / "meta.json"
    destination_notes = destination_dir / "notes.md"

    triage = subprocess.run(
        [
            "python3",
            str(TRIAGE_SCRIPT),
            "--artifact",
            str(artifact),
            "--brief",
            "--timeout",
            str(args.timeout),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )

    metadata = {
        "source_artifact": str(artifact.relative_to(ROOT)) if artifact.is_relative_to(ROOT) else str(artifact),
        "slug": args.slug,
        "status": args.status,
        "promotion_target": args.promotion_target,
        "notes": args.notes,
        "triage_command": f"python3 ./scripts/stress-fuzz-artifacts.py --artifact {artifact} --brief --timeout {args.timeout}",
        "triage_exit_code": triage.returncode,
        "triage_summary": triage.stdout.strip(),
    }

    if args.dry_run:
        print(json.dumps(
            {
                "destination_dir": str(destination_dir),
                "artifact_copy": str(destination_artifact),
                "meta_file": str(destination_meta),
                "notes_file": str(destination_notes),
                "metadata": metadata,
            },
            indent=2,
        ))
        return 0

    destination_dir.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(artifact, destination_artifact)
    destination_meta.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    destination_notes.write_text(
        "\n".join(
            [
                f"# {args.slug}",
                "",
                f"- Source artifact: `{metadata['source_artifact']}`",
                f"- Status: `{args.status}`",
                f"- Promotion target: `{args.promotion_target}`",
                "",
                "## Triage summary",
                "",
                "```text",
                triage.stdout.strip() or "(no triage output)",
                "```",
                "",
                "## Reduction notes",
                "",
                args.notes or "_Add reduction and promotion notes here._",
                "",
            ]
        ),
        encoding="utf-8",
    )

    print(destination_dir.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
