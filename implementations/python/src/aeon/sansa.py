from __future__ import annotations

import re

from ._sansa_cursor import MAX_POSITION_INDEX, parse_dot_selector, parse_position_selector, validate_position_index


IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CHILD_IDENTITY_RE = re.compile(r"[A-Za-z0-9_-]+\Z")
QUALIFIER_NUMBER_RE = re.compile(r"^[+-]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|\.[0-9]+)$")


class SansaParseError(Exception):
    def __init__(self, message: str, index: int, code: str = "SANSA_PARSE_ERROR") -> None:
        super().__init__(message)
        self.message = message
        self.index = index
        self.code = code


def parse_address(input: str, options: dict[str, object] | None = None) -> dict[str, object]:
    try:
        parser = AddressParser(input, options or {})
        return {"ok": True, "address": parser.parse()}
    except SansaParseError as error:
        return {
            "ok": False,
            "errors": [
                {
                    "code": error.code,
                    "message": error.message,
                    "index": error.index,
                }
            ],
        }


def parse_address_or_throw(input: str, options: dict[str, object] | None = None) -> dict[str, object]:
    result = parse_address(input, options)
    if result["ok"]:
        return result["address"]  # type: ignore[return-value]
    first = result["errors"][0]  # type: ignore[index]
    raise SansaParseError(str(first["message"]), int(first["index"]), str(first["code"]))


def resolve_address(
    input: str | dict[str, object],
    namespace: dict[str, object],
    options: dict[str, object] | None = None,
) -> dict[str, object]:
    opts = options or {}
    parsed = parse_address(input, opts.get("parse") if isinstance(input, str) else None) if isinstance(input, str) else {"ok": True, "address": input}
    if not parsed["ok"]:
        return {"ok": False, "bindings": [], "errors": parsed["errors"]}

    address = parsed["address"]
    if not isinstance(address, dict):
        return {
            "ok": False,
            "bindings": [],
            "errors": [resolve_error("SANSA_RESOLVE_INVALID_ADDRESS", "Expected parsed SANSA address")],
        }

    selectors = address.get("selectors", [])
    if not isinstance(input, str) and isinstance(selectors, list) and len(selectors) > 1024:
        return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_INVALID_ADDRESS", "Caller AST selector limit exceeded")]}
    may_have_identity = not isinstance(input, str) or (not address.get("isExact") and ".\\" in input)
    has_identity = may_have_identity and isinstance(selectors, list) and any(
        isinstance(selector, dict) and selector.get("type") == "childIdentity" for selector in selectors
    )
    if has_identity and not isinstance(input, str):
        try:
            address = normalize_identity_address(address)
        except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_INVALID_ADDRESS", "Invalid identity address AST")]}
    identity_limit = opts.get("maxIdentityInspections", 10_000)
    if "maxIdentityInspections" in opts and (type(identity_limit) is not int or not 0 <= identity_limit <= 9_007_199_254_740_991):
        return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_INVALID_IDENTITY_LIMIT", "Identity inspection limit must be a non-negative safe integer")]}
    if has_identity and "maxBindings" in opts and (type(opts["maxBindings"]) is not int or not 0 <= opts["maxBindings"] <= 9_007_199_254_740_991):
        return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_INVALID_BINDING_LIMIT", "Resolve maxBindings must be a non-negative safe integer")]}

    root_result = resolve_root(address.get("root"), namespace, opts)
    if not root_result["ok"]:
        return {"ok": False, "bindings": [], "errors": [root_result["error"]]}

    if has_identity and not callable(namespace.get("identity")):
        index = next(i for i, selector in enumerate(selectors) if isinstance(selector, dict) and selector.get("type") == "childIdentity")
        return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_UNSUPPORTED_IDENTITY", "Namespace does not expose structural identities", index, identity=selectors[index]["identity"])]}
    if has_identity:
        identity_scope = namespace.get("identityScope")
        if callable(identity_scope) and identity_scope(root_result["binding"]) is not True:
            return {"ok": False, "bindings": [], "errors": [resolve_error("SANSA_RESOLVE_IDENTITY_SCOPE_MISMATCH", "Identity root belongs to another namespace scope")]}
    identity_budget = {"limit": identity_limit, "inspected": 0} if has_identity else None
    current = [root_result["binding"]]
    max_bindings = opts.get("maxBindings")
    if isinstance(max_bindings, bool) or not isinstance(max_bindings, int) or max_bindings < 0:
        max_bindings = None
    selectors = address.get("selectors", [])
    if not isinstance(selectors, list):
        selectors = []

    policy = {
        "effectiveRoot": None if opts.get("allowParentFromEffectiveRoot") is True else root_result["binding"],
        "parentTraversal": opts.get("parentTraversal"),
        "failOnParentFromEffectiveRoot": opts.get("failOnParentFromEffectiveRoot") is True,
    }
    if has_identity:
        policy.update(identityBudget=identity_budget, maxBindings=max_bindings)
    for index, selector in enumerate(selectors):
        if not isinstance(selector, dict):
            return {
                "ok": False,
                "bindings": [],
                "errors": [resolve_error("SANSA_RESOLVE_UNSUPPORTED_SELECTOR", "Unsupported SANSA selector", index)],
            }
        selected = apply_resolve_selector(
            selector,
            current,
            namespace,
            index,
            policy,
        )
        if not selected["ok"]:
            return {"ok": False, "bindings": [], "errors": [selected["error"]]}
        selected_bindings = selected.get("bindings", [])
        current = selected_bindings if isinstance(selected_bindings, list) else []
        if isinstance(max_bindings, int) and len(current) > max_bindings:
            error = resolve_error(
                "SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED",
                f"SANSA resolution binding count exceeds configured limit {max_bindings}",
                index,
            )
            error.update(limit=max_bindings, observed=max_bindings + 1)
            return {"ok": False, "bindings": [], "errors": [error]}
        if len(current) == 0:
            break

    if address.get("isExact") is True and len(current) > 1:
        return {
            "ok": False,
            "bindings": [],
            "errors": [
                resolve_error(
                    "SANSA_RESOLVE_EXACT_MULTIPLICITY_VIOLATION",
                    "Exact SANSA resolution produced more than one binding",
                )
            ],
        }

    return {"ok": True, "bindings": current, "diagnostics": []}


