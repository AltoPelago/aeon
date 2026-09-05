#![allow(clippy::result_large_err)]

mod flatten;
mod header;
mod lexer;
mod limits;
mod pathing;
mod portable;
mod resource_limits;
mod sansa;
mod temporal;
mod token_parser;
mod validation;

use std::collections::BTreeMap;
use std::env;
use std::fmt;

use flatten::{ValidationEvent, flatten_document, flatten_validation_document};
pub use header::strip_leading_bom;
use header::{extract_header_fields, lower_header, strip_preamble};
pub use pathing::format_path;
pub use portable::{PortableAesEvent, project_portable_events};
pub use sansa::{
    QualifierArgument, QualifierExpression, QualifierTerm, SANSA_MAX_POSITION_INDEX, SansaAddress,
    SansaParseError, SansaResolveBinding, SansaResolveDiagnostic, SansaResolveNamespace,
    SansaResolveOptions, SansaResolveOutput, SansaRoot, SansaSelector,
    parse_address as parse_sansa_address, resolve_address as resolve_sansa_address,
    resolve_parsed_address as resolve_parsed_sansa_address,
};
use validation::{
    build_validation_event_lookup, build_validation_indexes, validate_datatypes,
    validate_datatypes_light, validate_duplicate_canonical_paths,
    validate_duplicate_object_member_keys, validate_reference_steps, validate_typed_mode_rules,
};

pub use lexer::{
    CommentChannel, CommentForm, CommentMetadata, LexError, LexResult, LexerOptions,
    ReservedCommentSubtype, Token, TokenKind, tokenize,
};
pub use limits::{
    AEONIC_LIMITS_ID, AEONIC_LIMITS_VERSION, AeonCompileLimits, AeonFormatLimits, AeonicLimitsV1,
    LIMITS_BOOTSTRAP, LimitSetting, LimitsBootstrap, LimitsDiagnostic, ProcessingLimits,
    StructureLimits, TelexFormatLimits, TransportLimits, aeon_compile_limits, load_aeonic_limits,
};
use resource_limits::{validate_event_path_limits, validate_source_resource_limits};
use token_parser::parse_document_from_tokens_recovery;
#[cfg(test)]
use validation::datatype_has_generic_args;

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

    #[must_use]
    pub fn with_span(mut self, span: Span) -> Self {
        self.span = Some(span);
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
pub enum BehaviorMode {
    Transport,
    Strict,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileOptions {
    pub recovery: bool,
    pub max_input_bytes: Option<usize>,
    pub max_events: Option<usize>,
    pub max_attribute_depth: usize,
    /// Canonical clarifier-value limit. When absent, `max_separator_depth`
    /// remains a backwards-compatible alias.
    pub max_clarifier_values: Option<usize>,
    /// Deprecated compatibility alias; prefer `max_clarifier_values`.
    pub max_separator_depth: usize,
    pub max_generic_depth: usize,
    pub max_generic_arguments: usize,
    pub max_datatype_components: usize,
    /// Canonical logical container-depth limit. When absent,
    /// `max_nesting_depth` remains a backwards-compatible alias.
    pub max_value_nesting_depth: Option<usize>,
    /// Deprecated compatibility alias; prefer `max_value_nesting_depth`.
    pub max_nesting_depth: usize,
    pub max_path_depth: usize,
    pub max_string_codepoints: usize,
    pub max_key_segment_codepoints: usize,
    pub max_list_items: usize,
    pub max_tuple_items: usize,
    pub max_path_characters: usize,
    pub max_numeric_literal_characters: usize,
    pub max_structured_comment_characters: usize,
    pub datatype_policy: Option<DatatypePolicy>,
    pub profile: Option<String>,
    pub mode: Option<BehaviorMode>,
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
            max_events: None,
            max_attribute_depth: 1,
            max_clarifier_values: None,
            max_separator_depth: 1,
            max_generic_depth: 1,
            max_generic_arguments: 32,
            max_datatype_components: 64,
            max_value_nesting_depth: None,
            max_nesting_depth: 256,
            max_path_depth: 1024,
            max_string_codepoints: 1_048_576,
            max_key_segment_codepoints: 1024,
            max_list_items: 65_536,
            max_tuple_items: 65_536,
            max_path_characters: 8192,
            max_numeric_literal_characters: 1024,
            max_structured_comment_characters: 1_048_576,
            datatype_policy: None,
            profile: None,
            mode: None,
            shallow_event_values: false,
            emit_binding_projections: true,
            include_header: true,
            include_event_annotations: true,
        }
    }
}

impl CompileOptions {
    #[must_use]
    pub fn effective_max_clarifier_values(&self) -> usize {
        self.max_clarifier_values
            .unwrap_or(self.max_separator_depth)
    }

