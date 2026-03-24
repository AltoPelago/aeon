mod flatten;
mod header;
mod lexer;
mod pathing;
mod temporal;
mod token_parser;
mod validation;

use std::collections::BTreeMap;
use std::env;
use std::fmt;

use flatten::{flatten_document, flatten_validation_document};
use header::{extract_header_fields, lower_header, strip_preamble};
use validation::{
    build_validation_event_lookup, build_validation_indexes, validate_datatypes,
    validate_datatypes_light, validate_duplicate_canonical_paths, validate_header_typing,
    validate_reference_steps, validate_typed_mode_rules,
};
pub use header::strip_leading_bom;
pub use pathing::format_path;

pub use lexer::{
    tokenize, CommentChannel, CommentForm, CommentMetadata, LexError, LexResult, LexerOptions,
    ReservedCommentSubtype, Token, TokenKind,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn trace_compile_enabled() -> bool {
    env::var_os("AEON_TRACE_COMPILE").is_some()
}

fn trace_compile(message: impl AsRef<str>) {
    if trace_compile_enabled() {
        eprintln!("[aeon-core] {}", message.as_ref());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub line: usize,
    pub column: usize,
    pub offset: usize,
}

impl Position {
    #[must_use]
    pub const fn zero() -> Self {
        Self {
            line: 1,
            column: 1,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: Position,
    pub end: Position,
}

impl Span {
    #[must_use]
    pub const fn zero() -> Self {
        Self {
            start: Position::zero(),
            end: Position::zero(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSegment {
    Root,
    Member(String),
    Index(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalPath {
    pub segments: Vec<PathSegment>,
}

impl CanonicalPath {
    #[must_use]
    pub fn root() -> Self {
        Self {
            segments: vec![PathSegment::Root],
        }
    }

    #[must_use]
    pub fn member(&self, key: impl Into<String>) -> Self {
        let mut segments = self.segments.clone();
        segments.push(PathSegment::Member(key.into()));
        Self { segments }
    }

    #[must_use]
    pub fn index(&self, index: usize) -> Self {
        let mut segments = self.segments.clone();
        segments.push(PathSegment::Index(index));
        Self { segments }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub path: Option<String>,
    pub span: Option<Span>,
    pub phase: Option<u8>,
    pub message: String,
}

impl Diagnostic {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: None,
            span: None,
            phase: None,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn at_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatatypePolicy {
    ReservedOnly,
    AllowCustom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BehaviorMode {
    Transport,
    Strict,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompileOptions {
    pub recovery: bool,
    pub max_input_bytes: Option<usize>,
    pub max_attribute_depth: usize,
    pub max_separator_depth: usize,
    pub max_generic_depth: usize,
    pub datatype_policy: Option<DatatypePolicy>,
    pub shallow_event_values: bool,
    pub emit_binding_projections: bool,
    pub include_header: bool,
    pub include_event_annotations: bool,
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            recovery: false,
            max_input_bytes: None,
            max_attribute_depth: 1,
            max_separator_depth: 1,
            max_generic_depth: 1,
            datatype_policy: None,
            shallow_event_values: false,
            emit_binding_projections: true,
            include_header: true,
            include_event_annotations: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReferenceSegment {
    Key(String),
    Index(usize),
    Attr(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    NumberLiteral { raw: String },
    InfinityLiteral { raw: String },
    StringLiteral { value: String, is_trimtick: bool },
    SwitchLiteral { raw: String },
    BooleanLiteral { raw: String },
    HexLiteral { raw: String },
    SeparatorLiteral { raw: String },
    EncodingLiteral { raw: String },
    RadixLiteral { raw: String },
    DateLiteral { raw: String },
    DateTimeLiteral { raw: String },
    TimeLiteral { raw: String },
    NodeLiteral {
        raw: String,
        tag: String,
        attributes: Vec<BTreeMap<String, AttributeValue>>,
        datatype: Option<String>,
        children: Vec<Value>,
    },
    ListNode { items: Vec<Value> },
    TupleLiteral { items: Vec<Value> },
    ObjectNode { bindings: Vec<Binding> },
    CloneReference { segments: Vec<ReferenceSegment> },
    PointerReference { segments: Vec<ReferenceSegment> },
}

impl Value {
    #[must_use]
    pub fn value_kind(&self) -> &'static str {
        match self {
            Self::NumberLiteral { .. } => "NumberLiteral",
            Self::InfinityLiteral { .. } => "InfinityLiteral",
            Self::StringLiteral { is_trimtick, .. } => {
                if *is_trimtick {
                    "TrimtickStringLiteral"
                } else {
                    "StringLiteral"
                }
            }
            Self::SwitchLiteral { .. } => "SwitchLiteral",
            Self::BooleanLiteral { .. } => "BooleanLiteral",
            Self::HexLiteral { .. } => "HexLiteral",
            Self::SeparatorLiteral { .. } => "SeparatorLiteral",
            Self::EncodingLiteral { .. } => "EncodingLiteral",
            Self::RadixLiteral { .. } => "RadixLiteral",
            Self::DateLiteral { .. } => "DateLiteral",
            Self::DateTimeLiteral { .. } => "DateTimeLiteral",
            Self::TimeLiteral { .. } => "TimeLiteral",
            Self::NodeLiteral { .. } => "NodeLiteral",
            Self::ListNode { .. } => "ListNode",
            Self::TupleLiteral { .. } => "TupleLiteral",
            Self::ObjectNode { .. } => "ObjectNode",
            Self::CloneReference { .. } => "CloneReference",
            Self::PointerReference { .. } => "PointerReference",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttributeValue {
    pub datatype: Option<String>,
    pub value: Option<Value>,
    pub nested_attrs: BTreeMap<String, AttributeValue>,
    pub object_members: BTreeMap<String, AttributeValue>,
}

impl AttributeValue {
    #[must_use]
    pub fn leaf() -> Self {
        Self {
            datatype: None,
            value: None,
            nested_attrs: BTreeMap::new(),
            object_members: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_nested_attrs(nested_attrs: BTreeMap<String, AttributeValue>) -> Self {
        Self {
            datatype: None,
            value: None,
            nested_attrs,
            object_members: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_object_members(object_members: BTreeMap<String, AttributeValue>) -> Self {
        Self {
            datatype: None,
            value: None,
            nested_attrs: BTreeMap::new(),
            object_members,
        }
    }

    #[must_use]
    pub fn with_parts(
        datatype: Option<String>,
        value: Option<Value>,
        nested_attrs: BTreeMap<String, AttributeValue>,
        object_members: BTreeMap<String, AttributeValue>,
    ) -> Self {
        Self {
            datatype,
            value,
            nested_attrs,
            object_members,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub key: String,
    pub datatype: Option<String>,
    pub attributes: BTreeMap<String, AttributeValue>,
    pub value: Value,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentEvent {
    pub path: CanonicalPath,
    pub key: String,
    pub datatype: Option<String>,
    pub annotations: BTreeMap<String, AttributeValue>,
    pub value: Value,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingProjection {
    pub path: String,
    pub datatype: Option<String>,
    pub kind: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderFields {
    pub fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileResult {
    pub source: String,
    pub events: Vec<AssignmentEvent>,
    pub errors: Vec<Diagnostic>,
    pub bindings: Vec<BindingProjection>,
    pub header: Option<HeaderFields>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PhaseTiming {
    pub parse_ns: u128,
    pub lower_header_ns: u128,
    pub flatten_ns: u128,
    pub datatype_validation_ns: u128,
    pub reference_validation_ns: u128,
    pub mode_validation_ns: u128,
}

#[must_use]
pub fn compile(input: &str, options: CompileOptions) -> CompileResult {
    trace_compile("compile:start");
    let source = strip_leading_bom(input);
    let source = strip_preamble(&source);
    trace_compile(format!("compile:normalized bytes={}", source.len()));

    if let Some(max_bytes) = options.max_input_bytes {
        let actual_bytes = source.as_bytes().len();
        if actual_bytes > max_bytes {
            return CompileResult {
                source,
                events: Vec::new(),
                errors: vec![Diagnostic {
                    code: String::from("INPUT_SIZE_EXCEEDED"),
                    path: Some(String::from("$")),
                    span: Some(Span::zero()),
                    phase: Some(0),
                    message: format!(
                        "Input size {actual_bytes} bytes exceeds configured limit of {max_bytes} bytes"
                    ),
                }],
                bindings: Vec::new(),
                header: None,
            };
        }
    }

    match parse_document_tokens(&source) {
        Ok(bindings) => {
            trace_compile(format!("compile:parsed bindings={}", bindings.len()));
            finalize_compile(source, bindings, options)
        }
        Err(error) => {
            trace_compile(format!("compile:parse_error code={}", error.code));
            CompileResult {
            source,
            events: Vec::new(),
            errors: vec![error],
            bindings: Vec::new(),
            header: None,
        }
        }
    }
}

#[must_use]
pub fn benchmark_validation_phases(input: &str, options: CompileOptions) -> Result<PhaseTiming, Diagnostic> {
    let source = strip_preamble(&strip_leading_bom(input));
    let parse_start = std::time::Instant::now();
    let parsed = parse_document_tokens(&source)?;
    let parse_ns = parse_start.elapsed().as_nanos();

    let lower_header_start = std::time::Instant::now();
    let lowered = lower_header(parsed)?;
    let lower_header_ns = lower_header_start.elapsed().as_nanos();

    let flatten_start = std::time::Instant::now();
    let flattened = flatten_validation_document(&lowered, &CanonicalPath::root(), options.shallow_event_values);
    let mut datatype_errors = Vec::new();
    let event_lookup = build_validation_event_lookup(&flattened.events, &mut datatype_errors);
    let flatten_ns = flatten_start.elapsed().as_nanos();

    let datatype_start = std::time::Instant::now();
    validate_datatypes_light(
        &flattened.events,
        &event_lookup,
        &lowered,
        options.datatype_policy,
        options.max_separator_depth,
        options.max_generic_depth,
        &mut datatype_errors,
    );
    let datatype_validation_ns = datatype_start.elapsed().as_nanos();

    let reference_start = std::time::Instant::now();
    let mut reference_errors = Vec::new();
    validate_reference_steps(
        &flattened.reference_steps,
        &flattened.reference_targets,
        options.max_attribute_depth,
        &mut reference_errors,
    );
    let reference_validation_ns = reference_start.elapsed().as_nanos();

    let mode_start = std::time::Instant::now();
    let mut mode_errors = Vec::new();
    validate_header_typing(&lowered, &mut mode_errors);
    validate_typed_mode_rules(&lowered, &mut mode_errors);
    let mode_validation_ns = mode_start.elapsed().as_nanos();

    Ok(PhaseTiming {
        parse_ns,
        lower_header_ns,
        flatten_ns,
        datatype_validation_ns,
        reference_validation_ns,
        mode_validation_ns,
    })
}

pub fn benchmark_token_parse(input: &str) -> Result<(), Diagnostic> {
    let source = strip_preamble(&strip_leading_bom(input));
    token_parser::parse_document_from_tokens(&source).map(|_| ())
}

fn parse_document_tokens(source: &str) -> Result<Vec<Binding>, Diagnostic> {
    token_parser::parse_document_from_tokens(source)
}

fn finalize_compile(source: String, bindings: Vec<Binding>, options: CompileOptions) -> CompileResult {
    trace_compile("compile:finalize:start");
    let bindings = match lower_header(bindings) {
        Ok(bindings) => bindings,
        Err(error) => {
            trace_compile(format!("compile:lower_header_error code={}", error.code));
            return CompileResult {
                source,
                events: Vec::new(),
                errors: vec![error],
                bindings: Vec::new(),
                header: None,
            }
        }
    };
    let mut errors = Vec::new();
    let root = CanonicalPath::root();
    let validation_only = options.shallow_event_values
        && !options.emit_binding_projections
        && !options.include_header
        && !options.include_event_annotations
        && !options.recovery;
    if validation_only {
        trace_compile("compile:validation_only");
        return validate_only_compile(source, bindings, options, &root);
    }
    trace_compile("compile:flatten_document");
    let mut flattened = flatten_document(
        &bindings,
        &root,
        options.shallow_event_values,
        options.emit_binding_projections,
        options.include_event_annotations,
    );
    validate_duplicate_canonical_paths(&mut flattened, options.recovery, &mut errors);
    let indexes = build_validation_indexes(&flattened);
    let header = options
        .include_header
        .then(|| extract_header_fields(&bindings));

    validate_datatypes(
        &flattened.events,
        &flattened.rendered_event_paths,
        &indexes.event_lookup,
        &bindings,
        options.datatype_policy,
        options.max_separator_depth,
        options.max_generic_depth,
        &mut errors,
    );
    validate_reference_steps(
        &flattened.reference_steps,
        &flattened.reference_targets,
        options.max_attribute_depth,
        &mut errors,
    );
    validate_header_typing(&bindings, &mut errors);
    validate_typed_mode_rules(&bindings, &mut errors);
    trace_compile(format!(
        "compile:finalize:done events={} errors={}",
        flattened.events.len(),
        errors.len()
    ));

    if !errors.is_empty() && !options.recovery {
        return CompileResult {
            source,
            events: Vec::new(),
            errors,
            bindings: Vec::new(),
            header,
        };
    }

    CompileResult {
        source,
        events: flattened.events,
        errors,
        bindings: flattened.bindings,
        header,
    }
}

fn validate_only_compile(
    source: String,
    bindings: Vec<Binding>,
    options: CompileOptions,
    root: &CanonicalPath,
) -> CompileResult {
    trace_compile("compile:validation_only:flatten");
    let mut errors = Vec::new();
    let flattened = flatten_validation_document(&bindings, root, options.shallow_event_values);
    trace_compile(format!(
        "compile:validation_only:flattened events={} ref_steps={} ref_targets={}",
        flattened.events.len(),
        flattened.reference_steps.len(),
        flattened.reference_targets.len()
    ));
    trace_compile("compile:validation_only:event_lookup");
    let event_lookup = build_validation_event_lookup(&flattened.events, &mut errors);
    trace_compile("compile:validation_only:datatypes");
    validate_datatypes_light(
        &flattened.events,
        &event_lookup,
        &bindings,
        options.datatype_policy,
        options.max_separator_depth,
        options.max_generic_depth,
        &mut errors,
    );
    trace_compile("compile:validation_only:references");
    validate_reference_steps(
        &flattened.reference_steps,
        &flattened.reference_targets,
        options.max_attribute_depth,
        &mut errors,
    );
    trace_compile("compile:validation_only:mode");
    validate_header_typing(&bindings, &mut errors);
    validate_typed_mode_rules(&bindings, &mut errors);
    trace_compile(format!(
        "compile:validation_only:done errors={}",
        errors.len()
    ));

    CompileResult {
        source,
        events: Vec::new(),
        errors,
        bindings: Vec::new(),
        header: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_leading_bom_before_processing() {
        let result = compile("\u{feff}hello = 1", CompileOptions::default());
        assert_eq!(result.source, "hello = 1");
        assert!(result.errors.is_empty());
    }

    #[test]
    fn rejects_inputs_over_the_configured_byte_limit() {
        let result = compile(
            "hello",
            CompileOptions {
                max_input_bytes: Some(4),
                ..CompileOptions::default()
            },
        );

        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INPUT_SIZE_EXCEEDED");
    }

    #[test]
    fn formats_root_member_and_index_segments() {
        let path = CanonicalPath::root().member("users").index(0).member("full.name");
        assert_eq!(format_path(&path), "$.users[0].[\"full.name\"]");
    }

    #[test]
    fn parses_simple_binding_into_event_and_projection() {
        let result = compile("a:number = 1", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].path, "$.a");
        assert_eq!(result.bindings[0].datatype.as_deref(), Some("number"));
        assert_eq!(result.events[0].value.value_kind(), "NumberLiteral");
    }

    #[test]
    fn parses_lists_with_indexed_bindings() {
        let result = compile("a = [1]", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.bindings.len(), 2);
        assert_eq!(result.bindings[1].path, "$.a[0]");
    }

    #[test]
    fn reports_forward_reference() {
        let result = compile("b = ~a\na = 1", CompileOptions::default());
        assert_eq!(result.errors[0].code, "FORWARD_REFERENCE");
    }

    #[test]
    fn reports_self_reference_from_node_attribute() {
        let result = compile(
            "aeon:mode = \"custom\"\nwidget:node = <card@{ \"a.b\":lookup = ~$.widget }:node>\n",
            CompileOptions::default(),
        );
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "SELF_REFERENCE"));
    }

    #[test]
    fn supports_allow_custom_datatypes() {
        let result = compile(
            "color:stroke = #ff00ff",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty());
    }

    #[test]
    fn accepts_reserved_generic_list_datatypes() {
        let result = compile("items:list<int32> = [1, 2]\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 3);
    }

    #[test]
    fn strict_mode_accepts_embed_and_inline_as_reserved_encoding_aliases() {
        for datatype in ["embed", "inline"] {
            let source = format!("aeon:mode = \"strict\"\npayload:{datatype} = $QmFzZTY0IQ==\n");
            let result = compile(&source, CompileOptions::default());
            assert!(result.errors.is_empty(), "{datatype}: {:?}", result.errors);
        }
    }

    #[test]
    fn transport_mode_allows_custom_datatypes_without_explicit_override() {
        let result = compile("aeon:mode = \"transport\"\ncolor:stroke = #ff00ff\n", CompileOptions::default());
        assert!(result.errors.is_empty());
    }

    #[test]
    fn custom_mode_requires_types_and_allows_custom_datatypes() {
        let ok = compile("aeon:mode = \"custom\"\ncolor:stroke = #ff00ff\n", CompileOptions::default());
        assert!(ok.errors.is_empty());

        let fail = compile("aeon:mode = \"custom\"\ncolor = #ff00ff\n", CompileOptions::default());
        assert!(fail
            .errors
            .iter()
            .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE" && error.path.as_deref() == Some("$.color")));
    }

    #[test]
    fn typed_clone_reference_uses_target_value_kind_for_datatype_checking() {
        let result = compile("source:number = 99\ncopy:number = ~source", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
    }

    #[test]
    fn accepts_supported_number_literal_forms() {
        let result = compile(
            "a:number = -.5\nb:number = +.5\nc:number = 3e33\nd:number = 0.5e3\ne:number = 1_1_1e2_2\nf:number = 1_1_1.2_2e3_3\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn rejects_invalid_number_literal_forms() {
        let invalid_number_cases = [
            "a:number = +00.5\n",
            "a:number = -00.5\n",
            "a:number = 3_e3\n",
            "a:number = 3e3__3\n",
            "a:number = 33__3\n",
            "a:number = 3e3_\n",
        ];

        for source in invalid_number_cases {
            let result = compile(source, CompileOptions::default());
            assert!(
                result.errors.iter().any(|error| error.code == "INVALID_NUMBER"),
                "expected INVALID_NUMBER for {source:?}, got {:?}",
                result.errors
            );
        }

        let malformed_boundary_cases = ["a:number = 3e_3\n"];
        for source in malformed_boundary_cases {
            let result = compile(source, CompileOptions::default());
            assert!(!result.errors.is_empty(), "expected an error for {source:?}");
        }
    }

    #[test]
    fn rejects_invalid_temporal_literals_with_temporal_codes() {
        let cases = [
            ("a:date = 2024-13-13\n", "INVALID_DATE"),
            ("a:time = 24:00\n", "INVALID_TIME"),
            ("a:datetime = 2024-13-13T09:30:00Z\n", "INVALID_DATETIME"),
        ];

        for (source, expected_code) in cases {
            let result = compile(source, CompileOptions::default());
            assert!(
                result.errors.iter().any(|error| error.code == expected_code),
                "expected {expected_code} for {source:?}, got {:?}",
                result.errors
            );
        }
    }

    #[test]
    fn parses_pointer_references() {
        let result = compile("target = 1\nptr = ~>target\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert!(matches!(result.events[1].value, Value::PointerReference { .. }));
    }

    #[test]
    fn parses_node_literals_with_attributes() {
        let result = compile(
            "content:node = <span@{id=\"text\", class:string=\"dark\"}(\"hello\")>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        match &result.events[0].value {
            Value::NodeLiteral {
                tag,
                attributes,
                datatype,
                children,
                ..
            } => {
                assert_eq!(tag, "span");
                assert!(datatype.is_none());
                assert_eq!(attributes.len(), 1);
                assert_eq!(attributes[0]["id"].datatype, None);
                assert_eq!(attributes[0]["class"].datatype.as_deref(), Some("string"));
                assert_eq!(children.len(), 1);
            }
            value => panic!("expected node literal, got {}", value.value_kind()),
        }
    }

    #[test]
    fn skips_structured_comments_during_parse() {
        let result = compile("//# doc title\na = 1 //? inline\n/@ meta @/\nb = 2\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
        assert_eq!(format_path(&result.events[0].path), "$.a");
        assert_eq!(format_path(&result.events[1].path), "$.b");
    }

    #[test]
    fn rejects_untyped_switch_literals_in_strict_mode() {
        let result = compile(
            "aeon:mode = \"strict\"\ndebug = yes\n",
            CompileOptions::default(),
        );
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "UNTYPED_SWITCH_LITERAL" && error.path.as_deref() == Some("$.debug")));
        assert!(result.events.is_empty());
    }

    #[test]
    fn rejects_duplicate_canonical_paths_fail_closed() {
        let result = compile("a = 1\na = 2\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "DUPLICATE_CANONICAL_PATH" && error.path.as_deref() == Some("$.a")));
        assert!(result.events.is_empty());
        assert!(result.bindings.is_empty());
    }

    #[test]
    fn retains_first_duplicate_in_recovery_mode() {
        let result = compile(
            "a = 1\na = 2\n",
            CompileOptions {
                recovery: true,
                ..CompileOptions::default()
            },
        );
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "DUPLICATE_CANONICAL_PATH"));
        assert_eq!(result.events.len(), 1);
        assert_eq!(format_path(&result.events[0].path), "$.a");
    }

    #[test]
    fn rejects_mixed_structured_and_shorthand_headers() {
        let result = compile(
            "aeon:header = { profile = \"core\" }\naeon:mode = \"strict\"\na:int32 = 1\n",
            CompileOptions::default(),
        );
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "HEADER_CONFLICT"));
        assert!(result.events.is_empty());
    }

    #[test]
    fn supports_datatype_after_attribute_block() {
        let result = compile("a@{ ns = \"alto.v1\" }:int32 = 3\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].datatype.as_deref(), Some("int32"));
        assert_eq!(
            result.events[0].annotations["ns"].value,
            Some(Value::StringLiteral {
                value: String::from("alto.v1"),
                is_trimtick: false,
            })
        );
    }

    #[test]
    fn supports_single_quoted_keys_and_references() {
        let result = compile("'single\\'quote':int32 = 2\nref = ~['single\\'quote']\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
    }

    #[test]
    fn rejects_backtick_quoted_keys() {
        let result = compile("`hello`:number = 2\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "SYNTAX_ERROR" && error.message.contains("Backtick strings are not valid keys")));
    }

    #[test]
    fn rejects_duplicate_top_level_datatype_annotations() {
        let result = compile("c:number:number = 2\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "SYNTAX_ERROR" && error.message.contains("Expected `=` after key")));
    }

    #[test]
    fn rejects_multiple_bindings_in_single_datatype_slot() {
        let result = compile("c:number, b:number = 2\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "SYNTAX_ERROR" && error.message.contains("Expected `=` after key")));
    }

    #[test]
    fn rejects_reserved_comma_separator_datatypes() {
        let result = compile("badSepType2:set[,] = ^0,0,0,\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "INVALID_SEPARATOR_CHAR"));
    }

    #[test]
    fn rejects_quoted_type_names() {
        let result = compile("a:'string' = 'hello world'\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "SYNTAX_ERROR" && error.message.contains("Quoted type names are not supported")));
    }

    #[test]
    fn accepts_singleton_tuple_literals() {
        let result = compile("aa:tuple<string> = (3)\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn accepts_singleton_tuple_literals_with_trailing_comma() {
        let result = compile("aa:tuple<string> = (3,)\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn rejects_attribute_datatype_mismatches() {
        let result = compile("b@{n:string=3}:n = 3\n", CompileOptions::default());
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "DATATYPE_LITERAL_MISMATCH" && error.path.as_deref() == Some("$.b@n")));
    }

    #[test]
    fn rejects_empty_separator_literals() {
        let result = compile("blue:sep = ^\n", CompileOptions::default());
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn rejects_hex_literals_with_trailing_underscore() {
        let result = compile("blue = #FF_FF_FF_\n", CompileOptions::default());
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn supports_backtick_strings_and_multiline_node_introducers() {
        let result = compile(
            "text:string = `hello`\ncontent:node = <div(\n  <span@{id=\"text\"}:node(\n    `world`\n  )>\n)>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
        assert!(matches!(result.events[0].value, Value::StringLiteral { .. }));
        assert!(matches!(result.events[1].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn strict_mode_rejects_non_node_inline_node_head_datatypes() {
        let result = compile(
            "aeon:mode = \"strict\"\nwidget:node = <tag:contact(\"x\")>\n",
            CompileOptions::default(),
        );
        assert!(result
            .errors
            .iter()
            .any(|error| error.code == "INVALID_NODE_HEAD_DATATYPE" && error.path.as_deref() == Some("$.widget")));
    }

    #[test]
    fn strict_mode_allows_node_inline_node_head_datatype() {
        let result = compile(
            "aeon:mode = \"strict\"\nwidget:node = <tag:node(\"x\")>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn transport_mode_allows_custom_inline_node_head_datatype() {
        let result = compile(
            "aeon:mode = \"transport\"\nwidget:node = <tag:pair(\"x\", \"y\")>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn supports_escaped_backticks_in_backtick_strings() {
        let result = compile(
            "string006:string = `\\``\nstring007:string = `\\``\nstring008:string = \"'`\\\"\"\nstring009:string = '\"`'\nsrting010:string = `\"'`\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 5);
        assert_eq!(
            result.events[0].value,
            Value::StringLiteral {
                value: String::from("`"),
                is_trimtick: false,
            }
        );
        assert_eq!(
            result.events[4].value,
            Value::StringLiteral {
                value: String::from("\"'"),
                is_trimtick: false,
            }
        );
    }

    #[test]
    fn supports_trimticks_with_marker_widths_one_and_two() {
        let result = compile(
            "note1:trimtick = >`\n  one\n  two\n`\nnote2:trimtick = >>`\n\talpha\n  beta\n`\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(
            result.events[0].value,
            Value::StringLiteral {
                value: String::from("one\ntwo"),
                is_trimtick: true,
            }
        );
        assert_eq!(
            result.events[1].value,
            Value::StringLiteral {
                value: String::from("alpha\nbeta"),
                is_trimtick: true,
            }
        );
    }

    #[test]
    fn supports_comma_delimited_separator_literals() {
        let result = compile(
            "obj = { sep10:sep[.] = ^93.2.3.3, sep11:sep[x] = ^800x600, sep12:sep[-] = ^2025-01-01 }\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 4);
    }

    #[test]
    fn supports_newline_delimited_node_children_and_multiline_node_attributes() {
        let result = compile(
            "n:node = <a (\n  <title (\"hello\")>\n  <text (\"world\", {n:n = 234, m:node = <a>})>\n)>\ns:node = <span\n  @\n  {class = \"line-4\"}\n  (\"world\")\n>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
        assert!(matches!(result.events[0].value, Value::NodeLiteral { .. }));
        assert!(matches!(result.events[1].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn supports_multiline_binding_layout_around_colon_and_equals() {
        let result = compile(
            "name\n  :\n  string = \n  \"playground\"\n\norder001:node = \n<\n  aeon\n  (\n    \"hello\"\n  )\n>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
    }

    #[test]
    fn reports_unterminated_block_comment() {
        let result = compile("/? orphan eof", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "UNTERMINATED_BLOCK_COMMENT");
    }

    #[test]
    fn supports_comment_prefixed_list_elements() {
        let result = compile(
            "list = [\n  1 /# postfix #/\n  /# prefix #/ 2\n  3\n]\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 4);
        assert_eq!(format_path(&result.events[3].path), "$.list[2]");
    }

    #[test]
    fn supports_bracketed_quoted_reference_segments() {
        let result = compile(
            "obj = { \"key with space\" = { \"inner.dot\" = 7 } }\nvia = ~obj[\"key with space\"][\"inner.dot\"]\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 4);
    }

    #[test]
    fn strict_mode_accepts_temporal_and_extended_reserved_datatypes() {
        let result = compile(
            "aeon:mode = \"strict\"\n\
             d:date = 2025-12-12\n\
             t:time = 09:30:00Z\n\
             dt:datetime = 2025-01-01T09:30:00Z\n\
             z:zrut = 2025-01-01T00:00:00Z&Australia/Sydney\n\
             sep:sep[;] = ^a;b;c\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 5);
    }

    #[test]
    fn scenarios_fixture_parses_cleanly() {
        let fixture = std::fs::read_to_string(format!(
            "{}/../../../../stress-tests/full/scenarios.aeon",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read scenarios.aeon fixture");
        let result = compile(&fixture, CompileOptions::default());
        assert_eq!(result.errors.len(), 1, "{:?}", result.errors);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert!(result.errors[0]
            .message
            .contains("Invalid encoding literal"));
    }

}
