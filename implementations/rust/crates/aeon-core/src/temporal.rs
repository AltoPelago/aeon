use crate::Value;

pub(crate) fn classify_temporal_literal(raw: &str) -> Option<Value> {
    if looks_like_datetime(raw) {
        return Some(Value::DateTimeLiteral {
            raw: String::from(raw),
        });
    }
    if looks_like_date(raw) {
        return Some(Value::DateLiteral {
            raw: String::from(raw),
        });
    }
    if looks_like_time(raw) {
        return Some(Value::TimeLiteral {
            raw: String::from(raw),
        });
    }
    None
}

pub(crate) fn invalid_temporal_literal(raw: &str) -> Option<(&'static str, String)> {
    if looks_like_datetime(raw) || looks_like_date(raw) || looks_like_time(raw) {
        return None;
    }
    if has_malformed_lowercase_datetime_marker(raw) {
        return Some(("SYNTAX_ERROR", format!("Invalid datetime literal: '{raw}'")));
    }
    if has_invalid_wtc_reference(raw) {
        return Some((
            if has_invalid_wtc_reference_punctuation(raw) {
                "SYNTAX_ERROR"
            } else {
                "INVALID_DATETIME"
            },
            format!("Invalid datetime literal: '{raw}'"),
        ));
    }
    if looks_like_datetime_candidate(raw) && !looks_like_datetime(raw) {
        return Some((
            "INVALID_DATETIME",
            format!("Invalid datetime literal: '{raw}'"),
        ));
    }
    if looks_like_date_candidate(raw) && !looks_like_date(raw) {
        return Some(("INVALID_DATE", format!("Invalid date literal: '{raw}'")));
    }
    if looks_like_time_candidate(raw) && !looks_like_time(raw) {
        return Some(("INVALID_TIME", format!("Invalid time literal: '{raw}'")));
    }
    None
}

fn looks_like_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() == 5 && bytes[4] == b'-' && bytes[..4].iter().all(u8::is_ascii_digit) {
        return value[0..4]
            .parse::<u32>()
            .is_ok_and(|year| (1..=9999).contains(&year));
    }
    if bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
    {
        return match (value[0..4].parse::<u32>(), value[5..7].parse::<u32>()) {
            (Ok(year), Ok(month)) => (1..=9999).contains(&year) && (1..=12).contains(&month),
            _ => false,
        };
    }
    looks_like_full_date(value)
}

fn looks_like_full_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit))
    {
        return false;
    }

    match (
        value[0..4].parse::<u32>().ok(),
        value[5..7].parse::<u32>().ok(),
        value[8..10].parse::<u32>().ok(),
    ) {
        (Some(year), Some(month), Some(day)) => is_valid_date_parts(year, month, day),
        _ => false,
    }
}

fn looks_like_date_candidate(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() >= 5
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || *byte == b'-')
        && bytes[5..].iter().filter(|byte| **byte == b'-').count() <= 1
    {
        return true;
    }
    let mut parts = value.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    year.len() == 4
        && (1..=2).contains(&month.len())
        && (1..=2).contains(&day.len())
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && month.bytes().all(|byte| byte.is_ascii_digit())
        && day.bytes().all(|byte| byte.is_ascii_digit())
}

fn looks_like_time(value: &str) -> bool {
    looks_like_standalone_time(value)
}

fn looks_like_datetime(value: &str) -> bool {
    if let Some((date, rest)) = value.split_once('T') {
        if !looks_like_date(date) {
            return false;
        }
        if looks_like_datetime_time(rest) || looks_like_datetime_zoned_time(rest) {
            return true;
        }
        if let Some((base, zone)) = rest.split_once('&') {
            return (looks_like_datetime_time(base) || looks_like_datetime_zoned_time(base))
                && is_valid_wtc_reference(zone);
        }
    }
    false
}

fn looks_like_datetime_candidate(value: &str) -> bool {
    if let Some((date, rest)) = value.split_once('T') {
        return looks_like_date_candidate(date)
            && !rest.is_empty()
            && rest.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b':' | b'.' | b'+' | b'-' | b'/' | b'_' | b'&')
            });
    }
    false
}

fn looks_like_standalone_time(value: &str) -> bool {
    matches_time_core(value, true) || looks_like_zoned_time(value)
}

fn looks_like_time_candidate(value: &str) -> bool {
    value.contains(':')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'+' | b'-'))
}

fn looks_like_datetime_time(value: &str) -> bool {
    matches_datetime_core(value) || matches_time_core(value, true)
}

fn looks_like_datetime_zoned_time(value: &str) -> bool {
    value
        .strip_suffix('Z')
        .is_some_and(looks_like_datetime_time)
        || value
            .rsplit_once(['+', '-'])
            .is_some_and(|(time, offset)| looks_like_datetime_time(time) && matches_offset(offset))
}

