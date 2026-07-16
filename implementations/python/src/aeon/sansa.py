from __future__ import annotations

import re


IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
QUALIFIER_ARG_RE = re.compile(r"^[A-Za-z0-9!#$%&*+\-.:;=?@^_|~<>]+$")


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
        elif selector_type == "position":
            output += f"[{selector.get('index')}]"
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
        for argument in arguments:
            output += f"[{render_qualifier_argument(argument)}]"
    return output


def render_qualifier_argument(argument: object) -> str:
    if not isinstance(argument, dict):
        return ""
    if argument.get("kind") == "token":
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
        self.consume(".")
        if self.match("@"):
            return {"type": "attributeSpace"}
        if self.match("*"):
            if self.match("*"):
                return {"type": "descendantExpansion"}
            return {"type": "directExpansion"}
        if self.match("["):
            name = self.parse_quoted_payload()
            if len(name) == 0:
                self.fail("Quoted member names must not be empty", "SANSA_EMPTY_MEMBER_NAME")
            self.consume("]")
            return {"type": "member", "name": name, "quoted": True}
        if self.match("<"):
            name = self.parse_quoted_payload()
            if len(name) == 0:
                self.fail("Local address-space names must not be empty", "SANSA_EMPTY_LOCAL_SPACE_NAME")
            self.consume(">")
            return {"type": "localSpace", "name": name}
        if self.match("("):
            pattern = self.parse_quoted_payload()
            self.consume(")")
            return {"type": "namePattern", "pattern": pattern}
        return {"type": "member", "name": self.parse_identifier("member selector"), "quoted": False}

    def parse_position_selector(self) -> dict[str, object]:
        self.consume("[")
        start = self.index
        while is_digit(self.peek()):
            self.index += 1
        if self.index == start:
            self.fail("Expected positional index", "SANSA_EXPECTED_INDEX")
        raw = self.input[start:self.index]
        if len(raw) > 1 and raw.startswith("0"):
            self.fail("Positional indexes must not contain leading zeroes", "SANSA_LEADING_ZERO_INDEX", start)
        self.consume("]")
        return {"type": "position", "index": int(raw)}

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

        while self.match("["):
            arguments.append(self.parse_qualifier_argument())
            self.consume("]")

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
        while not self.at_end() and self.peek() != "]":
            char = self.peek()
            if not is_qualifier_argument_char(char):
                self.fail(
                    f"Invalid unquoted qualifier argument character '{char}'",
                    "SANSA_INVALID_QUALIFIER_ARGUMENT_CHAR",
                )
            self.index += 1
        if self.index == start:
            self.fail("Expected qualifier argument", "SANSA_EXPECTED_QUALIFIER_ARGUMENT")
        value = self.input[start:self.index]
        if not QUALIFIER_ARG_RE.fullmatch(value):
            self.fail("Invalid qualifier argument", "SANSA_INVALID_QUALIFIER_ARGUMENT")
        return {"kind": "token", "value": value}

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


def is_qualifier_argument_char(char: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9!#$%&*+\-.:;=?@^_|~<>]", char or ""))


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
