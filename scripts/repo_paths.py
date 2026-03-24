from __future__ import annotations

from pathlib import Path
import os

AEONITE_CTS_ROOT_ENV = "AEONITE_CTS_ROOT"
AEON_TOOLING_PRIVATE_ROOT_ENV = "AEON_TOOLING_PRIVATE_ROOT"
AEONITE_SPECS_ROOT_ENV = "AEONITE_SPECS_ROOT"


def get_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def get_family_root() -> Path:
    return get_repo_root().parents[1]


def get_aeonite_cts_root() -> Path:
    return Path(
        os.environ.get(
            AEONITE_CTS_ROOT_ENV,
            str(get_family_root() / "aeonite-org" / "aeonite-cts" / "cts"),
        )
    )


def get_aeon_tooling_private_root() -> Path:
    return Path(
        os.environ.get(
            AEON_TOOLING_PRIVATE_ROOT_ENV,
            str(get_family_root() / "altopelago" / "aeon-tooling-private"),
        )
    )


def get_aeonite_specs_root() -> Path:
    return Path(
        os.environ.get(
            AEONITE_SPECS_ROOT_ENV,
            str(get_family_root() / "aeonite-org" / "aeonite-specs"),
        )
    )


def repo_path_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base or os.environ)
    env.setdefault(AEONITE_CTS_ROOT_ENV, str(get_aeonite_cts_root()))
    env.setdefault(AEON_TOOLING_PRIVATE_ROOT_ENV, str(get_aeon_tooling_private_root()))
    env.setdefault(AEONITE_SPECS_ROOT_ENV, str(get_aeonite_specs_root()))
    return env