fn looks_like_zoned_time(value: &str) -> bool {
    matches_time_core(value, true)
        || value
            .strip_suffix('Z')
            .is_some_and(|time| matches_time_core(time, true))
        || value
            .rsplit_once(['+', '-'])
            .is_some_and(|(time, offset)| matches_time_core(time, true) && matches_offset(offset))
}

fn is_valid_wtc_reference(reference: &str) -> bool {
    !reference.is_empty()
        && (reference == "local" || !reference.eq_ignore_ascii_case("local"))
        && !reference.starts_with('/')
        && !reference.ends_with('/')
        && !reference.contains("//")
        && reference
            .split('/')
            .all(|segment| !segment.is_empty() && segment.chars().all(is_valid_wtc_reference_char))
}

fn is_valid_wtc_reference_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '+' | '.')
}

fn has_malformed_lowercase_datetime_marker(value: &str) -> bool {
    if let Some((date, rest)) = value.split_once('t')
        && looks_like_date_candidate(date)
        && !rest.is_empty()
    {
        return true;
    }
    if let Some((date, rest)) = value.split_once('T') {
        if !looks_like_date_candidate(date) {
            return false;
        }
        if let Some(base) = rest.strip_suffix('z') {
            return looks_like_datetime_time(base);
        }
        if let Some((base, _zone)) = rest.split_once('&')
            && let Some(time) = base.strip_suffix('z')
        {
            return looks_like_datetime_time(time);
        }
    }
    false
}

fn has_invalid_wtc_reference(value: &str) -> bool {
    let Some((date, rest)) = value.split_once('T') else {
        return false;
    };
    if !looks_like_date_candidate(date) {
        return false;
    }
    let Some((base, zone)) = rest.split_once('&') else {
        return false;
    };
    (looks_like_datetime_time(base) || looks_like_datetime_zoned_time(base))
        && !is_valid_wtc_reference(zone)
}

fn has_invalid_wtc_reference_punctuation(value: &str) -> bool {
    let Some((_date, rest)) = value.split_once('T') else {
        return false;
    };
    let Some((_base, zone)) = rest.split_once('&') else {
        return false;
    };
    zone.chars()
        .any(|ch| !matches!(ch, '/' | '_' | '-' | '+') && !ch.is_ascii_alphanumeric())
}

fn matches_time_core(value: &str, allow_hour_precision_marker: bool) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() == 3 {
        return allow_hour_precision_marker
            && bytes[2] == b':'
            && bytes[..2].iter().all(u8::is_ascii_digit)
            && value[0..2].parse::<u32>().ok().is_some_and(is_valid_hour);
    }
    if bytes.len() == 5 {
        return bytes[2] == b':'
            && bytes[..2].iter().all(u8::is_ascii_digit)
            && bytes[3..5].iter().all(u8::is_ascii_digit)
            && value[0..2].parse::<u32>().ok().is_some_and(is_valid_hour)
            && value[3..5].parse::<u32>().ok().is_some_and(is_valid_minute);
    }
    matches_hms(value)
}

fn matches_datetime_core(value: &str) -> bool {
    if value.len() == 2 {
        return value.as_bytes().iter().all(u8::is_ascii_digit);
    }
    matches_time_core(value, false)
}

fn matches_hms(value: &str) -> bool {
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) => {
            if fraction.is_empty()
                || !fraction.bytes().all(|byte| byte.is_ascii_digit())
                || fraction.contains('.')
            {
                return false;
            }
            (whole, Some(fraction))
        }
        None => (value, None),
    };
    let bytes = whole.as_bytes();
    bytes.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && bytes[..2].iter().all(u8::is_ascii_digit)
        && bytes[3..5].iter().all(u8::is_ascii_digit)
        && bytes[6..8].iter().all(u8::is_ascii_digit)
        && whole[0..2].parse::<u32>().ok().is_some_and(is_valid_hour)
        && whole[3..5].parse::<u32>().ok().is_some_and(is_valid_minute)
        && whole[6..8].parse::<u32>().ok().is_some_and(is_valid_second)
        && fraction.is_none_or(|digits| !digits.is_empty())
}

fn matches_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[..2].iter().all(u8::is_ascii_digit)
        && bytes[3..5].iter().all(u8::is_ascii_digit)
        && value[0..2].parse::<u32>().ok().is_some_and(is_valid_hour)
        && value[3..5].parse::<u32>().ok().is_some_and(is_valid_minute)
}

fn is_valid_date_parts(year: u32, month: u32, day: u32) -> bool {
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => unreachable!(),
    };
    day <= days_in_month
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn is_valid_hour(value: u32) -> bool {
    value <= 23
}