def render_address(address: dict[str, object]) -> str:
    root = address["root"]
    output = "$" if isinstance(root, dict) and root.get("kind") == "absolute" else "?"

    for selector in address.get("selectors", []):
        if not isinstance(selector, dict):
            continue
        selector_type = selector.get("type")
        if selector_type == "member":
            name = str(selector.get("name", ""))
            output += f".{name}" if IDENTIFIER_RE.fullmatch(name) else f".[{quote_payload(name)}]"
        elif selector_type == "childIdentity":
            identity = selector.get("identity")
            if not isinstance(identity, str) or not CHILD_IDENTITY_RE.fullmatch(identity):
                raise ValueError("Invalid child identity")
            output += ".\\" + identity + "\\"
        elif selector_type == "position":
            output += f"[{selector.get('index')}]"
        elif selector_type == "positionRange":
            start = selector.get("start")
            end = selector.get("end")
            output += f"[{'' if start is None else start}..{'' if end is None else end}]"
        elif selector_type == "parent":
            output += ".^"
        elif selector_type == "attributeSpace":
            output += ".@"
        elif selector_type == "localSpace":
            output += f".<{quote_payload(str(selector.get('name', '')))}>"
        elif selector_type == "directExpansion":
            output += ".*"
        elif selector_type == "descendantExpansion":
            output += ".**"
        elif selector_type == "namePattern":
            output += f".({quote_payload(str(selector.get('pattern', '')))})"
        elif selector_type == "semanticTypeFilter":
            output += f"#{selector.get('name')}"
        elif selector_type == "representationKindFilter":
            output += f"%{selector.get('name')}"
        else:
            raise ValueError(f"Unknown selector type: {selector_type}")

    qualifier = address.get("qualifierExpression")
    if qualifier:
        output += f":{render_qualifier_expression(qualifier)}"

    return output


def resolve_root(root: object, namespace: dict[str, object], options: dict[str, object]) -> dict[str, object]:
    if not isinstance(namespace, dict):
        return {"ok": False, "error": resolve_error("SANSA_RESOLVE_EXPECTED_NAMESPACE", "Expected SANSA resolve namespace")}

    root_kind = root.get("kind") if isinstance(root, dict) else None
    if root_kind == "contextual":
        contextual_root = options.get("contextualRoot", namespace.get("contextualRoot"))
        binding = contextual_root() if callable(contextual_root) else contextual_root
        if binding:
            return {"ok": True, "binding": binding}
        return {
            "ok": False,
            "error": resolve_error(
                "SANSA_RESOLVE_UNSUPPORTED_CONTEXTUAL_ROOT",
                "Contextual root requires a contextualRoot binding",
            ),
        }

    root_binding = namespace.get("root")
    binding = root_binding() if callable(root_binding) else root_binding
    if binding:
        return {"ok": True, "binding": binding}
    return {
        "ok": False,
        "error": resolve_error("SANSA_RESOLVE_MISSING_ROOT", "SANSA resolve namespace does not expose a root binding"),
    }


