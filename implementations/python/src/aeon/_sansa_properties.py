"""Private property admission, occurrence frames and checked inspection work.

The caller supplies authoritative callbacks. Public binding fields never grant
property capabilities. No frame, counter or mutable session is returned.
"""
from types import MappingProxyType
import math
from inspect import getattr_static

MAX_SELECTORS = 256
MAX_ARGUMENT_SCALARS = 4096
MAX_CANONICAL_SCALARS = 65536
DEFAULT_INSPECTIONS = 10000
MAX_INSPECTIONS = 1000000


class SansaPropertyAccessError(Exception):
    """A checked adapter failure; neither message nor arbitrary host data escapes."""
    __slots__ = ("kind",)

    def __init__(self, kind):
        if type(kind) is not str or kind not in {"invalidMetadata", "scopeViolation", "adapterFailure"}:
            raise ValueError("Invalid property access error kind")
        self.kind = kind
        super().__init__(kind)


def has_property_syntax(text):
    quoted = escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "&":
            return True
    return False


def valid_limit(value):
    return (type(value) is int and 0 <= value <= MAX_INSPECTIONS) or (
        type(value) is float and math.isfinite(value) and value.is_integer()
        and 0 <= value <= MAX_INSPECTIONS
    )


def scalar(value):
    return type(value) is str and all(not 0xD800 <= ord(c) <= 0xDFFF for c in value)


def frame(root):
    return MappingProxyType({"scopeRoot": root, "evaluationRoot": root})


def error(code, index=None, property=None, **details):
    result = {"code": code, "message": "Property resolution failed"}
    if index is not None:
        result["selectorIndex"] = index
    if property is not None:
        result["property"] = property
    result.update(details)
    return result


def fault(cause, index, property):
    code = "SANSA_RESOLVE_PROPERTY_ADAPTER_ERROR"
    # Do not read arbitrary exception attributes, descriptors or string values.
    if type(cause) is SansaPropertyAccessError:
        try:
            kind = cause.kind
        except Exception:
            return error(code, index, property)
        if type(kind) is str:
            code = {"invalidMetadata": "SANSA_RESOLVE_INVALID_PROPERTY_METADATA",
                    "scopeViolation": "SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION"}.get(kind, code)
    return error(code, index, property)


def prepare(namespace, selectors):
    facet = namespace.get("properties")
    for index, selector in enumerate(selectors):
        if selector["type"] != "propertyFilter":
            continue
        property = selector["property"]
        if type(facet) is not dict or not callable(facet.get("scope")):
            return None, error("SANSA_RESOLVE_UNSUPPORTED_PROPERTY_SCOPE", index, property)
        required = ["key"] if property == "key" else ["nodeKind", "nodeTag", "nodeHeads"]
        if any(not callable(facet.get(name)) for name in required):
            return None, error("SANSA_RESOLVE_UNSUPPORTED_KEY" if property == "key" else "SANSA_RESOLVE_UNSUPPORTED_TAG", index, property)
    # Hold the selected callbacks, not a mutable caller-owned facet lookup table.
    return {name: facet.get(name) for name in ["scope", "key", "nodeKind", "nodeTag", "nodeHeads"]}, None


def _charge(budget, index, property):
    if budget["inspected"] >= budget["limit"]:
        return error("SANSA_RESOLVE_PROPERTY_LIMIT_EXCEEDED", index, property,
                     budget="maxPropertyInspections", limit=budget["limit"], observed=budget["limit"] + 1)
    budget["inspected"] += 1
    return None


def _authorize(binding, context, facet, index, property):
    role = facet["scope"](binding, context)
    if type(role) is not str or role not in {"root", "inside", "outside"}:
        return None, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
    if role == "outside":
        return None, error("SANSA_RESOLVE_PROPERTY_SCOPE_VIOLATION", index, property)
    if (role == "root") != (binding is context["scopeRoot"]):
        return None, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
    return role, None


def _tag(binding, context, facet, index):
    kind = facet["nodeKind"](binding, context)
    if type(kind) is not str or kind not in {"NodeLiteral", "NodeHead", "Other"}:
        return None, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, "tag")
    return kind, None


