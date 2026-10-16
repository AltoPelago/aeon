"""Exact radix metadata interpretation, independent of GP activation."""
from __future__ import annotations

from typing import Mapping, Sequence

from ._compat import dataclass


@dataclass(frozen=True)
class RadixBaseResolution:
    base: int | None = None
    invalid: bool = False


def radix_base_from_number(value: str) -> int | None:
    """Resolve an integral base without floating point or exponent expansion."""
    cursor = 1 if value.startswith("+") else 0
    start = cursor
    while cursor < len(value) and "0" <= value[cursor] <= "9":
        cursor += 1
    integer = value[start:cursor]
    if len(integer) > 1 and integer[0] == "0":
        return None
    fraction = ""
    if value[cursor:cursor + 1] == ".":
        cursor += 1
        start = cursor
        while cursor < len(value) and "0" <= value[cursor] <= "9":
            cursor += 1
        fraction = value[start:cursor]
        if not fraction:
            return None
    if not integer and not fraction:
        return None
    exponent = 0
    if value[cursor:cursor + 1] in ("e", "E"):
        cursor += 1
        negative = value[cursor:cursor + 1] == "-"
        if value[cursor:cursor + 1] in ("-", "+"):
            cursor += 1
        start = cursor
        while cursor < len(value) and "0" <= value[cursor] <= "9":
            exponent = min(len(value) + 2, exponent * 10 + ord(value[cursor]) - 48)
            cursor += 1
        if cursor == start:
            return None
        if negative:
            exponent = -exponent
    if cursor != len(value):
        return None
    digits = integer + fraction
    significant = digits.lstrip("0").rstrip("0")
    trailing = len(digits) - len(digits.rstrip("0"))
    shift = exponent - len(fraction) + trailing
    if not 1 <= len(significant) <= 2 or shift < 0 or len(significant) + shift > 2:
        return None
    base = int(significant) * (10 if shift == 1 else 1)
    return base if 2 <= base <= 64 else None


def resolve_radix_base_from_datatype(datatype: str | None) -> RadixBaseResolution:
    if datatype is None:
        return RadixBaseResolution()
    normalized = datatype.strip().lower()
    aliases = {"decimal": 10, "radix2": 2, "radix6": 6, "radix8": 8, "radix12": 12}
    if normalized in aliases:
        return RadixBaseResolution(base=aliases[normalized])
    if not normalized.startswith("radix["):
        return RadixBaseResolution()
    base = radix_base_from_number(normalized[6:-1].strip()) if normalized.endswith("]") else None
    return RadixBaseResolution(base=base, invalid=base is None)


def resolve_radix_base_from_components(
    datatype: str | None, clarifiers: Sequence[Mapping[str, object]],
) -> RadixBaseResolution:
    if datatype != "radix":
        return resolve_radix_base_from_datatype(datatype)
    if not clarifiers:
        return RadixBaseResolution()
    if len(clarifiers) != 1 or clarifiers[0].get("kind") != "NumberLiteral":
        return RadixBaseResolution(invalid=True)
    value = clarifiers[0].get("value")
    base = radix_base_from_number(value) if isinstance(value, str) else None
    return RadixBaseResolution(base=base, invalid=base is None)
