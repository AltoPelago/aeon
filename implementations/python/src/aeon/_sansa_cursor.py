"""SANSA-owned synchronous step grammar shared with trusted lexical cursors.

Cursors own decoding, positions, native errors and consumption. They are local to
one parse; no registry, source reparsing, cached path or session is involved.
"""
import re

_INDEX_RE = re.compile(r"[0-9]+\Z")
MAX_POSITION_INDEX = 999_999


def validate_position_index(raw, fail, maximum=MAX_POSITION_INDEX):
    """Check original ASCII spelling and bound before converting to an integer."""
    if not _INDEX_RE.fullmatch(raw):
        fail("Expected unsigned decimal positional index", "SANSA_EXPECTED_INDEX")
    if len(raw) > 1 and raw[0] == "0":
        fail("Positional indexes must not contain leading zeroes", "SANSA_LEADING_ZERO_INDEX")
    bound = str(maximum)
    if len(raw) > len(bound) or (len(raw) == len(bound) and raw > bound):
        fail(f"Position indexes must be less than or equal to {maximum}", "SANSA_POSITION_INDEX_LIMIT_EXCEEDED")
    return int(raw)


def member(name, quoted):
    return {"type": "member", "name": name, "quoted": quoted}


def position(index):
    return {"type": "position", "index": index}


def parse_dot_selector(cursor, project_member=member, attribute_space=None):
    cursor.consume(".")
    char = cursor.peek()
    if char == "@":
        cursor.consume("@")
        # Native addresses own fresh nodes; hosts may lower this marker directly.
        return {"type": "attributeSpace"} if attribute_space is None else attribute_space
    if char == "^":
        cursor.consume("^")
        return {"type": "parent"}
    if char == "*":
        cursor.consume("*")
        if cursor.match("*"):
            return {"type": "descendantExpansion"}
        return {"type": "directExpansion"}
    if char == "[":
        cursor.consume("[")
        name = cursor.parse_quoted_payload()
        if len(name) == 0:
            cursor.fail("Quoted member names must not be empty", "SANSA_EMPTY_MEMBER_NAME")
        cursor.consume("]")
        return project_member(name, True)
    if char == "<":
        cursor.consume("<")
        name = cursor.parse_quoted_payload()
        if len(name) == 0:
            cursor.fail("Local address-space names must not be empty", "SANSA_EMPTY_LOCAL_SPACE_NAME")
        cursor.consume(">")
        return {"type": "localSpace", "name": name}
    if char == "(":
        cursor.consume("(")
        pattern = cursor.parse_quoted_payload()
        cursor.consume(")")
        return {"type": "namePattern", "pattern": pattern}
    return project_member(cursor.parse_identifier("member selector"), False)


def parse_position_selector(cursor, project_position=position):
    cursor.consume("[")
    selector_start = cursor.index
    start = cursor.parse_optional_position_index()
    if cursor.match_range_separator():
        end = cursor.parse_optional_position_index()
        if start is None and end is None:
            cursor.fail("Position ranges must include a start or end index", "SANSA_EMPTY_POSITION_RANGE", selector_start)
        cursor.consume("]")
        return {"type": "positionRange", "start": start, "end": end}
    if start is None:
        cursor.fail("Expected positional index", "SANSA_EXPECTED_INDEX")
    cursor.consume("]")
    return project_position(start)
