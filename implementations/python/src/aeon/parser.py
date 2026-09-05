from __future__ import annotations

import json
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
    NaNLiteral,
    NullLiteral,
    Header,
    HexLiteral,
    ListNode,
    NodeLiteral,
    NumberLiteral,
    ObjectNode,
    PointerReference,
    RadixLiteral,
    ReferencePathSegment,
    SansaAddressLiteral,
    SeparatorLiteral,
    StringLiteral,
    ToggleLiteral,
    TimeLiteral,
    TupleLiteral,
    TypedValue,
    TypeAnnotation,
    Value,
)
from .errors import (
    AeonError,
    AttributeDepthExceededError,
    DuplicateStructuralIdentityError,
    DatatypeComponentsExceededError,
    GenericArgumentsExceededError,
    GenericDepthExceededError,
    HeaderConflictError,
    InvalidSeparatorCharError,
    NestingDepthExceededError,
    ClarifierValuesExceededError,
    SyntaxError,
    UnsafeMaxNestingDepthError,
)
from .lexer import Token
from .sansa import parse_address
from .spans import Span

GENERIC_V1_DATATYPES = {"list", "tuple", "triple", "object", "node", "null", "nan", "infinity"}
RESERVED_V1_DATATYPES = {
    "n", "number", "int", "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64",
    "float", "float32", "float64",
    "string", "trimtick", "prose", "boolean", "bool", "toggle", "infinity", "nan",
    "hex", "date", "time", "datetime", "wtc",
    "encoding", "base64", "embed", "inline",
    "radix", "decimal", "radix2", "radix6", "radix8", "radix12",
    "sep", "kadot",
    "tuple", "triple", "list", "object", "obj", "envelope", "o", "node", "null", "sansa",
}

RESERVED_ATTRIBUTE_KEYS = {"@", "@items", "__proto__", "constructor", "prototype"}

RESERVED_NULL_SENTINELS = {"none", "notSet", "notApplicable", "tombstone"}
BARE_KEY_TOKEN_KINDS = {"IDENT", "TRUE", "FALSE", "YES", "NO", "ON", "OFF"}

PARSER_STACK_SAFE_MAX_NESTING_DEPTH = 512


def datatype_base(datatype: str) -> str:
    generic_idx = datatype.find("<")
    bracket_idx = datatype.find("[")
    indices = [idx for idx in (generic_idx, bracket_idx) if idx >= 0]
    if not indices:
        return datatype
    return datatype[:min(indices)]


@dataclass(slots=True)
class ParseResult:
    document: Document | None
    errors: list[Exception]


