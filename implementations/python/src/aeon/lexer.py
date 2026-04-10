from __future__ import annotations

import re

from ._compat import dataclass
from .errors import (
    AeonError,
    InvalidDateError,
    InvalidDateTimeError,
    InvalidNumberError,
    InvalidTimeError,
    SyntaxError,
    UnterminatedStringError,
    UnterminatedBlockCommentError,
)
from .spans import Position, Span


@dataclass(slots=True)
class Token:
    kind: str
    value: str
    span: Span
    quote: str | None = None


@dataclass(slots=True)
class LexResult:
    tokens: list[Token]
    errors: list[AeonError]


KEYWORDS = {
    "true": "TRUE",
    "false": "FALSE",
    "yes": "YES",
    "no": "NO",
    "on": "ON",
    "off": "OFF",
}

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Lexer:
    def __init__(self, source: str) -> None:
        self.source = source
        self.offset = 0
        self.line = 1
        self.column = 1
        self.tokens: list[Token] = []
        self.errors: list[AeonError] = []

    def tokenize(self) -> LexResult:
        while not self.is_at_end():
            self.scan_token()
        eof = self.current_position()
        self.tokens.append(Token("EOF", "", Span(eof, eof)))
        return LexResult(tokens=self.tokens, errors=self.errors)

    def is_at_end(self) -> bool:
        return self.offset >= len(self.source)

    def current_position(self) -> Position:
        return Position(line=self.line, column=self.column, offset=self.offset)

    def peek(self) -> str:
        if self.is_at_end():
            return "\0"
        return self.source[self.offset]

    def peek_next(self) -> str:
        if self.offset + 1 >= len(self.source):
            return "\0"
        return self.source[self.offset + 1]

    def advance(self) -> str:
        char = self.source[self.offset]
        self.offset += 1
        if char == "\n":
            self.line += 1
            self.column = 1
        else:
            self.column += 1
        return char

    def make_span(self, start: Position) -> Span:
        return Span(start=start, end=self.current_position())

    def add_token(self, kind: str, value: str, start: Position, quote: str | None = None) -> None:
        self.tokens.append(Token(kind=kind, value=value, span=self.make_span(start), quote=quote))

    def match(self, expected: str) -> bool:
        if self.peek() != expected:
            return False
        self.advance()
        return True

    def scan_token(self) -> None:
        start = self.current_position()
        char = self.advance()

        if char == "." and self.peek().isdigit():
            self.scan_numeric_like(start, char)
            return

        singles = {
            "{": "LBRACE",
            "}": "RBRACE",
            "[": "LBRACKET",
            "]": "RBRACKET",
            "(": "LPAREN",
            ")": "RPAREN",
            "<": "LANGLE",
            ">": "RANGLE",
            "=": "EQUALS",
            ":": "COLON",
            ",": "COMMA",
            ".": "DOT",
            "@": "AT",
            "$": "DOLLAR",
            "%": "PERCENT",
            "&": "AMPERSAND",
            ";": "SEMICOLON",
        }
        if char in singles:
            if char == "$" and self.peek() == ".":
                self.add_token(singles[char], char, start)
                return
            if char == "$" and self.is_encoding_start_char(self.peek()):
                self.scan_prefixed_literal(start, char, "ENCODING", self.is_encoding_char, self.is_valid_encoding_payload)
                return
            if char == "%" and self.is_radix_start_char(self.peek()):
                self.scan_prefixed_literal(start, char, "RADIX", self.is_radix_char, self.is_valid_radix_payload)
                return
            self.add_token(singles[char], char, start)
            return

        if char == "~":
            if self.match(">"):
                self.add_token("TILDE_ARROW", "~>", start)
            else:
                self.add_token("TILDE", "~", start)
            return

        if char == "#":
            if self.is_leading_shebang_start(start) and self.peek() == "!":
                self.scan_shebang_comment(start)
                return
            if self.is_hex_digit(self.peek()):
                self.scan_hex_literal(start)
            else:
                self.add_token("HASH", char, start)
            return

        if char == "^":
            self.scan_separator_literal(start)
            return

        if char in {'"', "'", "`"}:
            self.scan_string(start, char)
            return

        if char == "/":
            if self.match("/"):
                self.scan_line_comment()
                return
            if self.match("*"):
                self.scan_block_comment(start)
                return
            if self.peek() in {"#", "@", "?", "{", "[", "("}:
                self.scan_slash_channel_comment(start)
                return
            self.add_token("SYMBOL", char, start)
            return

        if char == "\n":
            self.add_token("NEWLINE", "\n", start)
            return

        if char in {" ", "\t", "\r"}:
            return

        if char in {"+", "-"} and (self.peek().isdigit() or (self.peek() == "." and self.peek_next().isdigit())):
            self.scan_numeric_like(start, char)
            return

        if char.isdigit():
            self.scan_numeric_like(start, char)
            return

        if char.isalpha() or char == "_":
            self.scan_identifier(start, char)
            return

        self.add_token("SYMBOL", char, start)

    def scan_string(self, start: Position, delimiter: str) -> None:
        is_raw = delimiter == "`"
        value_parts: list[str] = []
        while not self.is_at_end():
            char = self.peek()
            if char == delimiter:
                self.advance()
                self.add_token("STRING", "".join(value_parts), start, quote=delimiter)
                return
            if char == "\n" and not is_raw:
                self.errors.append(UnterminatedStringError(delimiter, self.make_span(start)))
                return
            if char == "\\":
                self.advance()
                if self.is_at_end():
                    self.errors.append(SyntaxError("Invalid escape sequence", self.make_span(start)))
                    return
                escaped = self.advance()
                mapping = {
                    "\\": "\\",
                    '"': '"',
                    "'": "'",
                    "`": "`",
                    "n": "\n",
                    "r": "\r",
                    "t": "\t",
                    "b": "\b",
                    "f": "\f",
                }
                if escaped in mapping:
                    value_parts.append(mapping[escaped])
                    continue
                if escaped == "u":
                    if self.match("{"):
                        hex_digits = []
                        while self.peek() not in {"}", "\0"}:
                            hex_digits.append(self.advance())
                        if not self.match("}") or not 1 <= len(hex_digits) <= 6:
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        if any(not self.is_hex_digit(c) for c in hex_digits):
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        codepoint = int("".join(hex_digits), 16)
                        if codepoint > 0x10FFFF:
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        value_parts.append(chr(codepoint))
                        continue
                    hex_digits = "".join(self.advance() for _ in range(4) if not self.is_at_end())
                    if len(hex_digits) != 4 or any(not self.is_hex_digit(c) for c in hex_digits):
                        self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                        self.consume_invalid_string_tail(delimiter, is_raw)
                        return
                    codepoint = int(hex_digits, 16)
                    if 0xD800 <= codepoint <= 0xDBFF:
                        if self.is_at_end() or self.peek() != "\\":
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        self.advance()
                        if self.is_at_end() or self.advance() != "u":
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        low_hex = "".join(self.advance() for _ in range(4) if not self.is_at_end())
                        if len(low_hex) != 4 or any(not self.is_hex_digit(c) for c in low_hex):
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        low_codepoint = int(low_hex, 16)
                        if not (0xDC00 <= low_codepoint <= 0xDFFF):
                            self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                            self.consume_invalid_string_tail(delimiter, is_raw)
                            return
                        combined = 0x10000 + ((codepoint - 0xD800) << 10) + (low_codepoint - 0xDC00)
                        value_parts.append(chr(combined))
                        continue
                    if 0xDC00 <= codepoint <= 0xDFFF:
                        self.errors.append(SyntaxError("Invalid unicode escape", self.make_span(start)))
                        self.consume_invalid_string_tail(delimiter, is_raw)
                        return
                    value_parts.append(chr(codepoint))
                    continue
                self.errors.append(SyntaxError("Invalid escape sequence", self.make_span(start)))
                self.consume_invalid_string_tail(delimiter, is_raw)
                return
            value_parts.append(self.advance())
        self.errors.append(UnterminatedStringError(delimiter, self.make_span(start)))

    def consume_invalid_string_tail(self, delimiter: str, is_raw: bool) -> None:
        while not self.is_at_end():
            char = self.peek()
            if char == delimiter:
                self.advance()
                return
            if char == "\n" and not is_raw:
                return
            self.advance()

    def scan_block_comment(self, start: Position) -> None:
        while not self.is_at_end():
            if self.peek() == "*" and self.peek_next() == "/":
                self.advance()
                self.advance()
                return
            self.advance()
        self.errors.append(UnterminatedBlockCommentError(self.make_span(start)))

    def scan_line_comment(self) -> None:
        while self.peek() not in {"\0", "\n"}:
            self.advance()

    def scan_shebang_comment(self, start: Position) -> None:
        self.advance()
        while self.peek() not in {"\0", "\n"}:
            self.advance()

    def scan_slash_channel_comment(self, start: Position) -> None:
        marker = self.advance()
        closing = {"{": "}", "[": "]", "(": ")"}.get(marker, marker)
        while not self.is_at_end():
            if self.peek() == closing and self.peek_next() == "/":
                self.advance()
                self.advance()
                return
            self.advance()
        self.errors.append(UnterminatedBlockCommentError(self.make_span(start)))

    def scan_prefixed_while(self, start: Position, prefix: str, kind: str, predicate) -> None:
        chars = [prefix]
        while predicate(self.peek()):
            chars.append(self.advance())
        self.add_token(kind, "".join(chars), start)

    def is_leading_shebang_start(self, start: Position) -> bool:
        return start.offset == 0 and start.line == 1 and start.column == 1

    def scan_prefixed_literal(self, start: Position, prefix: str, kind: str, predicate, validator) -> None:
        chars = [prefix]
        while predicate(self.peek()):
            chars.append(self.advance())
        value = "".join(chars)
        if not validator(value[1:]):
            if kind == "RADIX":
                self.errors.append(InvalidNumberError(value, self.make_span(start)))
                return
            self.errors.append(SyntaxError(f"Invalid {kind.lower()} literal: '{value}'", self.make_span(start)))
            return
        self.add_token(kind, value, start)

    def scan_hex_literal(self, start: Position) -> None:
        chars = ["#"]
        while self.is_hex_digit(self.peek()) or self.peek() == "_":
            chars.append(self.advance())
        value = "".join(chars)
        if len(value) == 1 or not self.has_valid_literal_underscores(value):
            self.errors.append(SyntaxError(f"Invalid hex literal: '{value}'", self.make_span(start)))
            return
        self.add_token("HEX", value, start)

    def scan_separator_literal(self, start: Position) -> None:
        chars = ["^"]
        saw_payload_char = False
        while not self.is_at_end():
            char = self.peek()
            if char in {'"', "'"}:
                chars.append(self.advance())
                saw_payload_char = True
                while not self.is_at_end():
                    inner = self.peek()
                    if inner in {"\n", "\r", "\0"}:
                        self.errors.append(UnterminatedStringError(char, self.make_span(start)))
                        return
                    chars.append(self.advance())
                    if inner == "\\":
                        if not self.is_at_end():
                            chars.append(self.advance())
                        continue
                    if inner == char:
                        break
                if chars[-1] != char:
                    self.errors.append(UnterminatedStringError(char, self.make_span(start)))
                    return
                continue
            if not self.is_separator_raw_char(char):
                break
            chars.append(self.advance())
            saw_payload_char = True
        value = "".join(chars)
        if value == "^":
            self.add_token("CARET", value, start)
            return
        if not self.is_valid_separator_payload(value[1:]):
            self.errors.append(SyntaxError(f"Invalid separator literal: '{value}'", self.make_span(start)))
            return
        self.add_token("SEPARATOR", value, start)

    def scan_numeric_like(self, start: Position, first: str) -> None:
        value = first
        has_error = False
        starts_with_leading_dot = value in {".", "-.", "+."}

        def scan_digits_with_underscores(allow_underscores: bool) -> bool:
            nonlocal value, has_error
            last_was_underscore = False
            scanned_any = False
            while self.peek().isdigit() or self.peek() == "_":
                if self.peek() == "_":
                    if not allow_underscores:
                        value += self.advance()
                        has_error = True
                        continue
                    last_char = value[-1] if value else ""
                    if last_was_underscore or not last_char.isdigit():
                        value += self.advance()
                        has_error = True
                        continue
                    last_was_underscore = True
                else:
                    last_was_underscore = False
                value += self.advance()
                scanned_any = True
            if last_was_underscore:
                has_error = True
            return scanned_any or not last_was_underscore

        scan_digits_with_underscores(True)

        if (
            not has_error
            and not starts_with_leading_dot
            and first not in {"+", "-"}
            and self.peek() == ":"
            and "_" not in value
        ):
            self.scan_time(start, value)
            return

        if not has_error and not starts_with_leading_dot and self.peek() == "-" and len(value) == 4 and "_" not in value:
            self.scan_date_or_datetime(start, value)
            return

        if not has_error and not starts_with_leading_dot and self.peek() == "-" and self.peek_next().isdigit() and "_" not in value:
            while not self.is_at_end():
                char = self.peek()
                if char in {" ", "\t", "\n", "\r", ",", "]", ")", "}"}:
                    break
                value += self.advance()
            self.errors.append(InvalidNumberError(value, self.make_span(start)))
            return

        if not starts_with_leading_dot and self.peek() == ".":
            next_char = self.peek_next()
            if next_char == "_":
                value += self.advance()
                value += self.advance()
                has_error = True
                scan_digits_with_underscores(True)
            elif next_char.isdigit():
                value += self.advance()
                scan_digits_with_underscores(True)

        if self.peek() in {"e", "E"}:
            value += self.advance()
            if self.peek() in {"+", "-"}:
                value += self.advance()
            if self.peek() == "_":
                value += self.advance()
                has_error = True
                scan_digits_with_underscores(True)
            elif self.peek().isdigit():
                scan_digits_with_underscores(True)
            else:
                has_error = True

        if has_error:
            self.errors.append(InvalidNumberError(value, self.make_span(start)))
            return

        if starts_with_leading_dot and not re.search(r"\.\d", value):
            self.errors.append(InvalidNumberError(value, self.make_span(start)))
            return

        normalized = value.replace("_", "")
        unsigned = normalized[1:] if normalized.startswith(("+", "-")) else normalized
        if len(unsigned) > 1 and unsigned.startswith("0") and not unsigned.startswith(("0.", "0e", "0E")):
            self.errors.append(InvalidNumberError(value, self.make_span(start)))
            return

        self.add_token("NUMBER", value, start)

    def scan_time(self, start: Position, hours: str) -> None:
        value = hours
        while self.peek().isdigit() or self.peek() in {":", "."}:
            value += self.advance()
        if self.peek() == "Z":
            value += self.advance()
        elif self.peek() in {"+", "-"}:
            value += self.advance()
            while self.peek().isdigit() or self.peek() == ":":
                value += self.advance()
        if self.is_valid_time_literal(value):
            self.add_token("TIME", value, start)
            return
        self.errors.append(InvalidTimeError(value, self.make_span(start)))

    def scan_date_or_datetime(self, start: Position, year: str) -> None:
        value = year
        value += self.advance()
        for _ in range(2):
            if self.peek().isdigit():
                value += self.advance()
        if self.peek() == "-":
            value += self.advance()
            for _ in range(2):
                if self.peek().isdigit():
                    value += self.advance()

        if self.peek() == "T":
            value += self.advance()
            while self.peek().isdigit() or self.peek() in {":", "."}:
                value += self.advance()
            if self.peek() == "Z":
                value += self.advance()
            elif self.peek() in {"+", "-"}:
                value += self.advance()
                while self.peek().isdigit() or self.peek() == ":":
                    value += self.advance()
            if self.peek() == "&":
                value += self.advance()
                while self.peek().isalnum() or self.peek() in {"/", "_", "-", "+"}:
                    value += self.advance()
            if self.is_valid_datetime_literal(value):
                self.add_token("DATETIME", value, start)
            else:
                self.errors.append(InvalidDateTimeError(value, self.make_span(start)))
            return

        if self.is_valid_date_literal(value):
            self.add_token("DATE", value, start)
            return
        self.errors.append(InvalidDateError(value, self.make_span(start)))

    def scan_identifier(self, start: Position, first: str) -> None:
        chars = [first]
        while self.peek().isalnum() or self.peek() == "_":
            chars.append(self.advance())
        value = "".join(chars)
        self.add_token(KEYWORDS.get(value, "IDENT"), value, start)

    @staticmethod
    def valid_numeric_underscores(value: str) -> bool:
        for index, char in enumerate(value):
            if char != "_":
                continue
            if index == 0 or index == len(value) - 1:
                return False
            if not value[index - 1].isdigit() or not value[index + 1].isdigit():
                return False
        return "__" not in value

    @staticmethod
    def is_valid_date_literal(value: str) -> bool:
        if not (len(value) == 10 and value[4] == "-" and value[7] == "-" and value[:4].isdigit() and value[5:7].isdigit() and value[8:10].isdigit()):
            return False
        year = int(value[:4])
        month = int(value[5:7])
        day = int(value[8:10])
        return Lexer.is_valid_date_parts(year, month, day)

    @classmethod
    def is_valid_time_literal(cls, value: str) -> bool:
        return cls.matches_time_core(value, allow_hour_precision_marker=True) or cls.matches_zoned_time(value)

    @classmethod
    def is_valid_datetime_literal(cls, value: str) -> bool:
        if "T" not in value:
            return False
        date, rest = value.split("T", 1)
        if not cls.is_valid_date_literal(date):
            return False
        if cls.matches_datetime_time(rest) or cls.matches_datetime_zoned_time(rest):
            return True
        if "&" in rest:
            base, zone = rest.split("&", 1)
            return cls.is_valid_zrut_zone(zone) and (cls.matches_datetime_time(base) or cls.matches_datetime_zoned_time(base))
        return False

    @staticmethod
    def is_valid_zrut_zone(zone: str) -> bool:
        return (
            bool(zone)
            and not zone.startswith("/")
            and not zone.endswith("/")
            and "//" not in zone
            and "/*" not in zone
            and "/[" not in zone
        )

    @staticmethod
    def is_valid_separator_payload(payload: str) -> bool:
        if not payload:
            return False
        index = 0
        while index < len(payload):
            char = payload[index]
            if char in {'"', "'"}:
                quote = char
                index += 1
                terminated = False
                while index < len(payload):
                    inner = payload[index]
                    if inner in {"\n", "\r"}:
                        return False
                    if inner == "\\":
                        index += 2
                        continue
                    index += 1
                    if inner == quote:
                        terminated = True
                        break
                if not terminated:
                    return False
                continue
            if not Lexer.is_separator_raw_char(char):
                return False
            index += 1
        return True

    @staticmethod
    def is_separator_raw_char(char: str) -> bool:
        return bool(re.match(r"^[A-Za-z0-9!#$%&*+\-.:;=?@^_|~<>]$", char))

    @staticmethod
    def matches_time_core(value: str, allow_hour_precision_marker: bool) -> bool:
        if len(value) == 3:
            return (
                allow_hour_precision_marker
                and value[2] == ":"
                and value[:2].isdigit()
                and Lexer.is_valid_hour(int(value[:2]))
            )
        if len(value) == 5:
            return (
                value[2] == ":"
                and value[:2].isdigit()
                and value[3:5].isdigit()
                and Lexer.is_valid_hour(int(value[:2]))
                and Lexer.is_valid_minute_or_second(int(value[3:5]))
            )
        return Lexer.matches_hms(value)

    @staticmethod
    def matches_datetime_core(value: str) -> bool:
        if len(value) == 2:
            return value.isdigit()
        return Lexer.matches_time_core(value, allow_hour_precision_marker=False)

    @staticmethod
    def matches_datetime_time(value: str) -> bool:
        return Lexer.matches_datetime_core(value) or Lexer.matches_time_core(value, allow_hour_precision_marker=True)

    @staticmethod
    def matches_hms(value: str) -> bool:
        return (
            len(value) == 8
            and value[2] == ":"
            and value[5] == ":"
            and value[:2].isdigit()
            and value[3:5].isdigit()
            and value[6:8].isdigit()
            and Lexer.is_valid_hour(int(value[:2]))
            and Lexer.is_valid_minute_or_second(int(value[3:5]))
            and Lexer.is_valid_minute_or_second(int(value[6:8]))
        )

    @classmethod
    def matches_zoned_time(cls, value: str) -> bool:
        if cls.matches_time_core(value, allow_hour_precision_marker=True):
            return True
        if value.endswith("Z"):
            return cls.matches_time_core(value[:-1], allow_hour_precision_marker=True)
        for marker in ("+", "-"):
            if marker in value:
                base, offset = value.rsplit(marker, 1)
                return cls.matches_time_core(base, allow_hour_precision_marker=True) and cls.matches_offset(offset)
        return False

    @classmethod
    def matches_datetime_zoned_time(cls, value: str) -> bool:
        if value.endswith("Z"):
            return cls.matches_datetime_time(value[:-1])
        for marker in ("+", "-"):
            if marker in value:
                base, offset = value.rsplit(marker, 1)
                return cls.matches_datetime_time(base) and cls.matches_offset(offset)
        return False

    @staticmethod
    def matches_offset(value: str) -> bool:
        return (
            len(value) == 5
            and value[2] == ":"
            and value[:2].isdigit()
            and value[3:5].isdigit()
            and Lexer.is_valid_hour(int(value[:2]))
            and Lexer.is_valid_minute_or_second(int(value[3:5]))
        )

    @staticmethod
    def is_valid_date_parts(year: int, month: int, day: int) -> bool:
        if month < 1 or month > 12 or day < 1:
            return False
        days_in_month = [31, 29 if Lexer.is_leap_year(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return day <= days_in_month[month - 1]

    @staticmethod
    def is_leap_year(year: int) -> bool:
        return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

    @staticmethod
    def is_valid_hour(value: int) -> bool:
        return 0 <= value <= 23

    @staticmethod
    def is_valid_minute_or_second(value: int) -> bool:
        return 0 <= value <= 59

    @staticmethod
    def is_hex_digit(char: str) -> bool:
        return char.isdigit() or char.lower() in {"a", "b", "c", "d", "e", "f"}

    @staticmethod
    def is_encoding_char(char: str) -> bool:
        return char.isalnum() or char in {"+", "/", "=", "-", "_", "."}

    @staticmethod
    def is_encoding_start_char(char: str) -> bool:
        return char != "=" and Lexer.is_encoding_char(char)

    @staticmethod
    def is_radix_char(char: str) -> bool:
        return char.isalnum() or char in {"+", "-", ".", "_", "&", "!"}

    @staticmethod
    def is_radix_start_char(char: str) -> bool:
        return char in {"+", "-", ".", "&", "!"} or char.isalnum()

    @staticmethod
    def is_radix_digit(char: str) -> bool:
        return char.isalnum() or char in {"&", "!"}

    @staticmethod
    def is_valid_radix_payload(payload: str) -> bool:
        if not payload:
            return False
        index = 1 if payload[0] in {"+", "-"} else 0
        if index >= len(payload):
            return False
        saw_digit = False
        saw_decimal = False
        prev_was_digit = False
        saw_digit_before_decimal = False
        while index < len(payload):
            char = payload[index]
            if Lexer.is_radix_digit(char):
                saw_digit = True
                prev_was_digit = True
                if not saw_decimal:
                    saw_digit_before_decimal = True
            elif char == "_":
                if not prev_was_digit or index + 1 >= len(payload) or not Lexer.is_radix_digit(payload[index + 1]):
                    return False
                prev_was_digit = False
            elif char == ".":
                if saw_decimal or index + 1 >= len(payload) or not Lexer.is_radix_digit(payload[index + 1]):
                    return False
                if not prev_was_digit and saw_digit_before_decimal:
                    return False
                saw_decimal = True
                prev_was_digit = False
            else:
                return False
            index += 1
        return saw_digit and prev_was_digit

    @staticmethod
    def is_valid_encoding_payload(payload: str) -> bool:
        if not payload:
            return False
        if not re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", payload):
            return False
        padding_index = payload.find("=")
        return padding_index == -1 or all(char == "=" for char in payload[padding_index:])

    @staticmethod
    def has_valid_literal_underscores(raw: str) -> bool:
        body = raw[1:] if raw else ""
        return bool(body) and not body.startswith("_") and not body.endswith("_") and "__" not in body


def tokenize(source: str) -> LexResult:
    return Lexer(source).tokenize()
