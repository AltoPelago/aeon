from __future__ import annotations

from ._compat import dataclass
from .spans import Span


@dataclass(slots=True)
class AeonError(Exception):
    message: str
    span: Span
    code: str
    path: str | None = None

    def __str__(self) -> str:
        return self.message

    def to_json(self) -> dict[str, object]:
        payload = {
            "code": self.code,
            "path": self.path or "$",
            "span": self.span.to_json(),
            "message": self.message,
        }
        phase_label = infer_phase_label_from_code(self.code)
        if phase_label is not None:
            payload["phaseLabel"] = phase_label
        return payload


def infer_phase_label_from_code(code: str) -> str | None:
    if code == "INPUT_SIZE_EXCEEDED":
        return "Input Validation"
    if code in {"UNEXPECTED_CHARACTER", "UNTERMINATED_BLOCK_COMMENT", "UNTERMINATED_STRING", "UNTERMINATED_TRIMTICK"}:
        return "Lexical Analysis"
    if code in {
        "SYNTAX_ERROR",
        "INVALID_DATE",
        "INVALID_TIME",
        "INVALID_DATETIME",
        "INVALID_NUMBER",
        "INVALID_SEPARATOR_CHAR",
        "SEPARATOR_DEPTH_EXCEEDED",
        "GENERIC_DEPTH_EXCEEDED",
    }:
        return "Parsing"
    if code in {"HEADER_CONFLICT", "DUPLICATE_CANONICAL_PATH", "DATATYPE_LITERAL_MISMATCH"}:
        return "Core Validation"
    if code in {"MISSING_REFERENCE_TARGET", "FORWARD_REFERENCE", "SELF_REFERENCE", "ATTRIBUTE_DEPTH_EXCEEDED"}:
        return "Reference Validation"
    if code in {"UNTYPED_SWITCH_LITERAL", "UNTYPED_VALUE_IN_STRICT_MODE", "CUSTOM_DATATYPE_NOT_ALLOWED", "INVALID_NODE_HEAD_DATATYPE"}:
        return "Mode Enforcement"
    if code.startswith("FINALIZE_") or code == "TYPE_GUARD_FAILED":
        return "Finalization"
    return None


class SyntaxError(AeonError):
    def __init__(self, message: str, span: Span, path: str | None = None) -> None:
        super().__init__(message=message, span=span, code="SYNTAX_ERROR", path=path)


class UnterminatedStringError(AeonError):
    def __init__(self, delimiter: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Unterminated string literal (started with {delimiter})",
            span=span,
            code="UNTERMINATED_STRING",
            path=path,
        )


class InvalidNumberError(AeonError):
    def __init__(self, raw: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Invalid number literal: '{raw}'",
            span=span,
            code="INVALID_NUMBER",
            path=path,
        )


class InvalidDateError(AeonError):
    def __init__(self, raw: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Invalid date literal: '{raw}'",
            span=span,
            code="INVALID_DATE",
            path=path,
        )


class InvalidTimeError(AeonError):
    def __init__(self, raw: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Invalid time literal: '{raw}'",
            span=span,
            code="INVALID_TIME",
            path=path,
        )


class InvalidDateTimeError(AeonError):
    def __init__(self, raw: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Invalid datetime literal: '{raw}'",
            span=span,
            code="INVALID_DATETIME",
            path=path,
        )


class InvalidSeparatorCharError(AeonError):
    def __init__(self, char: str, span: Span, path: str | None = None) -> None:
        super().__init__(
            message=f"Invalid separator character '{char}'",
            span=span,
            code="INVALID_SEPARATOR_CHAR",
            path=path,
        )


class SeparatorDepthExceededError(AeonError):
    def __init__(self, observed: int, limit: int, span: Span) -> None:
        super().__init__(
            message=f"Separator depth {observed} exceeds max_separator_depth {limit}",
            span=span,
            code="SEPARATOR_DEPTH_EXCEEDED",
        )


class GenericDepthExceededError(AeonError):
    def __init__(self, observed: int, limit: int, span: Span) -> None:
        super().__init__(
            message=f"Generic depth {observed} exceeds max_generic_depth {limit}",
            span=span,
            code="GENERIC_DEPTH_EXCEEDED",
        )


class DuplicateCanonicalPathError(AeonError):
    def __init__(self, path: str, span: Span) -> None:
        super().__init__(
            message=f"Duplicate canonical path: '{path}'",
            span=span,
            code="DUPLICATE_CANONICAL_PATH",
            path=path,
        )


class HeaderConflictError(AeonError):
    def __init__(self, span: Span) -> None:
        super().__init__(
            message="Header conflict: cannot use both structured header (aeon:header) and shorthand header fields",
            span=span,
            code="HEADER_CONFLICT",
        )