def apply_resolve_selector(
    selector: dict[str, object],
    bindings: list[object],
    namespace: dict[str, object],
    selector_index: int,
    policy: dict[str, object] | None = None,
) -> dict[str, object]:
    policy = policy or {}
    selector_type = selector.get("type")
    if selector_type == "childIdentity":
        return select_child_identity(namespace, bindings, selector, selector_index, policy)

    if selector_type == "member":
        return {"ok": True, "bindings": [child for binding in bindings for child in select_member(namespace, binding, str(selector.get("name", "")))]}
    if selector_type == "position":
        return {"ok": True, "bindings": [child for binding in bindings for child in select_position(namespace, binding, int(selector.get("index", 0)))]}
    if selector_type == "positionRange":
        start = selector.get("start")
        end = selector.get("end")
        return {
            "ok": True,
            "bindings": [
                child
                for binding in bindings
                for child in select_position_range(
                    namespace,
                    binding,
                    start if isinstance(start, int) else None,
                    end if isinstance(end, int) else None,
                )
            ],
        }
    if selector_type == "parent":
        return select_parents(namespace, bindings, selector_index, policy)
    if selector_type == "directExpansion":
        return {"ok": True, "bindings": [child for binding in bindings for child in get_children(namespace, binding)]}
    if selector_type == "descendantExpansion":
        return {"ok": True, "bindings": [child for binding in bindings for child in get_descendants(namespace, binding)]}
    if selector_type == "namePattern":
        pattern = glob_pattern_to_regex(str(selector.get("pattern", "")))
        return {
            "ok": True,
            "bindings": [
                child
                for binding in bindings
                for child in get_children(namespace, binding)
                if isinstance(get_binding_name(namespace, child), str) and pattern.fullmatch(str(get_binding_name(namespace, child)))
            ],
        }
    if selector_type == "semanticTypeFilter":
        return {"ok": True, "bindings": [binding for binding in bindings if matches_semantic_type(namespace, binding, str(selector.get("name", "")))]}
    if selector_type == "representationKindFilter":
        return {"ok": True, "bindings": [binding for binding in bindings if matches_representation_kind(namespace, binding, str(selector.get("name", "")))]}
    if selector_type == "attributeSpace":
        return select_attribute_spaces(namespace, bindings, selector_index)
    if selector_type == "localSpace":
        return select_local_spaces(namespace, bindings, str(selector.get("name", "")), selector_index)

    return {
        "ok": False,
        "error": resolve_error("SANSA_RESOLVE_UNSUPPORTED_SELECTOR", f"Unsupported SANSA selector type: {selector_type}", selector_index),
    }


def select_child_identity(namespace, bindings, selector, selector_index, policy):
    output = []
    budget = policy["identityBudget"]
    for binding in bindings:
        match = None
        children = namespace.get("children")
        iterable = children(binding) if callable(children) else binding.get("children", []) if isinstance(binding, dict) else []
        iterator = iter(iterable if iterable is not None else ())
        try:
            for child in iterator:
                if budget["inspected"] >= budget["limit"]:
                    error = resolve_error("SANSA_RESOLVE_IDENTITY_LIMIT_EXCEEDED", "Identity inspection limit exceeded", selector_index)
                    error.update(limit=budget["limit"], observed=budget["inspected"] + 1)
                    return {"ok": False, "error": error}
                budget["inspected"] += 1
                identity = namespace["identity"](child)
                if identity is not None and (not isinstance(identity, str) or not CHILD_IDENTITY_RE.fullmatch(identity)):
                    return {"ok": False, "error": resolve_error("SANSA_RESOLVE_INVALID_IDENTITY", "Adapter returned an invalid structural identity", selector_index)}
                if identity == selector["identity"]:
                    if match is not None:
                        return {"ok": False, "error": resolve_error("SANSA_RESOLVE_AMBIGUOUS_IDENTITY", "Multiple children have the selected identity", selector_index, identity=selector["identity"])}
                    match = child
        finally:
            close = getattr(iterator, "close", None)
            if callable(close):
                close()
        if match is not None:
            maximum = policy.get("maxBindings")
            if maximum is not None and len(output) >= maximum:
                error = resolve_error("SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED", "Binding limit exceeded", selector_index)
                error.update(limit=maximum, observed=len(output) + 1)
                return {"ok": False, "error": error}
            output.append(match)
    return {"ok": True, "bindings": output}