class Parser:
    def __init__(
        self,
        source: str,
        tokens: list[Token],
        max_clarifier_values: int = 1,
        max_generic_depth: int = 1,
        max_generic_arguments: int = 32,
        max_datatype_components: int = 64,
        max_attribute_depth: int = 1,
        max_value_nesting_depth: int = 256,
    ) -> None:
        self.source = source
        self.tokens = tokens
        self.current = 0
        self.max_clarifier_values = max_clarifier_values
        self.max_generic_depth = max_generic_depth
        self.max_generic_arguments = max_generic_arguments
        self.max_datatype_components = max_datatype_components
        self.max_attribute_depth = max_attribute_depth
        self.max_value_nesting_depth = max_value_nesting_depth
        self.current_nesting_depth = 0
        self.errors: list[Exception] = []
        self.deferred_errors: list[Exception] = []
        self.structural_identities: set[str] = set()

    def skip_layout(self) -> None:
        while self.check("NEWLINE"):
            self.advance()

    def parse(self) -> ParseResult:
        try:
            document = self.parse_document()
            return ParseResult(document=document, errors=self.errors)
        except AeonError as error:
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
            except AeonError as error:
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
                and self.is_key_token(self.peek())
                and self.check_next("EQUALS") | self.check_next("COLON")
            ):
                return
            self.advance()

    def is_header_start(self) -> bool:
        if not self.check("IDENT") or self.peek().value != "aeon":
            return False
        header = self.header_token_indices()
        if header is None:
            return False
        _, field_index, equals_index = header
        field_token = self.tokens[field_index]
        equals_token = self.tokens[equals_index] if equals_index is not None else None
        if field_token.kind == "IDENT" and field_token.value == "envelope" and equals_token is not None:
            return False
        return True

    def is_structured_header_start(self) -> bool:
        header = self.header_token_indices()
        if header is None:
            return False
        _, field_index, equals_index = header
        field_token = self.tokens[field_index]
        return (
            field_token.kind == "IDENT"
            and field_token.value == "header"
            and equals_index is not None
        )

    def skip_layout_index(self, index: int) -> int:
        while index < len(self.tokens) and self.tokens[index].kind == "NEWLINE":
            index += 1
        return index

    def header_token_indices(self) -> tuple[int, int, int | None] | None:
        if not self.check("IDENT") or self.peek().value != "aeon":
            return None
        colon_index = self.skip_layout_index(self.current + 1)
        if colon_index >= len(self.tokens) or self.tokens[colon_index].kind != "COLON":
            return None
        field_index = self.skip_layout_index(colon_index + 1)
        if field_index >= len(self.tokens) or self.tokens[field_index].kind != "IDENT":
            return None
        equals_index = self.skip_layout_index(field_index + 1)
        if equals_index >= len(self.tokens) or self.tokens[equals_index].kind != "EQUALS":
            equals_index = None
        return colon_index, field_index, equals_index

    def parse_header(self) -> Header:
        start = self.peek().span.start
        bindings: list[Binding] = []
        fields: dict[str, Value] = {}
        has_structured = False
        has_shorthand = False
        end = start
        while self.is_header_start():
            self.advance()
            self.skip_separators()
            self.consume("COLON", "Expected ':' after 'aeon'")
            self.skip_separators()
            field_token = self.consume("IDENT", "Expected header field name")
            field_name = field_token.value
            self.skip_separators()
            self.consume("EQUALS", "Expected '=' in header")
            self.skip_layout()
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
        key_token = self.consume_key_token("Expected binding key")
        key = self.key_from_token(key_token)
        self.skip_layout()
        structural_id = self.parse_optional_structural_identity()
        self.skip_layout()
        attributes: list[Attribute] = []
        if self.check("AT"):
            attributes.append(self.parse_attribute(1))
            self.skip_layout()
            if self.check("AT"):
                raise SyntaxError("Only one attribute block is allowed before a binding datatype", self.peek().span)
        datatype: TypeAnnotation | None = None
        if self.check("COLON"):
            self.advance()
            self.skip_layout()
            datatype = self.parse_type_annotation()
            self.validate_binding_node_datatype(datatype)
            self.skip_layout()
        self.consume("EQUALS", f"Expected '=' after key '{key}'")
        self.skip_separators()
        value = self.parse_value()
        end = self.previous().span.end
        if self.check("AT"):
            raise SyntaxError("Postfix literal attributes are not valid Core v1 syntax", self.peek().span)
        return Binding(key=key, value=value, datatype=datatype, attributes=attributes, span=Span(start=start, end=end), structural_id=structural_id)

    def parse_attribute(self, depth: int) -> Attribute:
        if depth > self.max_attribute_depth:
            raise AttributeDepthExceededError("$", depth, self.max_attribute_depth, self.peek().span)
        start = self.peek().span.start
        self.consume("AT", "Expected '@'")
        self.skip_layout()
        self.consume("LBRACE", "Expected '{' after '@'")
        entries: dict[str, AttributeEntry] = {}
        self.skip_layout()
        while not self.check("RBRACE"):
            key_token = self.consume_key_token("Expected attribute key")
            key = self.key_from_token(key_token)
            if key in RESERVED_ATTRIBUTE_KEYS:
                raise SyntaxError(f"Reserved attribute key: {key}", key_token.span)
            if key in entries:
                raise AeonError(message=f"Duplicate key: '{key}'", span=key_token.span, code="DUPLICATE_KEY")
            self.skip_layout()
            structural_id = self.parse_optional_structural_identity()
            self.skip_layout()
            attributes: list[Attribute] = []
            if self.check("AT"):
                attributes.append(self.parse_attribute(depth + 1))
                self.skip_layout()
                if self.check("AT"):
                    raise SyntaxError("Only one attribute block is allowed before an attribute entry datatype", self.peek().span)
            datatype: TypeAnnotation | None = None
            if self.check("COLON"):
                self.advance()
                self.skip_layout()
                datatype = self.parse_type_annotation()
                self.validate_binding_node_datatype(datatype)
                self.skip_layout()
            self.consume("EQUALS", "Expected '=' in attribute")
            self.skip_separators()
            value = self.parse_value()
            entries[key] = AttributeEntry(value=value, datatype=datatype, attributes=attributes, structural_id=structural_id)
            self.consume_member_delimiter("RBRACE", "Expected attribute delimiter")
        end = self.consume("RBRACE", "Expected '}' to close attribute").span.end
        return Attribute(entries=entries, span=Span(start=start, end=end))

    def parse_type_annotation(
        self,
        generic_depth: int = 0,
        components: list[int] | None = None,
    ) -> TypeAnnotation:
        if components is None:
            components = [0]
        if generic_depth > self.max_generic_depth:
            raise GenericDepthExceededError(generic_depth, self.max_generic_depth, self.peek().span)
        self.count_datatype_component(components, self.peek().span)
        start = self.peek().span.start
        name = self.consume("IDENT", "Expected type name").value
        generic_args: list[str] = []
        clarifiers: list[str | int | float] = []
        self.skip_layout()
        if self.check("LANGLE"):
            if name == "radix":
                raise SyntaxError("Radix datatype bases must use bracket syntax like 'radix[10]'", self.peek().span)
            self.advance()
            self.skip_layout()
            generic_args.append(self.parse_generic_argument(generic_depth, components))
            self.enforce_generic_argument_count(len(generic_args))
            self.skip_layout()
            while self.check("COMMA"):
                self.advance()
                self.skip_layout()
                generic_args.append(self.parse_generic_argument(generic_depth, components))
                self.enforce_generic_argument_count(len(generic_args))
                self.skip_layout()
            self.consume("RANGLE", "Expected '>' to close generic arguments")
            self.skip_layout()
        if self.check("LBRACKET"):
            self.advance()
            self.skip_layout()
            while True:
                token = self.peek()
                if token.kind == "RBRACKET":
                    if not clarifiers:
                        raise SyntaxError("Datatype clarifier must contain at least one string or number", token.span)
                    break
                if token.kind == "STRING":
                    clarifiers.append(token.value)
                    self.advance()
                elif token.kind == "NUMBER":
                    clarifiers.append(self.parse_numeric_clarifier(token.value))
                    self.advance()
                else:
                    raise SyntaxError("Expected clarifier value", token.span)
                if len(clarifiers) > self.max_clarifier_values:
                    raise ClarifierValuesExceededError(len(clarifiers), self.max_clarifier_values, token.span)
                self.count_datatype_component(components, token.span)
                self.skip_layout()
                if self.check("RBRACKET"):
                    break
                self.consume("COMMA", "Expected ',' between clarifier values")
                self.skip_layout()
            self.consume("RBRACKET", "Expected ']' to close datatype clarifier")
            self.skip_layout()
            if self.check("LBRACKET"):
                raise SyntaxError('Datatype clarifiers must use a single bracketed list like \'sep["/", "."]\'', self.peek().span)
        self.validate_reserved_datatype_adornments(name, generic_args)
        return TypeAnnotation(name=name, generic_args=generic_args, clarifiers=clarifiers, span=Span(start=start, end=self.previous().span.end))

    def parse_generic_argument(self, generic_depth: int, components: list[int]) -> str:
        token = self.peek()
        if token.kind not in {"IDENT", "NUMBER"}:
            raise SyntaxError("Expected generic argument", token.span)
        if token.kind == "NUMBER":
            self.advance()
            self.count_datatype_component(components, token.span)
            return token.value
        nested = self.parse_type_annotation(generic_depth + 1, components)
        return self.format_type_annotation(nested)

    def enforce_generic_argument_count(self, observed: int) -> None:
        if observed > self.max_generic_arguments:
            raise GenericArgumentsExceededError(observed, self.max_generic_arguments, self.previous().span)

    def count_datatype_component(self, components: list[int], span: Span) -> None:
        components[0] += 1
        if components[0] > self.max_datatype_components:
            raise DatatypeComponentsExceededError(components[0], self.max_datatype_components, span)

    def format_type_annotation(self, annotation: TypeAnnotation) -> str:
        generic_suffix = ""
        if annotation.generic_args:
            generic_suffix = "<" + ", ".join(annotation.generic_args) + ">"
        clarifier_suffix = ""
        if annotation.clarifiers:
            clarifier_suffix = "[" + ", ".join(self.format_clarifier(value) for value in annotation.clarifiers) + "]"
        return f"{annotation.name}{generic_suffix}{clarifier_suffix}"

    @staticmethod
    def format_clarifier(value: str | int | float) -> str:
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    @staticmethod
    def parse_numeric_clarifier(value: str) -> int | float:
        normalized = value.replace("_", "")
        if normalized.startswith("+"):
            normalized = normalized[1:]
        if re.fullmatch(r"-?\d+", normalized):
            return int(normalized)
        return float(normalized)

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
    ) -> None:
        if name not in RESERVED_V1_DATATYPES:
            return
        if generic_args and name not in GENERIC_V1_DATATYPES:
            raise SyntaxError(f"Datatype '{name}' does not support generic arguments in v1", self.previous().span)

    def validate_binding_node_datatype(self, annotation: TypeAnnotation) -> None:
        if annotation.name != "node":
            return
        for generic_arg in annotation.generic_args:
            base = datatype_base(generic_arg)
            if base != "node" and base in RESERVED_V1_DATATYPES:
                raise SyntaxError(
                    "Binding datatype 'node<T>' may use 'node' or a custom profile/domain argument; reserved child value datatypes belong on node heads",
                    annotation.span,
                )

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
            "CARET",
            "EQUALS",
            "TILDE",
            "LANGLE",
            "RANGLE",
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
        if len(value) != 1 or not self.is_allowed_separator_spec_char(value):
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
            "CARET",
            "EQUALS",
            "TILDE",
            "LANGLE",
            "RANGLE",
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

    @staticmethod
    def is_allowed_separator_spec_char(value: str) -> bool:
        return bool(re.fullmatch(r"[A-Za-z0-9!#$%&*+\-.:;=?@^_|~<>]", value))

    def parse_value(self) -> Value:
        counts_toward_nesting = self.check("LANGLE") or self.check("LBRACE") or self.check("LBRACKET") or self.check("LPAREN")
        if counts_toward_nesting:
            self.current_nesting_depth += 1
            if self.current_nesting_depth > self.max_value_nesting_depth:
                observed_depth = self.current_nesting_depth
                self.current_nesting_depth -= 1
                raise NestingDepthExceededError(observed_depth, self.max_value_nesting_depth, self.peek().span)
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
            if counts_toward_nesting:
                self.current_nesting_depth -= 1

    def parse_anonymous_value(self) -> Value:
        if not self.check("STRUCTURAL_IDENTITY") and not self.check("COLON") and not self.check("AT"):
            return self.parse_value()
        start = self.peek().span.start
        structural_id = self.parse_optional_structural_identity()
        self.skip_layout()
        attributes: list[Attribute] = []
        if self.check("AT"):
            attributes.append(self.parse_attribute(1))
            self.skip_layout()
            if self.check("AT"):
                raise SyntaxError("Only one attribute block is allowed before an anonymous value datatype", self.peek().span)
        datatype = None
        if self.check("COLON"):
            self.advance()
            self.skip_layout()
            datatype = self.parse_type_annotation()
            self.validate_binding_node_datatype(datatype)
        self.skip_layout()
        self.consume("EQUALS", "Expected '=' after anonymous value head")
        self.skip_separators()
        value = self.parse_value()
        return TypedValue(
            datatype=datatype,
            attributes=attributes,
            value=value,
            span=Span(start=start, end=value.span.end if value.span else self.previous().span.end),
            structural_id=structural_id,
        )

    def parse_optional_structural_identity(self) -> str | None:
        if not self.check("STRUCTURAL_IDENTITY"):
            return None
        token = self.advance()
        structural_id = token.value
        if structural_id in self.structural_identities:
            raise DuplicateStructuralIdentityError(structural_id, token.span)
        self.structural_identities.add(structural_id)
        return structural_id

    def parse_node(self) -> NodeLiteral:
        start = self.consume("LANGLE", "Expected '<' to start node literal").span.start
        self.skip_layout()
        tag = self.key_from_token(self.consume_key_token("Expected node tag after '<'"))
        self.skip_layout()
        structural_id = self.parse_optional_structural_identity()
        self.skip_layout()
        attributes: list[Attribute] = []
        if self.check("AT"):
            attributes.append(self.parse_attribute(1))
            self.skip_layout()
            if self.check("AT"):
                raise SyntaxError("Only one attribute block is allowed before a node datatype", self.peek().span)
        datatype: TypeAnnotation | None = None
        if self.check("COLON"):
            self.advance()
            self.skip_layout()
            datatype = self.parse_type_annotation()
            if (datatype.generic_args and datatype.name != "node") or datatype.clarifiers:
                raise SyntaxError("Node head datatypes must be simple labels or node<T> without clarifiers", datatype.span)
            self.skip_layout()
        children: list[Value] = []
        if self.check("RANGLE"):
            end = self.advance().span.end
            return NodeLiteral(tag=tag, attributes=attributes, datatype=datatype, children=children, span=Span(start=start, end=end), structural_id=structural_id)
        self.consume("LPAREN", "Expected '(' or '>' after node tag")
        self.skip_layout()
        while not self.check("RPAREN"):
            children.append(self.parse_anonymous_value())
            self.consume_member_delimiter("RPAREN", "Expected node child delimiter")
        self.consume("RPAREN", "Expected ')' to close node children")
        self.skip_layout()
        end = self.consume("RANGLE", "Expected '>' after node children").span.end
        return NodeLiteral(tag=tag, attributes=attributes, datatype=datatype, children=children, span=Span(start=start, end=end), structural_id=structural_id)

    def parse_object(self) -> ObjectNode:
        start = self.consume("LBRACE", "Expected '{'").span.start
        bindings: list[Binding] = []
        self.skip_layout()
        while not self.check("RBRACE"):
            binding = self.parse_binding()
            bindings.append(binding)
            self.consume_member_delimiter("RBRACE", "Expected object member delimiter")
        end = self.consume("RBRACE", "Expected '}' to close object").span.end
        return ObjectNode(bindings=bindings, attributes=[], span=Span(start=start, end=end))

    def parse_list(self) -> ListNode:
        start = self.consume("LBRACKET", "Expected '['").span.start
        elements: list[Value] = []
        self.skip_layout()
        while not self.check("RBRACKET"):
            elements.append(self.parse_anonymous_value())
            self.consume_member_delimiter("RBRACKET", "Expected list delimiter")
        end = self.consume("RBRACKET", "Expected ']' to close list").span.end
        return ListNode(elements=elements, attributes=[], span=Span(start=start, end=end))

    def parse_tuple(self) -> TupleLiteral:
        start = self.consume("LPAREN", "Expected '('").span.start
        elements: list[Value] = []
        self.skip_layout()
        while not self.check("RPAREN"):
            elements.append(self.parse_anonymous_value())
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
        saw_root_dot = False
        saw_explicit_root = False
        if self.check("DOLLAR"):
            self.advance()
            saw_explicit_root = True
            if self.check("DOT"):
                self.advance()
                saw_root_dot = True
        self.parse_path_initial_segment(
            path,
            saw_root_dot=saw_root_dot,
            saw_explicit_root=saw_explicit_root,
        )
        while self.check("DOT") or self.check("LBRACKET"):
            if self.check("DOT"):
                self.advance()
                if self.check("AT"):
                    self.advance()
                    self.consume("DOT", "Expected '.' after attribute address-space marker")
                    path.append(self.parse_attribute_path_segment())
                elif self.check("LBRACKET"):
                    path.append(self.parse_quoted_bracket_member_segment())
                else:
                    path.append(self.parse_member_segment("Expected member path segment after '.'"))
                continue
            path.append(self.parse_bracket_path_segment())
        return path

    def parse_path_initial_segment(
        self,
        path: list[ReferencePathSegment],
        saw_root_dot: bool = False,
        saw_explicit_root: bool = False,
    ) -> None:
        if self.is_key_token(self.peek()):
            path.append(self.parse_member_segment("Expected path segment"))
            return
        if self.check("LBRACKET"):
            if saw_explicit_root and not saw_root_dot and self.check_next("STRING"):
                raise SyntaxError("Expected '.' after '$' before quoted root-member segment", self.peek().span)
            path.append(self.parse_bracket_path_segment())
            return
        raise SyntaxError("Expected path segment", self.peek().span)

    def parse_member_segment(self, message: str) -> str:
        token = self.consume_key_token(message)
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
        token = self.consume_key_token("Expected attribute path segment")
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
        if token.kind == "IDENT" and token.value == "NaN":
            self.advance()
            return NaNLiteral(value="NaN", raw="NaN", span=token.span)
        if token.kind == "SYMBOL" and token.value == "-" and self.check_next("IDENT") and self.tokens[self.current + 1].value == "Infinity":
            start = self.advance().span.start
            infinity = self.advance()
            return InfinityLiteral(value="-Infinity", raw="-Infinity", span=Span(start=start, end=infinity.span.end))
        if token.kind == "SYMBOL" and token.value == "-" and self.check_next("IDENT") and self.tokens[self.current + 1].value == "NaN":
            start = self.advance().span.start
            nan = self.advance()
            return NaNLiteral(value="-NaN", raw="-NaN", span=Span(start=start, end=nan.span.end))
        if token.kind == "SYMBOL" and token.value == "!":
            return self.parse_null_literal()
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
            return ToggleLiteral(value=cast(str, token.value), raw=token.value, span=token.span)
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
        if token.kind == "SANSA_ADDRESS":
            self.advance()
            result = parse_address(token.value)
            if not result["ok"]:
                errors = result.get("errors")
                if isinstance(errors, list) and errors:
                    first = errors[0]
                    message = first.get("message") if isinstance(first, dict) else None
                    raise SyntaxError(str(message or "Invalid SANSA address literal"), token.span)
                raise SyntaxError("Invalid SANSA address literal", token.span)
            address = result["address"]
            canonical = str(address.get("canonical") if isinstance(address, dict) else token.value)
            return SansaAddressLiteral(
                address=address if isinstance(address, dict) else {},
                value=canonical,
                raw=token.value,
                canonical=canonical,
                span=token.span,
            )
        raise SyntaxError(f"Unexpected token '{token.value}'", token.span)

    def parse_null_literal(self) -> NullLiteral:
        bang = self.advance()
        token = self.peek()

        if token.kind == "IDENT":
            span = Span(start=bang.span.start, end=token.span.end)
            if token.value not in RESERVED_NULL_SENTINELS:
                raise AeonError(
                    message=f"Invalid null sentinel '{token.value}'",
                    span=span,
                    code="INVALID_NULL_SENTINEL",
                )
            self.advance()
            return NullLiteral(mode="reserved", value=token.value, raw=f"!{token.value}", span=span)

        if token.kind == "STRING":
            span = Span(start=bang.span.start, end=token.span.end)
            value = token.value
            if value == "":
                raise AeonError(
                    message="Null reason must not be empty",
                    span=span,
                    code="INVALID_NULL_REASON_EMPTY",
                )
            if is_ascii_whitespace_only(value):
                raise AeonError(
                    message="Null reason must not be ASCII-whitespace-only",
                    span=span,
                    code="INVALID_NULL_REASON_WHITESPACE",
                )
            if value in RESERVED_NULL_SENTINELS:
                raise AeonError(
                    message=f"Null reason collides with reserved sentinel '{value}'",
                    span=span,
                    code="INVALID_NULL_REASON_COLLISION",
                )
            self.advance()
            return NullLiteral(mode="reason", value=value, raw=f"!{json.dumps(value)}", span=span)

        raise AeonError(
            message="Null literal must be followed by a reserved sentinel or quoted reason",
            span=bang.span,
            code="INVALID_NULL_LITERAL",
        )

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

    def is_key_token(self, token: Token) -> bool:
        return token.kind in BARE_KEY_TOKEN_KINDS or token.kind == "STRING"

    def next_non_newline_index(self, index: int) -> int | None:
        while index < len(self.tokens) and self.tokens[index].kind == "NEWLINE":
            index += 1
        return index if index < len(self.tokens) else None

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

    def consume_key_token(self, message: str) -> Token:
        if self.is_key_token(self.peek()):
            return self.advance()
        raise SyntaxError(message, self.peek().span)


