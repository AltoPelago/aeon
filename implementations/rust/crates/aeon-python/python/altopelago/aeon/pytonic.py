"""Immutable AEON document views with shared Rust SANSA Query evaluation."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from ._native import (
    Binding,
    Capabilities,
    Clarifier,
    Document,
    GenericArgument,
    QueryField,
    QueryObject,
    QueryRecord,
    QueryResult,
    QueryScalar,
    SansaCapabilities,
    SansaDiagnostic,
    Value,
    pytonic_loads,
)
from .errors import NativeError

DatatypePolicy = Literal["reserved_only", "allow_custom"]


def loads(
    source: str,
    *,
    datatype_policy: DatatypePolicy | None = None,
    max_attribute_depth: int | None = None,
) -> Document:
    """Compile AEON source into an immutable, metadata-preserving document."""

    try:
        return pytonic_loads(
            source,
            datatype_policy=datatype_policy,
            max_attribute_depth=max_attribute_depth,
        )
    except RuntimeError as error:
        raise NativeError(str(error)) from error


def load(
    path: str | Path,
    *,
    datatype_policy: DatatypePolicy | None = None,
    max_attribute_depth: int | None = None,
) -> Document:
    """Read UTF-8 AEON source and return an immutable document."""

    source = Path(path).read_bytes().decode("utf-8")
    return loads(
        source,
        datatype_policy=datatype_policy,
        max_attribute_depth=max_attribute_depth,
    )


__all__ = (
    "Binding",
    "Capabilities",
    "Clarifier",
    "Document",
    "GenericArgument",
    "QueryField",
    "QueryObject",
    "QueryRecord",
    "QueryResult",
    "QueryScalar",
    "SansaCapabilities",
    "SansaDiagnostic",
    "Value",
    "load",
    "loads",
)