def normalize_identity_address(address):
    """Bound caller-owned identity ASTs before rendering; ignore derived flags."""
    root = address.get("root")
    selectors = address.get("selectors")
    if address.get("type") != "SansaAddress" or not isinstance(root, dict) or root.get("type") != "root" or root.get("kind") not in {"absolute", "contextual"}:
        raise ValueError("Invalid root")
    if not isinstance(selectors, list) or len(selectors) > 1024:
        raise ValueError("Invalid selectors")
    # Walk only rendered fields, with finite work even for cyclic caller objects.
    pending = [(selectors, 0), (address.get("qualifierExpression"), 0)]
    nodes = payload = 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if nodes > 16384 or depth > 64:
            raise ValueError("AST work limit exceeded")
        if isinstance(value, str):
            if len(value) > 65536:
                raise ValueError("AST payload limit exceeded")
            payload += len(value.encode("utf-8"))
            if payload > 65536:
                raise ValueError("AST payload limit exceeded")
        elif isinstance(value, dict):
            if len(value) > 32:
                raise ValueError("Invalid AST object")
            pending.extend((v, depth + 1) for v in value.values())
        elif isinstance(value, list):
            if len(value) > 1024:
                raise ValueError("AST list limit exceeded")
            pending.extend((v, depth + 1) for v in value)
        elif value is not None and type(value) not in {int, bool}:
            raise ValueError("Invalid AST value")
    marker_types = {"parent", "attributeSpace", "directExpansion", "descendantExpansion"}
    for selector in selectors:
        if not isinstance(selector, dict):
            raise ValueError("Invalid selector")
        kind = selector.get("type")
        if kind in {"member", "localSpace", "semanticTypeFilter", "representationKindFilter"}:
            name = selector.get("name")
            if not isinstance(name, str) or not name or (kind.endswith("Filter") and not IDENTIFIER_RE.fullmatch(name)):
                raise ValueError("Invalid selector name")
        elif kind == "namePattern":
            if not isinstance(selector.get("pattern"), str):
                raise ValueError("Invalid pattern")
        elif kind in {"position", "positionRange"}:
            values = [selector.get("index")] if kind == "position" else [selector.get("start"), selector.get("end")]
            if all(v is None for v in values) or any(v is not None and (type(v) is not int or not 0 <= v <= MAX_POSITION_INDEX) for v in values):
                raise ValueError("Invalid position")
        elif kind == "childIdentity":
            identity = selector.get("identity")
            if not isinstance(identity, str) or not CHILD_IDENTITY_RE.fullmatch(identity):
                raise ValueError("Invalid identity")
        elif kind not in marker_types:
            raise ValueError("Unknown selector")
    qualifier = address.get("qualifierExpression")
    if qualifier is not None:
        if not isinstance(qualifier, dict) or qualifier.get("type") != "QualifierExpression" or not isinstance(qualifier.get("terms"), list) or not qualifier["terms"]:
            raise ValueError("Invalid qualifier expression")
        terms = list(qualifier["terms"])
        work = 0
        while terms:
            term = terms.pop()
            work += 1
            if work > 1024 or not isinstance(term, dict) or term.get("type") != "QualifierTerm" or not isinstance(term.get("name"), str) or not IDENTIFIER_RE.fullmatch(term["name"]):
                raise ValueError("Invalid qualifier term")
            groups = term.get("parameterGroups")
            if groups is None:
                parameters = term.get("parameters", [])
                groups = [parameters] if parameters else []
            if not isinstance(groups, list):
                raise ValueError("Invalid qualifier groups")
            for group in groups:
                work += 1
                if not isinstance(group, list) or not group:
                    raise ValueError("Invalid qualifier group")
                terms.extend(group)
            arguments = term.get("arguments", [])
            if not isinstance(arguments, list):
                raise ValueError("Invalid qualifier arguments")
            for argument in arguments:
                work += 1
                if not isinstance(argument, dict) or argument.get("kind") not in {"quoted", "number", "token"} or not isinstance(argument.get("value"), str):
                    raise ValueError("Invalid qualifier argument")
                if argument["kind"] != "quoted" and not QUALIFIER_NUMBER_RE.fullmatch(argument["value"]):
                    raise ValueError("Invalid qualifier number")
            if work > 1024:
                raise ValueError("Qualifier work limit exceeded")
    normalized = parse_address(render_address(address))
    if not normalized["ok"]:
        raise ValueError("Invalid identity address")
    return normalized["address"]


def select_member(namespace: dict[str, object], binding: object, name: str) -> list[object]:
    member = namespace.get("member")
    if callable(member):
        selected = member(binding, name)
        return [selected] if selected else []
    return [child for child in get_children(namespace, binding) if get_binding_name(namespace, child) == name]


def select_position(namespace: dict[str, object], binding: object, index: int) -> list[object]:
    position = namespace.get("position")
    if callable(position):
        selected = position(binding, index)
        return [selected] if selected else []
    children = get_children(namespace, binding)
    for child in children:
        if get_binding_index(namespace, child) == index:
            return [child]
    return [children[index]] if 0 <= index < len(children) else []


