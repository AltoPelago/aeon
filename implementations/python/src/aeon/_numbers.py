from __future__ import annotations


def normalize_number_literal(raw: str) -> str:
    value = raw.replace("_", "").replace("E", "e")
    if value.startswith("."):
        value = f"0{value}"
    elif value.startswith("-."):
        value = value.replace("-.", "-0.", 1)
    elif value.startswith("+."):
        value = value.replace("+.", "0.", 1)
    elif value.startswith("+") and len(value) > 1 and value[1].isdigit():
        value = value[1:]

    if "e" in value:
        mantissa, exponent = value.split("e", 1)
    else:
        mantissa, exponent = value, None
    if "." in mantissa:
        integer, fraction = mantissa.split(".", 1)
        fraction = fraction.rstrip("0") or "0"
        mantissa = integer if exponent is not None and fraction == "0" else f"{integer}.{fraction}"
    if exponent is None:
        return mantissa
    if mantissa in ("0", "-0"):
        return f"{mantissa}e0"

    exponent = exponent.removeprefix("+")
    negative = exponent.startswith("-")
    digits = exponent[1:] if negative else exponent
    normalized = digits.lstrip("0") or "0"
    if normalized == "0":
        return f"{mantissa}e0"
    sign = "-" if negative else ""
    return f"{mantissa}e{sign}{normalized}"
