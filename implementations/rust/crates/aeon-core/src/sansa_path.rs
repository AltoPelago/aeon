//! Shared, allocation-free spelling rules for structural SANSA path steps.
//! AEON references use these rules without admitting SANSA selectors.

pub const MAX_POSITION_INDEX: usize = 999_999;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PositionIndexError {
    InvalidSpelling,
    LeadingZero,
    LimitExceeded,
}

pub(crate) fn parse_position_index(raw: &str) -> Result<usize, PositionIndexError> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(PositionIndexError::InvalidSpelling);
    }
    if raw.len() > 1 && raw.starts_with('0') {
        return Err(PositionIndexError::LeadingZero);
    }
    // Six decimal digits bound both the grammar and arithmetic on every target.
    // Avoid parsing an unbounded host usize or allocating the limit's spelling.
    if raw.len() > 6 {
        return Err(PositionIndexError::LimitExceeded);
    }
    Ok(raw
        .bytes()
        .fold(0, |value, byte| value * 10 + usize::from(byte - b'0')))
}

/// Host decoding and diagnostics stay on the cursor; grammar never retains it.
#[derive(Clone, Copy)]
pub(crate) enum MemberContext {
    Member,
    Attribute,
    Bracket,
}

pub(crate) enum StructuralStep {
    Member {
        name: String,
        quoted: bool,
    },
    AttributeSpace,
    Position {
        index: usize,
    },
    PositionRange {
        start: Option<usize>,
        end: Option<usize>,
    },
}

pub(crate) trait StructuralCursor {
    type Error;
    fn match_syntax(&mut self, ch: char) -> bool;
    fn member(&mut self, quoted: bool, context: MemberContext) -> Result<String, Self::Error>;
    fn close_bracket(&mut self, context: MemberContext) -> Result<(), Self::Error>;
    fn optional_index(&mut self) -> Result<Option<usize>, Self::Error>;
    fn match_range(&mut self) -> bool;
    fn missing_index(&self) -> Self::Error;
    fn empty_range(&self) -> Self::Error;
}

/// The caller has consumed the dot. Extensions are dispatched by the host
/// before entering this structural-only routine.
#[inline]
pub(crate) fn parse_dot_step<C: StructuralCursor>(
    cursor: &mut C,
) -> Result<StructuralStep, C::Error> {
    if cursor.match_syntax('@') {
        return Ok(StructuralStep::AttributeSpace);
    }
    parse_member_step(cursor, MemberContext::Member)
}

#[inline]
pub(crate) fn parse_member_step<C: StructuralCursor>(
    cursor: &mut C,
    context: MemberContext,
) -> Result<StructuralStep, C::Error> {
    let quoted = cursor.match_syntax('[');
    let name = cursor.member(quoted, context)?;
    if quoted {
        cursor.close_bracket(context)?;
    }
    Ok(StructuralStep::Member { name, quoted })
}

/// The caller has consumed '['; quoted native aliases are dispatched first.
#[inline]
pub(crate) fn parse_position_step<C: StructuralCursor>(
    cursor: &mut C,
) -> Result<StructuralStep, C::Error> {
    let start = cursor.optional_index()?;
    if cursor.match_range() {
        let end = cursor.optional_index()?;
        if start.is_none() && end.is_none() {
            return Err(cursor.empty_range());
        }
        cursor.close_bracket(MemberContext::Bracket)?;
        return Ok(StructuralStep::PositionRange { start, end });
    }
    let index = start.ok_or_else(|| cursor.missing_index())?;
    cursor.close_bracket(MemberContext::Bracket)?;
    Ok(StructuralStep::Position { index })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positional_index_spellings_follow_sansa_on_all_word_sizes() {
        for (raw, expected) in [("0", 0), ("1", 1), ("999999", MAX_POSITION_INDEX)] {
            assert_eq!(parse_position_index(raw), Ok(expected));
        }
        for raw in ["", "+1", "-0", "1_0", "1.0", "1e2", "0x10", "١"] {
            assert_eq!(
                parse_position_index(raw),
                Err(PositionIndexError::InvalidSpelling)
            );
        }
        for raw in ["00", "01", "0000000"] {
            assert_eq!(
                parse_position_index(raw),
                Err(PositionIndexError::LeadingZero)
            );
        }
        for raw in ["1000000", "18446744073709551615", "18446744073709551616"] {
            assert_eq!(
                parse_position_index(raw),
                Err(PositionIndexError::LimitExceeded)
            );
        }
    }
}
