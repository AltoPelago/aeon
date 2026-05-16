use aeon_core::{Position, Span};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnnotationTarget {
    Path { path: String },
    Unbound { reason: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationRecord {
    pub kind: String,
    pub form: String,
    pub subtype: Option<String>,
    pub raw: String,
    pub span: Span,
    pub target: AnnotationTarget,
    pub placement: Option<AnnotationPlacement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationPlacement {
    pub after: Option<AnnotationPlacementPart>,
    pub before: Option<AnnotationPlacementPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnotationPlacementPart {
    Key,
    Attributes,
    DatatypeColon,
    Datatype,
    Equals,
    Value,
}

impl AnnotationPlacementPart {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Key => "key",
            Self::Attributes => "attributes",
            Self::DatatypeColon => "datatype-colon",
            Self::Datatype => "datatype",
            Self::Equals => "equals",
            Self::Value => "value",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Bindable {
    path: String,
    span: Span,
    landmarks: Vec<PlacementLandmark>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlacementLandmark {
    part: AnnotationPlacementPart,
    span: Span,
}

struct DatatypeSpan {
    start: Position,
    colon_end: Position,
    datatype_start: Position,
    end: Position,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommentRecord {
    kind: String,
    form: String,
    subtype: Option<String>,
    raw: String,
    span: Span,
}

#[must_use]
pub fn extract_annotations(source: &str) -> Vec<AnnotationRecord> {
    let source = strip_preamble_and_bom(source);
    let bindables = collect_bindables(&source);
    let comments = scan_structured_comments(&source);
    comments
        .into_iter()
        .map(|comment| {
            let target = resolve_target(comment.span, &bindables);
            let placement = resolve_placement(comment.span, &target, &bindables);
            AnnotationRecord {
                kind: comment.kind,
                form: comment.form,
                subtype: comment.subtype,
                raw: comment.raw,
                span: comment.span,
                target,
                placement,
            }
        })
        .collect()
}

#[must_use]
pub fn sort_annotations(mut records: Vec<AnnotationRecord>) -> Vec<AnnotationRecord> {
    records.sort_by(|left, right| {
        (
            left.span.start.offset,
            left.span.end.offset,
            &left.kind,
            &left.form,
            &left.raw,
        )
            .cmp(&(
                right.span.start.offset,
                right.span.end.offset,
                &right.kind,
                &right.form,
                &right.raw,
            ))
    });
    records
}

fn strip_preamble_and_bom(source: &str) -> String {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut lines = source.lines();
    let mut kept = Vec::new();
    if let Some(first) = lines.next()
        && !first.starts_with("#!")
    {
        kept.push(first);
    }
    if let Some(second) = lines.next()
        && !(kept.is_empty() && second.starts_with("//! format:"))
    {
        kept.push(second);
    }
    kept.extend(lines);
    kept.join("\n")
}

fn resolve_target(comment_span: Span, bindables: &[Bindable]) -> AnnotationTarget {
    if bindables.is_empty() {
        return AnnotationTarget::Unbound {
            reason: "no_bindable",
        };
    }

    let mut infix_containing = bindables
        .iter()
        .filter(|bindable| span_contains(bindable.span, comment_span))
        .collect::<Vec<_>>();
    infix_containing.sort_by_key(|bindable| span_length(bindable.span));

    for container in &infix_containing {
        let descendants = bindables
            .iter()
            .filter(|candidate| bindable_descends_from(container, candidate))
            .collect::<Vec<_>>();
        if let Some(nearest) = resolve_nearest_by_offset(comment_span, &descendants) {
            return AnnotationTarget::Path {
                path: nearest.path.clone(),
            };
        }
    }

    if let Some(container) = infix_containing.first() {
        return AnnotationTarget::Path {
            path: container.path.clone(),
        };
    }

    let mut trailing = bindables
        .iter()
        .filter(|bindable| {
            bindable.span.end.line == comment_span.start.line
                && bindable.span.end.offset <= comment_span.start.offset
        })
        .collect::<Vec<_>>();
    trailing.sort_by_key(|bindable| usize::MAX - bindable.span.end.offset);
    if let Some(hit) = trailing.first() {
        return AnnotationTarget::Path {
            path: hit.path.clone(),
        };
    }

    let mut forward = bindables
        .iter()
        .filter(|bindable| bindable.span.start.offset >= comment_span.end.offset)
        .collect::<Vec<_>>();
    forward.sort_by_key(|bindable| bindable.span.start.offset);
    if let Some(hit) = forward.first() {
        if hit.path == "$.[\"aeon:header\"]" {
            let descendants = bindables
                .iter()
                .filter(|candidate| bindable_descends_from(hit, candidate))
                .collect::<Vec<_>>();
            if let Some(descendant) = resolve_nearest_by_offset(comment_span, &descendants) {
                return AnnotationTarget::Path {
                    path: descendant.path.clone(),
                };
            }
        }
        return AnnotationTarget::Path {
            path: hit.path.clone(),
        };
    }

    AnnotationTarget::Unbound { reason: "eof" }
}

fn resolve_nearest_by_offset<'a>(
    comment_span: Span,
    bindables: &'a [&'a Bindable],
) -> Option<&'a Bindable> {
    let containing = bindables
        .iter()
        .filter(|bindable| span_contains(bindable.span, comment_span))
        .min_by_key(|bindable| span_length(bindable.span))
        .copied();
    if containing.is_some() {
        return containing;
    }

    let trailing = bindables
        .iter()
        .filter(|bindable| bindable.span.end.offset <= comment_span.start.offset)
        .max_by_key(|bindable| bindable.span.end.offset)
        .copied();
    let forward = bindables
        .iter()
        .filter(|bindable| bindable.span.start.offset >= comment_span.end.offset)
        .min_by_key(|bindable| bindable.span.start.offset)
        .copied();
    match (trailing, forward) {
        (Some(left), Some(right)) => {
            let left_distance = comment_span.start.offset - left.span.end.offset;
            let right_distance = right.span.start.offset - comment_span.end.offset;
            if right_distance <= left_distance {
                Some(right)
            } else {
                Some(left)
            }
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn span_contains(outer: Span, inner: Span) -> bool {
    outer.start.offset <= inner.start.offset && outer.end.offset >= inner.end.offset
}

fn span_length(span: Span) -> usize {
    span.end.offset.saturating_sub(span.start.offset)
}

fn resolve_placement(
    comment_span: Span,
    target: &AnnotationTarget,
    bindables: &[Bindable],
) -> Option<AnnotationPlacement> {
    let AnnotationTarget::Path { path } = target else {
        return None;
    };
    let bindable = bindables.iter().find(|candidate| &candidate.path == path)?;
    if bindable.landmarks.is_empty() {
        return None;
    }
    if bindable
        .landmarks
        .iter()
        .any(|landmark| spans_overlap(landmark.span, comment_span))
    {
        return None;
    }

    let previous = bindable
        .landmarks
        .iter()
        .filter(|landmark| landmark.span.end.offset <= comment_span.start.offset)
        .next_back();
    let next = bindable
        .landmarks
        .iter()
        .find(|landmark| landmark.span.start.offset >= comment_span.end.offset);

    if previous.is_none() && next.is_none() {
        return None;
    }

    Some(AnnotationPlacement {
        after: previous.map(|landmark| landmark.part),
        before: next.map(|landmark| landmark.part),
    })
}

fn spans_overlap(left: Span, right: Span) -> bool {
    left.start.offset < right.end.offset && right.start.offset < left.end.offset
}

fn is_descendant_path(parent: &str, candidate: &str) -> bool {
    candidate.len() > parent.len()
        && (candidate.starts_with(&format!("{parent}."))
            || candidate.starts_with(&format!("{parent}[")))
}

fn bindable_descends_from(container: &Bindable, candidate: &Bindable) -> bool {
    candidate.path != container.path
        && span_contains(container.span, candidate.span)
        && (is_descendant_path(&container.path, &candidate.path)
            || (container.path == "$.[\"aeon:header\"]"
                && candidate.path.starts_with("$.[\"aeon:")
                && candidate.path != "$.[\"aeon:header\"]"))
}

fn scan_structured_comments(source: &str) -> Vec<CommentRecord> {
    let bytes = source.as_bytes();
    let mut scanner = Scanner::new(source);
    let mut records = Vec::new();
    while !scanner.is_eof() {
        match scanner.peek() {
            Some('"') | Some('\'') | Some('`') => {
                scanner.read_string();
            }
            Some('/') if scanner.peek_n(1) == Some('/') => {
                let start = scanner.position();
                scanner.bump();
                scanner.bump();
                let marker = scanner.peek();
                if let Some(marker) = marker.filter(|candidate| is_structured_marker(*candidate)) {
                    scanner.bump();
                    while !scanner.is_eof() && scanner.peek() != Some('\n') {
                        scanner.bump();
                    }
                    let end = scanner.position();
                    let (kind, form, subtype) = line_kind(marker);
                    records.push(CommentRecord {
                        kind: kind.to_owned(),
                        form: form.to_owned(),
                        subtype: subtype.map(str::to_owned),
                        raw: source[start.offset..end.offset].to_owned(),
                        span: Span { start, end },
                    });
                } else {
                    while !scanner.is_eof() && scanner.peek() != Some('\n') {
                        scanner.bump();
                    }
                }
            }
            Some('/') if scanner.peek_n(1).is_some_and(is_structured_marker) => {
                let start = scanner.position();
                scanner.bump();
                let marker = scanner.bump().expect("marker present");
                let closing = structured_block_closer(marker);
                while !scanner.is_eof() {
                    if scanner.peek() == Some(closing) && scanner.peek_n(1) == Some('/') {
                        scanner.bump();
                        scanner.bump();
                        break;
                    }
                    scanner.bump();
                }
                let end = scanner.position();
                let (kind, form, subtype) = block_kind(marker);
                records.push(CommentRecord {
                    kind: kind.to_owned(),
                    form: form.to_owned(),
                    subtype: subtype.map(str::to_owned),
                    raw: source[start.offset..end.offset].to_owned(),
                    span: Span { start, end },
                });
            }
            Some('/') if scanner.peek_n(1) == Some('*') => {
                scanner.bump();
                scanner.bump();
                while !scanner.is_eof() {
                    if scanner.peek() == Some('*') && scanner.peek_n(1) == Some('/') {
                        scanner.bump();
                        scanner.bump();
                        break;
                    }
                    scanner.bump();
                }
            }
            _ => {
                scanner.bump();
            }
        }
    }
    let _ = bytes;
    records
}

fn is_structured_marker(marker: char) -> bool {
    matches!(marker, '#' | '@' | '?' | '{' | '[' | '(')
}

fn structured_block_closer(marker: char) -> char {
    match marker {
        '{' => '}',
        '[' => ']',
        '(' => ')',
        _ => marker,
    }
}

fn line_kind(marker: char) -> (&'static str, &'static str, Option<&'static str>) {
    match marker {
        '#' => ("doc", "line", None),
        '@' => ("annotation", "line", None),
        '?' => ("hint", "line", None),
        '{' => ("reserved", "line", Some("structure")),
        '[' => ("reserved", "line", Some("profile")),
        '(' => ("reserved", "line", Some("instructions")),
        _ => ("reserved", "line", None),
    }
}

fn block_kind(marker: char) -> (&'static str, &'static str, Option<&'static str>) {
    match marker {
        '#' => ("doc", "block", None),
        '@' => ("annotation", "block", None),
        '?' => ("hint", "block", None),
        '{' => ("reserved", "block", Some("structure")),
        '[' => ("reserved", "block", Some("profile")),
        '(' => ("reserved", "block", Some("instructions")),
        _ => ("reserved", "block", None),
    }
}

fn collect_bindables(source: &str) -> Vec<Bindable> {
    let mut parser = AnnotationParser::new(source);
    parser.parse_document()
}

struct AnnotationParser<'a> {
    scanner: Scanner<'a>,
}

const AEON_HEADER_CHILD_PARENT: &str = "$<aeon_header>";

impl<'a> AnnotationParser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            scanner: Scanner::new(source),
        }
    }

    fn parse_document(&mut self) -> Vec<Bindable> {
        let mut bindables = Vec::new();
        self.skip_trivia(true);
        while !self.scanner.is_eof() {
            if let Some(binding) = self.parse_binding("$") {
                bindables.extend(binding);
            } else {
                break;
            }
            self.skip_trivia(true);
        }
        bindables
    }

    fn parse_binding(&mut self, parent_path: &str) -> Option<Vec<Bindable>> {
        self.skip_trivia(false);
        let start = self.scanner.position();
        let (key, key_span) = self.parse_key_with_span()?;
        let mut landmarks = vec![PlacementLandmark {
            part: AnnotationPlacementPart::Key,
            span: key_span,
        }];
        self.skip_trivia(false);
        if let Some(datatype) = self.skip_type_annotation() {
            landmarks.push(PlacementLandmark {
                part: AnnotationPlacementPart::DatatypeColon,
                span: Span {
                    start: datatype.start,
                    end: datatype.colon_end,
                },
            });
            if datatype.datatype_start.offset < datatype.end.offset {
                landmarks.push(PlacementLandmark {
                    part: AnnotationPlacementPart::Datatype,
                    span: Span {
                        start: datatype.datatype_start,
                        end: datatype.end,
                    },
                });
            }
        }
        self.skip_trivia(false);
        if let Some(span) = self.skip_attributes() {
            landmarks.push(PlacementLandmark {
                part: AnnotationPlacementPart::Attributes,
                span,
            });
        }
        self.skip_trivia(false);
        if self.scanner.peek() != Some('=') {
            return None;
        }
        let equals_start = self.scanner.position();
        self.scanner.bump();
        let equals_end = self.scanner.position();
        landmarks.push(PlacementLandmark {
            part: AnnotationPlacementPart::Equals,
            span: Span {
                start: equals_start,
                end: equals_end,
            },
        });
        self.skip_trivia(false);
        let value_start = self.scanner.position();
        let path = format_path(parent_path, &key);
        let mut bindables = Vec::new();
        let end = match self.scanner.peek()? {
            '{' => {
                let child_parent_path = if parent_path == "$" && key == "aeon:header" {
                    AEON_HEADER_CHILD_PARENT
                } else {
                    &path
                };
                self.capture_object(child_parent_path, &mut bindables)
            }
            '[' => self.capture_sequence('[', ']', &path, &mut bindables),
            '(' => self.capture_sequence('(', ')', &path, &mut bindables),
            '<' => self.capture_balanced('<', '>'),
            _ => self.capture_scalar(),
        };
        landmarks.push(PlacementLandmark {
            part: AnnotationPlacementPart::Value,
            span: Span {
                start: value_start,
                end,
            },
        });
        landmarks.sort_by_key(|landmark| landmark.span.start.offset);
        bindables.insert(
            0,
            Bindable {
                path,
                span: Span { start, end },
                landmarks,
            },
        );
        Some(bindables)
    }

    fn capture_object(&mut self, parent_path: &str, bindables: &mut Vec<Bindable>) -> Position {
        self.scanner.bump();
        self.skip_trivia(true);
        while !self.scanner.is_eof() && self.scanner.peek() != Some('}') {
            let before = self.scanner.index;
            if let Some(children) = self.parse_binding(parent_path) {
                bindables.extend(children);
            } else {
                self.capture_scalar();
                if self.scanner.index == before {
                    self.scanner.bump();
                }
            }
            self.skip_trivia(true);
            if self.scanner.peek() == Some(',') {
                self.scanner.bump();
                self.skip_trivia(true);
            }
        }
        if self.scanner.peek() == Some('}') {
            self.scanner.bump();
        }
        self.scanner.position()
    }

    fn capture_sequence(
        &mut self,
        open: char,
        close: char,
        parent_path: &str,
        bindables: &mut Vec<Bindable>,
    ) -> Position {
        self.scanner.bump();
        self.skip_trivia(true);
        let mut index = 0usize;
        while !self.scanner.is_eof() && self.scanner.peek() != Some(close) {
            let start = self.scanner.position();
            let item_path = format!("{parent_path}[{index}]");
            match self.scanner.peek() {
                Some('@') | Some(':') => {
                    let end = self.capture_anonymous_headed_value(&item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path,
                        span: Span { start, end },
                        landmarks: vec![PlacementLandmark {
                            part: AnnotationPlacementPart::Value,
                            span: Span { start, end },
                        }],
                    });
                }
                Some('{') => {
                    let end = self.capture_object(&item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                        landmarks: vec![PlacementLandmark {
                            part: AnnotationPlacementPart::Value,
                            span: Span { start, end },
                        }],
                    });
                }
                Some('[') => {
                    let end = self.capture_sequence('[', ']', &item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                        landmarks: vec![PlacementLandmark {
                            part: AnnotationPlacementPart::Value,
                            span: Span { start, end },
                        }],
                    });
                }
                Some('(') => {
                    let end = self.capture_sequence('(', ')', &item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                        landmarks: vec![PlacementLandmark {
                            part: AnnotationPlacementPart::Value,
                            span: Span { start, end },
                        }],
                    });
                }
                Some(_) => {
                    let end = self.capture_scalar();
                    bindables.push(Bindable {
                        path: item_path,
                        span: Span { start, end },
                        landmarks: vec![PlacementLandmark {
                            part: AnnotationPlacementPart::Value,
                            span: Span { start, end },
                        }],
                    });
                }
                None => break,
            }
            self.skip_trivia(true);
            if self.scanner.peek() == Some(',') {
                self.scanner.bump();
                self.skip_trivia(true);
            }
            index += 1;
        }
        if self.scanner.peek() == Some(close) {
            self.scanner.bump();
        }
        let _ = open;
        self.scanner.position()
    }

    fn capture_anonymous_headed_value(
        &mut self,
        item_path: &str,
        bindables: &mut Vec<Bindable>,
    ) -> Position {
        if self.scanner.peek() == Some('@') {
            let _ = self.skip_attributes();
            self.skip_trivia(true);
        }
        if self.scanner.peek() == Some(':') {
            let _ = self.skip_type_annotation();
            self.skip_trivia(true);
        }
        if self.scanner.peek() == Some('=') {
            self.scanner.bump();
            self.skip_trivia(true);
        }
        match self.scanner.peek() {
            Some('{') => self.capture_object(item_path, bindables),
            Some('[') => self.capture_sequence('[', ']', item_path, bindables),
            Some('(') => self.capture_sequence('(', ')', item_path, bindables),
            Some('<') => self.capture_balanced('<', '>'),
            Some(_) => self.capture_scalar(),
            None => self.scanner.position(),
        }
    }

    fn capture_balanced(&mut self, open: char, close: char) -> Position {
        let mut depth = 0usize;
        while !self.scanner.is_eof() {
            match self.scanner.peek() {
                Some(ch) if ch == open => {
                    depth += 1;
                    self.scanner.bump();
                }
                Some(ch) if ch == close => {
                    self.scanner.bump();
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        break;
                    }
                }
                Some('"') | Some('\'') | Some('`') => self.scanner.read_string(),
                Some('/')
                    if self.scanner.peek_n(1) == Some('/')
                        || self.scanner.peek_n(1) == Some('*') =>
                {
                    self.skip_trivia(true);
                }
                Some(_) => {
                    self.scanner.bump();
                }
                None => break,
            }
        }
        self.scanner.position()
    }

    fn capture_scalar(&mut self) -> Position {
        match self.scanner.peek() {
            Some('"') | Some('\'') | Some('`') => self.scanner.read_string(),
            Some('~') => {
                self.scanner.bump();
                self.skip_trivia(true);
                let mut bracket_depth = 0usize;
                while !self.scanner.is_eof() {
                    match self.scanner.peek() {
                        Some('[') => {
                            bracket_depth += 1;
                            self.scanner.bump();
                        }
                        Some(']') if bracket_depth > 0 => {
                            bracket_depth = bracket_depth.saturating_sub(1);
                            self.scanner.bump();
                        }
                        Some(' ' | '\t' | '\n' | '\r' | ',' | '}' | ']') if bracket_depth == 0 => {
                            break;
                        }
                        Some('/') if self.scanner.peek_n(1) == Some('?') => {
                            self.skip_trivia(true);
                        }
                        Some(_) => {
                            self.scanner.bump();
                        }
                        None => break,
                    }
                }
            }
            Some(_) => {
                while !self.scanner.is_eof() {
                    match self.scanner.peek() {
                        Some(' ' | '\t' | '\n' | '\r' | ',' | ']' | '}' | ')') => {
                            break;
                        }
                        Some('/')
                            if self.scanner.peek_n(1) == Some('/')
                                || self.scanner.peek_n(1).is_some_and(is_structured_marker) =>
                        {
                            break;
                        }
                        Some(_) => {
                            self.scanner.bump();
                        }
                        None => break,
                    }
                }
            }
            None => {}
        }
        self.scanner.position()
    }

    fn parse_key_with_span(&mut self) -> Option<(String, Span)> {
        self.skip_trivia(false);
        let start_position = self.scanner.position();
        match self.scanner.peek()? {
            '"' => {
                let key = self.scanner.read_quoted()?;
                let end = self.scanner.position();
                Some((
                    key,
                    Span {
                        start: start_position,
                        end,
                    },
                ))
            }
            _ => {
                let start = self.scanner.index;
                if self.scanner.source[start..].starts_with("aeon:") {
                    while let Some(ch) = self.scanner.peek() {
                        if ch == '/'
                            && (self.scanner.peek_n(1).is_some_and(is_structured_marker)
                                || self.scanner.peek_n(1) == Some('/'))
                        {
                            break;
                        }
                        if matches!(ch, '@' | '=' | ' ' | '\t' | '\n' | '\r' | ',' | '}' | ']') {
                            break;
                        }
                        self.scanner.bump();
                    }
                    let end = self.scanner.position();
                    return Some((
                        self.scanner.source[start..self.scanner.index].to_owned(),
                        Span {
                            start: start_position,
                            end,
                        },
                    ));
                }
                while let Some(ch) = self.scanner.peek() {
                    if ch == '/'
                        && (self.scanner.peek_n(1).is_some_and(is_structured_marker)
                            || self.scanner.peek_n(1) == Some('/'))
                    {
                        break;
                    }
                    if matches!(
                        ch,
                        ':' | '@' | '=' | ' ' | '\t' | '\n' | '\r' | ',' | '}' | ']'
                    ) {
                        break;
                    }
                    self.scanner.bump();
                }
                if self.scanner.index == start {
                    None
                } else {
                    let end = self.scanner.position();
                    Some((
                        self.scanner.source[start..self.scanner.index].to_owned(),
                        Span {
                            start: start_position,
                            end,
                        },
                    ))
                }
            }
        }
    }

    fn skip_type_annotation(&mut self) -> Option<DatatypeSpan> {
        if self.scanner.peek() != Some(':') {
            return None;
        }
        let start = self.scanner.position();
        self.scanner.bump();
        let colon_end = self.scanner.position();
        self.skip_trivia(false);
        let datatype_start = self.scanner.position();
        let mut brackets = 0usize;
        let mut angles = 0usize;
        while let Some(ch) = self.scanner.peek() {
            match ch {
                '[' => {
                    brackets += 1;
                    self.scanner.bump();
                }
                ']' => {
                    brackets = brackets.saturating_sub(1);
                    self.scanner.bump();
                }
                '<' => {
                    angles += 1;
                    self.scanner.bump();
                }
                '>' => {
                    angles = angles.saturating_sub(1);
                    self.scanner.bump();
                }
                '@' | '=' if brackets == 0 && angles == 0 => break,
                ' ' | '\t' | '\n' | '\r' if brackets == 0 && angles == 0 => break,
                '/' if brackets == 0
                    && angles == 0
                    && (self.scanner.peek_n(1) == Some('/')
                        || self.scanner.peek_n(1) == Some('*')
                        || self.scanner.peek_n(1).is_some_and(is_structured_marker)) =>
                {
                    break;
                }
                _ => {
                    self.scanner.bump();
                }
            }
        }
        Some(DatatypeSpan {
            start,
            colon_end,
            datatype_start,
            end: self.scanner.position(),
        })
    }

    fn skip_attributes(&mut self) -> Option<Span> {
        let mut start = None;
        let mut end = None;
        while self.scanner.peek() == Some('@') {
            start.get_or_insert_with(|| self.scanner.position());
            self.scanner.bump();
            if self.scanner.peek() != Some('{') {
                end = Some(self.scanner.position());
                break;
            }
            self.capture_balanced('{', '}');
            end = Some(self.scanner.position());
            self.skip_trivia(false);
        }
        match (start, end) {
            (Some(start), Some(end)) => Some(Span { start, end }),
            _ => None,
        }
    }

    fn skip_trivia(&mut self, include_newlines: bool) {
        loop {
            let mut progressed = false;
            while let Some(ch) = self.scanner.peek() {
                if ch == ' ' || ch == '\t' || (include_newlines && (ch == '\n' || ch == '\r')) {
                    self.scanner.bump();
                    progressed = true;
                } else {
                    break;
                }
            }
            match (self.scanner.peek(), self.scanner.peek_n(1)) {
                (Some('/'), Some('/')) => {
                    while !self.scanner.is_eof() && self.scanner.peek() != Some('\n') {
                        self.scanner.bump();
                    }
                    progressed = true;
                }
                (Some('/'), Some(marker)) if is_structured_marker(marker) => {
                    let closing =
                        structured_block_closer(self.scanner.peek_n(1).expect("marker exists"));
                    self.scanner.bump();
                    self.scanner.bump();
                    while !self.scanner.is_eof() {
                        if self.scanner.peek() == Some(closing)
                            && self.scanner.peek_n(1) == Some('/')
                        {
                            self.scanner.bump();
                            self.scanner.bump();
                            break;
                        }
                        self.scanner.bump();
                    }
                    progressed = true;
                }
                (Some('/'), Some('*')) => {
                    self.scanner.bump();
                    self.scanner.bump();
                    while !self.scanner.is_eof() {
                        if self.scanner.peek() == Some('*') && self.scanner.peek_n(1) == Some('/') {
                            self.scanner.bump();
                            self.scanner.bump();
                            break;
                        }
                        self.scanner.bump();
                    }
                    progressed = true;
                }
                _ => {}
            }
            if !progressed {
                break;
            }
        }
    }
}

