"""Bounded, data-only admission for property-bearing Python address ASTs."""
from ._sansa_properties import MAX_ARGUMENT_SCALARS, MAX_CANONICAL_SCALARS, MAX_SELECTORS, scalar


def property_limit(kind, limit, index=0):
    from .sansa import SansaParseError
    return SansaParseError("Property address limit exceeded", index, "SANSA_PROPERTY_LIMIT_EXCEEDED",
                           limit_kind=kind, limit=limit, observed=limit + 1)


def has_property_ast(address):
    return type(address) is dict and type(address.get("selectors")) is list and any(
        type(step) is dict and type(step.get("type")) is str and step["type"] == "propertyFilter" for step in address["selectors"]
    )


def render_property_address(address, parse_options=None):
    from . import sansa
    if type(address) is not dict or type(address.get("type")) is not str or address["type"] != "SansaAddress":
        raise ValueError("Invalid address")
    root = address.get("root")
    if type(root) is not dict or type(root.get("type")) is not str or root["type"] != "root" or type(root.get("kind")) is not str or root["kind"] not in {"absolute", "contextual"}:
        raise ValueError("Invalid root")
    selectors = address.get("selectors")
    if type(selectors) is not list:
        raise ValueError("Invalid selectors")
    if len(selectors) > MAX_SELECTORS:
        raise property_limit("selectors", MAX_SELECTORS)
    maximum = (parse_options or {}).get("maxPositionIndex", sansa.MAX_POSITION_INDEX)
    if type(maximum) is not int or maximum < 0 or maximum > 9_007_199_254_740_991:
        raise ValueError("Invalid positional ceiling")
    output = []
    length = 0

    def emit(text):
        nonlocal length
        length += len(text)
        if length > MAX_CANONICAL_SCALARS:
            raise property_limit("canonicalScalars", MAX_CANONICAL_SCALARS)
        output.append(text)

    def string(value, maximum=MAX_CANONICAL_SCALARS, kind="canonicalScalars"):
        if type(value) is not str:
            raise ValueError("Invalid string")
        if len(value) > maximum:
            raise property_limit(kind, maximum)
        if not scalar(value):
            raise ValueError("Invalid Unicode scalar")
        return value

    def identifier(value):
        value = string(value)
        if not sansa.IDENTIFIER_RE.fullmatch(value):
            raise ValueError("Invalid identifier")
        return value

    def position(value):
        if type(value) is not int or not 0 <= value <= maximum:
            raise ValueError("Invalid position")
        return str(value)

    emit("$" if root["kind"] == "absolute" else "?")
    for selector in selectors:
        if type(selector) is not dict or type(selector.get("type")) is not str:
            raise ValueError("Invalid selector")
        kind = selector["type"]
        if kind == "propertyFilter":
            property = selector.get("property")
            if type(property) is not str or property not in {"key", "tag", "headTag"}:
                raise ValueError("Invalid property")
            value = string(selector.get("value"), MAX_ARGUMENT_SCALARS, "payloadScalars")
            emit("&" + property + "(" + sansa.quote_payload(value) + ")")
        elif kind == "member":
            name = string(selector.get("name"))
            emit("." + name if sansa.IDENTIFIER_RE.fullmatch(name) else ".[" + sansa.quote_payload(name) + "]")
        elif kind == "childIdentity":
            identity = string(selector.get("identity"))
            if not sansa.CHILD_IDENTITY_RE.fullmatch(identity):
                raise ValueError("Invalid identity")
            emit(".\\" + identity + "\\")
        elif kind == "position":
            emit("[" + position(selector.get("index")) + "]")
        elif kind == "positionRange":
            start, end = selector.get("start"), selector.get("end")
            if start is None and end is None:
                raise ValueError("Empty range")
            emit("[" + ("" if start is None else position(start)) + ".." + ("" if end is None else position(end)) + "]")
        elif kind in {"localSpace", "namePattern"}:
            text = string(selector.get("name" if kind == "localSpace" else "pattern"))
            if kind == "localSpace" and not text:
                raise ValueError("Empty local space")
            emit((".<" if kind == "localSpace" else ".(") + sansa.quote_payload(text) + (">" if kind == "localSpace" else ")"))
        elif kind in {"semanticTypeFilter", "representationKindFilter"}:
            emit(("#" if kind == "semanticTypeFilter" else "%") + identifier(selector.get("name")))
        elif kind in {"parent", "attributeSpace", "directExpansion", "descendantExpansion"}:
            emit({"parent": ".^", "attributeSpace": ".@", "directExpansion": ".*", "descendantExpansion": ".**"}[kind])
        else:
            raise ValueError("Unknown selector")

    expression = address.get("qualifierExpression")
    if expression is not None:
        if type(expression) is not dict or type(expression.get("type")) is not str or expression["type"] != "QualifierExpression":
            raise ValueError("Invalid qualifier")
        terms = expression.get("terms")
        if type(terms) is not list or not terms:
            raise ValueError("Invalid qualifier terms")
        emit(":")
        # Lazy sequence frames bound pending state; active IDs reject cycles.
        # Repeated rendered occurrences still emit and consume the canonical cap.
        pending = [("sequence", iter(terms), "|", "term", False)]
        active = set()
        while pending:
            action, *args = pending.pop()
            if action == "text":
                emit(args[0])
            elif action == "exit":
                active.remove(args[0])
            elif action == "sequence":
                iterator, separator, entry, seen = args
                try:
                    value = next(iterator)
                except StopIteration:
                    continue
                pending.append(("sequence", iterator, separator, entry, True))
                pending.append((entry, value))
                if seen:
                    emit(separator)
            elif action == "term":
                term = args[0]
                if type(term) is not dict or type(term.get("type")) is not str or term["type"] != "QualifierTerm" or id(term) in active:
                    raise ValueError("Invalid or cyclic qualifier term")
                active.add(id(term))
                emit(identifier(term.get("name")))
                groups, parameters, arguments = term.get("parameterGroups"), term.get("parameters", []), term.get("arguments", [])
                if groups is None:
                    if type(parameters) is not list:
                        raise ValueError("Invalid qualifier parameters")
                    groups = [parameters] if parameters else []
                if type(groups) is not list or type(arguments) is not list:
                    raise ValueError("Invalid qualifier containers")
                pending.append(("exit", id(term)))
                if arguments:
                    pending.extend([("text", "]"), ("sequence", iter(arguments), ",", "argument", False), ("text", "[")])
                pending.append(("sequence", iter(groups), "", "group", False))
            elif action == "group":
                group = args[0]
                if type(group) is not list or not group:
                    raise ValueError("Invalid qualifier group")
                emit("<")
                pending.extend([("text", ">"), ("sequence", iter(group), ",", "term", False)])
            elif action == "argument":
                argument = args[0]
                if type(argument) is not dict or type(argument.get("kind")) is not str:
                    raise ValueError("Invalid qualifier argument")
                value = string(argument.get("value"))
                if argument["kind"] == "quoted":
                    emit(sansa.quote_payload(value))
                elif argument["kind"] in {"number", "token"} and sansa.QUALIFIER_NUMBER_RE.fullmatch(value):
                    emit(value)
                else:
                    raise ValueError("Invalid qualifier argument")
    return "".join(output)


def normalize_property_address(address, parse_options=None):
    from . import sansa
    canonical = render_property_address(address, parse_options)
    parsed = sansa.parse_address(canonical, parse_options)
    if not parsed["ok"]:
        raise ValueError("Invalid property address")
    return parsed["address"]