def select_position_range(namespace: dict[str, object], binding: object, start: int | None, end: int | None) -> list[object]:
    lower = 0 if start is None else start
    if end is not None and lower > end:
        return []
    output = []
    for ordinal, child in enumerate(get_children(namespace, binding)):
        explicit_index = get_binding_index(namespace, child)
        position = explicit_index if isinstance(explicit_index, int) else ordinal
        if position >= lower and (end is None or position <= end):
            output.append(child)
    return output


def select_parents(namespace: dict[str, object], bindings: list[object], selector_index: int, policy: dict[str, object]) -> dict[str, object]:
    if policy.get("parentTraversal") == "forbid":
        return {
            "ok": False,
            "error": resolve_error(
                "SANSA_RESOLVE_PARENT_TRAVERSAL_FORBIDDEN",
                "Parent traversal is forbidden by resolver policy",
                selector_index,
            ),
        }

    effective_root = policy.get("effectiveRoot")
    root_bindings = [binding for binding in bindings if binding is effective_root]
    if root_bindings and policy.get("failOnParentFromEffectiveRoot") is True:
        return {
            "ok": False,
            "error": resolve_error(
                "SANSA_RESOLVE_BOUNDARY_ESCAPE_FORBIDDEN",
                "Parent traversal would escape the effective resolution root",
                selector_index,
            ),
        }

    traversable = [binding for binding in bindings if binding is not effective_root]
    if len(traversable) == 0:
        return {"ok": True, "bindings": []}

    parent = namespace.get("parent")
    if callable(parent):
        return {"ok": True, "bindings": [selected for binding in traversable if (selected := parent(binding))]}
    if any(isinstance(binding, dict) and "parent" in binding for binding in traversable):
        return {
            "ok": True,
            "bindings": [
                binding.get("parent")
                for binding in traversable
                if isinstance(binding, dict) and binding.get("parent") is not None
            ],
        }
    return {
        "ok": False,
        "error": resolve_error(
            "SANSA_RESOLVE_UNSUPPORTED_PARENT",
            "The namespace does not expose parent traversal",
            selector_index,
        ),
    }


def select_attribute_spaces(namespace: dict[str, object], bindings: list[object], selector_index: int) -> dict[str, object]:
    attribute_space = namespace.get("attributeSpace")
    if callable(attribute_space):
        return {"ok": True, "bindings": [selected for binding in bindings if (selected := attribute_space(binding))]}

    selected = [
        space
        for binding in bindings
        if isinstance(binding, dict)
        for space in [binding.get("attributeSpace") or binding.get("attributes")]
        if space
    ]
    if selected or len(bindings) == 0:
        return {"ok": True, "bindings": selected}
    return {
        "ok": False,
        "error": resolve_error(
            "SANSA_RESOLVE_UNSUPPORTED_ATTRIBUTE_SPACE",
            "The namespace does not expose attribute address-space traversal",
            selector_index,
        ),
    }


def select_local_spaces(namespace: dict[str, object], bindings: list[object], name: str, selector_index: int) -> dict[str, object]:
    local_space = namespace.get("localSpace")
    if not callable(local_space):
        return {
            "ok": False,
            "error": resolve_error(
                "SANSA_RESOLVE_UNSUPPORTED_LOCAL_SPACE",
                f"The namespace does not expose local address space '{name}'",
                selector_index,
            ),
        }
    return {"ok": True, "bindings": [selected for binding in bindings if (selected := local_space(binding, name))]}


def get_children(namespace: dict[str, object], binding: object) -> list[object]:
    children = namespace.get("children")
    if callable(children):
        result = children(binding)
        return list(result) if result is not None else []
    if isinstance(binding, dict) and isinstance(binding.get("children"), list):
        return binding["children"]  # type: ignore[return-value]
    return []


def get_descendants(namespace: dict[str, object], binding: object) -> list[object]:
    output: list[object] = []
    for child in get_children(namespace, binding):
        output.append(child)
        output.extend(get_descendants(namespace, child))
    return output


def get_binding_name(namespace: dict[str, object], binding: object) -> str | None:
    name = namespace.get("name")
    if callable(name):
        value = name(binding)
        return value if isinstance(value, str) else None
    if isinstance(binding, dict):
        value = binding.get("name", binding.get("key"))
        return value if isinstance(value, str) else None
    return None


def get_binding_index(namespace: dict[str, object], binding: object) -> int | None:
    index = namespace.get("index")
    if callable(index):
        value = index(binding)
        return value if isinstance(value, int) else None
    if isinstance(binding, dict):
        value = binding.get("index")
        return value if isinstance(value, int) else None
    return None