struct Scanner<'a> {
    source: &'a str,
    index: usize,
    line: usize,
    column: usize,
}

impl<'a> Scanner<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            index: 0,
            line: 1,
            column: 1,
        }
    }

    fn is_eof(&self) -> bool {
        self.index >= self.source.len()
    }

    fn peek(&self) -> Option<char> {
        self.source[self.index..].chars().next()
    }

    fn peek_n(&self, n: usize) -> Option<char> {
        self.source[self.index..].chars().nth(n)
    }

    fn position(&self) -> Position {
        Position {
            line: self.line,
            column: self.column,
            offset: self.index,
        }
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.index += ch.len_utf8();
        if ch == '\n' {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += 1;
        }
        Some(ch)
    }

    fn read_string(&mut self) {
        let delimiter = match self.peek() {
            Some(ch @ ('"' | '\'' | '`')) => ch,
            _ => return,
        };
        self.bump();
        while let Some(ch) = self.peek() {
            self.bump();
            if ch == '\\' && delimiter != '`' {
                let _ = self.bump();
                continue;
            }
            if ch == delimiter {
                break;
            }
            if ch == '\n' && delimiter != '`' {
                break;
            }
        }
    }

    fn read_quoted(&mut self) -> Option<String> {
        if self.peek() != Some('"') {
            return None;
        }
        self.bump();
        let mut out = String::new();
        while let Some(ch) = self.peek() {
            self.bump();
            match ch {
                '"' => return Some(out),
                '\\' => {
                    if let Some(next) = self.peek() {
                        self.bump();
                        out.push(next);
                    }
                }
                _ => out.push(ch),
            }
        }
        Some(out)
    }
}

