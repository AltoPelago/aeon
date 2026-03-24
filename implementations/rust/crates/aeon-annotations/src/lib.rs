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
    pub raw: String,
    pub span: Span,
    pub target: AnnotationTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Bindable {
    path: String,
    span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommentRecord {
    kind: String,
    form: String,
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
        .map(|comment| AnnotationRecord {
            kind: comment.kind,
            form: comment.form,
            raw: comment.raw,
            span: comment.span,
            target: resolve_target(comment.span, &bindables),
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
    if let Some(first) = lines.next() {
        if !first.starts_with("#!") {
            kept.push(first);
        }
    }
    if let Some(second) = lines.next() {
        if !(kept.is_empty() && second.starts_with("//! format:")) {
            kept.push(second);
        }
    }
    kept.extend(lines);
    kept.join("\n")
}

fn resolve_target(comment_span: Span, bindables: &[Bindable]) -> AnnotationTarget {
    if bindables.is_empty() {
        return AnnotationTarget::Unbound { reason: "no_bindable" };
    }

    let mut infix_containing = bindables
        .iter()
        .filter(|bindable| span_contains(bindable.span, comment_span))
        .collect::<Vec<_>>();
    infix_containing.sort_by_key(|bindable| span_length(bindable.span));

    for container in &infix_containing {
        let descendants = bindables
            .iter()
            .filter(|candidate| {
                candidate.path != container.path
                    && is_descendant_path(&container.path, &candidate.path)
                    && span_contains(container.span, candidate.span)
            })
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
        return AnnotationTarget::Path {
            path: hit.path.clone(),
        };
    }

    AnnotationTarget::Unbound { reason: "eof" }
}

fn resolve_nearest_by_offset<'a>(comment_span: Span, bindables: &'a [&'a Bindable]) -> Option<&'a Bindable> {
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

fn is_descendant_path(parent: &str, candidate: &str) -> bool {
    candidate.len() > parent.len()
        && (candidate.starts_with(&format!("{parent}.")) || candidate.starts_with(&format!("{parent}[")))
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
                if matches!(marker, Some('#' | '@' | '?')) {
                    scanner.bump();
                    while !scanner.is_eof() && scanner.peek() != Some('\n') {
                        scanner.bump();
                    }
                    let end = scanner.position();
                    let (kind, form) = line_kind(marker.expect("marker present"));
                    records.push(CommentRecord {
                        kind: kind.to_owned(),
                        form: form.to_owned(),
                        raw: source[start.offset..end.offset].to_owned(),
                        span: Span { start, end },
                    });
                } else {
                    while !scanner.is_eof() && scanner.peek() != Some('\n') {
                        scanner.bump();
                    }
                }
            }
            Some('/') if matches!(scanner.peek_n(1), Some('#' | '@' | '?')) => {
                let start = scanner.position();
                scanner.bump();
                let marker = scanner.bump().expect("marker present");
                let closing = marker;
                while !scanner.is_eof() {
                    if scanner.peek() == Some(closing) && scanner.peek_n(1) == Some('/') {
                        scanner.bump();
                        scanner.bump();
                        break;
                    }
                    scanner.bump();
                }
                let end = scanner.position();
                let (kind, form) = block_kind(marker);
                records.push(CommentRecord {
                    kind: kind.to_owned(),
                    form: form.to_owned(),
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

fn line_kind(marker: char) -> (&'static str, &'static str) {
    match marker {
        '#' => ("doc", "line"),
        '@' => ("annotation", "line"),
        '?' => ("hint", "line"),
        _ => ("reserved", "line"),
    }
}

fn block_kind(marker: char) -> (&'static str, &'static str) {
    match marker {
        '#' => ("doc", "block"),
        '@' => ("annotation", "block"),
        '?' => ("hint", "block"),
        _ => ("reserved", "block"),
    }
}

fn collect_bindables(source: &str) -> Vec<Bindable> {
    let mut parser = AnnotationParser::new(source);
    parser.parse_document()
}

struct AnnotationParser<'a> {
    scanner: Scanner<'a>,
}

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
        let key = self.parse_key()?;
        self.skip_type_annotation();
        self.skip_attributes();
        self.skip_trivia(false);
        if self.scanner.peek() != Some('=') {
            return None;
        }
        self.scanner.bump();
        self.skip_trivia(false);
        let path = format_path(parent_path, &key);
        let mut bindables = Vec::new();
        match self.scanner.peek()? {
            '{' => {
                let end = self.capture_object(&path, &mut bindables);
                bindables.insert(0, Bindable {
                    path,
                    span: Span { start, end },
                });
            }
            '[' => {
                let end = self.capture_sequence('[', ']', &path, &mut bindables);
                bindables.insert(0, Bindable {
                    path,
                    span: Span { start, end },
                });
            }
            '(' => {
                let end = self.capture_sequence('(', ')', &path, &mut bindables);
                bindables.insert(0, Bindable {
                    path,
                    span: Span { start, end },
                });
            }
            '<' => {
                let end = self.capture_balanced('<', '>');
                bindables.push(Bindable {
                    path,
                    span: Span { start, end },
                });
            }
            _ => {
                let end = self.capture_scalar();
                bindables.push(Bindable {
                    path,
                    span: Span { start, end },
                });
            }
        }
        Some(bindables)
    }

    fn capture_object(&mut self, parent_path: &str, bindables: &mut Vec<Bindable>) -> Position {
        self.scanner.bump();
        self.skip_trivia(true);
        while !self.scanner.is_eof() && self.scanner.peek() != Some('}') {
            if let Some(children) = self.parse_binding(parent_path) {
                bindables.extend(children);
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
                Some('{') => {
                    let end = self.capture_object(&item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                    });
                }
                Some('[') => {
                    let end = self.capture_sequence('[', ']', &item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                    });
                }
                Some('(') => {
                    let end = self.capture_sequence('(', ')', &item_path, bindables);
                    bindables.push(Bindable {
                        path: item_path.clone(),
                        span: Span { start, end },
                    });
                }
                Some(_) => {
                    let end = self.capture_scalar();
                    bindables.push(Bindable {
                        path: item_path,
                        span: Span { start, end },
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
                Some('/') if self.scanner.peek_n(1) == Some('/') || self.scanner.peek_n(1) == Some('*') => {
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
                while !self.scanner.is_eof() {
                    match self.scanner.peek() {
                        Some(ch) if matches!(ch, ' ' | '\t' | '\n' | '\r' | ',' | ']' | '}') => break,
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
                        Some(ch) if matches!(ch, ' ' | '\t' | '\n' | '\r' | ',' | ']' | '}' | ')') => break,
                        Some('/') if self.scanner.peek_n(1) == Some('/') || matches!(self.scanner.peek_n(1), Some('#' | '@' | '?')) => break,
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

    fn parse_key(&mut self) -> Option<String> {
        self.skip_trivia(false);
        match self.scanner.peek()? {
            '"' => self.scanner.read_quoted(),
            _ => {
                let start = self.scanner.index;
                while let Some(ch) = self.scanner.peek() {
                    if matches!(ch, ':' | '@' | '=' | ' ' | '\t' | '\n' | '\r' | ',' | '}' | ']') {
                        break;
                    }
                    self.scanner.bump();
                }
                if self.scanner.index == start {
                    None
                } else {
                    Some(self.scanner.source[start..self.scanner.index].to_owned())
                }
            }
        }
    }

    fn skip_type_annotation(&mut self) {
        if self.scanner.peek() != Some(':') {
            return;
        }
        self.scanner.bump();
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
                _ => {
                    self.scanner.bump();
                }
            }
        }
    }

    fn skip_attributes(&mut self) {
        while self.scanner.peek() == Some('@') {
            self.scanner.bump();
            if self.scanner.peek() != Some('{') {
                return;
            }
            self.capture_balanced('{', '}');
            self.skip_trivia(false);
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
                (Some('/'), Some('#' | '@' | '?')) => {
                    let closing = self.scanner.peek_n(1).expect("marker exists");
                    self.scanner.bump();
                    self.scanner.bump();
                    while !self.scanner.is_eof() {
                        if self.scanner.peek() == Some(closing) && self.scanner.peek_n(1) == Some('/') {
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
    if parent == "$" {
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
        assert!(matches!(records[0].target, AnnotationTarget::Path { ref path } if path == "$.a"));
    }

    #[test]
    fn binds_in_list_to_nearest_index() {
        let records = extract_annotations("a = [1, /? in-list ?/ 2]");
        assert_eq!(records.len(), 1);
        assert!(matches!(records[0].target, AnnotationTarget::Path { ref path } if path == "$.a[1]"));
    }
}