fn is_valid_minute(value: u32) -> bool {
    value <= 59
}

fn is_valid_second(value: u32) -> bool {
    value <= 60
}

#[cfg(test)]
mod tests {
    use super::classify_temporal_literal;

    #[test]
    fn accepts_wtc_with_non_empty_slash_separated_segments() {
        assert!(
            classify_temporal_literal("2025-01-01T00:00:00Z&Europe/Belgium/Brussels").is_some()
        );
    }

    #[test]
    fn rejects_wtc_with_invalid_slash_placement() {
        assert!(classify_temporal_literal("2025-01-01T00:00:00Z&/Belgium/Brussels").is_none());
        assert!(classify_temporal_literal("2025-01-01T00:00:00Z&Europe/Belgium/").is_none());
        assert!(classify_temporal_literal("2025-01-01T00:00:00Z&Belgium//Brussels").is_none());
        assert!(classify_temporal_literal("2025-01-01T00:00:00Z&/*comment*/").is_none());
    }

    #[test]
    fn rejects_temporal_literals_with_invalid_ranges() {
        assert!(classify_temporal_literal("24:00").is_none());
        assert!(classify_temporal_literal("99:99").is_none());
        assert!(classify_temporal_literal("23:59:61").is_none());
        assert!(classify_temporal_literal("09:30z").is_none());
        assert!(classify_temporal_literal("09:+24:99").is_none());
        assert!(classify_temporal_literal("2025-01-01T09z").is_none());
        assert!(classify_temporal_literal("2025-01-01T09:30z").is_none());
        assert!(classify_temporal_literal("2025-13-40").is_none());
        assert!(classify_temporal_literal("2025-02-29").is_none());
        assert!(classify_temporal_literal("2025-13-40T99:99:99").is_none());
        assert!(classify_temporal_literal("2025-02-29T09:30:00").is_none());
        assert!(classify_temporal_literal("0000-01-01").is_none());
        assert!(classify_temporal_literal("23:59:59.").is_none());
        assert!(classify_temporal_literal("23:59:59.1.2").is_none());
    }

    #[test]
    fn accepts_temporal_literals_with_valid_ranges() {
        assert!(classify_temporal_literal("09:").is_some());
        assert!(classify_temporal_literal("09:30").is_some());
        assert!(classify_temporal_literal("23:59:59").is_some());
        assert!(classify_temporal_literal("23:59:60").is_some());
        assert!(classify_temporal_literal("23:59:59.340000").is_some());
        assert!(classify_temporal_literal("09:30Z").is_some());
        assert!(classify_temporal_literal("09:+02:00").is_some());
        assert!(classify_temporal_literal("09:30+02:00").is_some());
        assert!(classify_temporal_literal("2025-01-01T09Z").is_some());
        assert!(classify_temporal_literal("2025-01-01T09+02:00").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:30Z").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:30+02:00").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:+02:00").is_some());
        assert!(classify_temporal_literal("2025-01-01T09&Europe/Belgium/Brussels").is_some());
        assert!(classify_temporal_literal("2025-01-01T09Z&Europe/Belgium/Brussels").is_some());
        assert!(classify_temporal_literal("2025-01-01T09+02:00&Europe/Belgium/Brussels").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:30&Europe/Belgium/Brussels").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:30Z&Europe/Belgium/Brussels").is_some());
        assert!(
            classify_temporal_literal("2025-01-01T09:30+02:00&Europe/Belgium/Brussels").is_some()
        );
        assert!(
            classify_temporal_literal("2025-01-01T09:+02:00&Europe/Belgium/Brussels").is_some()
        );
        assert!(classify_temporal_literal("2025-01-01T09:30Z&local").is_some());
        assert!(classify_temporal_literal("2025-01-01T09:30Z&Local").is_none());
        assert!(classify_temporal_literal("2025-01-01T09:30Z&LOCAL").is_none());
        assert!(classify_temporal_literal("2024-02-29").is_some());
        assert!(classify_temporal_literal("2024-02-29T09:30:00").is_some());
        assert!(classify_temporal_literal("0001-01-01").is_some());
        assert!(classify_temporal_literal("9999-12-31").is_some());
        assert!(classify_temporal_literal("2016-12-31T23:59:60.5Z").is_some());
        assert!(classify_temporal_literal("2016-12-31T18:59:60-05:00").is_some());
        assert!(classify_temporal_literal("2017-01-01T12:59:60+13:00").is_some());
        assert!(
            classify_temporal_literal("2017-01-01T10:59:60+11:00&Australia/Melbourne").is_some()
        );
        assert!(
            classify_temporal_literal("2026-01-01T09:10:00+01:00&+/Antarctica/Elisabeth").is_some()
        );
    }
}