def matches_semantic_type(namespace: dict[str, object], binding: object, expected: str) -> bool:
    matcher = namespace.get("semanticTypeMatches")
    if callable(matcher):
        return matcher(binding, expected) is True
    semantic_type = namespace.get("semanticType")
    actual = semantic_type(binding) if callable(semantic_type) else None
    if actual is None and isinstance(binding, dict):
        actual = binding.get("semanticType", binding.get("datatype"))
    if actual == expected:
        return True
    return isinstance(actual, str) and datatype_base_name(actual) == expected


def matches_representation_kind(namespace: dict[str, object], binding: object, expected: str) -> bool:
    matcher = namespace.get("representationKindMatches")
    if callable(matcher):
        return matcher(binding, expected) is True
    representation_kind = namespace.get("representationKind")
    actual = representation_kind(binding) if callable(representation_kind) else None
    if actual is None and isinstance(binding, dict):
        actual = binding.get("representationKind", binding.get("kind", binding.get("type")))
    return isinstance(actual, str) and (actual == expected or lower_first(actual) == expected)


def resolve_error(code: str, message: str, selector_index: int | None = None, *, identity: str | None = None) -> dict[str, object]:
    error: dict[str, object] = {"code": code, "message": message}
    if selector_index is not None:
        error["selectorIndex"] = selector_index
    if identity is not None:
        error["identity"] = identity
    return error


def render_qualifier_expression(expression: object) -> str:
    if not isinstance(expression, dict):
        return ""
    return "|".join(render_qualifier_term(term) for term in expression.get("terms", []))


def render_qualifier_term(term: object) -> str:
    if not isinstance(term, dict):
        return ""
    output = str(term.get("name", ""))
    parameter_groups = term.get("parameterGroups")
    if not isinstance(parameter_groups, list):
        parameters = term.get("parameters")
        parameter_groups = [parameters] if isinstance(parameters, list) and parameters else []
    for group in parameter_groups:
        if isinstance(group, list):
            output += "<" + ",".join(render_qualifier_term(param) for param in group) + ">"
    arguments = term.get("arguments")
    if isinstance(arguments, list):
        rendered_arguments = [render_qualifier_argument(argument) for argument in arguments]
        if rendered_arguments:
            output += "[" + ",".join(rendered_arguments) + "]"
    return output


def render_qualifier_argument(argument: object) -> str:
    if not isinstance(argument, dict):
        return ""
    if argument.get("kind") in {"token", "number"}:
        return str(argument.get("value", ""))
    return quote_payload(str(argument.get("value", "")))


