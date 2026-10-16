//! Exact radix metadata interpretation; this does not activate GP validation.

use aes_telex::{ClarifierKind, DatatypeClarifier};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RadixBaseResolution {
    Unspecified,
    Invalid,
    Base(usize),
}

impl RadixBaseResolution {
    #[must_use]
    pub fn base(self) -> Option<usize> {
        match self {
            Self::Base(base) => Some(base),
            Self::Unspecified | Self::Invalid => None,
        }
    }
}

/// Resolve a finite number spelling to an exact integral radix in 2..=64.
/// Work is linear in the input length, never in the represented exponent.
#[must_use]
pub fn radix_base_from_number(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut cursor = usize::from(bytes.first() == Some(&b'+'));
    let start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    let integer = &value[start..cursor];
    if integer.len() > 1 && integer.starts_with('0') {
        return None;
    }
    let mut fraction = "";
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        fraction = &value[start..cursor];
        if fraction.is_empty() {
            return None;
        }
    }
    if integer.is_empty() && fraction.is_empty() {
        return None;
    }
    let mut exponent = 0_i128;
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        let negative = bytes.get(cursor) == Some(&b'-');
        if negative || bytes.get(cursor) == Some(&b'+') {
            cursor += 1;
        }
        let start = cursor;
        while let Some(digit) = bytes.get(cursor).filter(|digit| digit.is_ascii_digit()) {
            exponent = (exponent * 10 + i128::from(*digit - b'0')).min(value.len() as i128 + 2);
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
        if negative {
            exponent = -exponent;
        }
    }
    if cursor != bytes.len() {
        return None;
    }
    let digits = format!("{integer}{fraction}");
    let significant = digits.trim_start_matches('0').trim_end_matches('0');
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    let width = significant.len();
    let shift = exponent - fraction.len() as i128 + trailing as i128;
    if !(1..=2).contains(&width) || shift < 0 || width as i128 + shift > 2 {
        return None;
    }
    let base = significant.parse::<usize>().ok()? * if shift == 1 { 10 } else { 1 };
    (2..=64).contains(&base).then_some(base)
}

#[must_use]
pub fn resolve_radix_base_from_datatype(datatype: Option<&str>) -> RadixBaseResolution {
    let Some(datatype) = datatype else {
        return RadixBaseResolution::Unspecified;
    };
    // Datatype names are case-sensitive: Radix and Decimal are custom names.
    let datatype = datatype.trim();
    let alias = match datatype {
        "decimal" => Some(10),
        "radix2" => Some(2),
        "radix6" => Some(6),
        "radix8" => Some(8),
        "radix12" => Some(12),
        _ => None,
    };
    if let Some(base) = alias {
        return RadixBaseResolution::Base(base);
    }
    let Some(body) = datatype.strip_prefix("radix[") else {
        return RadixBaseResolution::Unspecified;
    };
    body.strip_suffix(']')
        .and_then(|number| radix_base_from_number(number.trim()))
        .map_or(RadixBaseResolution::Invalid, RadixBaseResolution::Base)
}

#[must_use]
pub fn resolve_radix_base_from_components(
    datatype: Option<&str>,
    clarifiers: &[DatatypeClarifier],
) -> RadixBaseResolution {
    if datatype != Some("radix") {
        return resolve_radix_base_from_datatype(datatype);
    }
    if clarifiers.is_empty() {
        return RadixBaseResolution::Unspecified;
    }
    if let [
        DatatypeClarifier {
            kind: ClarifierKind::NumberLiteral,
            value,
        },
    ] = clarifiers
    {
        return radix_base_from_number(value)
            .map_or(RadixBaseResolution::Invalid, RadixBaseResolution::Base);
    }
    RadixBaseResolution::Invalid
}
