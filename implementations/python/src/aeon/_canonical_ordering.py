"""Experimental reference-safe ordering, independent of historical rendering.

Only Core authored-reference legality is consulted. No reference evaluation,
profile/schema validation, default-contract promotion, or JSON conversion.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import heapq
from typing import TYPE_CHECKING

from .ast import (
    Attribute, AttributePathSegment, Binding, CloneReference, Document,
    ListNode, NodeLiteral, ObjectNode, PointerReference, TupleLiteral, TypedValue,
    Value,
)
from .core import resolve_paths, validate_references
from .errors import CanonicalOrderingError

if TYPE_CHECKING:
    from .canonical import CanonicalizeOptions, CanonicalResult

Path = tuple[str | int | AttributePathSegment, ...]


@dataclass(eq=False, slots=True)
class _Scope:
    identity: list
    keys: list[str]
    successors: dict[int, set[int]] = field(default_factory=dict)
    indegree: list[int] = field(default_factory=list)


@dataclass(slots=True)
class _Membership:
    scope: _Scope
    entry: int
    parent: _Membership | None


def _orders(document: Document, max_edges: int, resolved) -> dict[int, list[int]]:
    scopes: list[_Scope] = []
    candidates: dict[tuple[str, Path], _Membership | None] = {}
    claims: list[tuple[Path, _Membership | None]] = []
    payload_planes: dict[Path, str] = {}
    for binding in resolved:
        path = tuple(segment.key if segment.type == "member" else segment.index
                     for segment in binding.path.segments if segment.type != "root")
        previous = payload_planes.get(path)
        if previous is None or (previous == "header" and binding.source_plane == "body"):
            payload_planes[path] = binding.source_plane

    plane = "header"

    def scope(identity: list, keys: list[str]) -> _Scope:
        result = _Scope(identity, keys, indegree=[0] * len(keys))
        scopes.append(result)
        return result

    def attributes(head: list[Attribute], path: Path, parent: _Membership | None, targetable: bool) -> None:
        if not head:
            return
        entries = [(key, entry) for attribute in head for key, entry in attribute.entries.items()]
        owner = scope(head, [key for key, _ in entries])
        for index, (key, entry) in enumerate(entries):
            child = (*path, AttributePathSegment(key=key))
            membership = _Membership(owner, index, parent)
            attributes(entry.attributes, child, membership, targetable)
            value(entry.value, child, membership, targetable)

    def bindings(entries: list[Binding], path: Path, parent: _Membership | None,
                 header: bool = False, targetable: bool = True) -> None:
        owner = scope(entries, [binding.key for binding in entries])
        for index, binding in enumerate(entries):
            child = (*path, f"aeon:{binding.key}" if header else binding.key)
            membership = _Membership(owner, index, parent)
            attributes(binding.attributes, child, membership, targetable)
            value(binding.value, child, membership, targetable)

    def value(payload: Value, path: Path, membership: _Membership | None, targetable: bool) -> None:
        if isinstance(payload, TypedValue):
            attributes(payload.attributes, path, membership, targetable)
            value(payload.value, path, membership, targetable)
            return
        if isinstance(payload, (ObjectNode, ListNode, TupleLiteral)):
            attributes(payload.attributes, path, membership, targetable)
        elif isinstance(payload, NodeLiteral):
            # Implicit node heads are not source-addressable, but references
            # within their metadata still constrain enclosing sortable scopes.
            attributes(payload.attributes, path, membership, False)
        if isinstance(payload, (CloneReference, PointerReference)):
            claims.append((tuple(payload.path), membership))
        if targetable:
            candidates.setdefault((plane, path), membership)
        if isinstance(payload, ObjectNode):
            bindings(payload.bindings, path, membership, targetable=targetable)
        elif isinstance(payload, (ListNode, TupleLiteral, NodeLiteral)):
            items = payload.children if isinstance(payload, NodeLiteral) else payload.elements
            for index, item in enumerate(items):
                value(item, (*path, index), membership, targetable)

    if document.header is not None:
        bindings(document.header.bindings, (), None, header=True)
    plane = "body"
    bindings(document.bindings, (), None)
    targets: dict[Path, _Membership | None] = {}
    for (candidate_plane, path), membership in candidates.items():
        # The nearest actual payload owns metadata. Body payloads shadow exact
        # header paths, not independently retained header descendant payloads.
        for length in range(len(path), 0, -1):
            owner = payload_planes.get(path[:length])
            if owner is not None:
                if owner == candidate_plane:
                    targets[path] = membership
                break

    edge_count = 0
    for path, membership in claims:
        if path not in targets:
            raise CanonicalOrderingError("CANONICAL_ORDERING_CONFLICT",
                                         "A validated reference has no ordering target", document.span)
        source_entries: dict[_Scope, int] = {}
        source = membership
        while source is not None:
            source_entries[source.scope] = source.entry
            source = source.parent
        target = targets[path]
        while target is not None:
            entry = source_entries.get(target.scope)
            if entry is not None and entry != target.entry:
                successors = target.scope.successors.setdefault(target.entry, set())
                if entry not in successors:
                    if edge_count >= max_edges:
                        raise CanonicalOrderingError("CANONICAL_ORDERING_LIMIT_EXCEEDED",
                                                     f"Canonical ordering exceeds {max_edges} dependency edges", document.span)
                    edge_count += 1
                    successors.add(entry)
                    target.scope.indegree[entry] += 1
            target = target.parent

    orders: dict[int, list[int]] = {}
    for owner in scopes:
        # Python string comparison orders Unicode scalars, not UTF-16 units.
        heap = [(key, index) for index, key in enumerate(owner.keys) if owner.indegree[index] == 0]
        heapq.heapify(heap)
        ordered: list[int] = []
        while heap:
            _, index = heapq.heappop(heap)
            ordered.append(index)
            for successor in owner.successors.get(index, ()):
                owner.indegree[successor] -= 1
                if owner.indegree[successor] == 0:
                    heapq.heappush(heap, (owner.keys[successor], successor))
        if len(ordered) != len(owner.keys):
            raise CanonicalOrderingError("CANONICAL_ORDERING_CONFLICT",
                                         "Canonical ordering dependencies form a cycle", document.span)
        orders[id(owner.identity)] = ordered
    return orders


class _Renderer:
    """Read the plan without mutating or re-sorting the authored AST."""

    def __init__(self, document: Document, orders: dict[int, list[int]]) -> None:
        from . import canonical

        self.format = canonical
        self.document = document
        self.orders = orders

    def ordered(self, identity: list, entries: list):
        indices = self.orders.get(id(identity))
        if indices is None:
            raise CanonicalOrderingError("CANONICAL_ORDERING_CONFLICT",
                                         "A sortable scope has no canonical ordering plan", self.document.span)
        return [entries[index] for index in indices]

    def head(self, key: str | None, owner) -> str:
        identity = f"\\{owner.structural_id}\\" if owner.structural_id is not None else ""
        attributes = self.attributes(owner.attributes)
        if key is None:
            formatted = ""
        elif key == "aeon" and owner.datatype is not None and not identity and not attributes:
            formatted = self.format.format_string(key)  # Avoid the aeon: namespace token.
        else:
            formatted = self.format.format_binding_key(key)
        return formatted + identity + attributes + self.format.render_type(owner.datatype)

    def attributes(self, attributes: list[Attribute]) -> str:
        if not attributes:
            return ""
        entries = [(key, entry) for attribute in attributes for key, entry in attribute.entries.items()]
        ordered = self.ordered(attributes, entries)
        if not ordered:
            return ""
        return "@{" + ", ".join(f"{self.head(key, entry)} = {self.compact(entry.value)}"
                                 for key, entry in ordered) + "}"

    def binding(self, binding: Binding, indent: int) -> list[str]:
        key = self.head(binding.key, binding)
        prefix = " " * indent
        payload = binding.value
        if isinstance(payload, ObjectNode):
            lines = [f"{prefix}{key} = {{"]
            for child in self.ordered(payload.bindings, payload.bindings):
                lines.extend(self.binding(child, indent + 2))
            return [*lines, f"{prefix}}}"]
        if isinstance(payload, (ListNode, TupleLiteral)):
            opening, closing = ("[", "]") if isinstance(payload, ListNode) else ("(", ")")
            if all(self.format.is_simple_value(item) for item in payload.elements):
                body = ", ".join(self.value(item, indent + 1, True)[0] for item in payload.elements)
                return [f"{prefix}{key} = {opening}{body}{closing}"]
            lines = self.collection(payload.elements, indent, opening, closing)
        elif isinstance(payload, NodeLiteral):
            lines = self.node(payload, indent, False)
        else:
            lines = self.value(payload, indent, True)
        return [f"{prefix}{key} = {lines[0].lstrip()}", *lines[1:]]

    def collection(self, items: list[Value], indent: int, opening: str,
                   closing: str, inline_items: bool = False) -> list[str]:
        prefix = " " * indent
        lines = [prefix + opening]
        for index, item in enumerate(items):
            rendered = self.value(item, indent + 2, inline_items)
            if not rendered[0].startswith(" " * (indent + 2)):
                rendered[0] = " " * (indent + 2) + rendered[0]
            if index < len(items) - 1:
                rendered[-1] += ","
            lines.extend(rendered)
        return [*lines, prefix + closing]

    def node(self, payload: NodeLiteral, indent: int, inline: bool) -> list[str]:
        head = "<" + self.head(payload.tag, payload)
        if not payload.children:
            return [head + ">"]
        if inline and all(self.format.is_simple_value(item) for item in payload.children):
            return [head + "(" + ", ".join(self.value(item, indent + 1, True)[0]
                                           for item in payload.children) + ")>"]
        return self.collection(payload.children, indent, head + "(", ")>", inline_items=True)

    def value(self, payload: Value, indent: int, inline: bool) -> list[str]:
        if isinstance(payload, TypedValue):
            rendered = self.value(payload.value, indent, inline)
            return [self.head(None, payload) + " = " + rendered[0].lstrip(), *rendered[1:]]
        if isinstance(payload, ObjectNode):
            lines = [" " * indent + "{"]
            for child in self.ordered(payload.bindings, payload.bindings):
                lines.extend(self.binding(child, indent + 2))
            return [*lines, " " * indent + "}"]
        if isinstance(payload, (ListNode, TupleLiteral)):
            opening, closing = ("[", "]") if isinstance(payload, ListNode) else ("(", ")")
            if inline and all(self.format.is_simple_value(item) for item in payload.elements):
                return [opening + ", ".join(self.value(item, indent + 1, True)[0]
                                            for item in payload.elements) + closing]
            return self.collection(payload.elements, indent, opening, closing)
        if isinstance(payload, NodeLiteral):
            return self.node(payload, indent, inline)
        return self.format.render_value(payload, indent, inline_only=inline)

    def compact(self, payload: Value) -> str:
        if isinstance(payload, TypedValue):
            return self.head(None, payload) + " = " + self.compact(payload.value)
        if isinstance(payload, ObjectNode):
            entries = [f"{self.head(binding.key, binding)} = {self.compact(binding.value)}"
                       for binding in self.ordered(payload.bindings, payload.bindings)]
            return "{ " + ", ".join(entries) + " }" if entries else "{ }"
        if isinstance(payload, (ListNode, TupleLiteral)):
            opening, closing = ("[", "]") if isinstance(payload, ListNode) else ("(", ")")
            return opening + ", ".join(self.compact(item) for item in payload.elements) + closing
        if isinstance(payload, NodeLiteral):
            head = "<" + self.head(payload.tag, payload)
            return head + ("(" + ", ".join(self.compact(item) for item in payload.children) + ")>"
                           if payload.children else ">")
        return self.format.render_compact_inline_value(payload)

    def render(self) -> str:
        lines = ["aeon:header = {"]
        if self.document.header is None:
            # Default bindings are introduced only after authored validation.
            for key, value in sorted(self.format.DEFAULT_HEADER.items()):
                lines.append(f"  {key} = {self.compact(value)}")
        else:
            for binding in self.ordered(self.document.header.bindings, self.document.header.bindings):
                lines.extend(self.binding(binding, 2))
        lines.append("}")
        for binding in self.ordered(self.document.bindings, self.document.bindings):
            lines.extend(self.binding(binding, 0))
        return "\n".join(lines) + "\n"


def canonicalize_document(document: Document, options: CanonicalizeOptions) -> CanonicalResult:
    from .canonical import CanonicalResult
    from .lexer import tokenize
    from .parser import parse_tokens

    max_edges = options.max_ordering_edges
    if type(max_edges) is not int or not 0 <= max_edges <= 9_007_199_254_740_991:
        return CanonicalResult(text="", errors=[CanonicalOrderingError(
            "CANONICAL_ORDERING_INVALID_OPTION", "max_ordering_edges must be a non-negative safe integer", document.span
        )])
    resolved, errors = resolve_paths(document)
    if not errors:
        errors = validate_references(resolved, options.max_attribute_depth)
    if errors:
        return CanonicalResult(text="", errors=errors)
    try:
        text = _Renderer(document, _orders(document, max_edges, resolved)).render()
    except CanonicalOrderingError as error:
        return CanonicalResult(text="", errors=[error])
    lexed = tokenize(text)
    emitted = parse_tokens(
        text, lexed.tokens, max_attribute_depth=options.max_attribute_depth,
        max_clarifier_values=options.max_clarifier_values, max_generic_depth=options.max_generic_depth,
        max_generic_arguments=options.max_generic_arguments, max_datatype_components=options.max_datatype_components,
    )
    valid = not lexed.errors and not emitted.errors and emitted.document is not None
    if valid:
        emitted_bindings, errors = resolve_paths(emitted.document)
        valid = not errors and not validate_references(emitted_bindings, options.max_attribute_depth)
    if not valid:
        return CanonicalResult(text="", errors=[CanonicalOrderingError(
            "CANONICAL_ORDERING_CONFLICT", "Canonical output failed Core reference validation", document.span
        )])
    return CanonicalResult(text=text, errors=[])