class AddressParser:
    def __init__(self, input: str, options: dict[str, object]) -> None:
        self.input = input
        self.options = options
        self.index = 0

    def parse(self) -> dict[str, object]:
        if len(self.input) == 0:
            self.fail("Expected SANSA address root", "SANSA_EMPTY_ADDRESS")
        root_char = self.peek()
        if root_char not in {"$", "?"}:
            self.fail("Expected SANSA address root '$' or '?'", "SANSA_EXPECTED_ROOT")
        self.index += 1

        root = {"type": "root", "kind": "absolute" if root_char == "$" else "contextual"}
        selectors: list[dict[str, object]] = []
        qualifier_expression: dict[str, object] | None = None

        while not self.at_end():
            char = self.peek()
            if char == ":":
                self.index += 1
                if self.at_end():
                    self.fail("Expected qualifier expression", "SANSA_EXPECTED_QUALIFIER")
                qualifier_expression = self.parse_qualifier_expression()
                break
            if char == ".":
                selectors.append(self.parse_dot_selector())
                continue
            if char == "[":
                selectors.append(self.parse_position_selector())
                continue
            if char == "#":
                self.index += 1
                selectors.append({"type": "semanticTypeFilter", "name": self.parse_identifier("semantic type filter")})
                continue
            if char == "%":
                self.index += 1
                selectors.append({"type": "representationKindFilter", "name": self.parse_identifier("representation kind filter")})
                continue
            if is_layout(char):
                self.fail("Whitespace is not allowed inside a SANSA address", "SANSA_UNEXPECTED_WHITESPACE")
            self.fail(f"Unexpected character '{char}'", "SANSA_UNEXPECTED_CHARACTER")

        self.expect_end()
        address: dict[str, object] = {
            "type": "SansaAddress",
            "root": root,
            "selectors": selectors,
            "qualifierExpression": qualifier_expression,
            "isExact": all(is_exact_selector(selector) for selector in selectors),
        }
        address["canonical"] = render_address(address)
        return address

    def parse_dot_selector(self) -> dict[str, object]:
        # Identity syntax belongs only to standalone addresses, never the shared
        # structural cursor used by AEON clone/pointer references.
        if self.input.startswith(".\\", self.index):
            self.index += 2
            start = self.index
            while not self.at_end() and self.peek() != "\\":
                if not self.peek().isascii() or not (self.peek().isalnum() or self.peek() in "_-"):
                    self.fail("Expected structural identity name", "SANSA_EXPECTED_IDENTITY")
                self.index += 1
            if self.at_end():
                self.fail("Unterminated structural identity selector", "SANSA_UNTERMINATED_IDENTITY")
            if self.index == start:
                self.fail("Expected structural identity name", "SANSA_EXPECTED_IDENTITY")
            identity = self.input[start:self.index]
            self.index += 1
            return {"type": "childIdentity", "identity": identity}
        return parse_dot_selector(self)

    def parse_position_selector(self) -> dict[str, object]:
        return parse_position_selector(self)

    def match_range_separator(self) -> bool:
        if not self.input.startswith("..", self.index):
            return False
        self.index += 2
        return True

    def parse_optional_position_index(self) -> int | None:
        start = self.index
        while is_digit(self.peek()):
            self.index += 1
        if self.index == start:
            return None
        raw = self.input[start:self.index]
        return validate_position_index(raw, lambda message, code: self.fail(message, code, start))

    def parse_qualifier_expression(self, stop_char: str = "") -> dict[str, object]:
        terms = [self.parse_qualifier_term(stop_char)]
        while not self.at_end() and self.peek() == "|":
            self.index += 1
            terms.append(self.parse_qualifier_term(stop_char))
        return {"type": "QualifierExpression", "terms": terms}

    def parse_qualifier_term(self, stop_char: str = "") -> dict[str, object]:
        name = self.parse_identifier("qualifier type name")
        parameters: list[dict[str, object]] = []
        parameter_groups: list[list[dict[str, object]]] = []
        arguments: list[dict[str, object]] = []

        while self.match("<"):
            group = [self.parse_qualifier_term(">")]
            if self.peek() == "|":
                self.fail("Nested qualifier unions are not supported", "SANSA_INVALID_QUALIFIER")
            while self.match(","):
                group.append(self.parse_qualifier_term(">"))
                if self.peek() == "|":
                    self.fail("Nested qualifier unions are not supported", "SANSA_INVALID_QUALIFIER")
            self.consume(">")
            parameter_groups.append(group)
            parameters.extend(group)

        if self.match("["):
            arguments.append(self.parse_qualifier_argument())
            while self.match(","):
                arguments.append(self.parse_qualifier_argument())
            self.consume("]")
            if self.peek() == "[":
                self.fail("Qualifier clarifiers must use a single bracketed list", "SANSA_INVALID_QUALIFIER")

        next_char = self.peek()
        if next_char and next_char not in {"|", ",", ">", stop_char}:
            self.fail(f"Unexpected character '{next_char}' in qualifier expression", "SANSA_INVALID_QUALIFIER")

        return {
            "type": "QualifierTerm",
            "name": name,
            "parameters": parameters,
            "parameterGroups": parameter_groups,
            "arguments": arguments,
        }

    def parse_qualifier_argument(self) -> dict[str, object]:
        if self.peek() == '"':
            return {"kind": "quoted", "value": self.parse_quoted_payload()}

        start = self.index
        while not self.at_end() and self.peek() not in {"]", ","}:
            self.index += 1
        if self.index == start:
            self.fail("Expected qualifier argument", "SANSA_EXPECTED_QUALIFIER_ARGUMENT")
        value = self.input[start:self.index]
        if not QUALIFIER_NUMBER_RE.fullmatch(value):
            self.fail("Invalid qualifier argument", "SANSA_INVALID_QUALIFIER_ARGUMENT")
        return {"kind": "number", "value": value}

    def parse_identifier(self, context: str) -> str:
        start = self.index
        first = self.peek()
        if not is_identifier_start(first):
            self.fail(f"Expected {context}", "SANSA_EXPECTED_IDENTIFIER")
        self.index += 1
        while is_identifier_continue(self.peek()):
            self.index += 1
        return self.input[start:self.index]

    def parse_quoted_payload(self) -> str:
        self.consume('"')
        output = ""
        while not self.at_end():
            char = self.peek()
            if char == '"':
                self.index += 1
                return output
            if char in {"\n", "\r"}:
                self.fail("Quoted payloads must not contain raw newlines", "SANSA_RAW_NEWLINE_IN_QUOTED_PAYLOAD")
            if char == "\\":
                output += self.parse_escape()
                continue
            output += char
            self.index += 1
        self.fail("Unterminated quoted payload", "SANSA_UNTERMINATED_QUOTED_PAYLOAD")

    def parse_escape(self) -> str:
        self.consume("\\")
        escape = self.peek()
        if not escape:
            self.fail("Unterminated escape sequence", "SANSA_UNTERMINATED_ESCAPE")
        self.index += 1
        if escape == "\\":
            return "\\"
        if escape == '"':
            return '"'
        if escape == "'":
            return "'"
        if escape == "`":
            return "`"
        if escape == "n":
            return "\n"
        if escape == "r":
            return "\r"
        if escape == "t":
            return "\t"
        if escape == "b":
            return "\b"
        if escape == "f":
            return "\f"
        if escape == "u":
            return self.parse_unicode_escape()
        self.fail(f"Invalid escape sequence \\{escape}", "SANSA_INVALID_ESCAPE", self.index - 2)

    def parse_unicode_escape(self) -> str:
        if self.match("{"):
            start = self.index
            while not self.at_end() and self.peek() != "}":
                self.index += 1
            if self.at_end():
                self.fail("Unterminated Unicode escape", "SANSA_UNTERMINATED_UNICODE_ESCAPE")
            raw = self.input[start:self.index]
            self.consume("}")
            if not re.fullmatch(r"[0-9A-Fa-f]{1,6}", raw):
                self.fail("Invalid Unicode escape", "SANSA_INVALID_UNICODE_ESCAPE", start)
            return code_point_to_string(int(raw, 16), start)

        raw = self.input[self.index:self.index + 4]
        if not re.fullmatch(r"[0-9A-Fa-f]{4}", raw):
            self.fail("Invalid Unicode escape", "SANSA_INVALID_UNICODE_ESCAPE")
        self.index += 4
        return code_point_to_string(int(raw, 16), self.index - 4)

    def expect_end(self) -> None:
        if not self.at_end():
            self.fail(f"Unexpected trailing character '{self.peek()}'", "SANSA_TRAILING_INPUT")

    def consume(self, char: str) -> None:
        if self.peek() != char:
            self.fail(f"Expected '{char}'", "SANSA_EXPECTED_TOKEN")
        self.index += 1

    def match(self, char: str) -> bool:
        if self.peek() != char:
            return False
        self.index += 1
        return True

    def peek(self) -> str:
        if self.index >= len(self.input):
            return ""
        return self.input[self.index]

    def at_end(self) -> bool:
        return self.index >= len(self.input)

    def fail(self, message: str, code: str, index: int | None = None) -> None:
        raise SansaParseError(message, self.index if index is None else index, code)