fn format_path(parent: &str, key: &str) -> String {
    if parent == AEON_HEADER_CHILD_PARENT {
        format!("$.[\"aeon:{}\"]", escape_key(key))
    } else if parent == "$" {
        if is_identifier(key) {
            format!("$.{key}")
        } else {
            format!("$.[\"{}\"]", escape_key(key))
        }
    } else if is_identifier(key) {
        format!("{parent}.{key}")
    } else {
        format!("{parent}.[\"{}\"]", escape_key(key))
    }
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn escape_key(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_forward_doc_comment() {
        let records = extract_annotations("//# docs\na = 1");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, "doc");
        assert_eq!(records[0].subtype, None);
        assert!(matches!(records[0].target, AnnotationTarget::Path { ref path } if path == "$.a"));
    }

    #[test]
    fn binds_in_list_to_nearest_index() {
        let records = extract_annotations("a = [1, /? in-list ?/ 2]");
        assert_eq!(records.len(), 1);
        assert!(
            matches!(records[0].target, AnnotationTarget::Path { ref path } if path == "$.a[1]")
        );
    }

    #[test]
    fn binds_block_comment_between_equals_and_value_to_current_field() {
        let records = extract_annotations(
            "app:object = {\n  name:string = \"alignment playground\"\n  enabled:boolean = /# h #/ true\n  port:number = 8080\n}\n",
        );
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].target,
            AnnotationTarget::Path {
                path: String::from("$.app.enabled")
            }
        );
        assert_eq!(
            records[0].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Equals),
                before: Some(AnnotationPlacementPart::Value),
            })
        );
    }

    #[test]
    fn reports_forward_and_trailing_annotation_placement() {
        let records = extract_annotations("//# docs\na = 1 //? required\n");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].placement,
            Some(AnnotationPlacement {
                after: None,
                before: Some(AnnotationPlacementPart::Key),
            })
        );
        assert_eq!(
            records[1].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Value),
                before: None,
            })
        );
    }

    #[test]
    fn reports_binding_head_gap_annotation_placement() {
        let records = extract_annotations(
            "aname/#A#/ :string = \"alignment playground\"\n\
             bname:/#B#/ string = \"alignment playground\"\n\
             cname: string /#C#/ = \"alignment playground\"\n\
             cnameCompact:string/#CC#/= \"alignment playground\"\n\
             dname: string = /#D#/ \"alignment playground\"\n",
        );
        assert_eq!(records.len(), 5);
        assert_eq!(
            records[0].target,
            AnnotationTarget::Path {
                path: String::from("$.aname")
            }
        );
        assert_eq!(
            records[0].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Key),
                before: Some(AnnotationPlacementPart::DatatypeColon),
            })
        );
        assert_eq!(
            records[1].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::DatatypeColon),
                before: Some(AnnotationPlacementPart::Datatype),
            })
        );
        assert_eq!(
            records[2].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Datatype),
                before: Some(AnnotationPlacementPart::Equals),
            })
        );
        assert_eq!(
            records[3].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Datatype),
                before: Some(AnnotationPlacementPart::Equals),
            })
        );
        assert_eq!(
            records[4].placement,
            Some(AnnotationPlacement {
                after: Some(AnnotationPlacementPart::Equals),
                before: Some(AnnotationPlacementPart::Value),
            })
        );
    }

    #[test]
    fn captures_reserved_slash_channels_with_subtypes() {
        let records =
            extract_annotations("//{ structure\n/[ profile ]/\n/( instructions )/\na = 1");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].kind, "reserved");
        assert_eq!(records[0].subtype.as_deref(), Some("structure"));
        assert_eq!(records[1].subtype.as_deref(), Some("profile"));
        assert_eq!(records[2].subtype.as_deref(), Some("instructions"));
        assert!(records.iter().all(
            |record| matches!(record.target, AnnotationTarget::Path { ref path } if path == "$.a")
        ));
    }

    #[test]
    fn anonymous_attributed_children_do_not_hang_annotation_extraction() {
        let records = extract_annotations("width:list = [@{unit:string = \"cm\"} = 3]\n");
        assert!(records.is_empty());
    }

    #[test]
    fn malformed_object_attribute_blocks_do_not_hang_annotation_extraction() {
        let records = extract_annotations("x = { @{meta=1} k = 2 }\n");
        assert!(records.is_empty());
    }

    #[test]
    fn header_and_empty_container_comments_bind_deterministically() {
        let source = "//!/bin/aeon --profile=ts.object.v1\n\n/# Comment Stress (r5 target forms) #/\naeon:header = {\n  version = \"2.1\"\n  mode = \"transport\"\n  profile = \"ts.object.v1\"\n}\n\nemptyList:list<int32> = [ /# container fallback #/ ]\n";
        let records = extract_annotations(source);
        assert_eq!(
            records[0].target,
            AnnotationTarget::Path {
                path: String::from("$.[\"aeon:version\"]")
            }
        );
        assert!(matches!(
            records[1].target,
            AnnotationTarget::Path { ref path } if path == "$.emptyList"
        ));
    }
}