class UntypedValueInStrictModeError(AeonError):
    def __init__(self, path: str, span: Span) -> None:
        super().__init__(
            message=f"Untyped value in strict mode: '{path}' requires explicit type annotation",
            span=span,
            code="UNTYPED_VALUE_IN_STRICT_MODE",
            path=path,
        )


class UntypedSwitchLiteralError(AeonError):
    def __init__(self, path: str, span: Span) -> None:
        super().__init__(
            message=f"Untyped switch literal in typed mode: '{path}' requires ':switch' type annotation",
            span=span,
            code="UNTYPED_SWITCH_LITERAL",
            path=path,
        )


class DatatypeLiteralMismatchError(AeonError):
    def __init__(self, path: str, datatype: str, actual_kind: str, expected: tuple[str, ...], span: Span) -> None:
        super().__init__(
            message=(
                f"Datatype/literal mismatch at '{path}': datatype ':{datatype}' "
                f"expects {' or '.join(expected)}, got {actual_kind}"
            ),
            span=span,
            code="DATATYPE_LITERAL_MISMATCH",
            path=path,
        )


class InvalidCustomDatatypeBracketShapeError(AeonError):
    def __init__(self, path: str, datatype: str, actual_kind: str, span: Span) -> None:
        super().__init__(
            message=(
                f"Datatype/literal mismatch at '{path}': datatype ':{datatype}' "
                f"has bracket specs incompatible with both SeparatorLiteral and RadixLiteral, got {actual_kind}"
            ),
            span=span,
            code="DATATYPE_LITERAL_MISMATCH",
            path=path,
        )


class IncompatibleCustomDatatypeAdornmentsError(AeonError):
    def __init__(self, path: str, datatype: str, actual_kind: str, span: Span) -> None:
        super().__init__(
            message=(
                f"Datatype/literal mismatch at '{path}': datatype ':{datatype}' "
                f"combines incompatible generic and bracket constraints, got {actual_kind}"
            ),
            span=span,
            code="DATATYPE_LITERAL_MISMATCH",
            path=path,
        )


class CustomDatatypeNotAllowedError(AeonError):
    def __init__(self, path: str, datatype: str, span: Span) -> None:
        super().__init__(
            message=(
                f"Custom datatype not allowed in strict mode at '{path}': "
                f"':{datatype}' requires --datatype-policy allow_custom"
            ),
            span=span,
            code="CUSTOM_DATATYPE_NOT_ALLOWED",
            path=path,
        )


class InvalidNodeHeadDatatypeError(AeonError):
    def __init__(self, path: str, datatype: str, span: Span) -> None:
        super().__init__(
            message=(
                f"Invalid node head datatype in strict mode at '{path}': "
                f"node heads must use ':node', got ':{datatype}'"
            ),
            span=span,
            code="INVALID_NODE_HEAD_DATATYPE",
            path=path,
        )


class MissingReferenceTargetError(AeonError):
    def __init__(self, target_path: str, span: Span) -> None:
        super().__init__(
            message=f"Missing reference target: '{target_path}'",
            span=span,
            code="MISSING_REFERENCE_TARGET",
        )


class ForwardReferenceError(AeonError):
    def __init__(self, source_path: str, target_path: str, span: Span) -> None:
        super().__init__(
            message=f"Forward reference: '{source_path}' references '{target_path}' defined later",
            span=span,
            code="FORWARD_REFERENCE",
        )


class SelfReferenceError(AeonError):
    def __init__(self, source_path: str, span: Span) -> None:
        super().__init__(
            message=f"Self reference: '{source_path}' references itself",
            span=span,
            code="SELF_REFERENCE",
        )


class AttributeDepthExceededError(AeonError):
    def __init__(self, target_path: str, observed: int, limit: int, span: Span) -> None:
        super().__init__(
            message=(
                f"Attribute depth {observed} exceeds max_attribute_depth {limit} "
                f"for '{target_path}'"
            ),
            span=span,
            code="ATTRIBUTE_DEPTH_EXCEEDED",
        )


class UnterminatedBlockCommentError(AeonError):
    def __init__(self, span: Span) -> None:
        super().__init__(
            message="Unterminated block comment",
            span=span,
            code="UNTERMINATED_BLOCK_COMMENT",
        )


class InputSizeExceededError(AeonError):
    def __init__(self, actual_bytes: int, max_bytes: int, span: Span) -> None:
        super().__init__(
            message=f"Input size {actual_bytes} bytes exceeds configured limit of {max_bytes} bytes",
            span=span,
            code="INPUT_SIZE_EXCEEDED",
        )