def is_exact_selector(selector: dict[str, object]) -> bool:
    return selector.get("type") in {"member", "position", "attributeSpace", "localSpace"}


def is_identifier_start(char: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_]", char or ""))


def is_identifier_continue(char: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_]", char or ""))


def is_digit(char: str) -> bool:
    return bool(re.fullmatch(r"[0-9]", char or ""))


def is_layout(char: str) -> bool:
    return char in {" ", "\t", "\n", "\r"}


def datatype_base_name(datatype: str) -> str:
    cuts = [index for index in (datatype.find("<"), datatype.find("[")) if index >= 0]
    cut = min(cuts) if cuts else len(datatype)
    return datatype[:cut].strip()


def lower_first(value: str) -> str:
    if not value:
        return value
    return value[0].lower() + value[1:]


def glob_pattern_to_regex(pattern: str) -> re.Pattern[str]:
    source = "^"
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\" and index + 1 < len(pattern) and pattern[index + 1] in {"*", "?", "\\"}:
            source += re.escape(pattern[index + 1])
            index += 2
            continue
        if char == "*":
            source += ".*"
        elif char == "?":
            source += "."
        else:
            source += re.escape(char)
        index += 1
    source += "$"
    return re.compile(source)


def code_point_to_string(code_point: int, index: int) -> str:
    if code_point > 0x10FFFF or 0xD800 <= code_point <= 0xDFFF:
        raise SansaParseError("Unicode escape must decode to a scalar value", index, "SANSA_INVALID_UNICODE_SCALAR")
    return chr(code_point)


def quote_payload(value: str) -> str:
    output = '"'
    for char in value:
        if char == "\\":
            output += "\\\\"
        elif char == '"':
            output += '\\"'
        elif char == "\n":
            output += "\\n"
        elif char == "\r":
            output += "\\r"
        elif char == "\t":
            output += "\\t"
        elif char == "\b":
            output += "\\b"
        elif char == "\f":
            output += "\\f"
        else:
            output += char
    output += '"'
    return output