    #[must_use]
    pub fn effective_max_value_nesting_depth(&self) -> usize {
        self.max_value_nesting_depth
            .unwrap_or(self.max_nesting_depth)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReferenceSegment {
    Key(String),
    Index(usize),
    Attr(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NullLiteralMode {
    Reserved,
    Reason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    TypedValue {
        structural_id: Option<String>,
        datatype: Option<String>,
        attributes: BTreeMap<String, AttributeValue>,
        attribute_order: Vec<String>,
        value: Box<Value>,
    },
    NumberLiteral {
        raw: String,
    },
    InfinityLiteral {
        raw: String,
        span: Span,
    },
    NaNLiteral {
        raw: String,
        span: Span,
    },
    NullLiteral {
        mode: NullLiteralMode,
        value: String,
        raw: String,
    },
    StringLiteral {
        value: String,
        raw: String,
        delimiter: char,
        trimticks: Option<TrimtickMetadata>,
    },
    ToggleLiteral {
        raw: String,
    },
    BooleanLiteral {
        raw: String,
    },
    HexLiteral {
        raw: String,
    },
    SeparatorLiteral {
        raw: String,
    },
    EncodingLiteral {
        raw: String,
    },
    RadixLiteral {
        raw: String,
    },
    DateLiteral {
        raw: String,
    },
    DateTimeLiteral {
        raw: String,
    },
    TimeLiteral {
        raw: String,
    },
    SansaAddressLiteral {
        address: SansaAddress,
        raw: String,
        canonical: String,
    },
    NodeLiteral {
        raw: String,
        tag: String,
        structural_id: Option<String>,
        attributes: Vec<BTreeMap<String, AttributeValue>>,
        attribute_order: Vec<String>,
        datatype: Option<String>,
        children: Vec<Value>,
    },
    ListNode {
        items: Vec<Value>,
    },
    TupleLiteral {
        items: Vec<Value>,
    },
    ObjectNode {
        bindings: Vec<Binding>,
    },
    CloneReference {
        segments: Vec<ReferenceSegment>,
        span: Span,
    },
    PointerReference {
        segments: Vec<ReferenceSegment>,
        span: Span,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrimtickMetadata {
    pub marker_width: usize,
    pub raw_value: String,
}

#[must_use]
pub fn normalize_number_literal(raw: &str) -> String {
    let mut value = raw.replace('_', "").replace('E', "e");
    if value.starts_with('.') {
        value = format!("0{value}");
    }
    if value.starts_with("-.") {
        value = value.replacen("-.", "-0.", 1);
    }
    if value.starts_with("+.") {
        value = value.replacen("+.", "0.", 1);
    }
    if value.starts_with('+') && value.as_bytes().get(1).is_some_and(u8::is_ascii_digit) {
        value.remove(0);
    }

    let (mut mantissa, exponent) = match value.split_once('e') {
        Some((mantissa, exponent)) => (mantissa.to_owned(), Some(exponent.to_owned())),
        None => (value, None),
    };

    if let Some((int_part, frac_part_raw)) = mantissa.split_once('.') {
        let mut frac_part = frac_part_raw.trim_end_matches('0').to_owned();
        if frac_part.is_empty() {
            frac_part = String::from("0");
        }
        if exponent.is_some() && frac_part == "0" {
            mantissa = int_part.to_owned();
        } else {
            mantissa = format!("{int_part}.{frac_part}");
        }
    }

    match exponent {
        Some(exponent) => format!("{mantissa}e{exponent}"),
        None => mantissa,
    }
}

impl Value {
    #[must_use]
    pub fn value_kind(&self) -> &'static str {
        match self {
            Self::TypedValue { .. } => "TypedValue",
            Self::NumberLiteral { .. } => "NumberLiteral",
            Self::InfinityLiteral { .. } => "InfinityLiteral",
            Self::NaNLiteral { .. } => "NaNLiteral",
            Self::NullLiteral { .. } => "NullLiteral",
            Self::StringLiteral { trimticks, .. } => {
                if trimticks.is_some() {
                    "TrimtickStringLiteral"
                } else {
                    "StringLiteral"
                }
            }
            Self::ToggleLiteral { .. } => "ToggleLiteral",
            Self::BooleanLiteral { .. } => "BooleanLiteral",
            Self::HexLiteral { .. } => "HexLiteral",
            Self::SeparatorLiteral { .. } => "SeparatorLiteral",
            Self::EncodingLiteral { .. } => "EncodingLiteral",
            Self::RadixLiteral { .. } => "RadixLiteral",
            Self::DateLiteral { .. } => "DateLiteral",
            Self::DateTimeLiteral { raw } => {
                if raw.contains('&') {
                    "WTCDateTimeLiteral"
                } else {
                    "DateTimeLiteral"
                }
            }
            Self::TimeLiteral { .. } => "TimeLiteral",
            Self::SansaAddressLiteral { .. } => "SansaAddressLiteral",
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
    pub structural_id: Option<String>,
    pub datatype: Option<String>,
    pub value: Option<Value>,
    pub nested_attrs: BTreeMap<String, AttributeValue>,
    pub nested_attr_order: Vec<String>,
    pub object_members: BTreeMap<String, AttributeValue>,
    pub object_member_order: Vec<String>,
}

impl AttributeValue {
    #[must_use]
    pub fn leaf() -> Self {
        Self {
            structural_id: None,
            datatype: None,
            value: None,
            nested_attrs: BTreeMap::new(),
            nested_attr_order: Vec::new(),
            object_members: BTreeMap::new(),
            object_member_order: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_nested_attrs(
        nested_attrs: BTreeMap<String, AttributeValue>,
        nested_attr_order: Vec<String>,
    ) -> Self {
        Self {
            structural_id: None,
            datatype: None,
            value: None,
            nested_attrs,
            nested_attr_order,
            object_members: BTreeMap::new(),
            object_member_order: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_object_members(
        object_members: BTreeMap<String, AttributeValue>,
        object_member_order: Vec<String>,
    ) -> Self {
        Self {
            structural_id: None,
            datatype: None,
            value: None,
            nested_attrs: BTreeMap::new(),
            nested_attr_order: Vec::new(),
            object_members,
            object_member_order,
        }
    }

    #[must_use]
    pub fn with_parts(
        structural_id: Option<String>,
        datatype: Option<String>,
        value: Option<Value>,
        nested_attrs: BTreeMap<String, AttributeValue>,
        nested_attr_order: Vec<String>,
        object_members: BTreeMap<String, AttributeValue>,
        object_member_order: Vec<String>,
    ) -> Self {
        Self {
            structural_id,
            datatype,
            value,
            nested_attrs,
            nested_attr_order,
            object_members,
            object_member_order,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub key: String,
    pub structural_id: Option<String>,
    pub datatype: Option<String>,
    pub attributes: BTreeMap<String, AttributeValue>,
    pub attribute_order: Vec<String>,
    pub value: Value,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentEvent {
    pub path: CanonicalPath,
    pub key: String,
    pub structural_id: Option<String>,
    pub datatype: Option<String>,
    pub annotations: BTreeMap<String, AttributeValue>,
    pub annotation_order: Vec<String>,
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
    pub warnings: Vec<Diagnostic>,
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
    let warnings = compile_portability_warnings(&options);
    if let Some(max_bytes) = options.max_input_bytes {
        let actual_bytes = input.len();
        if actual_bytes > max_bytes {
            return CompileResult {
                source: strip_preamble(&strip_leading_bom(input)),
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
                warnings,
                bindings: Vec::new(),
                header: None,
            };
        }
    }

    let source = strip_leading_bom(input);
    let source = strip_preamble(&source);
    trace_compile(format!("compile:normalized bytes={}", source.len()));

    let parsed = parse_document_from_tokens_recovery(
        &source,
        options.effective_max_value_nesting_depth(),
        options.max_attribute_depth,
        options.effective_max_clarifier_values(),
        options.max_generic_depth,
        options.max_generic_arguments,
        options.max_datatype_components,
    );
    if !parsed.errors.is_empty() {
        return CompileResult {
            source,
            events: Vec::new(),
            errors: parsed.errors,
            warnings,
            bindings: Vec::new(),
            header: None,
        };
    }
    if let Some(error) = validate_source_resource_limits(input, &parsed.bindings, &options) {
        return CompileResult {
            source,
            events: Vec::new(),
            errors: vec![error],
            warnings,
            bindings: Vec::new(),
            header: None,
        };
    }
    trace_compile(format!("compile:parsed bindings={}", parsed.bindings.len()));
    finalize_compile(source, parsed.bindings, options)
}

pub fn benchmark_validation_phases(
    input: &str,
    options: CompileOptions,
) -> Result<PhaseTiming, Diagnostic> {
    let source = strip_preamble(&strip_leading_bom(input));
    let parse_start = std::time::Instant::now();
    let parsed = parse_document_tokens(
        &source,
        options.effective_max_value_nesting_depth(),
        options.max_attribute_depth,
        options.effective_max_clarifier_values(),
        options.max_generic_depth,
        options.max_generic_arguments,
        options.max_datatype_components,
    )?;
    let parse_ns = parse_start.elapsed().as_nanos();

    let lower_header_start = std::time::Instant::now();
    let lowered = lower_header(parsed)?;
    let lower_header_ns = lower_header_start.elapsed().as_nanos();

    let flatten_start = std::time::Instant::now();
    let flattened = flatten_validation_document(
        &lowered,
        &CanonicalPath::root(),
        options.shallow_event_values,
    );
    let mut datatype_errors = Vec::new();
    let event_lookup = build_validation_event_lookup(&flattened.events, &mut datatype_errors);
    let flatten_ns = flatten_start.elapsed().as_nanos();

    let datatype_start = std::time::Instant::now();
    validate_datatypes_light(
        &flattened.events,
        &event_lookup,
        &lowered,
        options.mode,
        options.datatype_policy,
        options.effective_max_clarifier_values(),
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
    validate_typed_mode_rules(&lowered, options.mode, &mut mode_errors);
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
    let defaults = CompileOptions::default();
    token_parser::parse_document_from_tokens(
        &source,
        defaults.effective_max_value_nesting_depth(),
        defaults.max_attribute_depth,
        defaults.effective_max_clarifier_values(),
        defaults.max_generic_depth,
        defaults.max_generic_arguments,
        defaults.max_datatype_components,
    )
    .map(|_| ())
}

fn parse_document_tokens(
    source: &str,
    max_nesting_depth: usize,
    max_attribute_depth: usize,
    max_separator_depth: usize,
    max_generic_depth: usize,
    max_generic_arguments: usize,
    max_datatype_components: usize,
) -> Result<Vec<Binding>, Diagnostic> {
    token_parser::parse_document_from_tokens(
        source,
        max_nesting_depth,
        max_attribute_depth,
        max_separator_depth,
        max_generic_depth,
        max_generic_arguments,
        max_datatype_components,
    )
}

fn finalize_compile(
    source: String,
    bindings: Vec<Binding>,
    options: CompileOptions,
) -> CompileResult {
    let warnings = compile_portability_warnings(&options);
    trace_compile("compile:finalize:start");
    let bindings = match lower_header(bindings) {
        Ok(bindings) => bindings,
        Err(error) => {
            trace_compile(format!("compile:lower_header_error code={}", error.code));
            return CompileResult {
                source,
                events: Vec::new(),
                errors: vec![error],
                warnings,
                bindings: Vec::new(),
                header: None,
            };
        }
    };
    let mut errors = Vec::new();
    let root = CanonicalPath::root();
    validate_duplicate_object_member_keys(&bindings, &mut errors);
    let validation_only = options.shallow_event_values
        && !options.emit_binding_projections
        && !options.include_header
        && !options.include_event_annotations
        && !options.recovery;
    if validation_only {
        trace_compile("compile:validation_only");
        return validate_only_compile(source, bindings, options, &root, warnings);
    }
    trace_compile("compile:flatten_document");
    let mut flattened = flatten_document(
        &bindings,
        &root,
        options.shallow_event_values,
        options.emit_binding_projections,
        options.include_event_annotations,
    );
    if let Some(error) = validate_event_path_limits(&flattened.events, &options) {
        errors.push(error);
    }
    if let Some(max_events) = options.max_events {
        if flattened.events.len() > max_events {
            return CompileResult {
                source,
                events: Vec::new(),
                errors: vec![event_count_exceeded_error(
                    flattened.events.len(),
                    max_events,
                )],
                warnings,
                bindings: Vec::new(),
                header: options
                    .include_header
                    .then(|| extract_header_fields(&bindings)),
            };
        }
    }
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
        options.mode,
        options.datatype_policy,
        options.effective_max_clarifier_values(),
        options.max_generic_depth,
        &mut errors,
    );
    if uses_gp_profile(options.profile.as_deref(), &bindings) {
        validate_gp_datatype_clarifiers(
            &flattened.events,
            &flattened.rendered_event_paths,
            &mut errors,
        );
    }
    validate_reference_steps(
        &flattened.reference_steps,
        &flattened.reference_targets,
        options.max_attribute_depth,
        &mut errors,
    );
    validate_typed_mode_rules(&bindings, options.mode, &mut errors);
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
            warnings,
            bindings: Vec::new(),
            header,
        };
    }

    CompileResult {
        source,
        events: flattened.events,
        errors,
        warnings,
        bindings: flattened.bindings,
        header,
    }
}

fn validate_only_compile(
    source: String,
    bindings: Vec<Binding>,
    options: CompileOptions,
    root: &CanonicalPath,
    warnings: Vec<Diagnostic>,
) -> CompileResult {
    trace_compile("compile:validation_only:flatten");
    let mut errors = Vec::new();
    validate_duplicate_object_member_keys(&bindings, &mut errors);
    let flattened = flatten_validation_document(&bindings, root, options.shallow_event_values);
    if let Some(max_events) = options.max_events {
        if flattened.events.len() > max_events {
            return CompileResult {
                source,
                events: Vec::new(),
                errors: vec![event_count_exceeded_error(
                    flattened.events.len(),
                    max_events,
                )],
                warnings,
                bindings: Vec::new(),
                header: None,
            };
        }
    }
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
        options.mode,
        options.datatype_policy,
        options.effective_max_clarifier_values(),
        options.max_generic_depth,
        &mut errors,
    );
    if uses_gp_profile(options.profile.as_deref(), &bindings) {
        validate_gp_validation_datatype_clarifiers(&flattened.events, &mut errors);
    }
    trace_compile("compile:validation_only:references");
    validate_reference_steps(
        &flattened.reference_steps,
        &flattened.reference_targets,
        options.max_attribute_depth,
        &mut errors,
    );
    trace_compile("compile:validation_only:mode");
    validate_typed_mode_rules(&bindings, options.mode, &mut errors);
    trace_compile(format!(
        "compile:validation_only:done errors={}",
        errors.len()
    ));

    CompileResult {
        source,
        events: Vec::new(),
        errors,
        warnings,
        bindings: Vec::new(),
        header: None,
    }
}

const AEON_GP_PROFILE_ID: &str = "aeon.gp.profile.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GpDatatypeClarifierRule {
    None,
    RadixBase,
    SeparatorChars,
    EncodingName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GpClarifierValue {
    String,
    Number(String),
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GpDatatypeSurface {
    name: String,
    args: Vec<GpDatatypeSurface>,
    clarifiers: Option<Vec<GpClarifierValue>>,
}

fn uses_gp_profile(option_profile: Option<&str>, bindings: &[Binding]) -> bool {
    if option_profile == Some(AEON_GP_PROFILE_ID) {
        return true;
    }
    bindings.iter().any(|binding| {
        binding.key == "aeon:profile"
            && matches!(
                &binding.value,
                Value::StringLiteral { value, .. } if value == AEON_GP_PROFILE_ID
            )
    })
}

fn validate_gp_datatype_clarifiers(
    events: &[AssignmentEvent],
    rendered_paths: &[String],
    errors: &mut Vec<Diagnostic>,
) {
    for (index, event) in events.iter().enumerate() {
        let Some(datatype) = event.datatype.as_deref() else {
            continue;
        };
        let Some(surface) = parse_gp_datatype_surface(datatype) else {
            continue;
        };
        let rendered_path = rendered_paths
            .get(index)
            .cloned()
            .unwrap_or_else(|| format_path(&event.path));
        validate_gp_datatype_surface(&surface, &rendered_path, event.span, errors);
    }
}

fn validate_gp_validation_datatype_clarifiers(
    events: &[ValidationEvent],
    errors: &mut Vec<Diagnostic>,
) {
    for event in events {
        let Some(datatype) = event.datatype.as_deref() else {
            continue;
        };
        let Some(surface) = parse_gp_datatype_surface(datatype) else {
            continue;
        };
        validate_gp_datatype_surface(&surface, &event.path, event.span, errors);
    }
}

fn validate_gp_datatype_surface(
    datatype: &GpDatatypeSurface,
    rendered_path: &str,
    span: Span,
    errors: &mut Vec<Diagnostic>,
) {
    if let Some(clarifiers) = &datatype.clarifiers {
        match gp_datatype_clarifier_rule(&datatype.name) {
            Some(GpDatatypeClarifierRule::RadixBase) => {
                if !valid_radix_base_clarifiers(clarifiers) {
                    errors.push(
                        Diagnostic::new(
                            "PROFILE_DATATYPE_CLARIFIER_INVALID",
                            format!(
                                "Profile datatype ':{}' expects exactly one integral radix-base clarifier from 2 to 64",
                                datatype.name
                            ),
                        )
                        .at_path(rendered_path)
                        .with_span(span),
                    );
                }
            }
            Some(GpDatatypeClarifierRule::SeparatorChars) => {
                if clarifiers.is_empty()
                    || clarifiers
                        .iter()
                        .any(|value| !matches!(value, GpClarifierValue::String))
                {
                    errors.push(
                        Diagnostic::new(
                            "PROFILE_DATATYPE_CLARIFIER_INVALID",
                            format!(
                                "Profile datatype ':{}' expects string separator-character clarifiers",
                                datatype.name
                            ),
                        )
                        .at_path(rendered_path)
                        .with_span(span),
                    );
                }
            }
            Some(GpDatatypeClarifierRule::EncodingName) => {
                if clarifiers.len() != 1
                    || !matches!(clarifiers.first(), Some(GpClarifierValue::String))
                {
                    errors.push(
                        Diagnostic::new(
                            "PROFILE_DATATYPE_CLARIFIER_INVALID",
                            format!(
                                "Profile datatype ':{}' expects exactly one string encoding-name clarifier",
                                datatype.name
                            ),
                        )
                        .at_path(rendered_path)
                        .with_span(span),
                    );
                }
            }
            Some(GpDatatypeClarifierRule::None) | None => {
                errors.push(
                    Diagnostic::new(
                        "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED",
                        format!(
                            "Profile does not allow clarifiers on datatype ':{}'",
                            datatype.name
                        ),
                    )
                    .at_path(rendered_path)
                    .with_span(span),
                );
            }
        }
    }

    for arg in &datatype.args {
        validate_gp_datatype_surface(arg, rendered_path, span, errors);
    }
}

fn gp_datatype_clarifier_rule(name: &str) -> Option<GpDatatypeClarifierRule> {
    match name {
        "decimal" | "kadot" => Some(GpDatatypeClarifierRule::None),
        "radix" => Some(GpDatatypeClarifierRule::RadixBase),
        "sep" | "separator" => Some(GpDatatypeClarifierRule::SeparatorChars),
        "encoding" | "inline" | "embed" => Some(GpDatatypeClarifierRule::EncodingName),
        _ => None,
    }
}

fn valid_radix_base_clarifiers(clarifiers: &[GpClarifierValue]) -> bool {
    let [GpClarifierValue::Number(raw)] = clarifiers else {
        return false;
    };
    parse_gp_integer(raw).is_some_and(|value| (2..=64).contains(&value))
}

fn parse_gp_integer(raw: &str) -> Option<i64> {
    let normalized = raw.replace('_', "");
    let digits = normalized.strip_prefix('+').unwrap_or(&normalized);
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    digits.parse::<i64>().ok()
}

fn parse_gp_datatype_surface(input: &str) -> Option<GpDatatypeSurface> {
    let source = input.trim();
    let (name, mut index) = parse_gp_datatype_name(source, 0)?;
    index = skip_gp_whitespace(source, index);

    let mut args = Vec::new();
    if source[index..].starts_with('<') {
        let end = find_gp_matching_delimiter(source, index, '<', '>')?;
        let inner = &source[index + 1..end];
        for part in split_gp_top_level(inner, ',') {
            let part = part.trim();
            if !part.is_empty() {
                args.push(parse_gp_datatype_surface(part)?);
            }
        }
        index = skip_gp_whitespace(source, end + 1);
    }

    let clarifiers = if source[index..].starts_with('[') {
        let end = find_gp_matching_delimiter(source, index, '[', ']')?;
        let values = parse_gp_clarifier_values(&source[index + 1..end])?;
        index = skip_gp_whitespace(source, end + 1);
        Some(values)
    } else {
        None
    };

    if index != source.len() {
        return None;
    }

    Some(GpDatatypeSurface {
        name,
        args,
        clarifiers,
    })
}

fn parse_gp_datatype_name(source: &str, start: usize) -> Option<(String, usize)> {
    let mut chars = source[start..].char_indices();
    let (_, first) = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut end = start + first.len_utf8();
    for (offset, ch) in chars {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            end = start + offset + ch.len_utf8();
        } else {
            break;
        }
    }
    Some((source[start..end].to_owned(), end))
}

fn parse_gp_clarifier_values(input: &str) -> Option<Vec<GpClarifierValue>> {
    let mut values = Vec::new();
    let mut index = skip_gp_whitespace(input, 0);
    if index == input.len() {
        return Some(values);
    }

    while index < input.len() {
        let (value, next_index) = parse_gp_clarifier_value(input, index)?;
        values.push(value);
        index = skip_gp_whitespace(input, next_index);
        if index == input.len() {
            break;
        }
        if input[index..].starts_with(',') {
            index = skip_gp_whitespace(input, index + 1);
            continue;
        }
        return None;
    }

    Some(values)
}

fn parse_gp_clarifier_value(input: &str, start: usize) -> Option<(GpClarifierValue, usize)> {
    let ch = input[start..].chars().next()?;
    if matches!(ch, '"' | '\'' | '`') {
        let end = scan_gp_quoted(input, start, ch)?;
        return Some((GpClarifierValue::String, end));
    }

    let mut end = start;
    for (offset, ch) in input[start..].char_indices() {
        if ch == ',' {
            break;
        }
        end = start + offset + ch.len_utf8();
    }
    let raw = input[start..end].trim();
    if raw.is_empty() {
        return None;
    }
    let is_number_like = raw
        .chars()
        .all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '_' | '.' | 'e' | 'E'));
    if is_number_like && raw.chars().any(|ch| ch.is_ascii_digit()) {
        Some((GpClarifierValue::Number(raw.to_owned()), end))
    } else {
        Some((GpClarifierValue::Other, end))
    }
}

fn scan_gp_quoted(input: &str, start: usize, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (offset, ch) in input[start + quote.len_utf8()..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some(start + quote.len_utf8() + offset + quote.len_utf8());
        }
    }
    None
}

fn find_gp_matching_delimiter(
    source: &str,
    start: usize,
    open: char,
    close: char,
) -> Option<usize> {
    let mut depth = 0usize;
    let mut quoted: Option<char> = None;
    let mut escaped = false;
    for (offset, ch) in source[start..].char_indices() {
        if let Some(quote) = quoted {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                quoted = None;
            }
            continue;
        }
        if matches!(ch, '"' | '\'' | '`') {
            quoted = Some(ch);
            continue;
        }
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(start + offset);
            }
        }
    }
    None
}

fn split_gp_top_level(input: &str, delimiter: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut angle_depth = 0usize;
    let mut square_depth = 0usize;
    let mut quoted: Option<char> = None;
    let mut escaped = false;

    for (offset, ch) in input.char_indices() {
        if let Some(quote) = quoted {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                quoted = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' | '`' => quoted = Some(ch),
            '<' => angle_depth += 1,
            '>' => angle_depth = angle_depth.saturating_sub(1),
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            _ if ch == delimiter && angle_depth == 0 && square_depth == 0 => {
                parts.push(&input[start..offset]);
                start = offset + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&input[start..]);
    parts
}

fn skip_gp_whitespace(source: &str, mut index: usize) -> usize {
    while index < source.len() {
        let Some(ch) = source[index..].chars().next() else {
            break;
        };
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn compile_portability_warnings(options: &CompileOptions) -> Vec<Diagnostic> {
    let defaults = CompileOptions::default();
    let mut warnings = Vec::new();
    warn_if_above(
        &mut warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_attribute_depth",
        options.max_attribute_depth,
        8,
        defaults.max_attribute_depth,
    );
    warn_if_above(
        &mut warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_clarifier_values",
        options.effective_max_clarifier_values(),
        8,
        defaults.effective_max_clarifier_values(),
    );
    warn_if_above(
        &mut warnings,
        "AEON_NON_PORTABLE_POLICY_DEPTH",
        "max_generic_depth",
        options.max_generic_depth,
        8,
        defaults.max_generic_depth,
    );
    warn_if_above(
        &mut warnings,
        "AEON_NON_PORTABLE_CONTAINER_NESTING_DEPTH",
        "max_value_nesting_depth",
        options.effective_max_value_nesting_depth(),
        64,
        defaults.effective_max_value_nesting_depth(),
    );
    if let Some(max_events) = options.max_events {
        warn_if_above(
            &mut warnings,
            "AEON_NON_PORTABLE_EVENT_BUDGET",
            "max_events",
            max_events,
            100_000,
            defaults.max_events.unwrap_or(0),
        );
    }
    warnings
}

fn warn_if_above(
    warnings: &mut Vec<Diagnostic>,
    code: &str,
    policy: &str,
    observed: usize,
    portable_floor: usize,
    default_value: usize,
) {
    if observed == default_value || observed <= portable_floor {
        return;
    }
    warnings.push(Diagnostic {
        code: String::from(code),
        path: Some(String::from("$")),
        span: None,
        phase: None,
        message: format!("{policy} {observed} exceeds the AEON v1 portable floor {portable_floor}"),
    });
}

fn event_count_exceeded_error(actual_events: usize, max_events: usize) -> Diagnostic {
    Diagnostic {
        code: String::from("EVENT_COUNT_EXCEEDED"),
        path: Some(String::from("$")),
        span: Some(Span::zero()),
        phase: Some(4),
        message: format!("Event count {actual_events} exceeds configured limit of {max_events}"),
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
        assert!(result.warnings.is_empty());
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
    fn input_byte_limit_includes_the_utf8_bom() {
        let result = compile(
            "\u{feff}a=1",
            CompileOptions {
                max_input_bytes: Some(3),
                ..CompileOptions::default()
            },
        );

        assert_eq!(result.errors[0].code, "INPUT_SIZE_EXCEEDED");
    }

    #[test]
    fn rejects_inputs_over_the_configured_event_limit() {
        let result = compile(
            "a = 1\nb = 2",
            CompileOptions {
                max_events: Some(1),
                ..CompileOptions::default()
            },
        );

        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "EVENT_COUNT_EXCEEDED");
    }

    #[test]
    fn warns_when_policy_ceilings_exceed_portable_floors() {
        let result = compile(
            "a = 1",
            CompileOptions {
                max_attribute_depth: 9,
                max_separator_depth: 9,
                max_generic_depth: 9,
                max_nesting_depth: 65,
                max_events: Some(100_001),
                ..CompileOptions::default()
            },
        );

        assert!(result.errors.is_empty());
        let codes = result
            .warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            vec![
                "AEON_NON_PORTABLE_POLICY_DEPTH",
                "AEON_NON_PORTABLE_POLICY_DEPTH",
                "AEON_NON_PORTABLE_POLICY_DEPTH",
                "AEON_NON_PORTABLE_CONTAINER_NESTING_DEPTH",
                "AEON_NON_PORTABLE_EVENT_BUDGET",
            ]
        );
        assert!(result.warnings[0].message.contains("portable floor 8"));
        assert!(result.warnings[3].message.contains("portable floor 64"));
        assert!(result.warnings[4].message.contains("portable floor 100000"));
    }

    #[test]
    fn formats_root_member_and_index_segments() {
        let path = CanonicalPath::root()
            .member("users")
            .index(0)
            .member("full.name");
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
    fn preserves_structural_identity_on_binding_and_anonymous_events() {
        let result = compile(
            "age\\A1\\@{source = \"user\"}:int32 = 42\nitems = [\\B2\\ = \"red\", \\C3\\:string = \"green\"]",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events[0].structural_id.as_deref(), Some("A1"));
        assert_eq!(result.events[2].structural_id.as_deref(), Some("B2"));
        assert_eq!(result.events[3].structural_id.as_deref(), Some("C3"));
    }

    #[test]
    fn preserves_structural_identity_on_attribute_entry_and_node_heads() {
        let result = compile(
            "value@{source\\META\\:string = \"user\"} = <tag\\HEAD\\>",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.events[0].annotations["source"]
                .structural_id
                .as_deref(),
            Some("META")
        );
        match &result.events[0].value {
            Value::NodeLiteral { structural_id, .. } => {
                assert_eq!(structural_id.as_deref(), Some("HEAD"));
            }
            other => panic!("expected node literal, got {other:?}"),
        }
    }

    #[test]
    fn rejects_duplicate_identity_across_attribute_and_node_heads() {
        let result = compile(
            "value@{source\\same\\ = \"user\"} = <tag\\same\\>",
            CompileOptions::default(),
        );
        assert_eq!(result.errors[0].code, "DUPLICATE_STRUCTURAL_IDENTITY");
    }

    #[test]
    fn rejects_duplicate_and_malformed_structural_identity() {
        let duplicate = compile("a\\A1\\ = 1\nb = [\\A1\\ = 2]", CompileOptions::default());
        assert_eq!(duplicate.errors[0].code, "DUPLICATE_STRUCTURAL_IDENTITY");

        let malformed = compile("a\\bad.id\\ = 1", CompileOptions::default());
        assert_eq!(malformed.errors[0].code, "INVALID_STRUCTURAL_IDENTITY");

        let misplaced = compile(
            "a@{source = \"user\"}\\A1\\:int32 = 1",
            CompileOptions::default(),
        );
        assert_eq!(misplaced.errors[0].code, "SYNTAX_ERROR");
    }

    #[test]
    fn parses_sansa_address_literals() {
        let result = compile(
            "absolute:sansa = $.inventory:csv[\",\"]\ncontext:sansa = ?.name\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 2);
        assert_eq!(
            result.events[0].value,
            Value::SansaAddressLiteral {
                address: parse_sansa_address("$.inventory:csv[\",\"]").expect("parse"),
                raw: String::from("$.inventory:csv[\",\"]"),
                canonical: String::from("$.inventory:csv[\",\"]"),
            }
        );
        assert_eq!(result.events[1].value.value_kind(), "SansaAddressLiteral");
    }

    #[test]
    fn sansa_datatype_rejects_non_address_literal_values() {
        let result = compile("address:sansa = \"$.path\"\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "DATATYPE_LITERAL_MISMATCH");
    }

    #[test]
    fn clone_reference_root_dollar_is_not_scanned_as_sansa_address() {
        let result = compile("path = 1\ncopy = ~$.path\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events[1].value.value_kind(), "CloneReference");
    }

    #[test]
    fn parses_sansa_address_literals_before_comments_and_inside_containers() {
        let result = compile(
            "a:sansa = $.name/* block */\n\
             b:sansa = $.name// line\n\
             c:list = [$.name]\n\
             d:node = <tag($.name)>\n\
             e:tuple = ($.name)\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), event.value.value_kind()))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(by_path["$.a"], "SansaAddressLiteral");
        assert_eq!(by_path["$.b"], "SansaAddressLiteral");
        assert_eq!(by_path["$.c[0]"], "SansaAddressLiteral");
        assert_eq!(by_path["$.d[0]"], "SansaAddressLiteral");
        assert_eq!(by_path["$.e[0]"], "SansaAddressLiteral");
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
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SELF_REFERENCE")
        );
    }

    #[test]
    fn validates_direct_list_item_references() {
        let backward = compile("items = [1, ~items[0]]\n", CompileOptions::default());
        assert!(backward.errors.is_empty(), "{:?}", backward.errors);

        let binding_self_ref = compile("a:list = [~a]\n", CompileOptions::default());
        assert_eq!(binding_self_ref.errors[0].code, "SELF_REFERENCE");

        let backward_member = compile(
            "items = [{ email = \"a@example.com\" }, ~items[0].email]\n",
            CompileOptions::default(),
        );
        assert!(
            backward_member.errors.is_empty(),
            "{:?}",
            backward_member.errors
        );

        let forward = compile("items = [~items[1], 1]\n", CompileOptions::default());
        assert_eq!(forward.errors[0].code, "FORWARD_REFERENCE");

        let self_ref = compile("items = [~items[0]]\n", CompileOptions::default());
        assert_eq!(self_ref.errors[0].code, "SELF_REFERENCE");

        let missing = compile("items = [~items[9]]\n", CompileOptions::default());
        assert_eq!(missing.errors[0].code, "MISSING_REFERENCE_TARGET");

        let forward_member = compile(
            "items = [~items[1].email, { email = \"a@example.com\" }]\n",
            CompileOptions::default(),
        );
        assert_eq!(forward_member.errors[0].code, "FORWARD_REFERENCE");
    }

    #[test]
    fn validates_direct_tuple_item_references() {
        let forward = compile("items = (~items[1], 1)\n", CompileOptions::default());
        assert_eq!(forward.errors[0].code, "FORWARD_REFERENCE");

        let self_ref = compile("items = (~items[0], 1)\n", CompileOptions::default());
        assert_eq!(self_ref.errors[0].code, "SELF_REFERENCE");

        let missing = compile("items = (~items[9], 1)\n", CompileOptions::default());
        assert_eq!(missing.errors[0].code, "MISSING_REFERENCE_TARGET");
    }

    #[test]
    fn payload_can_reference_own_attached_attributes() {
        for source in [
            "a@{x = 2} = ~a.@.x\n",
            "a@{\"x.y\" = 2} = ~a.@.[\"x.y\"]\n",
            "a@{x = { z = 2 }} = ~a.@.x.z\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(result.errors.is_empty(), "{:?}", result.errors);
        }
    }

    #[test]
    fn attribute_payload_references_to_payload_follow_self_forward_and_missing_rules() {
        let backward = compile("b = 1\na@{x = ~b} = 1\n", CompileOptions::default());
        assert!(backward.errors.is_empty(), "{:?}", backward.errors);

        let self_ref = compile("a@{x = ~a} = 1\n", CompileOptions::default());
        assert_eq!(self_ref.errors[0].code, "SELF_REFERENCE");

        let forward = compile("a@{x = ~b} = 1\nb = 1\n", CompileOptions::default());
        assert_eq!(forward.errors[0].code, "FORWARD_REFERENCE");

        let missing = compile("a@{x = ~missing} = 1\n", CompileOptions::default());
        assert_eq!(missing.errors[0].code, "MISSING_REFERENCE_TARGET");
    }

    #[test]
    fn attribute_payload_self_and_missing_targets_fail_closed() {
        let self_ref = compile("a@{x = ~a.@.x} = 1\n", CompileOptions::default());
        assert_eq!(self_ref.errors[0].code, "SELF_REFERENCE");

        let nested_self = compile("a@{x = { z = ~a.@.x.z }} = 1\n", CompileOptions::default());
        assert_eq!(nested_self.errors[0].code, "SELF_REFERENCE");

        let missing = compile("a@{x = ~a.@.missing} = 1\n", CompileOptions::default());
        assert_eq!(missing.errors[0].code, "MISSING_REFERENCE_TARGET");
    }

    #[test]
    fn attribute_payload_sibling_order_is_source_ordered() {
        let backward = compile("a@{y = 1, x = ~a.@.y} = 1\n", CompileOptions::default());
        assert!(backward.errors.is_empty(), "{:?}", backward.errors);

        let quoted_backward = compile(
            "a@{\"z.y\" = 1, \"x.y\" = ~a.@.[\"z.y\"]} = 1\n",
            CompileOptions::default(),
        );
        assert!(
            quoted_backward.errors.is_empty(),
            "{:?}",
            quoted_backward.errors
        );

        let forward = compile("a@{x = ~a.@.y, y = 1} = 1\n", CompileOptions::default());
        assert_eq!(forward.errors[0].code, "FORWARD_REFERENCE");

        let quoted_forward = compile(
            "a@{\"x.y\" = ~a.@.[\"z.y\"], \"z.y\" = 1} = 1\n",
            CompileOptions::default(),
        );
        assert_eq!(quoted_forward.errors[0].code, "FORWARD_REFERENCE");
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
    fn strict_mode_rejects_custom_datatypes_with_aligned_message() {
        let result = compile(
            "aeon:mode = \"strict\"\nstroke:myColor = #ff00ff\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "CUSTOM_DATATYPE_NOT_ALLOWED");
        assert_eq!(
            result.errors[0].message,
            "Custom datatype not allowed in typed mode at '$.stroke': ':myColor' requires --datatype-policy allow_custom"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.stroke"));
        assert!(result.errors[0].span.is_some());
        assert!(result.events.is_empty());
    }

    #[test]
    fn accepts_reserved_generic_list_datatypes() {
        let result = compile("items:list<int32> = [1, 2]\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 3);
    }

    #[test]
    fn accepts_parameterized_object_and_node_claims() {
        let result = compile(
            "scores:object<number> = { alice:number = 10 }\ndoc:node<html> = <html>\nchild:node<node> = <tag>\nmissing:null<number> = !none\nbad:nan<number> = NaN\nfast:infinity<speedofmass> = Infinity\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events[0].datatype.as_deref(), Some("object<number>"));
        assert_eq!(result.events[2].datatype.as_deref(), Some("node<html>"));
        assert_eq!(result.events[3].datatype.as_deref(), Some("node<node>"));
        assert_eq!(result.events[4].datatype.as_deref(), Some("null<number>"));
        assert_eq!(result.events[5].datatype.as_deref(), Some("nan<number>"));
        assert_eq!(
            result.events[6].datatype.as_deref(),
            Some("infinity<speedofmass>")
        );
    }

    #[test]
    fn rejects_binding_node_claims_with_reserved_child_value_datatypes() {
        let result = compile("tag:node<string> = <tag>\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert!(
            result.errors[0]
                .message
                .contains("reserved child value datatypes belong on node heads")
        );
    }

    #[test]
    fn strict_mode_accepts_embed_and_inline_as_reserved_encoding_aliases() {
        for datatype in ["embed", "inline"] {
            let source = format!("aeon:mode = \"strict\"\npayload:{datatype} = &QmFzZTY0IQ==\n");
            let result = compile(&source, CompileOptions::default());
            assert!(result.errors.is_empty(), "{datatype}: {:?}", result.errors);
        }
    }

    #[test]
    fn strict_mode_accepts_prose_as_reserved_trimtick_alias() {
        let result = compile(
            "aeon:mode = \"strict\"\nbody:prose = >`\n  # Heading\n\n  Markdown-ish content.\n`\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let body = result
            .events
            .iter()
            .find(|event| format_path(&event.path) == "$.body")
            .expect("body event");
        assert_eq!(body.datatype.as_deref(), Some("prose"));
        assert_eq!(body.value.value_kind(), "TrimtickStringLiteral");
    }

    #[test]
    fn transport_mode_allows_custom_datatypes_without_explicit_override() {
        let result = compile(
            "aeon:mode = \"transport\"\ncolor:stroke = #ff00ff\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
    }

    #[test]
    fn custom_mode_requires_types_and_allows_custom_datatypes() {
        let ok = compile(
            "aeon:mode = \"custom\"\ncolor:stroke = #ff00ff\n",
            CompileOptions::default(),
        );
        assert!(ok.errors.is_empty());

        let fail = compile(
            "aeon:mode = \"custom\"\ncolor = #ff00ff\n",
            CompileOptions::default(),
        );
        assert!(
            fail.errors
                .iter()
                .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE"
                    && error.path.as_deref() == Some("$.color"))
        );
    }

    #[test]
    fn strict_mode_rejects_custom_toggle_alias_even_with_allow_custom() {
        let result = compile(
            "aeon:mode = \"strict\"\ns:myToggle = on\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED");
        assert_eq!(
            result.errors[0].message,
            "Custom toggle alias not allowed at '$.s': use ':toggle' instead of ':myToggle'"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.s"));
        assert!(result.events.is_empty());
    }

    #[test]
    fn custom_mode_allows_custom_toggle_aliases() {
        let result = compile(
            "aeon:mode = \"custom\"\ns:myToggle = on\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn custom_mode_rejects_removed_toggle_datatype_spelling() {
        let result = compile(
            "aeon:mode = \"custom\"\ns:switch = on\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "CUSTOM_TOGGLE_ALIAS_NOT_ALLOWED");
    }

    #[test]
    fn typed_clone_reference_uses_target_value_kind_for_datatype_checking() {
        let result = compile(
            "source:number = 99\ncopy:number = ~source",
            CompileOptions::default(),
        );
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
            "a:number = 1e\n",
            "a:number = 1e+\n",
            "a:number = 1e-\n",
        ];

        for source in invalid_number_cases {
            let result = compile(source, CompileOptions::default());
            assert!(
                result
                    .errors
                    .iter()
                    .any(|error| error.code == "INVALID_NUMBER"),
                "expected INVALID_NUMBER for {source:?}, got {:?}",
                result.errors
            );
        }

        let malformed_boundary_cases = ["a:number = 3e_3\n"];
        for source in malformed_boundary_cases {
            let result = compile(source, CompileOptions::default());
            assert!(
                !result.errors.is_empty(),
                "expected an error for {source:?}"
            );
        }
    }

    #[test]
    fn reports_invalid_radix_literal_with_exact_details() {
        let result = compile("a = 3e-3\nb = %3e-3\n", CompileOptions::default());
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INVALID_NUMBER");
        assert_eq!(result.errors[0].message, "Invalid radix literal `%3e-3`");
        let span = result.errors[0].span.as_ref().expect("span");
        assert_eq!(span.start.line, 2);
        assert_eq!(span.start.column, 5);
        assert_eq!(span.start.offset, 13);
        assert_eq!(span.end.line, 2);
        assert_eq!(span.end.column, 10);
        assert_eq!(span.end.offset, 18);
    }

    #[test]
    fn rejects_malformed_transport_number_before_finalize() {
        let result = compile(
            "aeon:mode = \"transport\"\na = 1-1\n",
            CompileOptions::default(),
        );
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INVALID_NUMBER");
        assert_eq!(
            result.errors[0].message,
            "Number literal `1-1` is not valid"
        );
    }

    #[test]
    fn accepts_valid_untyped_transport_dates() {
        let result = compile(
            "aeon:mode = \"transport\"\nd:date = 2012-06-13\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].value.value_kind(), "DateLiteral");
    }

    #[test]
    fn rejects_incomplete_transport_exponent_forms_before_finalize() {
        for source in [
            "aeon:mode = \"transport\"\na = 1e\n",
            "aeon:mode = \"transport\"\na = 1e+\n",
            "aeon:mode = \"transport\"\na = 1e-\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(result.events.is_empty(), "{source}");
            assert_eq!(result.errors.len(), 1, "{source}");
            assert_eq!(
                result.errors[0].code, "INVALID_NUMBER",
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn accepts_leading_dot_radix_literals() {
        let result = compile(
            "a:radix = %-.3\nb:radix = %+.1\nc:radix = %.1\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 3);
    }

    #[test]
    fn reports_unterminated_string_with_aligned_message_and_exact_span_details() {
        let result = compile("a = 1\nb = \"unterminated", CompileOptions::default());
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "UNTERMINATED_STRING");
        assert_eq!(
            result.errors[0].message,
            "Unterminated string literal (started with \")"
        );
        let span = result.errors[0].span.as_ref().expect("span");
        assert_eq!(span.start.line, 2);
        assert_eq!(span.start.column, 5);
        assert_eq!(span.start.offset, 10);
        assert_eq!(span.end.line, 2);
        assert_eq!(span.end.column, 18);
        assert_eq!(span.end.offset, 23);
    }

    #[test]
    fn reports_missing_reference_target_with_path_and_span_details() {
        let result = compile(
            "a@{ ns = \"alto.v1\" } = 1\nb = ~a.@.missing\n",
            CompileOptions::default(),
        );
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "MISSING_REFERENCE_TARGET");
        assert_eq!(
            result.errors[0].message,
            "Missing reference target: '$.a.@.missing'"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$"));
        let span = result.errors[0].span.as_ref().expect("span");
        assert_eq!(span.start.line, 2);
        assert_eq!(span.start.column, 5);
        assert_eq!(span.start.offset, 29);
        assert_eq!(span.end.line, 2);
        assert_eq!(span.end.column, 17);
        assert_eq!(span.end.offset, 41);
    }

    #[test]
    fn classifies_missing_attribute_target_on_missing_binding_as_missing_reference_target() {
        let result = compile("b = ~a.@.missing\n", CompileOptions::default());
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "MISSING_REFERENCE_TARGET");
        assert_eq!(
            result.errors[0].message,
            "Missing reference target: '$.a.@.missing'"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$"));
    }

    #[test]
    fn rejects_invalid_temporal_literals_with_aligned_messages_and_spans() {
        let cases = [
            (
                "a:date = 2024-13-13\n",
                "INVALID_DATE",
                "Invalid date literal: '2024-13-13'",
            ),
            (
                "a = 0000-1-20\n",
                "INVALID_DATE",
                "Invalid date literal: '0000-1-20'",
            ),
            (
                "a = 0000-02-1\n",
                "INVALID_DATE",
                "Invalid date literal: '0000-02-1'",
            ),
            (
                "a:time = 24:00\n",
                "INVALID_TIME",
                "Invalid time literal: '24:00'",
            ),
            (
                "a:datetime = 2024-13-13T09:30:00Z\n",
                "INVALID_DATETIME",
                "Invalid datetime literal: '2024-13-13T09:30:00Z'",
            ),
            (
                "a:datetime = 2007-01-02t10:10:25\n",
                "SYNTAX_ERROR",
                "Invalid datetime literal: '2007-01-02t10:10:25'",
            ),
            (
                "a:wtc = 2007-01-02t10:10:25Z&Australia/Melbourne\n",
                "SYNTAX_ERROR",
                "Invalid datetime literal: '2007-01-02t10:10:25Z&Australia/Melbourne'",
            ),
        ];

        for (source, expected_code, expected_message) in cases {
            let result = compile(source, CompileOptions::default());
            assert!(
                result.events.is_empty(),
                "expected no events for {source:?}"
            );
            assert_eq!(result.errors.len(), 1, "expected one error for {source:?}");
            assert_eq!(result.errors[0].code, expected_code);
            assert_eq!(result.errors[0].message, expected_message);
            assert!(
                result.errors[0].span.is_some(),
                "expected span for {source:?}"
            );
        }
    }

    #[test]
    fn rejects_lowercase_z_datetime_markers_as_syntax_errors() {
        for source in [
            "a:datetime = 2007-01-02T10:10:25z\n",
            "a:wtc = 2007-01-02T10:10:25z&Australia/Melbourne\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(
                result.events.is_empty(),
                "expected no events for {source:?}"
            );
            assert_eq!(result.errors.len(), 1, "expected one error for {source:?}");
            assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
            assert!(
                result.errors[0]
                    .message
                    .starts_with("Invalid datetime literal:"),
                "{:?}",
                result.errors
            );
        }
    }

    #[test]
    fn rejects_malformed_wtc_reference_punctuation() {
        for source in [
            "z:wtc = 2025-01-01T09Z&Europe*Brussels\n",
            "z:wtc = 2025-01-01T09Z&Europe#Brussels\n",
            "z:wtc = 2025-01-01T09Z&Europe[Brussels\n",
            "z:wtc = 2025-01-01T09Z&Europe;Brussels\n",
            "z:wtc = 2025-01-01T09Z&Europe=Brussels\n",
            "z:wtc = 2025-01-01T09Z&Europe'Brussels\n",
            "z:wtc = 2025-01-01T09Z&*\n",
            "z:wtc = 2025-01-01T09Z&#\n",
            "z:wtc = 2025-01-01T09Z&Europe/Brussels&Local\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(
                result.events.is_empty(),
                "expected no events for {source:?}"
            );
            assert_eq!(result.errors.len(), 1, "expected one error for {source:?}");
            assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        }
    }

    #[test]
    fn accepts_valid_wtc_reference_characters() {
        for source in [
            "z:wtc = 2025-01-01T09Z&America/Port-au-Prince\n",
            "z:wtc = 2025-01-01T09Z&GB-Eire\n",
            "z:wtc = 2025-01-01T09Z&Etc/GMT-1\n",
            "z:wtc = 2025-01-01T09Z&Etc/GMT+1\n",
            "z:wtc = 2035-01-01T09:00&-36.7590183/144.2826718\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(result.errors.is_empty(), "{:?}", result.errors);
        }
    }

    #[test]
    fn parses_pointer_references() {
        let result = compile("target = 1\nptr = ~>target\n", CompileOptions::default());
        assert!(result.errors.is_empty());
        assert!(matches!(
            result.events[1].value,
            Value::PointerReference { .. }
        ));
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
        let result = compile(
            "//# doc title\na = 1 //? inline\n/@ meta @/\nb = 2\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
        assert_eq!(format_path(&result.events[0].path), "$.a");
        assert_eq!(format_path(&result.events[1].path), "$.b");
    }

    #[test]
    fn rejects_untyped_toggle_literals_in_strict_mode_with_aligned_message() {
        let result = compile(
            "aeon:mode = \"strict\"\ndebug = yes\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "UNTYPED_TOGGLE_LITERAL");
        assert_eq!(
            result.errors[0].message,
            "Untyped toggle literal in typed mode: '$.debug' requires ':toggle' type annotation"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.debug"));
        assert!(result.errors[0].span.is_some());
        assert!(result.events.is_empty());
    }

    #[test]
    fn custom_mode_treats_untyped_toggle_literals_like_other_untyped_values() {
        let result = compile(
            "aeon:mode = \"custom\"\ndebug = yes\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE"
                    && error.path.as_deref() == Some("$.debug"))
        );
        assert!(
            !result
                .errors
                .iter()
                .any(|error| error.code == "UNTYPED_TOGGLE_LITERAL"
                    && error.path.as_deref() == Some("$.debug"))
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn rejects_duplicate_canonical_paths_fail_closed_with_duplicate_site_span_details() {
        let result = compile("a = 1\na = 2\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "DUPLICATE_KEY");
        assert_eq!(result.errors[0].message, "Duplicate key: 'a'");
        assert_eq!(result.errors[0].path.as_deref(), Some("$.a"));
        assert_eq!(
            result.errors[0].span,
            Some(Span {
                start: Position {
                    line: 2,
                    column: 1,
                    offset: 6,
                },
                end: Position {
                    line: 2,
                    column: 6,
                    offset: 11,
                },
            })
        );
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
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "DUPLICATE_KEY")
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(format_path(&result.events[0].path), "$.a");
    }

    #[test]
    fn reports_nested_duplicate_object_member_path() {
        let result = compile(
            "app:object = {\n  config:object = {\n    name:string = \"first\"\n    name:string = \"second\"\n  }\n}\n",
            CompileOptions::default(),
        );
        let error = result
            .errors
            .iter()
            .find(|error| error.code == "DUPLICATE_KEY")
            .expect("duplicate nested object member should be reported");
        assert_eq!(error.path.as_deref(), Some("$.app.config.name"));
    }

    #[test]
    fn rejects_mixed_structured_and_shorthand_headers_with_message_and_span_details() {
        let result = compile(
            "aeon:header = { profile = \"core\" }\naeon:mode = \"strict\"\na:int32 = 1\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "HEADER_CONFLICT");
        assert_eq!(
            result.errors[0].message,
            "Header conflict: cannot use both structured header (aeon:header) and shorthand header fields"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$"));
        assert_eq!(
            result.errors[0].span,
            Some(Span {
                start: Position {
                    line: 1,
                    column: 1,
                    offset: 0,
                },
                end: Position {
                    line: 2,
                    column: 21,
                    offset: 55,
                },
            })
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn structured_header_allows_newline_layout_between_key_tokens() {
        let result = compile(
            "aeon\n:\nheader = {\n  mode:\nstring = \"strict\"\n}\na:string = \"ok\"\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors, Vec::new());
        assert_eq!(result.events.len(), 1);
        assert_eq!(format_path(&result.events[0].path), "$.a");
        assert!(matches!(
            result.header.expect("header").fields.get("mode"),
            Some(Value::StringLiteral { value, .. }) if value == "strict"
        ));
    }

    #[test]
    fn parses_structured_header_split_across_whitespace_and_newlines() {
        let result = compile(
            "aeon\n:\nheader = {\n  mode:\nstring = \"strict\"\n  encoding:string = \"utf-8\"\n}\n",
            CompileOptions {
                max_separator_depth: 8,
                ..CompileOptions::default()
            },
        );

        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result
                .header
                .as_ref()
                .map(|header| header.fields.keys().cloned().collect::<Vec<_>>()),
            Some(vec![String::from("encoding"), String::from("mode")])
        );
        assert!(result.events.is_empty());
    }

    #[test]
    fn supports_datatype_after_attribute_block() {
        let result = compile(
            "a@{ ns = \"alto.v1\" }:int32 = 3\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].datatype.as_deref(), Some("int32"));
        assert_eq!(
            result.events[0].annotations["ns"].value,
            Some(Value::StringLiteral {
                value: String::from("alto.v1"),
                raw: String::from("alto.v1"),
                delimiter: '"',
                trimticks: None,
            })
        );
    }

    #[test]
    fn treats_structured_header_metadata_as_control_plane_in_strict_mode() {
        let result = compile(
            "aeon:header = {\n  mode = \"strict\"\n  version = \"1\"\n  profile = \"aeon.gp.profile.v1\"\n  schema = \"altopelago.example.schema.v1\"\n}\nname:string = \"AEON\"\n",
            CompileOptions::default(),
        );

        assert!(result.errors.is_empty());
        assert!(!result.events.is_empty());
    }

    #[test]
    fn consumer_selected_transport_mode_overrides_declared_strict_mode() {
        let result = compile(
            "aeon:mode = \"strict\"\nname = \"AEON\"\n",
            CompileOptions {
                mode: Some(BehaviorMode::Transport),
                ..CompileOptions::default()
            },
        );

        assert!(result.errors.is_empty());
        assert!(!result.events.is_empty());
    }

    #[test]
    fn supports_single_quoted_keys_and_references() {
        let result = compile(
            "'single\\'quote':int32 = 2\nref = ~['single\\'quote']\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 2);
    }

    #[test]
    fn rejects_backtick_quoted_keys() {
        let result = compile("`hello`:number = 2\n", CompileOptions::default());
        assert!(result.errors.iter().any(|error| {
            error.code == "SYNTAX_ERROR"
                && error
                    .message
                    .contains("Backtick strings are not valid keys")
        }));
    }

    #[test]
    fn rejects_duplicate_top_level_datatype_annotations() {
        let result = compile("c:number:number = 2\n", CompileOptions::default());
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SYNTAX_ERROR"
                    && error.message.contains("Expected '=' after key 'c'"))
        );
    }

    #[test]
    fn rejects_multiple_bindings_in_single_datatype_slot() {
        let result = compile("c:number, b:number = 2\n", CompileOptions::default());
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SYNTAX_ERROR"
                    && error.message.contains("Expected '=' after key 'c'"))
        );
    }

    #[test]
    fn rejects_unquoted_comma_separator_clarifiers() {
        let result = compile("badSepType2:sep[,] = ^0,0,0,\n", CompileOptions::default());
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SYNTAX_ERROR"
                    && error.message.contains("Expected clarifier value"))
        );
    }

    #[test]
    fn recovers_past_old_separator_clarifiers_to_report_syntax_errors() {
        let result = compile(
            "badSepType1:matrix[,][;] = ^1,2,3;4,5,6\nbadSepType2:sep[,] = ^0,0,0,\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SYNTAX_ERROR")
        );
    }

    #[test]
    fn rejects_unquoted_slash_separator_clarifiers() {
        let result = compile("badSepType3:sep[/] = ^000.000\n", CompileOptions::default());
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "SYNTAX_ERROR")
        );
    }

    #[test]
    fn accepts_reserved_angle_separator_datatypes() {
        let result = compile(
            "a:sep[\"<\"] = ^a<b\nb:sep[\">\"] = ^a>b\nc:sep[\"<\"] = ^a<b\nd:sep[\">\"] = ^a>b\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn accepts_reserved_caret_separator_datatypes() {
        let result = compile(
            "a:sep[\"^\"] = ^a^b\nb:sep[\"^\"] = ^a^b\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn rejects_inline_separator_boundary_collisions_in_lists() {
        let result = compile(
            "badInline1 = [ ^0,0 , 0,1 ]\nbadInline2 = [ ^0,0,0,1 ]\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "INVALID_SEPARATOR_CHAR"),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn collects_multiple_parse_errors_for_empty_quoted_keys() {
        let result = compile(
            "a = { \"\" = 1 }\nv = ~a.[\"\"]\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 2, "{:?}", result.errors);
        assert!(
            result
                .errors
                .iter()
                .all(|error| error.code == "SYNTAX_ERROR")
        );
    }

    #[test]
    fn recovers_to_quoted_key_bindings_after_parse_errors() {
        let result = compile("a = { \"\" = 1 }\n\"\" = 2\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 2, "{:?}", result.errors);
        assert!(
            result
                .errors
                .iter()
                .all(|error| error.code == "SYNTAX_ERROR"),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn accepts_numeric_radix_clarifiers_for_downstream_validation() {
        let result = compile(
            "a:radix[.2] = %2\nb:radix[1] = %2\nc:radix[65] = %2\nd:radix[333333333333333333333333333333333333333333333333333333] = %2\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events[0].datatype.as_deref(), Some("radix[0.2]"));
        assert_eq!(result.events[1].datatype.as_deref(), Some("radix[1]"));
        assert_eq!(result.events[2].datatype.as_deref(), Some("radix[65]"));
    }

    #[test]
    fn rejects_invalid_numeric_datatype_clarifiers() {
        let result = compile("a:radix[03] = %2\n", CompileOptions::default());
        assert!(result.events.is_empty());
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "INVALID_NUMBER"),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn rejects_missing_datatype_name_after_binding_colon() {
        let result = compile("a::n = 0\n", CompileOptions::default());
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert_eq!(result.errors[0].message, "Expected datatype annotation");
    }

    #[test]
    fn rejects_quoted_type_names() {
        let result = compile("a:'string' = 'hello world'\n", CompileOptions::default());
        assert!(result.errors.iter().any(|error| {
            error.code == "SYNTAX_ERROR"
                && error
                    .message
                    .contains("Quoted type names are not supported")
        }));
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
    fn rejects_attribute_datatype_mismatches_with_aligned_message() {
        let result = compile("b@{n:string=3}:n = 3\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "DATATYPE_LITERAL_MISMATCH");
        assert_eq!(
            result.errors[0].message,
            "Datatype/literal mismatch at '$.b.@.n': datatype ':string' expects StringLiteral, got NumberLiteral"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.b.@.n"));
    }

    #[test]
    fn strict_mode_rejects_untyped_attribute_entries() {
        let result = compile(
            "aeon:mode = \"strict\"\nb@{n=3}:n = 3\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE"
                    && error.path.as_deref() == Some("$.b.@.n")),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn strict_mode_rejects_untyped_node_head_attribute_entries() {
        let result = compile(
            "aeon:mode = \"strict\"\ncontent:node = <span@{id=\"text\", class=\"dark\"}(\"hello\")>\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE"
                    && error.path.as_deref() == Some("$.content.@.id")),
            "{:?}",
            result.errors
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "UNTYPED_VALUE_IN_STRICT_MODE"
                    && error.path.as_deref() == Some("$.content.@.class")),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn strict_mode_accepts_typed_attribute_entries() {
        let result = compile(
            "aeon:mode = \"strict\"\nb@{n:number=3}:n = 3\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn accepts_typed_null_literals_and_rejects_number_for_null_datatype() {
        let ok = compile(
            "value:null = !none\nreason:null = !\"postponed\"\n",
            CompileOptions::default(),
        );
        assert!(ok.errors.is_empty(), "{:?}", ok.errors);
        assert_eq!(ok.events[0].value.value_kind(), "NullLiteral");
        assert_eq!(ok.events[1].value.value_kind(), "NullLiteral");

        let result = compile("value:null = 0\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "DATATYPE_LITERAL_MISMATCH");
        assert_eq!(
            result.errors[0].message,
            "Datatype/literal mismatch at '$.value': datatype ':null' expects NullLiteral, got NumberLiteral"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.value"));
    }

    #[test]
    fn accepts_not_set_null_sentinel() {
        let ok = compile("value:null = !notSet\n", CompileOptions::default());
        assert!(ok.errors.is_empty(), "{:?}", ok.errors);
        match &ok.events[0].value {
            Value::NullLiteral { mode, value, .. } => {
                assert_eq!(mode, &NullLiteralMode::Reserved);
                assert_eq!(value, "notSet");
            }
            other => panic!("expected NullLiteral, got {:?}", other),
        }
    }

    #[test]
    fn custom_bracket_specs_allow_single_digit_for_separator_and_radix_literals() {
        let separator_result = compile(
            "aeon:mode = \"strict\"\na:custom[2] = ^a2a\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(
            separator_result.errors.is_empty(),
            "{:?}",
            separator_result.errors
        );

        let radix_result = compile(
            "aeon:mode = \"strict\"\nb:custom[2] = %0101\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(radix_result.errors.is_empty(), "{:?}", radix_result.errors);
    }

    #[test]
    fn custom_mode_rejects_scalar_values_for_generic_custom_datatypes() {
        let result = compile(
            "aeon:mode = \"custom\"\na:custom<custom> = 0\n",
            CompileOptions::default(),
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "DATATYPE_LITERAL_MISMATCH")
        );
    }

    #[test]
    fn custom_mode_allows_list_and_tuple_values_for_generic_custom_datatypes() {
        let list_result = compile(
            "aeon:mode = \"custom\"\nb:custom<custom> = [2]\n",
            CompileOptions::default(),
        );
        assert!(list_result.errors.is_empty(), "{:?}", list_result.errors);

        let tuple_result = compile(
            "aeon:mode = \"custom\"\nc:custom<custom> = (2)\n",
            CompileOptions::default(),
        );
        assert!(tuple_result.errors.is_empty(), "{:?}", tuple_result.errors);
    }

    #[test]
    fn custom_mode_allows_scalar_values_for_clarified_custom_datatypes() {
        let radix_like_result = compile(
            "aeon:mode = \"custom\"\nd:custom[3] = 3\n",
            CompileOptions::default(),
        );
        assert!(
            radix_like_result.errors.is_empty(),
            "{:?}",
            radix_like_result.errors
        );

        let separator_like_result = compile(
            "aeon:mode = \"custom\"\ne:custom[\".\"] = 3\n",
            CompileOptions::default(),
        );
        assert!(
            separator_like_result.errors.is_empty(),
            "{:?}",
            separator_like_result.errors
        );
    }

    #[test]
    fn custom_mode_preserves_custom_clarifier_bindings() {
        let radix_result = compile(
            "aeon:mode = \"custom\"\nf:custom[2] = %10101\n",
            CompileOptions::default(),
        );
        assert!(radix_result.errors.is_empty(), "{:?}", radix_result.errors);

        let separator_result = compile(
            "aeon:mode = \"custom\"\ng:custom[\".\"] = ^1.1.1\n",
            CompileOptions::default(),
        );
        assert!(
            separator_result.errors.is_empty(),
            "{:?}",
            separator_result.errors
        );

        let ambiguous_result = compile(
            "aeon:mode = \"custom\"\nh:custom[1] = ^1.1.1\n",
            CompileOptions::default(),
        );
        assert!(
            ambiguous_result.errors.is_empty(),
            "{:?}",
            ambiguous_result.errors
        );
    }

    #[test]
    fn custom_mode_allows_generic_custom_datatypes_with_clarifiers() {
        let result = compile(
            "aeon:mode = \"custom\"\na:custom<custom>[\".\"] = [2]\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn custom_mode_ignores_angle_brackets_inside_clarifiers() {
        assert!(datatype_has_generic_args("custom<custom>"));
        assert!(!datatype_has_generic_args("custom[\"<\",\">\"]"));
    }

    #[test]
    fn custom_numeric_clarifiers_do_not_constrain_separator_or_radix_literals() {
        let separator_result = compile(
            "aeon:mode = \"strict\"\na:test[22] = ^300x200\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(
            separator_result.errors.is_empty(),
            "{:?}",
            separator_result.errors
        );

        let radix_result = compile(
            "aeon:mode = \"strict\"\nb:test[22] = %0101\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(radix_result.errors.is_empty(), "{:?}", radix_result.errors);
    }

    #[test]
    fn custom_string_clarifiers_do_not_constrain_separator_or_radix_literals() {
        let separator_result = compile(
            "aeon:mode = \"strict\"\na:custom[\".\"] = ^300x200\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(
            separator_result.errors.is_empty(),
            "{:?}",
            separator_result.errors
        );

        let radix_result = compile(
            "aeon:mode = \"strict\"\nb:custom[\".\"] = %0101\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(radix_result.errors.is_empty(), "{:?}", radix_result.errors);
    }

    #[test]
    fn custom_clarifier_values_outside_core_meaning_are_allowed() {
        let result = compile(
            "aeon:mode = \"strict\"\na:custom[222] = %222\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn rejects_meaningless_reserved_datatype_generics() {
        for source in ["a:n<string> = 3\n", "b:boolean<toggle> = true\n"] {
            let result = compile(source, CompileOptions::default());
            assert!(!result.errors.is_empty(), "{source}");
            assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        }
    }

    #[test]
    fn preserves_reserved_datatype_clarifiers_without_core_meaning() {
        let result = compile(
            "aeon:mode = \"strict\"\na:n[10] = 22\nb:string[333] = \"hello world\"\nr:radix2[4] = %111\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events[0].datatype.as_deref(), Some("n[10]"));
        assert_eq!(result.events[1].datatype.as_deref(), Some("string[333]"));
        assert_eq!(result.events[2].datatype.as_deref(), Some("radix2[4]"));
    }

    #[test]
    fn gp_profile_rejects_disallowed_datatype_clarifiers() {
        let result = compile(
            "aeon:profile = \"aeon.gp.profile.v1\"\na:n[3] = 3\n",
            CompileOptions::default(),
        );
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(
            result.errors[0].code,
            "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED"
        );
    }

    #[test]
    fn gp_profile_validates_radix_datatype_clarifiers() {
        let result = compile(
            "aeon:profile = \"aeon.gp.profile.v1\"\nb:radix[\"hello\"] = %01\n",
            CompileOptions::default(),
        );
        assert!(result.events.is_empty());
        assert!(result.errors.iter().any(|error| {
            error.code == "PROFILE_DATATYPE_CLARIFIER_INVALID" || error.code == "DATATYPE_SHAPE"
        }));
    }

    #[test]
    fn gp_profile_allows_encoding_name_clarifiers() {
        for source in [
            "aeon:profile = \"aeon.gp.profile.v1\"\ncode:encoding[\"base58\"] = &FFF\n",
            "aeon:profile = \"aeon.gp.profile.v1\"\ncode:inline[\"base58\"] = &FFF\n",
            "aeon:profile = \"aeon.gp.profile.v1\"\ncode:embed[\"base58\"] = &FFF\n",
        ] {
            let result = compile(source, CompileOptions::default());
            assert!(result.errors.is_empty(), "{:?}", result.errors);
        }
    }

    #[test]
    fn gp_profile_rejects_invalid_encoding_name_clarifiers() {
        let result = compile(
            "aeon:profile = \"aeon.gp.profile.v1\"\ncode:encoding[58] = &FFF\n",
            CompileOptions::default(),
        );
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "PROFILE_DATATYPE_CLARIFIER_INVALID");
    }

    #[test]
    fn gp_profile_option_enables_datatype_clarifier_validation() {
        let result = compile(
            "a:n[3] = 3\n",
            CompileOptions {
                profile: Some(String::from("aeon.gp.profile.v1")),
                ..CompileOptions::default()
            },
        );
        assert!(result.events.is_empty());
        assert_eq!(
            result.errors[0].code,
            "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED"
        );
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
    fn rejects_untyped_hex_literals_with_double_underscore() {
        let result = compile("blue = #F__f\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
    }

    #[test]
    fn rejects_asterisk_delimited_preprocessor_placeholders() {
        let result = compile("password = *secret-key*\n", CompileOptions::default());
        assert!(!result.errors.is_empty());
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
    }

    #[test]
    fn supports_backtick_strings_and_multiline_node_introducers() {
        let result = compile(
            "text:string = `hello`\ncontent:node = <div(\n  <span@{id=\"text\"}:node(\n    `world`\n  )>\n)>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 4);
        assert!(matches!(
            result.events[0].value,
            Value::StringLiteral { .. }
        ));
        assert!(matches!(result.events[1].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn anonymous_typed_sequence_items_emit_indexed_datatypes() {
        let result = compile(
            "values:list = [:int32 = 3, :string = \"4\"]\npair:tuple = (:float64 = 10.5, :float64 = 2.0)\npage:node = <page(:string = \"hello\", <tag>, :int32 = 3)>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), event))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(by_path["$.values[0]"].datatype.as_deref(), Some("int32"));
        assert_eq!(by_path["$.values[1]"].datatype.as_deref(), Some("string"));
        assert_eq!(by_path["$.pair[0]"].datatype.as_deref(), Some("float64"));
        assert_eq!(by_path["$.pair[1]"].datatype.as_deref(), Some("float64"));
        assert!(matches!(by_path["$.page"].value, Value::NodeLiteral { .. }));
        assert_eq!(by_path["$.page[0]"].datatype.as_deref(), Some("string"));
        assert!(matches!(
            by_path["$.page[1]"].value,
            Value::NodeLiteral { .. }
        ));
        assert_eq!(by_path["$.page[2]"].datatype.as_deref(), Some("int32"));
    }

    #[test]
    fn anonymous_attributed_sequence_items_emit_indexed_annotations() {
        let result = compile(
            "page:node = <page(@{unit:string=\"cm\"}:int32 = 3)>\nvalues:list = [@{unit:string=\"cm\"} = 4]\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), event))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(by_path["$.page[0]"].datatype.as_deref(), Some("int32"));
        assert_eq!(
            by_path["$.page[0]"]
                .annotations
                .get("unit")
                .and_then(|value| value.datatype.as_deref()),
            Some("string")
        );
        assert!(by_path["$.values[0]"].datatype.is_none());
        assert_eq!(
            by_path["$.values[0]"]
                .annotations
                .get("unit")
                .and_then(|value| value.datatype.as_deref()),
            Some("string")
        );
    }

    #[test]
    fn node_children_emit_indexed_paths_and_descendants() {
        let result = compile(
            "page:node = <page({a:n = 1, b:n = 2}, \"hello\")>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), event))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert!(by_path.contains_key("$.page"));
        assert!(by_path.contains_key("$.page[0]"));
        assert!(by_path.contains_key("$.page[0].a"));
        assert!(by_path.contains_key("$.page[0].b"));
        assert!(by_path.contains_key("$.page[1]"));
    }

    #[test]
    fn references_resolve_through_node_child_indexes() {
        let result = compile(
            "page:node = <page({a:n = 1})>\ncopy:n = ~page[0].a\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .events
                .iter()
                .any(|event| format_path(&event.path) == "$.copy")
        );
    }

    #[test]
    fn strict_mode_rejects_non_node_inline_node_head_datatypes_with_aligned_message() {
        let result = compile(
            "aeon:mode = \"strict\"\nwidget:node = <tag:contact(\"x\")>\n",
            CompileOptions::default(),
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INVALID_NODE_HEAD_DATATYPE");
        assert_eq!(
            result.errors[0].message,
            "Invalid node head datatype in strict mode at '$.widget': node heads must use ':node', got ':contact'"
        );
        assert_eq!(result.errors[0].path.as_deref(), Some("$.widget"));
        assert!(result.errors[0].span.is_some());
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
                raw: String::from("\\`"),
                delimiter: '`',
                trimticks: None,
            }
        );
        assert_eq!(
            result.events[4].value,
            Value::StringLiteral {
                value: String::from("\"'"),
                raw: String::from("\"'"),
                delimiter: '`',
                trimticks: None,
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
                raw: String::from("\n  one\n  two\n"),
                delimiter: '`',
                trimticks: Some(TrimtickMetadata {
                    marker_width: 1,
                    raw_value: String::from("\n  one\n  two\n"),
                }),
            }
        );
        assert_eq!(
            result.events[1].value,
            Value::StringLiteral {
                value: String::from("alpha\nbeta"),
                raw: String::from("\n\talpha\n  beta\n"),
                delimiter: '`',
                trimticks: Some(TrimtickMetadata {
                    marker_width: 2,
                    raw_value: String::from("\n\talpha\n  beta\n"),
                }),
            }
        );
    }

    #[test]
    fn supports_comma_delimited_separator_literals() {
        let result = compile(
            "obj = { sep10:sep[\".\"] = ^93.2.3.3, sep11:sep[\"x\"] = ^800x600, sep12:sep[\"-\"] = ^2025-01-01 }\n",
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
        assert_eq!(result.events.len(), 10);
        let by_path = result
            .events
            .iter()
            .map(|event| (format_path(&event.path), event))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert!(matches!(by_path["$.n"].value, Value::NodeLiteral { .. }));
        assert!(matches!(by_path["$.s"].value, Value::NodeLiteral { .. }));
    }

    #[test]
    fn supports_multiline_binding_layout_around_colon_and_equals() {
        let result = compile(
            "name\n  :\n  string = \n  \"playground\"\n\norder001:node = \n<\n  aeon\n  (\n    \"hello\"\n  )\n>\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.events.len(), 3);
    }

    #[test]
    fn rejects_empty_quoted_keys_in_binding_positions() {
        let result = compile("\"\" = 1\n", CompileOptions::default());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
        assert_eq!(result.errors[0].message, "Keys must not be empty");
    }

    #[test]
    fn rejects_nested_attribute_heads_at_default_depth() {
        let result = compile("a@{b@{c=3}=2} = 1\n", CompileOptions::default());
        assert!(!result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.code == "ATTRIBUTE_DEPTH_EXCEEDED"),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn accepts_root_quoted_member_reference_after_dollar_dot() {
        let result = compile(
            "\"a.b\" = 1\nv = ~$. [\"a.b\"]\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn fails_closed_on_deep_valid_nesting() {
        let options = CompileOptions {
            max_nesting_depth: 32,
            ..CompileOptions::default()
        };
        let source = format!("v = {}0{}\n", "[".repeat(40), "]".repeat(40));
        let result = compile(&source, options);
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "NESTING_DEPTH_EXCEEDED");
    }

    #[test]
    fn honors_nesting_depth_conformance_floor() {
        let source = format!("v = {}0{}\n", "[".repeat(64), "]".repeat(64));

        let passing = compile(
            &source,
            CompileOptions {
                max_nesting_depth: 64,
                ..CompileOptions::default()
            },
        );
        assert!(passing.errors.is_empty(), "{:?}", passing.errors);

        let failing = compile(
            &source,
            CompileOptions {
                max_nesting_depth: 63,
                ..CompileOptions::default()
            },
        );
        assert!(failing.events.is_empty());
        assert_eq!(failing.errors.len(), 1);
        assert_eq!(failing.errors[0].code, "NESTING_DEPTH_EXCEEDED");
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
             z:wtc = 2025-01-01T00:00:00Z&Australia/Sydney\n\
             sep:sep[\";\"] = ^a;b;c\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 5);
    }

    #[test]
    fn separator_literals_accept_quoted_sections_in_payload() {
        let result = compile(
            "a:sep[\"|\"] = ^\"hello world\"|\"this, [is] fine\"\n",
            CompileOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn separator_literals_reject_unterminated_quoted_sections() {
        let result = compile("a:sep[\"|\"] = ^\"0;0\n", CompileOptions::default());
        assert!(!result.errors.is_empty());
        assert_eq!(result.errors[0].code, "UNTERMINATED_STRING");
    }

    #[test]
    fn separator_literals_stop_before_comments_resume() {
        let result = compile("a:sep[\"|\"] = ^aaa // d\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn separator_literals_reject_raw_slashes() {
        let result = compile("a:sep[\"|\"] = ^root/main\n", CompileOptions::default());
        assert!(!result.errors.is_empty());
        assert_eq!(result.errors[0].code, "SYNTAX_ERROR");
    }

    #[test]
    fn unparameterized_reserved_separator_datatype_accepts_caret_literals() {
        let result = compile("blue:sep = ^200\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn unparameterized_reserved_kadot_datatype_accepts_caret_literals() {
        let result = compile("semver:kadot = ^3.14.15\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn core_does_not_enforce_kadot_shape() {
        let result = compile("dimensions:kadot = ^300x250\n", CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.events.len(), 1);
    }

    #[test]
    fn scenarios_fixture_parses_cleanly() {
        let fixture = std::fs::read_to_string(format!(
            "{}/../../../../stress-tests/full/scenarios.aeon",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read scenarios.aeon fixture");
        let result = compile(&fixture, CompileOptions::default());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }
}
