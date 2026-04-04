from __future__ import annotations

import re
from typing import cast

from ._compat import dataclass
from .ast import (
    Attribute,
    AttributeEntry,
    AttributePathSegment,
    Binding,
    BooleanLiteral,
    CloneReference,
    DateLiteral,
    DateTimeLiteral,
    Document,
    EncodingLiteral,
    InfinityLiteral,
    Header,
    HexLiteral,
    ListNode,
    NodeLiteral,
    NumberLiteral,
    ObjectNode,
    PointerReference,
    RadixLiteral,
    ReferencePathSegment,
    SeparatorLiteral,
    StringLiteral,
    SwitchLiteral,
    TimeLiteral,
    TupleLiteral,
    TypeAnnotation,
    Value,
)
from .errors import (
    GenericDepthExceededError,
    HeaderConflictError,
    InvalidSeparatorCharError,
    NestingDepthExceededError,
    SeparatorDepthExceededError,
    SyntaxError,
)
from .lexer import Token
from .spans import Span

GENERIC_V1_DATATYPES = {"list", "tuple"}
BRACKETED_V1_DATATYPES = {"sep", "set", "radix"}
RESERVED_V1_DATATYPES = {
    "n", "number", "int", "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64",
    "float", "float32", "float64",
    "string", "trimtick", "boolean", "bool", "switch", "infinity",
    "hex", "date", "time", "datetime", "zrut",
    "encoding", "base64", "embed", "inline",
    "radix", "radix2", "radix6", "radix8", "radix12",
    "sep", "set",
    "tuple", "list", "object", "obj", "envelope", "o", "node", "null",
}


@dataclass(slots=True)
class ParseResult:
    document: Document | None
    errors: list[Exception]


