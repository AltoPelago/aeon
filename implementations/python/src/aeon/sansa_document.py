"""Experimental read-only SANSA projection of complete portable AES documents.

Body and header are separate namespace instances. AEOS rule selectors keep their
existing default-off namespace; this module does not grant consumer admission.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping

from .aeos import create_aeos_sansa_resolve_namespace
from ._sansa_cursor import MAX_POSITION_INDEX
from .portable import adapt_python_assignment_events_to_portable_aes
from .telex import AEON_DOCUMENT_PROJECTION, TelexLimits, parse_canonical_path, validate_telex_records


class SansaNamespaceError(ValueError):
    def __init__(self, diagnostics: list[dict[str, object]]) -> None:
        self.diagnostics = diagnostics
        self.code = str(diagnostics[0]["code"])
        super().__init__(f"{self.code}: {diagnostics[0]['message']}")


def namespace_from_portable_records(
    records: Iterable[Mapping[str, object]],
    *,
    scope: str = "payload",
    projection: str | None = None,
    limits: TelexLimits | Mapping[str, object] | None = None,
    registered_fields: Iterable[str] = (),
) -> dict[str, object]:
    """Snapshot one plane of validated complete AES records for read-only Resolve.

    Use scope='header' with the existing AEON document projection declaration.
    There is no combined plane that could collapse equal physical addresses.
    Validation retains AEON's document-wide identity rules; generic SANSA
    namespaces still need to detect ambiguity independently.
    """
    if scope not in {"payload", "header"}:
        raise ValueError("scope must be 'payload' or 'header'")
    # Copy record envelopes before validation, then retain only scalar projected
    # metadata. Later changes to the input records cannot retarget this namespace.
    items = [dict(record) for record in records]
    validation = validate_telex_records(
        items, projection=projection, limits=limits, registered_fields=registered_fields,
    )
    if not validation["valid"]:
        raise SansaNamespaceError(validation["diagnostics"])
    address_field = "path" if scope == "payload" else "header"
    events = {
        record[address_field]: {
            "type": record["kind"],
            "datatype": record.get("datatype"),
            "structuralId": record.get("identity"),
        }
        for record in items if address_field in record
    }
    namespace = create_aeos_sansa_resolve_namespace({})
    by_path = {"$": namespace["root"]}
    for path, info in events.items():
        details = parse_canonical_path(path)
        current = namespace["root"]
        for prefix, (kind, value) in zip(details.prefixes, details.segments):
            if kind == "index" and value > MAX_POSITION_INDEX:
                raise SansaNamespaceError([{
                    "code": "SANSA_RESOLVE_UNSUPPORTED_NAMESPACE_PATH",
                    "message": "Record position exceeds the portable SANSA index limit",
                    "path": path,
                }])
            if kind == "attribute":
                if "attributeSpace" not in current:
                    current["attributeSpace"] = {"path": current["path"] + ".@", "children": []}
                current = current["attributeSpace"]
            if prefix not in by_path:
                child = {"path": prefix, "children": []}
                child["index" if kind == "index" else "name"] = value
                current["children"].append(child)
                by_path[prefix] = child
            current = by_path[prefix]
        current["info"] = info
    # Numeric positions describe structural order, independent of record order.
    # Object members retain their first represented occurrence order.
    pending = [namespace["root"]]
    owned = {}
    while pending:
        binding = pending.pop()
        owned[id(binding)] = binding
        if "info" not in binding:
            binding["info"] = {"type": "ObjectNode"}
        children = binding["children"]
        if children and all("index" in child for child in children):
            children.sort(key=lambda child: child["index"])
        pending.extend(children)
        if "attributeSpace" in binding:
            pending.append(binding["attributeSpace"])
    namespace["identityScope"] = lambda binding: owned.get(id(binding)) is binding
    namespace["identity"] = lambda binding: binding.get("info", {}).get("structuralId")
    namespace["root"]["info"] = {"type": "ObjectNode"}
    return namespace


def namespace_from_assignment_events(
    events: Iterable[dict[str, object]],
    *,
    header: dict[str, object] | None = None,
    scope: str = "payload",
    limits: TelexLimits | Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Project native Python assignment events using the existing portable adapter."""
    projected = adapt_python_assignment_events_to_portable_aes(
        events, header=header, include_headers=True,
    )
    return namespace_from_portable_records(
        projected["events"], scope=scope, projection=AEON_DOCUMENT_PROJECTION, limits=limits,
    )