def select(binding, context, facet, selector, index, budget):
    property, expected = selector["property"], selector["value"]
    iterator = None
    exhausted = False
    result = (False, None)
    try:
        issue = _charge(budget, index, property)
        if issue is not None:
            return False, issue
        role, issue = _authorize(binding, context, facet, index, property)
        if issue is not None:
            return False, issue
        if property == "key":
            if role == "root":
                return False, None
            value = facet["key"](binding, context)
            if value is not None and not scalar(value):
                return False, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
            return value == expected, None
        kind, issue = _tag(binding, context, facet, index)
        if issue is not None or kind == "Other":
            return False, issue
        if kind == "NodeHead":
            value = facet["nodeTag"](binding, context)
            if value is not None and not scalar(value):
                return False, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
            return value == expected, None
        heads = facet["nodeHeads"](binding, context)
        try:
            iterator = iter(heads)
        except TypeError:
            if getattr_static(type(heads), "__iter__", None) is None and getattr_static(type(heads), "__getitem__", None) is None:
                return False, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
            raise
        head_context = MappingProxyType({**context, "directHeadOf": binding})
        while True:
            try:
                head = next(iterator)
            except StopIteration:
                exhausted = True
                break
            issue = _charge(budget, index, property)
            if issue is not None:
                result = False, issue
                break
            _, issue = _authorize(head, head_context, facet, index, property)
            if issue is not None:
                result = False, issue
                break
            head_kind, issue = _tag(head, head_context, facet, index)
            if issue is not None or head_kind != "NodeHead":
                result = False, issue or error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
                break
            value = facet["nodeTag"](head, head_context)
            if value is not None and not scalar(value):
                result = False, error("SANSA_RESOLVE_INVALID_PROPERTY_METADATA", index, property)
                break
            if value == expected:
                result = True, None
                break
    except Exception as cause:
        result = False, fault(cause, index, property)
    finally:
        if iterator is not None and not exhausted:
            try:
                close = getattr(iterator, "close", None)
                if callable(close):
                    close()
            except Exception as cause:
                result = False, fault(cause, index, property)
    return result


def resolve(address, namespace, root, facet, policy, limit):
    from . import sansa
    current = [(root, frame(root))]
    budget = {"inspected": 0, "limit": int(limit)}
    maximum = policy.get("maxBindings")
    policy = {**policy, "_propertyFrames": True}

    def failed(issue):
        return {"ok": False, "bindings": [], "errors": [issue]}

    for index, selector in enumerate(address["selectors"]):
        kind = selector["type"]
        if kind in {"parent", "attributeSpace"}:
            # Preserve the old whole-set support and policy decisions. Projection
            # follows input occurrence indices, never binding equality or a map.
            sources = [row for row in current if row[0] is not policy.get("effectiveRoot")] if kind == "parent" else current
            def project(binding, source_index):
                return binding, frame(binding) if kind == "attributeSpace" else sources[source_index][1]
            bindings = [row[0] for row in current]
            selected = sansa.select_parents(namespace, bindings, index, policy, project) if kind == "parent" else sansa.select_attribute_spaces(namespace, bindings, index, project)
            if not selected["ok"]:
                return failed(selected["error"])
            current = selected["bindings"]
            if maximum is not None and len(current) > maximum:
                return failed(error("SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED", index, limit=maximum, observed=maximum + 1))
        else:
            following = []
            for binding, context in current:
                if kind == "propertyFilter":
                    matched, issue = select(binding, context, facet, selector, index, budget)
                    if issue is not None:
                        return failed(issue)
                    if matched:
                        following.append((binding, context))
                else:
                    remaining = None if maximum is None else maximum - len(following)
                    selected = sansa.apply_resolve_selector(selector, [binding], namespace, index, {**policy, "maxBindings": remaining})
                    if not selected["ok"]:
                        issue = selected["error"]
                        if issue["code"] == "SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED" and maximum is not None:
                            issue = error(issue["code"], index, limit=maximum, observed=maximum + 1)
                        return failed(issue)
                    following.extend((value, frame(value) if kind == "localSpace" else context) for value in selected["bindings"])
                if maximum is not None and len(following) > maximum:
                    return failed(error("SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED", index, limit=maximum, observed=maximum + 1))
            current = following
        if not current:
            break
    return {"ok": True, "bindings": [row[0] for row in current], "diagnostics": []}