class Parser:
    def __init__(
        self,
        source: str,
        tokens: list[Token],
        max_separator_depth: int = 1,
        max_generic_depth: int = 1,
        max_nesting_depth: int = 256,
    ) -> None:
        self.source = source
        self.tokens = tokens
        self.current = 0
        self.max_separator_depth = max_separator_depth
        self.max_generic_depth = max_generic_depth
        self.max_nesting_depth = max_nesting_depth
        self.current_nesting_depth = 0
        self.errors: list[Exception] = []
        self.deferred_errors: list[Exception] = []

    def skip_layout(self) -> None:
        while self.check("NEWLINE"):
            self.advance()

    def parse(self) -> ParseResult:
        try:
            document = self.parse_document()
            return ParseResult(document=document, errors=self.errors)
        except Exception as error:
            self.errors.append(error)
            return ParseResult(document=None, errors=self.errors)

    def parse_document(self) -> Document:
        start = self.peek().span.start
        header: Header | None = None
        bindings: list[Binding] = []
        self.skip_separators()
        if self.is_header_start():
            header = self.parse_header()
        self.skip_separators()
        while not self.check("EOF"):
            try:
                if bindings and self.is_structured_header_start():
                    token = self.peek()
                    self.errors.append(
                        SyntaxError(
                            "Structured headers must precede body bindings",
                            token.span,
                        )
                    )
                    self.parse_header()
                    self.skip_separators()
                    continue
                binding = self.parse_binding()
                bindings.append(binding)
                if not self.check("EOF") and not self.check("NEWLINE") and not self.check("COMMA"):
                    raise SyntaxError("Expected top-level binding delimiter", self.peek().span)
            except Exception as error:
                self.errors.append(error)
                if self.deferred_errors:
                    self.errors.extend(self.deferred_errors)
                    self.deferred_errors.clear()
                self.synchronize_to_top_level_binding()
            self.skip_separators()
        end = self.previous().span.end
        return Document(header=header, bindings=bindings, span=Span(start=start, end=end))

    def synchronize_to_top_level_binding(self) -> None:
        if not self.check("EOF"):
            self.advance()
        while not self.check("EOF"):
            if (
                self.peek().span.start.column == 1
                and self.peek().kind in {"IDENT", "STRING"}
                and self.check_next("EQUALS") | self.check_next("COLON")
            ):
                return
            self.advance()

    def is_header_start(self) -> bool:
        if not self.check("IDENT") or self.peek().value != "aeon":
            return False
        if not self.check_next("COLON"):
            return False
        if self.current + 3 < len(self.tokens):
            next_token = self.tokens[self.current + 2]
            next_next = self.tokens[self.current + 3]
            if next_token.kind == "IDENT" and next_token.value == "envelope" and next_next.kind == "EQUALS":
                return False
        return True

    def is_structured_header_start(self) -> bool:
        if not self.is_header_start():
            return False
        if self.current + 3 >= len(self.tokens):
            return False
        field_token = self.tokens[self.current + 2]
        equals_token = self.tokens[self.current + 3]
        return field_token.kind == "IDENT" and field_token.value == "header" and equals_token.kind == "EQUALS"

    def parse_header(self) -> Header:
        start = self.peek().span.start
        bindings: list[Binding] = []
        fields: dict[str, Value] = {}
        has_structured = False
        has_shorthand = False
        end = start
        while self.is_header_start():
            self.advance()
            self.consume("COLON", "Expected ':' after 'aeon'")
            field_token = self.consume("IDENT", "Expected header field name")
            field_name = field_token.value
            self.consume("EQUALS", "Expected '=' in header")
            value = self.parse_value()
            end = self.previous().span.end
            if field_name == "header" and isinstance(value, ObjectNode):
                has_structured = True
                for binding in value.bindings:
                    bindings.append(binding)
                    fields[binding.key] = binding.value
            else:
                has_shorthand = True
                bindings.append(
                    Binding(
                        key=field_name,
                        value=value,
                        datatype=None,
                        attributes=[],
                        span=Span(start=field_token.span.start, end=value.span.end if value.span else end),
                    )
                )
                fields[field_name] = value
            self.skip_separators()
        if has_structured and has_shorthand:
            self.errors.append(HeaderConflictError(Span(start=start, end=end)))
        return Header(bindings=bindings, fields=fields, has_structured=has_structured, has_shorthand=has_shorthand, span=Span(start=start, end=end))

    def parse_binding(self) -> Binding:
        start = self.peek().span.start
        key_token = self.consume_one_of(("IDENT", "STRING"), "Expected binding key")
        key = self.key_from_token(key_token)
        self.skip_layout()
        attributes: list[Attribute] = []
        while self.check("AT"):
            attributes.append(self.parse_attribute())
            self.skip_layout()
        datatype: TypeAnnotation | None = None
        if self.check("COLON"):
            self.advance()
            self.skip_layout()
            datatype = self.parse_type_annotation()
            self.skip_layout()
        self.consume("EQUALS", f"Expected '=' after key '{key}'")
        self.skip_separators()
        value = self.parse_value()
        end = self.previous().span.end
        if self.check("AT"):
            raise SyntaxError("Postfix literal attributes are not valid Core v1 syntax", self.peek().span)
        return Binding(key=key, value=value, datatype=datatype, attributes=attributes, span=Span(start=start, end=end))

    def parse_attribute(self) -> Attribute:
        start = self.peek().span.start
        self.consume("AT", "Expected '@'")
        self.skip_layout()
        self.consume("LBRACE", "Expected '{' after '@'")
        entries: dict[str, AttributeEntry] = {}
        self.skip_layout()
        while not self.check("RBRACE"):
            key_token = self.consume_one_of(("IDENT", "STRING"), "Expected attribute key")
            key = self.key_from_token(key_token)
            self.skip_layout()
            attributes: list[Attribute] = []
            while self.check("AT"):
                attributes.append(self.parse_attribute())
                self.skip_layout()
            datatype: TypeAnnotation | None = None
            if self.check("COLON"):
                self.advance()
                self.skip_layout()
                datatype = self.parse_type_annotation()
                self.skip_layout()
            self.consume("EQUALS", "Expected '=' in attribute")
            self.skip_separators()
            value = self.parse_value()
            entries[key] = AttributeEntry(value=value, datatype=datatype, attributes=attributes)
            self.consume_member_delimiter("RBRACE", "Expected attribute delimiter")
        end = self.consume("RBRACE", "Expected '}' to close attribute").span.end
        return Attribute(entries=entries, span=Span(start=start, end=end))

    def parse_type_annotation(self, generic_depth: int = 0) -> TypeAnnotation:
        if generic_depth > self.max_generic_depth:
            raise GenericDepthExceededError(generic_depth, self.max_generic_depth, self.peek().span)
        start = self.peek().span.start
        name = self.consume("IDENT", "Expected type name").value
        generic_args: list[str] = []
        radix_base: int | None = None
        separators: list[str] = []
        self.skip_layout()
        if self.check("LANGLE"):
            if name == "radix":
                raise SyntaxError("Radix datatype bases must use bracket syntax like 'radix[10]'", self.peek().span)
            self.advance()
            self.skip_layout()
            generic_args.append(self.parse_generic_argument(generic_depth))
            self.skip_layout()
            while self.check("COMMA"):
                self.advance()
                self.skip_layout()
                generic_args.append(self.parse_generic_argument(generic_depth))
                self.skip_layout()
            self.consume("RANGLE", "Expected '>' to close generic arguments")
            self.skip_layout()
        while self.check("LBRACKET"):
            self.advance()
            self.skip_layout()
            if name in RESERVED_V1_DATATYPES and name not in BRACKETED_V1_DATATYPES:
                raise SyntaxError(f"Datatype '{name}' does not support bracket specifiers in v1", self.peek().span)
            if name == "radix" and radix_base is None:
                token = self.peek()
                if token.kind == "RBRACKET":
                    raise SyntaxError("Radix base must be an integer from 2 to 64", token.span)
                if token.kind != "NUMBER" or not self.is_valid_radix_base_spec(token.value):
                    raise SyntaxError("Radix base must be an integer from 2 to 64", token.span)
                radix_base = int(token.value)
                self.advance()
            elif name == "radix":
                raise SyntaxError("Radix datatype allows exactly one base bracket like 'radix[10]'", self.peek().span)
            else:
                if name in RESERVED_V1_DATATYPES:
                    separators.append(self.parse_separator_char())
                else:
                    separators.append(self.parse_custom_bracket_spec())
            self.skip_layout()
            self.consume("RBRACKET", "Expected ']' to close radix base spec" if name == "radix" and radix_base is not None else "Expected ']' to close separator spec")
            self.skip_layout()
            if len(separators) > self.max_separator_depth:
                raise SeparatorDepthExceededError(len(separators), self.max_separator_depth, self.previous().span)
        self.validate_reserved_datatype_adornments(name, generic_args, radix_base, separators)
        return TypeAnnotation(name=name, generic_args=generic_args, radix_base=radix_base, separators=separators, span=Span(start=start, end=self.previous().span.end))

    def parse_generic_argument(self, generic_depth: int) -> str:
        token = self.peek()
        if token.kind not in {"IDENT", "NUMBER"}:
            raise SyntaxError("Expected generic argument", token.span)
        if token.kind == "NUMBER":
            self.advance()
            return token.value
        nested = self.parse_type_annotation(generic_depth + 1)
        return self.format_type_annotation(nested)

    def format_type_annotation(self, annotation: TypeAnnotation) -> str:
        generic_suffix = ""
        if annotation.generic_args:
            generic_suffix = "<" + ", ".join(annotation.generic_args) + ">"
        radix_suffix = f"[{annotation.radix_base}]" if annotation.radix_base is not None else ""
        separator_suffix = "".join(f"[{separator}]" for separator in annotation.separators)
        if annotation.name == "radix":
            return f"{annotation.name}{generic_suffix}{radix_suffix}"
        return f"{annotation.name}{generic_suffix}{separator_suffix}"

    @staticmethod
    def is_valid_radix_base_spec(spec: str) -> bool:
        if not spec.isdigit() or spec.startswith("0"):
            return False
        value = int(spec)
        return 2 <= value <= 64

    def validate_reserved_datatype_adornments(
        self,
        name: str,
        generic_args: list[str],
        radix_base: int | None,
        separators: list[str],
    ) -> None:
        if name not in RESERVED_V1_DATATYPES:
            return
        if generic_args and name not in GENERIC_V1_DATATYPES:
            raise SyntaxError(f"Datatype '{name}' does not support generic arguments in v1", self.previous().span)
        if (radix_base is not None or separators) and name not in BRACKETED_V1_DATATYPES:
            raise SyntaxError(f"Datatype '{name}' does not support bracket specifiers in v1", self.previous().span)

    def parse_separator_char(self) -> str:
        token = self.peek()
        if token.kind in {
            "IDENT",
            "NUMBER",
            "STRING",
            "SYMBOL",
            "DOT",
            "AT",
            "HASH",
            "DOLLAR",
            "PERCENT",
            "AMPERSAND",
            "EQUALS",
            "TILDE",
            "COLON",
            "COMMA",
            "SEMICOLON",
            "LBRACKET",
            "RBRACKET",
        }:
            value = token.value
            self.advance()
        else:
            raise SyntaxError("Expected separator character", token.span)
        if len(value) != 1 or not (0x21 <= ord(value) <= 0x7E) or value in {",", "[", "]"}:
            raise InvalidSeparatorCharError(value, token.span)
        return value

    def parse_custom_bracket_spec(self) -> str:
        token = self.peek()
        if token.kind == "RBRACKET":
            raise SyntaxError("Expected separator character", token.span)
        if token.kind in {
            "IDENT",
            "NUMBER",
            "STRING",
            "SYMBOL",
            "DOT",
            "AT",
            "HASH",
            "DOLLAR",
            "PERCENT",
            "AMPERSAND",
            "EQUALS",
            "TILDE",
            "COLON",
            "COMMA",
            "SEMICOLON",
            "LBRACKET",
            "RBRACKET",
        }:
            value = token.value
            self.advance()
            return value
        raise SyntaxError("Expected separator character", token.span)

    def record_legacy_node_followup_error(self) -> None:
        for index in range(self.current + 2, len(self.tokens) - 3):
            token = self.tokens[index]
            if token.kind == "EOF":
                return
            if token.kind != "COLON":
                continue
            name_token = self.tokens[index + 1]
            angle_token = self.tokens[index + 2]
            arg_token = self.tokens[index + 3]
            if name_token.kind != "IDENT" or angle_token.kind != "LANGLE":
                continue
            if arg_token.kind in {"IDENT", "NUMBER"}:
                continue
            self.deferred_errors.append(SyntaxError("Expected generic argument", arg_token.span))
            return

    def parse_value(self) -> Value:
        self.current_nesting_depth += 1
        if self.current_nesting_depth > self.max_nesting_depth:
            self.current_nesting_depth -= 1
            raise NestingDepthExceededError(self.current_nesting_depth + 1, self.max_nesting_depth, self.peek().span)
        try:
            if self.check("LANGLE"):
                return self.parse_node()
            if self.check("RANGLE"):
                return self.parse_trimtick_string()
            if self.check("IDENT") and self.check_next("LANGLE"):
                self.record_legacy_node_followup_error()
                raise SyntaxError("Node values must use the '<tag>' or '<tag(...)>' forms", self.peek().span)
            if self.check("LBRACE"):
                return self.parse_object()
            if self.check("LBRACKET"):
                return self.parse_list()
            if self.check("LPAREN"):
                return self.parse_tuple()
            if self.check("TILDE_ARROW"):
                return self.parse_pointer_reference()
            if self.check("TILDE"):
                return self.parse_clone_reference()
            return self.parse_literal()
        finally:
            self.current_nesting_depth -= 1

    def parse_node(self) -> NodeLiteral:
        start = self.consume("LANGLE", "Expected '<' to start node literal").span.start
        self.skip_layout()
        tag = self.key_from_token(self.consume_one_of(("IDENT", "STRING"), "Expected node tag after '<'"))
        self.skip_layout()
        attributes: list[Attribute] = []
        while self.check("AT"):
            attributes.append(self.parse_attribute())
            self.skip_layout()
        datatype: TypeAnnotation | None = None
        if self.check("COLON"):
            self.advance()
            self.skip_layout()
            datatype = self.parse_type_annotation()
            if datatype.generic_args or datatype.separators:
                raise SyntaxError("Node head datatypes must be simple labels without generics or separator specs", datatype.span)
            self.skip_layout()
        children: list[Value] = []
        if self.check("RANGLE"):
            end = self.advance().span.end
            return NodeLiteral(tag=tag, attributes=attributes, datatype=datatype, children=children, span=Span(start=start, end=end))
        self.consume("LPAREN", "Expected '(' or '>' after node tag")
        self.skip_layout()
        while not self.check("RPAREN"):
            children.append(self.parse_value())
            self.consume_member_delimiter("RPAREN", "Expected node child delimiter")
        self.consume("RPAREN", "Expected ')' to close node children")
        self.skip_layout()
        end = self.consume("RANGLE", "Expected '>' after node children").span.end
        return NodeLiteral(tag=tag, attributes=attributes, datatype=datatype, children=children, span=Span(start=start, end=end))

    def parse_object(self) -> ObjectNode:
        start = self.consume("LBRACE", "Expected '{'").span.start
        bindings: list[Binding] = []
        self.skip_layout()
        while not self.check("RBRACE"):
            bindings.append(self.parse_binding())
            self.consume_member_delimiter("RBRACE", "Expected object member delimiter")
        end = self.consume("RBRACE", "Expected '}' to close object").span.end
        return ObjectNode(bindings=bindings, attributes=[], span=Span(start=start, end=end))

    def parse_list(self) -> ListNode:
        start = self.consume("LBRACKET", "Expected '['").span.start
        elements: list[Value] = []
        self.skip_layout()
        while not self.check("RBRACKET"):
            elements.append(self.parse_value())
            self.consume_member_delimiter("RBRACKET", "Expected list delimiter")
        end = self.consume("RBRACKET", "Expected ']' to close list").span.end
        return ListNode(elements=elements, attributes=[], span=Span(start=start, end=end))

    def parse_tuple(self) -> TupleLiteral:
        start = self.consume("LPAREN", "Expected '('").span.start
        elements: list[Value] = []
        self.skip_layout()
        while not self.check("RPAREN"):
            elements.append(self.parse_value())
            if self.check("COMMA"):
                self.advance()
                self.skip_layout()
                if self.check("RPAREN"):
                    break
                if self.check("COMMA"):
                    raise SyntaxError("Expected tuple delimiter", self.peek().span)
                continue
            if self.check("RPAREN"):
                break
            if self.check("NEWLINE"):
                self.skip_layout()
                continue
            raise SyntaxError("Expected tuple delimiter", self.peek().span)
        end = self.consume("RPAREN", "Expected ')' to close tuple").span.end
        return TupleLiteral(elements=elements, attributes=[], raw="", span=Span(start=start, end=end))

    def parse_clone_reference(self) -> CloneReference:
        start = self.consume("TILDE", "Expected '~'").span.start
        path = self.parse_path()
        return CloneReference(path=path, span=Span(start=start, end=self.previous().span.end))

    def parse_pointer_reference(self) -> PointerReference:
        start = self.consume("TILDE_ARROW", "Expected '~>'").span.start
        path = self.parse_path()
        return PointerReference(path=path, span=Span(start=start, end=self.previous().span.end))

    def parse_path(self) -> list[ReferencePathSegment]:
        path: list[ReferencePathSegment] = []
        if self.check("DOLLAR"):
            self.advance()
            if self.check("DOT"):
                self.advance()
        self.parse_path_initial_segment(path)
        while self.check("DOT") or self.check("LBRACKET") or self.check("AT"):
            if self.check("DOT"):
                self.advance()
                if self.check("LBRACKET"):
                    path.append(self.parse_quoted_bracket_member_segment())
                else:
                    path.append(self.parse_member_segment("Expected member path segment after '.'"))
                continue
            if self.check("AT"):
                self.advance()
                path.append(self.parse_attribute_path_segment())
                continue
            path.append(self.parse_bracket_path_segment())
        return path

    def parse_path_initial_segment(self, path: list[ReferencePathSegment]) -> None:
        if self.check("IDENT") or self.check("STRING"):
            path.append(self.parse_member_segment("Expected path segment"))
            return
        if self.check("LBRACKET"):
            path.append(self.parse_bracket_path_segment())
            return
        raise SyntaxError("Expected path segment", self.peek().span)

    def parse_member_segment(self, message: str) -> str:
        token = self.consume_one_of(("IDENT", "STRING"), message)
        if token.kind == "STRING" and token.quote == "`":
            raise SyntaxError("Backtick-quoted keys are not supported in paths", token.span)
        return self.assert_non_empty_key(token.value, token.span, "Quoted path keys must not be empty")

    def parse_attribute_path_segment(self) -> AttributePathSegment:
        if self.check("LBRACKET"):
            self.advance()
            token = self.consume("STRING", "Expected quoted attribute key after '@['")
            if token.quote == "`":
                raise SyntaxError("Backtick-quoted keys are not supported in attribute segments", token.span)
            self.consume("RBRACKET", "Expected ']' after quoted attribute key")
            return AttributePathSegment(
                key=self.assert_non_empty_key(token.value, token.span, "Quoted attribute keys must not be empty")
            )
        token = self.consume_one_of(("IDENT", "STRING"), "Expected attribute path segment")
        if token.kind == "STRING" and token.quote == "`":
            raise SyntaxError("Backtick-quoted keys are not supported in attribute segments", token.span)
        return AttributePathSegment(
            key=self.assert_non_empty_key(token.value, token.span, "Quoted attribute keys must not be empty")
        )

    def parse_bracket_path_segment(self) -> ReferencePathSegment:
        self.consume("LBRACKET", "Expected '['")
        if self.check("STRING"):
            token = self.advance()
            if token.quote == "`":
                raise SyntaxError("Backtick-quoted keys are not supported in paths", token.span)
            self.consume("RBRACKET", "Expected ']' after quoted path segment")
            return self.assert_non_empty_key(token.value, token.span, "Quoted path keys must not be empty")
        token = self.consume("NUMBER", "Expected numeric index or quoted key segment")
        self.consume("RBRACKET", "Expected ']' after index segment")
        text = token.value.replace("_", "")
        try:
            index = int(text, 10)
        except ValueError as exc:
            raise SyntaxError(f"Invalid index segment '{token.value}'", token.span) from exc
        if index < 0:
            raise SyntaxError(f"Invalid index segment '{token.value}'", token.span)
        return index

    def parse_quoted_bracket_member_segment(self) -> str:
        self.consume("LBRACKET", "Expected '[' after '.'")
        token = self.consume("STRING", "Expected quoted member path segment after '.['")
        if token.quote == "`":
            raise SyntaxError("Backtick-quoted keys are not supported in paths", token.span)
        self.consume("RBRACKET", "Expected ']' after quoted member path segment")
        return self.assert_non_empty_key(token.value, token.span, "Quoted path keys must not be empty")

    def parse_literal(self) -> Value:
        token = self.peek()
        if token.kind == "IDENT" and token.value == "Infinity":
            self.advance()
            return InfinityLiteral(value="Infinity", raw="Infinity", span=token.span)
        if token.kind == "SYMBOL" and token.value == "-" and self.check_next("IDENT") and self.tokens[self.current + 1].value == "Infinity":
            start = self.advance().span.start
            infinity = self.advance()
            return InfinityLiteral(value="-Infinity", raw="-Infinity", span=Span(start=start, end=infinity.span.end))
        if token.kind == "STRING":
            self.advance()
            return StringLiteral(value=token.value, raw=token.value, delimiter=cast(str, token.quote), span=token.span)
        if token.kind == "NUMBER":
            self.advance()
            return NumberLiteral(value=token.value.replace("_", ""), raw=token.value, span=token.span)
        if token.kind in {"TRUE", "FALSE"}:
            self.advance()
            return BooleanLiteral(value=token.value == "true", raw=token.value, span=token.span)
        if token.kind in {"YES", "NO", "ON", "OFF"}:
            self.advance()
            return SwitchLiteral(value=cast(str, token.value), raw=token.value, span=token.span)
        if token.kind == "HEX":
            self.advance()
            return HexLiteral(value=token.value[1:], raw=token.value, span=token.span)
        if token.kind == "RADIX":
            self.advance()
            return RadixLiteral(value=token.value[1:], raw=token.value, span=token.span)
        if token.kind == "ENCODING":
            self.advance()
            return EncodingLiteral(value=token.value[1:], raw=token.value, span=token.span)
        if token.kind == "DATE":
            self.advance()
            return DateLiteral(value=token.value, raw=token.value, span=token.span)
        if token.kind == "DATETIME":
            self.advance()
            return DateTimeLiteral(value=token.value, raw=token.value, span=token.span)
        if token.kind == "TIME":
            self.advance()
            return TimeLiteral(value=token.value, raw=token.value, span=token.span)
        if token.kind == "SEPARATOR":
            self.advance()
            return SeparatorLiteral(value=token.value[1:], raw=token.value, span=token.span)
        raise SyntaxError(f"Unexpected token '{token.value}'", token.span)

    def parse_trimtick_string(self) -> StringLiteral:
        start_token = self.peek()
        marker_width = 0
        previous_angle: Token | None = None
        while self.check("RANGLE"):
            angle = self.peek()
            if previous_angle is not None and previous_angle.span.end.offset != angle.span.start.offset:
                raise SyntaxError("Trimtick marker must be contiguous", angle.span)
            marker_width += 1
            if marker_width > 4:
                raise SyntaxError('Trimtick marker may contain at most four ">" characters', angle.span)
            previous_angle = self.advance()

        if not self.check("STRING") or self.peek().quote != "`":
            raise SyntaxError("Trimtick marker must be followed by a backtick string", self.peek().span)

        token = self.advance()
        raw_value = token.value
        return StringLiteral(
            value=apply_trimticks(raw_value, marker_width),
            raw=raw_value,
            delimiter="`",
            trimticks={"markerWidth": marker_width, "rawValue": raw_value},
            span=Span(start=start_token.span.start, end=token.span.end),
        )

    def key_from_token(self, token: Token) -> str:
        if token.kind == "STRING" and token.quote == "`":
            raise SyntaxError("Backtick-quoted keys are not supported", token.span)
        return self.assert_non_empty_key(token.value, token.span, "Keys must not be empty")

    def assert_non_empty_key(self, key: str, span: Span, message: str) -> str:
        if len(key) == 0:
            raise SyntaxError(message, span)
        return key

    def skip_separators(self) -> None:
        while self.check("NEWLINE") or self.check("COMMA"):
            self.advance()

    def consume_member_delimiter(self, terminator: str, message: str) -> None:
        saw_newline = False
        while self.check("NEWLINE"):
            self.advance()
            saw_newline = True
        if self.check("COMMA"):
            self.advance()
            self.skip_layout()
            if self.check("COMMA"):
                raise SyntaxError(message, self.peek().span)
            return
        if self.check(terminator):
            return
        if saw_newline:
            return
        raise SyntaxError(message, self.peek().span)

    def check(self, kind: str) -> bool:
        return self.peek().kind == kind

    def check_next(self, kind: str) -> bool:
        if self.current + 1 >= len(self.tokens):
            return False
        return self.tokens[self.current + 1].kind == kind

    def peek(self) -> Token:
        return self.tokens[self.current]

    def previous(self) -> Token:
        return self.tokens[self.current - 1]

    def advance(self) -> Token:
        if not self.check("EOF"):
            self.current += 1
        return self.tokens[self.current - 1]

    def consume(self, kind: str, message: str) -> Token:
        if self.check(kind):
            return self.advance()
        raise SyntaxError(message, self.peek().span)

    def consume_one_of(self, kinds: tuple[str, ...], message: str) -> Token:
        for kind in kinds:
            if self.check(kind):
                return self.advance()
        raise SyntaxError(message, self.peek().span)