def parse_tokens(
    source: str,
    tokens: list[Token],
    max_clarifier_values: int | None = None,
    max_generic_depth: int = 1,
    max_generic_arguments: int = 32,
    max_datatype_components: int = 64,
    max_attribute_depth: int = 1,
    max_value_nesting_depth: int | None = None,
    max_separator_depth: int = 1,
    max_nesting_depth: int = 256,
) -> ParseResult:
    effective_clarifier_values = max_separator_depth if max_clarifier_values is None else max_clarifier_values
    effective_value_nesting_depth = max_nesting_depth if max_value_nesting_depth is None else max_value_nesting_depth
    if effective_value_nesting_depth > PARSER_STACK_SAFE_MAX_NESTING_DEPTH:
        return ParseResult(
            document=None,
            errors=[
                UnsafeMaxNestingDepthError(
                    effective_value_nesting_depth,
                    PARSER_STACK_SAFE_MAX_NESTING_DEPTH,
                )
            ],
        )
    return Parser(
        source,
        tokens,
        max_clarifier_values=effective_clarifier_values,
        max_generic_depth=max_generic_depth,
        max_generic_arguments=max_generic_arguments,
        max_datatype_components=max_datatype_components,
        max_attribute_depth=max_attribute_depth,
        max_value_nesting_depth=effective_value_nesting_depth,
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


def is_ascii_whitespace_only(value: str) -> bool:
    return bool(value) and all(char in {" ", "\t", "\n", "\r"} for char in value)
