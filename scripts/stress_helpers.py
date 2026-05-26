"""Shared helpers for AEON stress scripts."""

from __future__ import annotations


def has_explicit_header(snippet: str) -> bool:
    tokens = header_prefix_tokens(snippet, limit=3)
    return tokens in (["aeon", ":", "mode"], ["aeon", ":", "header"])


def header_prefix_tokens(source: str, limit: int) -> list[str]:
    tokens: list[str] = []
    offset = 0
    while len(tokens) < limit:
        offset = skip_trivia(source, offset)
        if offset >= len(source):
            break
        char = source[offset]
        if char == ":":
            tokens.append(char)
            offset += 1
            continue
        if is_identifier_start(char):
            start = offset
            offset += 1
            while offset < len(source) and is_identifier_continue(source[offset]):
                offset += 1
            tokens.append(source[start:offset])
            continue
        break
    return tokens


def skip_trivia(source: str, offset: int) -> int:
    while offset < len(source):
        char = source[offset]
        if char.isspace():
            offset += 1
            continue
        if starts_line_comment(source, offset):
            offset = skip_line_comment(source, offset)
            continue
        if starts_block_comment(source, offset):
            offset = skip_block_comment(source, offset)
            continue
        break
    return offset


def starts_line_comment(source: str, offset: int) -> bool:
    return offset + 1 < len(source) and source[offset] == "/" and source[offset + 1] == "/"


def starts_block_comment(source: str, offset: int) -> bool:
    return (
        offset + 1 < len(source)
        and source[offset] == "/"
        and source[offset + 1] in {"#", "@", "?", "{", "[", "(", "*"}
    )


def skip_line_comment(source: str, offset: int) -> int:
    while offset < len(source) and source[offset] != "\n":
        offset += 1
    return offset


def skip_block_comment(source: str, offset: int) -> int:
    marker = source[offset + 1]
    closing = {"{": "}", "[": "]", "(": ")", "*": "*"}.get(marker, marker)
    offset += 2
    while offset + 1 < len(source):
        if source[offset] == closing and source[offset + 1] == "/":
            return offset + 2
        offset += 1
    return len(source)


def is_identifier_start(char: str) -> bool:
    return char.isalpha() or char == "_"


def is_identifier_continue(char: str) -> bool:
    return char.isalnum() or char in {"_", "-"}