def parse_tokens(
    source: str,
    tokens: list[Token],
    max_separator_depth: int = 1,
    max_generic_depth: int = 1,
    max_nesting_depth: int = 256,
) -> ParseResult:
    return Parser(
        source,
        tokens,
        max_separator_depth=max_separator_depth,
        max_generic_depth=max_generic_depth,
        max_nesting_depth=max_nesting_depth,
    ).parse()


def apply_trimticks(raw: str, marker_width: int) -> str:
    if "\n" not in raw:
        return raw

    lines = raw.split("\n")
    if lines and is_blank_line(lines[0]):
        lines.pop(0)
    while lines and is_blank_line(lines[-1]):
        lines.pop()
    if not lines:
        return ""

    normalized = []
    for line in lines:
        if is_blank_line(line):
            normalized.append("")
        elif marker_width == 1:
            normalized.append(line)
        else:
            normalized.append(normalize_leading_indent(line, marker_width))

    non_empty = [line for line in normalized if line]
    if not non_empty:
        return ""

    common_indent = min(count_leading_spaces(line) for line in non_empty)
    return "\n".join("" if not line else line[common_indent:] for line in normalized)


def is_blank_line(line: str) -> bool:
    return re.match(r"^[ \t]*$", line) is not None


def count_leading_spaces(line: str) -> int:
    index = 0
    while index < len(line) and line[index] == " ":
        index += 1
    return index


def normalize_leading_indent(line: str, tab_width: int) -> str:
    index = 0
    prefix: list[str] = []
    while index < len(line):
        char = line[index]
        if char == " ":
            prefix.append(" ")
            index += 1
            continue
        if char == "\t":
            prefix.append(" " * tab_width)
            index += 1
            continue
        break
    return "".join(prefix) + line[index:]
