#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
#[cfg(feature = "sofia-bench")]
use std::io::Read;
use std::num::NonZeroUsize;

use crate::flatten::{FlattenEventCursor, FlattenValidationCursor, ValidationReferenceStep};
use crate::header::{IncrementalHeaderState, extract_header_fields, lower_header};
use crate::lexer::retained_token_byte_limit;
use crate::resource_limits::{validate_binding_resource_limits, validate_event_path_limits};
use crate::token_parser::{
    IncrementalSofiaFrontend, IncrementalSofiaRetention, ParserImplementation,
};
#[cfg(feature = "sofia-bench")]
use crate::utf8_decoder::Utf8Decoder;
use crate::validation::{
    CompactDatatypeValue, CompactReferenceStep, compact_reference_steps,
    validate_attribute_datatypes, validate_compact_reference_datatype,
    validate_compact_reference_steps, validate_direct_event_datatype,
    validate_duplicate_object_member_keys, validate_typed_mode_rules,
};
use crate::{
    AssignmentEvent, BehaviorMode, Binding, BindingProjection, CanonicalPath, CompileOptions,
    CompileResult, Diagnostic, EventBatch, EventBatches, SourcePlane, SourceRetention, Value,
    compile_owned_sofia_whole, compile_owned_with_implementation, compile_portability_warnings,
    event_count_exceeded_error, format_path, input_size_diagnostic_for_len,
    validate_gp_datatype_clarifiers,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProvisionalEventBatch {
    sequence: usize,
    first_event_index: usize,
    batch: EventBatch,
}

impl ProvisionalEventBatch {
    pub(crate) const fn sequence(&self) -> usize {
        self.sequence
    }

    pub(crate) const fn first_event_index(&self) -> usize {
        self.first_event_index
    }

    pub(crate) fn events(&self) -> &[crate::AssignmentEvent] {
        self.batch.events()
    }

    pub(crate) fn into_events(self) -> Vec<crate::AssignmentEvent> {
        self.batch.into_events()
    }
}

#[derive(Debug, Default)]
struct ModeDiagnosticLedger {
    transport: Vec<Diagnostic>,
    strict: Vec<Diagnostic>,
    custom: Vec<Diagnostic>,
}

#[derive(Debug, Default)]
struct ModeOrderedDiagnosticLedger {
    transport: Vec<(usize, Diagnostic)>,
    strict: Vec<(usize, Diagnostic)>,
    custom: Vec<(usize, Diagnostic)>,
}

impl ModeOrderedDiagnosticLedger {
    fn errors(&self, mode: BehaviorMode) -> &[(usize, Diagnostic)] {
        match mode {
            BehaviorMode::Transport => &self.transport,
            BehaviorMode::Strict => &self.strict,
            BehaviorMode::Custom => &self.custom,
        }
    }

    fn errors_mut(&mut self, mode: BehaviorMode) -> &mut Vec<(usize, Diagnostic)> {
        match mode {
            BehaviorMode::Transport => &mut self.transport,
            BehaviorMode::Strict => &mut self.strict,
            BehaviorMode::Custom => &mut self.custom,
        }
    }

    fn retained_error_count(&self) -> usize {
        self.transport.len() + self.strict.len() + self.custom.len()
    }
}

#[derive(Debug)]
struct CompactReferenceDatatypeClaim {
    event_ordinal: usize,
    path: String,
    datatype: String,
    reference: CompactDatatypeValue,
    span: crate::Span,
}

impl CompactReferenceDatatypeClaim {
    fn retained_string_bytes(&self) -> usize {
        self.path.capacity() + self.datatype.capacity() + self.reference.retained_string_bytes()
    }
}

impl ModeDiagnosticLedger {
    fn errors(&self, mode: BehaviorMode) -> &[Diagnostic] {
        match mode {
            BehaviorMode::Transport => &self.transport,
            BehaviorMode::Strict => &self.strict,
            BehaviorMode::Custom => &self.custom,
        }
    }

    fn errors_mut(&mut self, mode: BehaviorMode) -> &mut Vec<Diagnostic> {
        match mode {
            BehaviorMode::Transport => &mut self.transport,
            BehaviorMode::Strict => &mut self.strict,
            BehaviorMode::Custom => &mut self.custom,
        }
    }

    fn retained_error_count(&self) -> usize {
        self.transport.len() + self.strict.len() + self.custom.len()
    }
}

#[derive(Debug)]
struct ProgressiveValidationState {
    options: CompileOptions,
    assume_unique_event_paths: bool,
    header: IncrementalHeaderState,
    event_count: usize,
    seen_event_paths: HashSet<(SourcePlane, String)>,
    source_resource_error: Option<Diagnostic>,
    structured_comment_error: Option<Diagnostic>,
    structured_comment_count: usize,
    duplicate_object_errors: Vec<Diagnostic>,
    event_path_error: Option<Diagnostic>,
    duplicate_errors: Vec<Diagnostic>,
    datatype_event_errors: ModeOrderedDiagnosticLedger,
    datatype_attribute_errors: ModeDiagnosticLedger,
    gp_profile_errors: Vec<Diagnostic>,
    reference_datatype_claims: Vec<CompactReferenceDatatypeClaim>,
    datatype_targets: HashMap<String, CompactDatatypeValue>,
    reference_targets: HashSet<String>,
    reference_steps: Vec<CompactReferenceStep>,
    typed_mode_errors: ModeDiagnosticLedger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct ProgressiveValidationRetention {
    effective_mode: Option<BehaviorMode>,
    has_declared_profile: bool,
    gp_profile_active: bool,
    header_field_count: usize,
    header_string_bytes: usize,
    reference_datatype_claim_count: usize,
    datatype_target_count: usize,
    datatype_target_string_bytes: usize,
    reference_datatype_claim_string_bytes: usize,
    reference_target_count: usize,
    reference_target_string_bytes: usize,
    reference_step_count: usize,
    reference_claim_count: usize,
    reference_step_string_bytes: usize,
    retained_candidate_error_count: usize,
    event_count: usize,
    seen_path_count: usize,
    seen_path_string_bytes: usize,
    error_count: usize,
    structured_comment_count: usize,
    has_structured_comment_error: bool,
}

impl ProgressiveValidationState {
    fn new(options: &CompileOptions) -> Self {
        Self {
            options: options.clone(),
            assume_unique_event_paths: false,
            header: IncrementalHeaderState::default(),
            event_count: 0,
            seen_event_paths: HashSet::new(),
            source_resource_error: None,
            structured_comment_error: None,
            structured_comment_count: 0,
            duplicate_object_errors: Vec::new(),
            event_path_error: None,
            duplicate_errors: Vec::new(),
            datatype_event_errors: ModeOrderedDiagnosticLedger::default(),
            datatype_attribute_errors: ModeDiagnosticLedger::default(),
            gp_profile_errors: Vec::new(),
            reference_datatype_claims: Vec::new(),
            datatype_targets: HashMap::new(),
            reference_targets: HashSet::new(),
            reference_steps: Vec::new(),
            typed_mode_errors: ModeDiagnosticLedger::default(),
        }
    }

    fn new_streaming(options: &CompileOptions) -> Self {
        Self {
            assume_unique_event_paths: true,
            ..Self::new(options)
        }
    }

    fn observe_bindings(&mut self, bindings: &[Binding]) {
        if self.source_resource_error.is_none() {
            self.source_resource_error = validate_binding_resource_limits(bindings, &self.options);
        }
        for binding in bindings {
            self.header.observe(binding);
        }
        for binding in bindings.iter().filter(|binding| !binding.is_header) {
            validate_duplicate_object_member_keys(
                std::slice::from_ref(binding),
                &mut self.duplicate_object_errors,
            );
        }
        for &mode in self.candidate_modes() {
            let mut body_start = 0;
            while body_start < bindings.len() {
                while body_start < bindings.len() && bindings[body_start].is_header {
                    body_start += 1;
                }
                let mut body_end = body_start;
                while body_end < bindings.len() && !bindings[body_end].is_header {
                    body_end += 1;
                }
                if body_start == body_end {
                    break;
                }
                validate_attribute_datatypes(
                    &bindings[body_start..body_end],
                    mode,
                    self.options.datatype_policy,
                    self.options.effective_max_clarifier_values(),
                    self.options.max_generic_depth,
                    self.datatype_attribute_errors.errors_mut(mode),
                );
                body_start = body_end;
            }
            if !matches!(mode, BehaviorMode::Transport) {
                validate_typed_mode_rules(
                    bindings,
                    Some(mode),
                    self.typed_mode_errors.errors_mut(mode),
                );
            }
        }
    }

    fn observe_structured_comments(&mut self, count: usize, error: Option<Diagnostic>) {
        self.structured_comment_count = count;
        if self.structured_comment_error.is_none() {
            self.structured_comment_error = error;
        }
    }

    fn observe_events(&mut self, events: &[crate::AssignmentEvent]) {
        let rendered_paths = events
            .iter()
            .map(|event| format_path(&event.path))
            .collect::<Vec<_>>();
        if self.event_path_error.is_none() {
            self.event_path_error =
                validate_event_path_limits(events, &rendered_paths, &self.options);
        }
        let first_event_ordinal = self.event_count;
        self.event_count = self.event_count.saturating_add(events.len());
        for (offset, (event, path)) in events.iter().zip(&rendered_paths).enumerate() {
            if !self.assume_unique_event_paths
                && !self
                    .seen_event_paths
                    .insert((event.source_plane, path.clone()))
            {
                self.duplicate_errors.push(
                    Diagnostic::new("DUPLICATE_KEY", format!("Duplicate key: '{}'", event.key))
                        .at_path(path.clone())
                        .with_span(event.span),
                );
            }
            if let Some(datatype) = &event.datatype
                && matches!(
                    event.value,
                    Value::CloneReference { .. } | Value::PointerReference { .. }
                )
            {
                self.reference_datatype_claims
                    .push(CompactReferenceDatatypeClaim {
                        event_ordinal: first_event_ordinal + offset,
                        path: path.clone(),
                        datatype: datatype.clone(),
                        reference: CompactDatatypeValue::from_value(&event.value),
                        span: event.span,
                    });
            }
        }
        for &mode in self.candidate_modes() {
            for (offset, (event, path)) in events.iter().zip(&rendered_paths).enumerate() {
                if let Some(error) = validate_direct_event_datatype(
                    event,
                    path,
                    mode,
                    self.options.datatype_policy,
                    self.options.effective_max_clarifier_values(),
                    self.options.max_generic_depth,
                ) {
                    self.datatype_event_errors
                        .errors_mut(mode)
                        .push((first_event_ordinal + offset, error));
                }
            }
        }
        validate_gp_datatype_clarifiers(events, &rendered_paths, &mut self.gp_profile_errors);
    }

    fn observe_references(&mut self, targets: &HashSet<String>, steps: &[ValidationReferenceStep]) {
        self.reference_targets.extend(targets.iter().cloned());
        for step in steps {
            if let ValidationReferenceStep::ValidateValue { path, value, .. } = step {
                let _ = self
                    .datatype_targets
                    .insert(path.clone(), CompactDatatypeValue::from_value(value));
            }
        }
        self.reference_steps.extend(compact_reference_steps(steps));
    }

    fn candidate_modes(&self) -> &'static [BehaviorMode] {
        match self.options.mode.or(self.header.declared_mode()) {
            Some(BehaviorMode::Transport) => &[BehaviorMode::Transport],
            Some(BehaviorMode::Strict) => &[BehaviorMode::Strict],
            Some(BehaviorMode::Custom) => &[BehaviorMode::Custom],
            None => &[
                BehaviorMode::Transport,
                BehaviorMode::Strict,
                BehaviorMode::Custom,
            ],
        }
    }

    fn errors(&self) -> Vec<Diagnostic> {
        if let Some(error) = &self.source_resource_error {
            return vec![error.clone()];
        }
        if let Some(error) = &self.structured_comment_error {
            return vec![error.clone()];
        }
        if let Some(error) = self.header.error() {
            return vec![error];
        }
        if let Some(max_events) = self.options.max_events
            && self.event_count > max_events
        {
            return vec![event_count_exceeded_error(self.event_count, max_events)];
        }
        let mut errors = self
            .duplicate_object_errors
            .iter()
            .cloned()
            .chain(self.event_path_error.iter().cloned())
            .chain(self.duplicate_errors.iter().cloned())
            .collect::<Vec<_>>();
        if !self.fail_closed_duplicate_suppresses_events() {
            errors.extend(self.effective_datatype_event_errors());
        }
        errors.extend(self.effective_datatype_attribute_errors().iter().cloned());
        if self.gp_profile_active() && !self.fail_closed_duplicate_suppresses_events() {
            errors.extend(self.gp_profile_errors.iter().cloned());
        }
        errors.extend(self.reference_errors());
        errors.extend(self.effective_typed_mode_errors().iter().cloned());
        errors
    }

    fn effective_mode(&self) -> BehaviorMode {
        self.header.effective_mode(self.options.mode)
    }

    fn gp_profile_active(&self) -> bool {
        self.header.uses_gp_profile(self.options.profile.as_deref())
    }

    fn fail_closed_duplicate_suppresses_events(&self) -> bool {
        !self.duplicate_errors.is_empty() && !self.validation_only()
    }

    fn validation_only(&self) -> bool {
        self.options.shallow_event_values
            && !self.options.emit_binding_projections
            && !self.options.include_header
            && !self.options.include_event_annotations
            && !self.options.recovery
    }

    fn effective_datatype_event_errors(&self) -> Vec<Diagnostic> {
        let mode = self.effective_mode();
        let mut ordered = self.datatype_event_errors.errors(mode).to_vec();
        for claim in &self.reference_datatype_claims {
            let resolved = self.resolve_compact_datatype_reference(&claim.reference);
            if let Some(error) = validate_compact_reference_datatype(
                &claim.datatype,
                &resolved,
                &claim.path,
                claim.span,
                mode,
                self.options.datatype_policy,
                self.options.effective_max_clarifier_values(),
                self.options.max_generic_depth,
            ) {
                ordered.push((claim.event_ordinal, error));
            }
        }
        ordered.sort_by_key(|(ordinal, _)| *ordinal);
        ordered.into_iter().map(|(_, error)| error).collect()
    }

    fn resolve_compact_datatype_reference(
        &self,
        reference: &CompactDatatypeValue,
    ) -> CompactDatatypeValue {
        let original = reference.clone();
        let mut current = reference.clone();
        let mut seen = HashSet::new();
        loop {
            let Some(target) = current.reference_target() else {
                return current;
            };
            if !seen.insert(target.to_owned()) {
                return current;
            }
            let Some(next) = self.datatype_targets.get(target) else {
                return original;
            };
            current = next.clone();
        }
    }

    fn effective_datatype_attribute_errors(&self) -> &[Diagnostic] {
        self.datatype_attribute_errors.errors(self.effective_mode())
    }

    fn effective_typed_mode_errors(&self) -> &[Diagnostic] {
        self.typed_mode_errors.errors(self.effective_mode())
    }

    fn reference_errors(&self) -> Vec<Diagnostic> {
        let mut errors = Vec::new();
        validate_compact_reference_steps(
            &self.reference_steps,
            &self.reference_targets,
            self.options.max_attribute_depth,
            &mut errors,
        );
        errors
    }

    fn retention(&self) -> ProgressiveValidationRetention {
        ProgressiveValidationRetention {
            effective_mode: Some(self.effective_mode()),
            has_declared_profile: self.header.declared_profile().is_some(),
            gp_profile_active: self.gp_profile_active(),
            header_field_count: self.header.observed_field_count(),
            header_string_bytes: self.header.retained_string_bytes(),
            reference_datatype_claim_count: self.reference_datatype_claims.len(),
            datatype_target_count: self.datatype_targets.len(),
            datatype_target_string_bytes: self
                .datatype_targets
                .iter()
                .map(|(path, value)| path.capacity() + value.retained_string_bytes())
                .sum(),
            reference_datatype_claim_string_bytes: self
                .reference_datatype_claims
                .iter()
                .map(CompactReferenceDatatypeClaim::retained_string_bytes)
                .sum(),
            reference_target_count: self.reference_targets.len(),
            reference_target_string_bytes: self
                .reference_targets
                .iter()
                .map(String::capacity)
                .sum(),
            reference_step_count: self.reference_steps.len(),
            reference_claim_count: self
                .reference_steps
                .iter()
                .filter(|step| step.is_claim())
                .count(),
            reference_step_string_bytes: self
                .reference_steps
                .iter()
                .map(CompactReferenceStep::retained_string_bytes)
                .sum(),
            retained_candidate_error_count: self.datatype_event_errors.retained_error_count()
                + self.datatype_attribute_errors.retained_error_count()
                + self.gp_profile_errors.len()
                + self.typed_mode_errors.retained_error_count(),
            event_count: self.event_count,
            seen_path_count: self.seen_event_paths.len(),
            seen_path_string_bytes: self
                .seen_event_paths
                .iter()
                .map(|(_, path)| path.capacity())
                .sum(),
            error_count: self.errors().len(),
            structured_comment_count: self.structured_comment_count,
            has_structured_comment_error: self.structured_comment_error.is_some(),
        }
    }
}

/// Builds Sofia's ordinary rich result while releasing completed top-level
/// bindings between bounded lexer/parser chunks. Recovery and unsupported
/// document shapes fall back to the authoritative whole-document finalizer.
pub(crate) fn compile_owned_sofia_streaming(
    source: String,
    options: CompileOptions,
) -> CompileResult {
    const CHUNK_BYTES: usize = 64 * 1024;

    let validation_only = options.shallow_event_values
        && !options.emit_binding_projections
        && !options.include_header
        && !options.include_event_annotations;
    if options.recovery || validation_only || !supports_flat_scalar_streaming(&source) {
        return compile_owned_sofia_whole(source, options);
    }

    let warnings = compile_portability_warnings(&options);
    let track_references = source.as_bytes().contains(&b'~');
    let mut parser = IncrementalSofiaFrontend::new(&options);
    let mut state = StreamingCompileState::new(&options);
    let mut start = 0;
    while start < source.len() {
        let mut end = (start + CHUNK_BYTES).min(source.len());
        if end < source.len()
            && let Some(newline) = source[end..].find('\n')
        {
            end += newline + 1;
        }
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        parser.push_str(&source[start..end]);
        append_streaming_bindings(
            parser.take_completed_bindings(),
            &options,
            track_references,
            &mut state,
        );
        start = end;
    }

    let incremental = parser.finish(&source);
    if incremental.retention_fallback {
        return compile_owned_sofia_whole(source, options);
    }
    state.validation.observe_structured_comments(
        incremental.structured_comment_count,
        incremental.structured_comment_error,
    );
    append_streaming_bindings(
        incremental.parsed.bindings,
        &options,
        track_references,
        &mut state,
    );
    if state.has_top_level_duplicate || !state.validation.duplicate_object_errors.is_empty() {
        return compile_owned_sofia_whole(source, options);
    }
    if !incremental.parsed.errors.is_empty() {
        return CompileResult {
            source,
            events: Vec::new(),
            errors: incremental.parsed.errors,
            warnings,
            bindings: Vec::new(),
            header: None,
        };
    }
    if let Some(error) = state
        .validation
        .source_resource_error
        .clone()
        .or_else(|| state.validation.structured_comment_error.clone())
    {
        return CompileResult {
            source,
            events: Vec::new(),
            errors: vec![error],
            warnings,
            bindings: Vec::new(),
            header: None,
        };
    }

    let errors = state.validation.errors();
    let header = if options.include_header {
        lower_header(state.header_bindings)
            .ok()
            .map(|lowered| extract_header_fields(&lowered))
    } else {
        None
    };
    if !errors.is_empty() {
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
        events: state.events,
        errors,
        warnings,
        bindings: state.projections,
        header,
    }
}

fn supports_flat_scalar_streaming(source: &str) -> bool {
    const MIN_STREAMING_BYTES: usize = 512 * 1024;
    if source.len() < MIN_STREAMING_BYTES {
        return false;
    }
    let body = if source.starts_with("aeon:header") {
        source
            .find("\n}\n")
            .map_or(source, |header_end| &source[header_end + 3..])
    } else {
        source
    };
    !body
        .as_bytes()
        .iter()
        .any(|byte| matches!(byte, b'[' | b'{' | b'(' | b'<' | b'~'))
}

struct StreamingCompileState {
    validation: ProgressiveValidationState,
    events: Vec<AssignmentEvent>,
    projections: Vec<BindingProjection>,
    header_bindings: Vec<Binding>,
    top_level_paths: HashSet<String>,
    has_top_level_duplicate: bool,
}

impl StreamingCompileState {
    fn new(options: &CompileOptions) -> Self {
        Self {
            validation: ProgressiveValidationState::new_streaming(options),
            events: Vec::new(),
            projections: Vec::new(),
            header_bindings: Vec::new(),
            top_level_paths: HashSet::new(),
            has_top_level_duplicate: false,
        }
    }
}

fn append_streaming_bindings(
    bindings: Vec<Binding>,
    options: &CompileOptions,
    track_references: bool,
    state: &mut StreamingCompileState,
) {
    state.validation.observe_bindings(&bindings);
    let mut completed_events = Vec::new();
    for binding in bindings {
        if binding.is_header {
            state.header_bindings.push(binding);
            continue;
        }
        if !state.top_level_paths.insert(binding.key.clone()) {
            state.has_top_level_duplicate = true;
        }
        if !track_references
            && !matches!(
                binding.value,
                Value::TypedValue { .. }
                    | Value::NodeLiteral { .. }
                    | Value::ListNode { .. }
                    | Value::TupleLiteral { .. }
                    | Value::ObjectNode { .. }
                    | Value::CloneReference { .. }
                    | Value::PointerReference { .. }
            )
        {
            let Binding {
                key,
                structural_id,
                datatype,
                attributes,
                attribute_order,
                value,
                span,
                ..
            } = binding;
            completed_events.push(AssignmentEvent {
                path: CanonicalPath::root().member(key.clone()),
                key,
                source_plane: SourcePlane::Body,
                structural_id,
                datatype,
                annotations: if options.include_event_annotations {
                    attributes
                } else {
                    BTreeMap::new()
                },
                annotation_order: if options.include_event_annotations {
                    attribute_order
                } else {
                    Vec::new()
                },
                value,
                span,
            });
            continue;
        }
        for item in FlattenValidationCursor::new(
            &binding,
            options.shallow_event_values,
            options.include_event_annotations,
        ) {
            state
                .validation
                .observe_references(&item.reference_targets, &item.reference_steps);
            completed_events.push(item.event);
        }
    }
    state.validation.observe_events(&completed_events);
    if options.emit_binding_projections {
        state
            .projections
            .extend(completed_events.iter().map(|event| BindingProjection {
                path: format_path(&event.path),
                datatype: event.datatype.clone(),
                kind: "binding",
            }));
    }
    state.events.append(&mut completed_events);
}

#[derive(Debug)]
struct ProgressiveEventAssembler {
    max_batch_events: NonZeroUsize,
    shallow_event_values: bool,
    include_event_annotations: bool,
    enabled: bool,
    validation: ProgressiveValidationState,
    next_sequence: usize,
    next_event_index: usize,
    pending_output: VecDeque<FlattenEventCursor>,
}

impl ProgressiveEventAssembler {
    fn new(options: &CompileOptions, max_batch_events: NonZeroUsize) -> Self {
        Self {
            max_batch_events,
            shallow_event_values: options.shallow_event_values,
            include_event_annotations: options.include_event_annotations,
            enabled: !options.recovery,
            validation: ProgressiveValidationState::new(options),
            next_sequence: 0,
            next_event_index: 0,
            pending_output: VecDeque::new(),
        }
    }

    fn push_completed_bindings(
        &mut self,
        bindings: Vec<Binding>,
        max_batches: usize,
    ) -> Vec<ProvisionalEventBatch> {
        self.queue_bindings(bindings);
        self.take_batches(max_batches)
    }

    fn finish_bindings(
        &mut self,
        remaining: Vec<Binding>,
        max_batches: usize,
    ) -> Vec<ProvisionalEventBatch> {
        self.queue_bindings(remaining);
        self.take_batches(max_batches)
    }

    fn observe_structured_comments(&mut self, count: usize, error: Option<Diagnostic>) {
        self.validation.observe_structured_comments(count, error);
    }

    fn queue_bindings(&mut self, bindings: Vec<Binding>) {
        if !self.enabled {
            return;
        }

        self.validation.observe_bindings(&bindings);
        for binding in bindings.into_iter().filter(|binding| !binding.is_header) {
            let mut event_count = 0;
            for item in FlattenValidationCursor::new(
                &binding,
                self.shallow_event_values,
                self.include_event_annotations,
            ) {
                self.validation
                    .observe_references(&item.reference_targets, &item.reference_steps);
                self.validation
                    .observe_events(std::slice::from_ref(&item.event));
                event_count += 1;
            }
            self.pending_output.push_back(FlattenEventCursor::new(
                binding,
                self.shallow_event_values,
                self.include_event_annotations,
                event_count,
            ));
        }
    }

    fn take_batches(&mut self, max_batches: usize) -> Vec<ProvisionalEventBatch> {
        let mut batches = Vec::with_capacity(max_batches.min(self.pending_output.len()));
        while batches.len() < max_batches && !self.pending_output.is_empty() {
            let mut events = Vec::with_capacity(self.max_batch_events.get());
            while events.len() < self.max_batch_events.get() {
                let Some(cursor) = self.pending_output.front_mut() else {
                    break;
                };
                if let Some(event) = cursor.next() {
                    events.push(event);
                } else {
                    self.pending_output.pop_front();
                }
            }
            if events.is_empty() {
                continue;
            }
            let batch = EventBatches::new(events, self.max_batch_events)
                .next()
                .expect("non-empty bounded events must produce one batch");
            let provisional = ProvisionalEventBatch {
                sequence: self.next_sequence,
                first_event_index: self.next_event_index,
                batch,
            };
            self.next_sequence += 1;
            self.next_event_index += provisional.events().len();
            batches.push(provisional);
        }
        batches
    }

    fn has_pending_output(&self) -> bool {
        !self.pending_output.is_empty()
    }

    fn pending_event_count(&self) -> usize {
        self.pending_output
            .iter()
            .map(FlattenEventCursor::remaining_events)
            .sum()
    }

    fn pending_cursor_count(&self) -> usize {
        self.pending_output.len()
    }

    fn pending_ast_slot_bytes(&self) -> usize {
        self.pending_output
            .iter()
            .map(FlattenEventCursor::retained_ast_slot_bytes)
            .sum()
    }

    fn into_pending_output(self) -> ProgressivePendingOutput {
        ProgressivePendingOutput {
            max_batch_events: self.max_batch_events,
            next_sequence: self.next_sequence,
            next_event_index: self.next_event_index,
            cursors: self.pending_output,
        }
    }

    fn validation_errors(&self) -> Vec<Diagnostic> {
        self.validation.errors()
    }

    fn validation_retention(&self) -> ProgressiveValidationRetention {
        self.validation.retention()
    }
}

#[derive(Debug)]
struct ProgressivePendingOutput {
    max_batch_events: NonZeroUsize,
    next_sequence: usize,
    next_event_index: usize,
    cursors: VecDeque<FlattenEventCursor>,
}

impl ProgressivePendingOutput {
    fn take_batches(&mut self, max_batches: usize) -> Vec<ProvisionalEventBatch> {
        let mut batches = Vec::with_capacity(max_batches.min(self.cursors.len()));
        while batches.len() < max_batches && !self.cursors.is_empty() {
            let mut events = Vec::with_capacity(self.max_batch_events.get());
            while events.len() < self.max_batch_events.get() {
                let Some(cursor) = self.cursors.front_mut() else {
                    break;
                };
                if let Some(event) = cursor.next() {
                    events.push(event);
                } else {
                    self.cursors.pop_front();
                }
            }
            if events.is_empty() {
                continue;
            }
            let batch = EventBatches::new(events, self.max_batch_events)
                .next()
                .expect("non-empty bounded events must produce one batch");
            let provisional = ProvisionalEventBatch {
                sequence: self.next_sequence,
                first_event_index: self.next_event_index,
                batch,
            };
            self.next_sequence += 1;
            self.next_event_index += provisional.events().len();
            batches.push(provisional);
        }
        batches
    }

    fn has_pending_output(&self) -> bool {
        !self.cursors.is_empty()
    }

    fn pending_event_count(&self) -> usize {
        self.cursors
            .iter()
            .map(FlattenEventCursor::remaining_events)
            .sum()
    }

    fn pending_cursor_count(&self) -> usize {
        self.cursors.len()
    }

    fn pending_ast_slot_bytes(&self) -> usize {
        self.cursors
            .iter()
            .map(FlattenEventCursor::retained_ast_slot_bytes)
            .sum()
    }
}

pub(crate) struct ProgressiveSofiaFrontend {
    parser: IncrementalSofiaFrontend,
    events: ProgressiveEventAssembler,
}

pub(crate) struct ProgressiveSofiaFinish {
    pub(crate) final_batches: Vec<ProvisionalEventBatch>,
    /// This only means the provisional stream can proceed to semantic
    /// validation. It is not final whole-document acceptance.
    pub(crate) parse_valid: bool,
    pub(crate) retention_fallback: bool,
    pub(crate) parse_errors: Vec<Diagnostic>,
    pub(crate) prevalidation_errors: Vec<Diagnostic>,
    pub(crate) prevalidated_event_count: usize,
    pub(crate) prevalidated_effective_mode: BehaviorMode,
    pub(crate) prevalidated_gp_profile_active: bool,
    pub(crate) prevalidated_structured_comment_count: usize,
    pub(crate) prevalidated_reference_datatype_claim_count: usize,
    pub(crate) prevalidated_reference_claim_count: usize,
    validation_retention: ProgressiveValidationRetention,
    pending_output: ProgressivePendingOutput,
}

impl ProgressiveSofiaFrontend {
    pub(crate) fn new(options: &CompileOptions, max_batch_events: NonZeroUsize) -> Self {
        Self {
            parser: IncrementalSofiaFrontend::new(options),
            events: ProgressiveEventAssembler::new(options, max_batch_events),
        }
    }

    pub(crate) fn push_str(
        &mut self,
        chunk: &str,
        max_batches: usize,
    ) -> Vec<ProvisionalEventBatch> {
        self.parser.push_str(chunk);
        let bindings = self.parser.take_completed_bindings();
        let batches = self.events.push_completed_bindings(bindings, max_batches);
        let (count, error) = self.parser.structured_comment_state();
        self.events.observe_structured_comments(count, error);
        batches
    }

    fn take_batches(&mut self, max_batches: usize) -> Vec<ProvisionalEventBatch> {
        self.events.take_batches(max_batches)
    }

    fn has_pending_output(&self) -> bool {
        self.events.has_pending_output()
    }

    fn retention(&self) -> (IncrementalSofiaRetention, ProgressiveValidationRetention) {
        (self.parser.retention(), self.events.validation_retention())
    }

    pub(crate) fn finish(self, source: &str, max_batches: usize) -> ProgressiveSofiaFinish {
        self.finish_inner(Some(source), max_batches)
    }

    pub(crate) fn finish_without_replay(self, max_batches: usize) -> ProgressiveSofiaFinish {
        self.finish_inner(None, max_batches)
    }

    fn finish_inner(self, source: Option<&str>, max_batches: usize) -> ProgressiveSofiaFinish {
        let Self { parser, mut events } = self;
        let incremental = match source {
            Some(source) => parser.finish(source),
            None => parser.finish_without_replay(),
        };
        events.observe_structured_comments(
            incremental.structured_comment_count,
            incremental.structured_comment_error.clone(),
        );
        let parse_valid = !incremental.retention_fallback && incremental.parsed.errors.is_empty();
        let final_batches = if parse_valid {
            events.finish_bindings(incremental.parsed.bindings, max_batches)
        } else {
            Vec::new()
        };
        let validation = events.validation_retention();
        ProgressiveSofiaFinish {
            final_batches,
            parse_valid,
            retention_fallback: incremental.retention_fallback,
            parse_errors: incremental.parsed.errors,
            prevalidation_errors: events.validation_errors(),
            prevalidated_event_count: validation.event_count,
            prevalidated_effective_mode: validation
                .effective_mode
                .expect("active validation state must retain an effective mode"),
            prevalidated_gp_profile_active: validation.gp_profile_active,
            prevalidated_structured_comment_count: validation.structured_comment_count,
            prevalidated_reference_datatype_claim_count: validation.reference_datatype_claim_count,
            prevalidated_reference_claim_count: validation.reference_claim_count,
            validation_retention: validation,
            pending_output: events.into_pending_output(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressiveLifecycleState {
    Accepting,
    Draining,
    TerminalReady,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressiveLifecycleProgress {
    NeedMoreInput {
        pending_batches: usize,
    },
    BatchAvailable {
        pending_batches: usize,
        backpressured: bool,
    },
    /// The attempted input or finish operation was not consumed.
    Backpressured {
        pending_batches: usize,
    },
    Draining {
        pending_batches: usize,
    },
    TerminalReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProgressiveLifecycleError {
    operation: &'static str,
    state: ProgressiveLifecycleState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProgressiveDisposition {
    Accepted {
        result: CompileResult,
        event_count: usize,
    },
    Invalidated {
        result: CompileResult,
        exposed_event_count: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressiveOutputMode {
    Compact,
    Rich(SourceRetention),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProgressiveRetentionSnapshot {
    pub accepted_input_bytes: usize,
    pub compact_output: bool,
    pub source_retained: bool,
    pub source_bytes: usize,
    pub source_capacity_bytes: usize,
    pub lexer_active_bytes: usize,
    pub parser_token_count: usize,
    pub parser_token_storage_bytes: usize,
    pub parser_frame_count: usize,
    pub structural_identity_count: usize,
    pub structural_identity_storage_bytes: usize,
    pub completed_binding_count: usize,
    pub completed_binding_storage_bytes: usize,
    pub released_completed_binding_count: usize,
    pub validation_effective_mode: Option<BehaviorMode>,
    pub validation_has_declared_profile: bool,
    pub validation_gp_profile_active: bool,
    pub validation_header_field_count: usize,
    pub validation_header_string_bytes: usize,
    pub validation_structured_comment_count: usize,
    pub validation_has_structured_comment_error: bool,
    pub validation_reference_datatype_claim_count: usize,
    pub validation_datatype_target_count: usize,
    pub validation_datatype_target_string_bytes: usize,
    pub validation_reference_datatype_claim_string_bytes: usize,
    pub validation_reference_target_count: usize,
    pub validation_reference_target_string_bytes: usize,
    pub validation_reference_step_count: usize,
    pub validation_reference_claim_count: usize,
    pub validation_reference_step_string_bytes: usize,
    pub validation_retained_candidate_error_count: usize,
    pub validation_event_count: usize,
    pub validation_seen_path_count: usize,
    pub validation_seen_path_string_bytes: usize,
    pub prevalidation_error_count: usize,
    pub ready_batch_count: usize,
    pub ready_event_count: usize,
    pub ready_event_slot_bytes: usize,
    pub staged_batch_count: usize,
    pub staged_cursor_count: usize,
    pub staged_event_count: usize,
    pub staged_event_slot_bytes: usize,
    pub staged_ast_slot_bytes: usize,
    pub terminal_source_capacity_bytes: usize,
    pub terminal_event_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressiveRetentionBounds {
    pub max_lexer_active_bytes: usize,
    pub max_ready_batch_count: usize,
    pub max_ready_event_count: usize,
    pub max_ready_event_slot_bytes: usize,
}

impl ProgressiveRetentionBounds {
    fn new(
        options: &CompileOptions,
        max_batch_events: NonZeroUsize,
        max_pending_batches: NonZeroUsize,
    ) -> Self {
        let max_ready_event_count = max_batch_events
            .get()
            .saturating_mul(max_pending_batches.get());
        Self {
            max_lexer_active_bytes: retained_token_byte_limit(options),
            max_ready_batch_count: max_pending_batches.get(),
            max_ready_event_count,
            max_ready_event_slot_bytes: max_ready_event_count
                .saturating_mul(std::mem::size_of::<crate::AssignmentEvent>()),
        }
    }

    fn validate(self, retention: ProgressiveRetentionSnapshot) -> Result<(), String> {
        let mut violations = Vec::new();
        if retention.lexer_active_bytes > self.max_lexer_active_bytes {
            violations.push(format!(
                "lexer active bytes {} exceed {}",
                retention.lexer_active_bytes, self.max_lexer_active_bytes
            ));
        }
        if retention.ready_batch_count > self.max_ready_batch_count {
            violations.push(format!(
                "ready batches {} exceed {}",
                retention.ready_batch_count, self.max_ready_batch_count
            ));
        }
        if retention.ready_event_count > self.max_ready_event_count {
            violations.push(format!(
                "ready events {} exceed {}",
                retention.ready_event_count, self.max_ready_event_count
            ));
        }
        if retention.ready_event_slot_bytes > self.max_ready_event_slot_bytes {
            violations.push(format!(
                "ready event slots {} bytes exceed {} bytes",
                retention.ready_event_slot_bytes, self.max_ready_event_slot_bytes
            ));
        }
        if retention.staged_event_slot_bytes != 0 {
            violations.push(format!(
                "staged events retain {} materialized slot bytes",
                retention.staged_event_slot_bytes
            ));
        }
        if retention.completed_binding_count != 0 || retention.completed_binding_storage_bytes != 0
        {
            violations.push(format!(
                "parser retains {} completed bindings in {} bytes of slots",
                retention.completed_binding_count, retention.completed_binding_storage_bytes
            ));
        }
        if retention.compact_output
            && (retention.source_retained
                || retention.source_bytes != 0
                || retention.source_capacity_bytes != 0
                || retention.terminal_source_capacity_bytes != 0
                || retention.terminal_event_count != 0)
        {
            violations.push(String::from(
                "compact output retains source or terminal result storage",
            ));
        }
        if violations.is_empty() {
            Ok(())
        } else {
            Err(violations.join("; "))
        }
    }
}

impl ProgressiveRetentionSnapshot {
    pub(crate) fn accounted_shallow_bytes(&self) -> usize {
        self.source_capacity_bytes
            .saturating_add(self.lexer_active_bytes)
            .saturating_add(self.parser_token_storage_bytes)
            .saturating_add(self.structural_identity_storage_bytes)
            .saturating_add(self.completed_binding_storage_bytes)
            .saturating_add(self.validation_header_string_bytes)
            .saturating_add(self.validation_seen_path_string_bytes)
            .saturating_add(self.validation_datatype_target_string_bytes)
            .saturating_add(self.validation_reference_datatype_claim_string_bytes)
            .saturating_add(self.validation_reference_target_string_bytes)
            .saturating_add(self.validation_reference_step_string_bytes)
            .saturating_add(self.ready_event_slot_bytes)
            .saturating_add(self.staged_event_slot_bytes)
            .saturating_add(self.staged_ast_slot_bytes)
            .saturating_add(self.terminal_source_capacity_bytes)
    }

    #[cfg(feature = "sofia-bench")]
    fn observe_peak(&mut self, current: Self) {
        macro_rules! observe_max {
            ($($field:ident),+ $(,)?) => {
                $(self.$field = self.$field.max(current.$field);)+
            };
        }
        observe_max!(
            accepted_input_bytes,
            source_bytes,
            source_capacity_bytes,
            lexer_active_bytes,
            parser_token_count,
            parser_token_storage_bytes,
            parser_frame_count,
            structural_identity_count,
            structural_identity_storage_bytes,
            completed_binding_count,
            completed_binding_storage_bytes,
            released_completed_binding_count,
            validation_header_field_count,
            validation_header_string_bytes,
            validation_structured_comment_count,
            validation_reference_datatype_claim_count,
            validation_datatype_target_count,
            validation_datatype_target_string_bytes,
            validation_reference_datatype_claim_string_bytes,
            validation_reference_target_count,
            validation_reference_target_string_bytes,
            validation_reference_step_count,
            validation_reference_claim_count,
            validation_reference_step_string_bytes,
            validation_retained_candidate_error_count,
            validation_event_count,
            validation_seen_path_count,
            validation_seen_path_string_bytes,
            prevalidation_error_count,
            ready_batch_count,
            ready_event_count,
            ready_event_slot_bytes,
            staged_batch_count,
            staged_cursor_count,
            staged_event_count,
            staged_event_slot_bytes,
            staged_ast_slot_bytes,
            terminal_source_capacity_bytes,
            terminal_event_count,
        );
        self.compact_output |= current.compact_output;
        self.source_retained |= current.source_retained;
        self.validation_has_declared_profile |= current.validation_has_declared_profile;
        self.validation_gp_profile_active |= current.validation_gp_profile_active;
        self.validation_has_structured_comment_error |=
            current.validation_has_structured_comment_error;
        if current.validation_effective_mode.is_some() {
            self.validation_effective_mode = current.validation_effective_mode;
        }
    }
}

#[cfg(feature = "sofia-bench")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressiveBenchmarkReport {
    pub result: CompileResult,
    pub accepted: bool,
    pub accepted_event_count: Option<usize>,
    pub delivered_event_count: usize,
    pub exposed_event_count: usize,
    pub retention_bounds: ProgressiveRetentionBounds,
    pub peak_accounted_shallow_bytes: usize,
    pub retention_peaks: ProgressiveRetentionSnapshot,
}

pub(crate) struct ProgressiveCompiler {
    frontend: Option<ProgressiveSofiaFrontend>,
    options: Option<CompileOptions>,
    output_mode: ProgressiveOutputMode,
    source: Option<String>,
    accepted_input_bytes: usize,
    terminal_validation_retention: Option<ProgressiveValidationRetention>,
    retention_bounds: ProgressiveRetentionBounds,
    max_pending_batches: NonZeroUsize,
    pending: VecDeque<ProvisionalEventBatch>,
    terminal_output: Option<ProgressivePendingOutput>,
    exposed_event_count: usize,
    state: ProgressiveLifecycleState,
    terminal: Option<ProgressiveDisposition>,
}

impl ProgressiveCompiler {
    pub(crate) fn new(
        options: CompileOptions,
        max_batch_events: NonZeroUsize,
        max_pending_batches: NonZeroUsize,
    ) -> Self {
        Self::with_output_mode(
            options,
            max_batch_events,
            max_pending_batches,
            ProgressiveOutputMode::Rich(SourceRetention::Retain),
        )
    }

    pub(crate) fn new_compact(
        mut options: CompileOptions,
        max_batch_events: NonZeroUsize,
        max_pending_batches: NonZeroUsize,
    ) -> Self {
        assert!(
            !options.recovery,
            "compact progressive mode forbids recovery"
        );
        options.shallow_event_values = true;
        options.emit_binding_projections = false;
        options.include_header = false;
        options.include_event_annotations = false;
        Self::with_output_mode(
            options,
            max_batch_events,
            max_pending_batches,
            ProgressiveOutputMode::Compact,
        )
    }

    pub(crate) fn new_rich(
        options: CompileOptions,
        source_retention: SourceRetention,
        max_batch_events: NonZeroUsize,
        max_pending_batches: NonZeroUsize,
    ) -> Self {
        Self::with_output_mode(
            options,
            max_batch_events,
            max_pending_batches,
            ProgressiveOutputMode::Rich(source_retention),
        )
    }

    fn with_output_mode(
        options: CompileOptions,
        max_batch_events: NonZeroUsize,
        max_pending_batches: NonZeroUsize,
        output_mode: ProgressiveOutputMode,
    ) -> Self {
        let retention_bounds =
            ProgressiveRetentionBounds::new(&options, max_batch_events, max_pending_batches);
        Self {
            frontend: Some(ProgressiveSofiaFrontend::new(&options, max_batch_events)),
            options: Some(options),
            output_mode,
            source: matches!(output_mode, ProgressiveOutputMode::Rich(_)).then(String::new),
            accepted_input_bytes: 0,
            terminal_validation_retention: None,
            retention_bounds,
            max_pending_batches,
            pending: VecDeque::new(),
            terminal_output: None,
            exposed_event_count: 0,
            state: ProgressiveLifecycleState::Accepting,
            terminal: None,
        }
    }

    pub(crate) const fn state(&self) -> ProgressiveLifecycleState {
        self.state
    }

    pub(crate) fn buffered_bytes(&self) -> usize {
        self.source.as_ref().map_or(0, String::len)
    }

    pub(crate) const fn accepted_input_bytes(&self) -> usize {
        self.accepted_input_bytes
    }

    pub(crate) fn pending_batches(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn retention(&self) -> ProgressiveRetentionSnapshot {
        let (incremental, validation) = self.frontend.as_ref().map_or_else(
            || {
                (
                    IncrementalSofiaRetention::default(),
                    self.terminal_validation_retention.unwrap_or_default(),
                )
            },
            ProgressiveSofiaFrontend::retention,
        );
        let (terminal_source_capacity_bytes, terminal_event_count) =
            self.terminal
                .as_ref()
                .map_or((0, 0), |terminal| match terminal {
                    ProgressiveDisposition::Accepted { result, .. }
                    | ProgressiveDisposition::Invalidated { result, .. } => {
                        (result.source.capacity(), result.events.len())
                    }
                });
        let (staged_batch_count, staged_cursor_count, staged_event_count, staged_ast_slot_bytes) =
            self.frontend
                .as_ref()
                .map(|frontend| {
                    let events = frontend.events.pending_event_count();
                    (
                        events.div_ceil(frontend.events.max_batch_events.get()),
                        frontend.events.pending_cursor_count(),
                        events,
                        frontend.events.pending_ast_slot_bytes(),
                    )
                })
                .or_else(|| {
                    self.terminal_output.as_ref().map(|output| {
                        let events = output.pending_event_count();
                        (
                            events.div_ceil(output.max_batch_events.get()),
                            output.pending_cursor_count(),
                            events,
                            output.pending_ast_slot_bytes(),
                        )
                    })
                })
                .unwrap_or((0, 0, 0, 0));
        ProgressiveRetentionSnapshot {
            accepted_input_bytes: self.accepted_input_bytes,
            compact_output: matches!(self.output_mode, ProgressiveOutputMode::Compact),
            source_retained: self.source.is_some(),
            source_bytes: self.source.as_ref().map_or(0, String::len),
            source_capacity_bytes: self.source.as_ref().map_or(0, String::capacity),
            lexer_active_bytes: incremental.lexer_active_bytes,
            parser_token_count: incremental.parser_token_count,
            parser_token_storage_bytes: incremental.parser_token_storage_bytes,
            parser_frame_count: incremental.parser_frame_count,
            structural_identity_count: incremental.structural_identity_count,
            structural_identity_storage_bytes: incremental.structural_identity_storage_bytes,
            completed_binding_count: incremental.completed_binding_count,
            completed_binding_storage_bytes: incremental.completed_binding_storage_bytes,
            released_completed_binding_count: incremental.released_completed_binding_count,
            validation_effective_mode: validation.effective_mode,
            validation_has_declared_profile: validation.has_declared_profile,
            validation_gp_profile_active: validation.gp_profile_active,
            validation_header_field_count: validation.header_field_count,
            validation_header_string_bytes: validation.header_string_bytes,
            validation_structured_comment_count: validation.structured_comment_count,
            validation_has_structured_comment_error: validation.has_structured_comment_error,
            validation_reference_datatype_claim_count: validation.reference_datatype_claim_count,
            validation_datatype_target_count: validation.datatype_target_count,
            validation_datatype_target_string_bytes: validation.datatype_target_string_bytes,
            validation_reference_datatype_claim_string_bytes: validation
                .reference_datatype_claim_string_bytes,
            validation_reference_target_count: validation.reference_target_count,
            validation_reference_target_string_bytes: validation.reference_target_string_bytes,
            validation_reference_step_count: validation.reference_step_count,
            validation_reference_claim_count: validation.reference_claim_count,
            validation_reference_step_string_bytes: validation.reference_step_string_bytes,
            validation_retained_candidate_error_count: validation.retained_candidate_error_count,
            validation_event_count: validation.event_count,
            validation_seen_path_count: validation.seen_path_count,
            validation_seen_path_string_bytes: validation.seen_path_string_bytes,
            prevalidation_error_count: validation.error_count,
            ready_batch_count: self.pending.len(),
            ready_event_count: self.pending.iter().map(|batch| batch.events().len()).sum(),
            ready_event_slot_bytes: self
                .pending
                .iter()
                .map(|batch| batch.batch.retained_event_slot_bytes())
                .sum(),
            staged_batch_count,
            staged_cursor_count,
            staged_event_count,
            staged_event_slot_bytes: 0,
            staged_ast_slot_bytes,
            terminal_source_capacity_bytes,
            terminal_event_count,
        }
    }

    fn validate_retention_bounds(&self) -> Result<(), String> {
        self.retention_bounds.validate(self.retention())
    }

    pub(crate) fn is_backpressured(&self) -> bool {
        self.pending.len() == self.max_pending_batches.get()
            || self
                .frontend
                .as_ref()
                .is_some_and(ProgressiveSofiaFrontend::has_pending_output)
            || self
                .terminal_output
                .as_ref()
                .is_some_and(ProgressivePendingOutput::has_pending_output)
    }

    pub(crate) fn push_str(
        &mut self,
        chunk: &str,
    ) -> Result<ProgressiveLifecycleProgress, ProgressiveLifecycleError> {
        self.require_state("push", ProgressiveLifecycleState::Accepting)?;
        if self.is_backpressured() {
            return Ok(self.backpressured_progress());
        }

        self.accepted_input_bytes = self.accepted_input_bytes.saturating_add(chunk.len());
        if let Some(source) = &mut self.source {
            source.push_str(chunk);
        }
        let available = self
            .max_pending_batches
            .get()
            .saturating_sub(self.pending.len());
        let batches = self
            .frontend
            .as_mut()
            .expect("accepting progressive compiler must retain its front end")
            .push_str(chunk, available);
        self.enqueue(batches);
        Ok(self.accepting_progress())
    }

    pub(crate) fn finish(
        &mut self,
    ) -> Result<ProgressiveLifecycleProgress, ProgressiveLifecycleError> {
        self.require_state("finish", ProgressiveLifecycleState::Accepting)?;
        if self.is_backpressured() {
            return Ok(self.backpressured_progress());
        }

        let frontend = self
            .frontend
            .take()
            .expect("accepting progressive compiler must retain its front end");
        let available = self
            .max_pending_batches
            .get()
            .saturating_sub(self.pending.len());
        let finished = match self.output_mode {
            ProgressiveOutputMode::Compact => frontend.finish_without_replay(available),
            ProgressiveOutputMode::Rich(_) => frontend.finish(
                self.source
                    .as_deref()
                    .expect("rich progressive mode must retain replay source"),
                available,
            ),
        };
        self.terminal_validation_retention = Some(finished.validation_retention);
        let options = self
            .options
            .take()
            .expect("accepting progressive compiler must retain options");
        let recovery = options.recovery;
        let result = match self.output_mode {
            ProgressiveOutputMode::Compact => {
                let errors = if let Some(error) =
                    input_size_diagnostic_for_len(self.accepted_input_bytes, &options)
                {
                    vec![error]
                } else if !finished.parse_errors.is_empty() {
                    finished.parse_errors.clone()
                } else {
                    finished.prevalidation_errors.clone()
                };
                CompileResult {
                    source: String::new(),
                    events: Vec::new(),
                    errors,
                    warnings: compile_portability_warnings(&options),
                    bindings: Vec::new(),
                    header: None,
                }
            }
            ProgressiveOutputMode::Rich(source_retention) => {
                let source = self
                    .source
                    .take()
                    .expect("rich progressive mode must retain replay source");
                // Completed streaming ASTs have already been released. Replay
                // the retained source through the authoritative Sofia pipeline
                // so rich result construction remains exactly compatible.
                let mut result =
                    compile_owned_with_implementation(source, options, ParserImplementation::Sofia);
                if source_retention == SourceRetention::Discard {
                    result.source = String::new();
                }
                result
            }
        };

        if matches!(self.output_mode, ProgressiveOutputMode::Rich(_))
            && result.errors.is_empty()
            && finished.parse_valid
            && !recovery
        {
            debug_assert_eq!(finished.prevalidated_event_count, result.events.len());
        }
        if result.errors.is_empty()
            && finished.parse_valid
            && finished.prevalidation_errors.is_empty()
        {
            let event_count = match self.output_mode {
                ProgressiveOutputMode::Compact => finished.prevalidated_event_count,
                ProgressiveOutputMode::Rich(_) => result.events.len(),
            };
            self.enqueue(finished.final_batches);
            self.terminal_output = Some(finished.pending_output);
            self.state = if self.pending.is_empty()
                && !self
                    .terminal_output
                    .as_ref()
                    .is_some_and(ProgressivePendingOutput::has_pending_output)
            {
                ProgressiveLifecycleState::TerminalReady
            } else {
                ProgressiveLifecycleState::Draining
            };
            self.terminal = Some(ProgressiveDisposition::Accepted {
                result,
                event_count,
            });
        } else {
            self.pending.clear();
            self.terminal_output = None;
            self.state = ProgressiveLifecycleState::TerminalReady;
            self.terminal = Some(ProgressiveDisposition::Invalidated {
                result,
                exposed_event_count: self.exposed_event_count,
            });
        }

        Ok(self.progress())
    }

    pub(crate) fn pull_batch(&mut self) -> Option<ProvisionalEventBatch> {
        let batch = self.pending.pop_front()?;
        self.exposed_event_count += batch.events().len();
        self.refill_pending();
        if self.state == ProgressiveLifecycleState::Draining
            && self.pending.is_empty()
            && !self
                .terminal_output
                .as_ref()
                .is_some_and(ProgressivePendingOutput::has_pending_output)
        {
            self.state = ProgressiveLifecycleState::TerminalReady;
        }
        Some(batch)
    }

    pub(crate) fn take_terminal(
        &mut self,
    ) -> Result<ProgressiveDisposition, ProgressiveLifecycleError> {
        self.require_state("take terminal", ProgressiveLifecycleState::TerminalReady)?;
        let terminal = self
            .terminal
            .take()
            .expect("terminal-ready compiler must retain a disposition");
        self.state = ProgressiveLifecycleState::Complete;
        Ok(terminal)
    }

    fn enqueue(&mut self, batches: Vec<ProvisionalEventBatch>) {
        debug_assert!(self.pending.len() + batches.len() <= self.max_pending_batches.get());
        self.pending.extend(batches);
    }

    fn refill_pending(&mut self) {
        let available = self
            .max_pending_batches
            .get()
            .saturating_sub(self.pending.len());
        if available == 0 {
            return;
        }
        let batches = if let Some(frontend) = &mut self.frontend {
            frontend.take_batches(available)
        } else if let Some(output) = &mut self.terminal_output {
            output.take_batches(available)
        } else {
            Vec::new()
        };
        self.pending.extend(batches);
        if self
            .terminal_output
            .as_ref()
            .is_some_and(|output| !output.has_pending_output())
        {
            self.terminal_output = None;
        }
    }

    fn progress(&self) -> ProgressiveLifecycleProgress {
        match self.state {
            ProgressiveLifecycleState::Accepting => self.accepting_progress(),
            ProgressiveLifecycleState::Draining => ProgressiveLifecycleProgress::Draining {
                pending_batches: self.pending.len(),
            },
            ProgressiveLifecycleState::TerminalReady => ProgressiveLifecycleProgress::TerminalReady,
            ProgressiveLifecycleState::Complete => {
                unreachable!("complete lifecycle has no further progress")
            }
        }
    }

    fn backpressured_progress(&self) -> ProgressiveLifecycleProgress {
        ProgressiveLifecycleProgress::Backpressured {
            pending_batches: self.pending.len(),
        }
    }

    fn accepting_progress(&self) -> ProgressiveLifecycleProgress {
        if self.pending.is_empty() {
            ProgressiveLifecycleProgress::NeedMoreInput { pending_batches: 0 }
        } else {
            ProgressiveLifecycleProgress::BatchAvailable {
                pending_batches: self.pending.len(),
                backpressured: self.is_backpressured(),
            }
        }
    }

    fn require_state(
        &self,
        operation: &'static str,
        expected: ProgressiveLifecycleState,
    ) -> Result<(), ProgressiveLifecycleError> {
        if self.state == expected {
            Ok(())
        } else {
            Err(ProgressiveLifecycleError {
                operation,
                state: self.state,
            })
        }
    }
}

#[cfg(feature = "sofia-bench")]
fn observe_benchmark_retention(
    compiler: &ProgressiveCompiler,
    peaks: &mut ProgressiveRetentionSnapshot,
    peak_accounted_shallow_bytes: &mut usize,
) -> Result<(), String> {
    let current = compiler.retention();
    compiler.retention_bounds.validate(current)?;
    *peak_accounted_shallow_bytes =
        (*peak_accounted_shallow_bytes).max(current.accounted_shallow_bytes());
    peaks.observe_peak(current);
    Ok(())
}

#[cfg(feature = "sofia-bench")]
fn drain_benchmark_backpressure(
    compiler: &mut ProgressiveCompiler,
    delivered_event_count: &mut usize,
) -> Result<(), String> {
    while compiler.is_backpressured() {
        let batch = compiler
            .pull_batch()
            .ok_or_else(|| String::from("progressive backpressure had no pending batch"))?;
        *delivered_event_count = delivered_event_count.saturating_add(batch.events().len());
        compiler.validate_retention_bounds()?;
    }
    Ok(())
}

/// Drives the crate-private compact progressive path from a fixed-size byte
/// stream for repository memory measurements.
#[cfg(feature = "sofia-bench")]
#[doc(hidden)]
pub fn benchmark_compact_progressive_sofia(
    mut reader: impl Read,
    options: CompileOptions,
    chunk_bytes: NonZeroUsize,
    max_batch_events: NonZeroUsize,
    max_pending_batches: NonZeroUsize,
) -> Result<ProgressiveBenchmarkReport, String> {
    if options.recovery {
        return Err(String::from(
            "compact progressive benchmark mode forbids recovery",
        ));
    }

    let mut compiler =
        ProgressiveCompiler::new_compact(options, max_batch_events, max_pending_batches);
    let mut decoder = Utf8Decoder::default();
    let mut input = vec![0; chunk_bytes.get()];
    let mut delivered_event_count = 0usize;
    let mut peaks = ProgressiveRetentionSnapshot::default();
    let mut peak_accounted_shallow_bytes = 0usize;
    observe_benchmark_retention(&compiler, &mut peaks, &mut peak_accounted_shallow_bytes)?;

    loop {
        let read = reader
            .read(&mut input)
            .map_err(|error| format!("failed to read progressive input: {error}"))?;
        if read == 0 {
            break;
        }

        let mut lifecycle_error = None;
        decoder
            .push(&input[..read], |_, text| {
                if lifecycle_error.is_some() {
                    return;
                }
                if let Err(error) =
                    drain_benchmark_backpressure(&mut compiler, &mut delivered_event_count)
                {
                    lifecycle_error = Some(error);
                    return;
                }
                if let Err(error) = compiler.push_str(text) {
                    lifecycle_error = Some(format!("progressive push failed: {error:?}"));
                    return;
                }
                if let Err(error) = observe_benchmark_retention(
                    &compiler,
                    &mut peaks,
                    &mut peak_accounted_shallow_bytes,
                ) {
                    lifecycle_error = Some(error);
                }
            })
            .map_err(|error| {
                format!(
                    "invalid UTF-8 at byte {} (error length {:?})",
                    error.valid_up_to, error.error_len
                )
            })?;
        if let Some(error) = lifecycle_error {
            return Err(error);
        }
        drain_benchmark_backpressure(&mut compiler, &mut delivered_event_count)?;
    }
    decoder.finish().map_err(|error| {
        format!(
            "incomplete UTF-8 at byte {} (error length {:?})",
            error.valid_up_to, error.error_len
        )
    })?;

    loop {
        drain_benchmark_backpressure(&mut compiler, &mut delivered_event_count)?;
        let progress = compiler
            .finish()
            .map_err(|error| format!("progressive finish failed: {error:?}"))?;
        observe_benchmark_retention(&compiler, &mut peaks, &mut peak_accounted_shallow_bytes)?;
        match progress {
            ProgressiveLifecycleProgress::Backpressured { .. } => {}
            ProgressiveLifecycleProgress::Draining { .. }
            | ProgressiveLifecycleProgress::TerminalReady => break,
            progress => return Err(format!("unexpected finish progress: {progress:?}")),
        }
    }
    while let Some(batch) = compiler.pull_batch() {
        delivered_event_count = delivered_event_count.saturating_add(batch.events().len());
    }
    observe_benchmark_retention(&compiler, &mut peaks, &mut peak_accounted_shallow_bytes)?;

    let terminal = compiler
        .take_terminal()
        .map_err(|error| format!("progressive terminal result failed: {error:?}"))?;
    let (result, accepted, accepted_event_count, exposed_event_count) = match terminal {
        ProgressiveDisposition::Accepted {
            result,
            event_count,
        } => (result, true, Some(event_count), delivered_event_count),
        ProgressiveDisposition::Invalidated {
            result,
            exposed_event_count,
        } => (result, false, None, exposed_event_count),
    };
    Ok(ProgressiveBenchmarkReport {
        result,
        accepted,
        accepted_event_count,
        delivered_event_count,
        exposed_event_count,
        retention_bounds: compiler.retention_bounds,
        peak_accounted_shallow_bytes,
        retention_peaks: peaks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token_parser::ParserImplementation;
    use crate::{SourcePlane, compile_owned_with_implementation};

    fn collect_progressive(
        source: &str,
        options: &CompileOptions,
        batch_size: usize,
    ) -> (Vec<ProvisionalEventBatch>, ProgressiveSofiaFinish) {
        let mut frontend = ProgressiveSofiaFrontend::new(
            options,
            NonZeroUsize::new(batch_size).expect("test batch size must be non-zero"),
        );
        let mut batches = Vec::new();
        for scalar in source.chars() {
            batches.extend(frontend.push_str(scalar.encode_utf8(&mut [0; 4]), usize::MAX));
        }
        let finished = frontend.finish(source, usize::MAX);
        (batches, finished)
    }

    fn compile_through_progressive_lifecycle(
        source: &str,
        options: CompileOptions,
    ) -> (Vec<crate::AssignmentEvent>, ProgressiveDisposition) {
        let mut compiler = ProgressiveCompiler::new(
            options,
            NonZeroUsize::new(2).expect("two is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        );
        let mut events = Vec::new();

        for scalar in source.chars() {
            let mut encoded = [0; 4];
            let chunk = scalar.encode_utf8(&mut encoded);
            loop {
                match compiler
                    .push_str(chunk)
                    .expect("push state should be valid")
                {
                    ProgressiveLifecycleProgress::Backpressured { .. } => events.extend(
                        compiler
                            .pull_batch()
                            .expect("backpressure must expose a pending batch")
                            .into_events(),
                    ),
                    ProgressiveLifecycleProgress::NeedMoreInput { .. }
                    | ProgressiveLifecycleProgress::BatchAvailable { .. } => break,
                    progress => panic!("unexpected push progress: {progress:?}"),
                }
            }
        }

        loop {
            match compiler.finish().expect("finish state should be valid") {
                ProgressiveLifecycleProgress::Backpressured { .. } => events.extend(
                    compiler
                        .pull_batch()
                        .expect("finish backpressure must expose a pending batch")
                        .into_events(),
                ),
                ProgressiveLifecycleProgress::Draining { .. }
                | ProgressiveLifecycleProgress::TerminalReady => break,
                progress => panic!("unexpected finish progress: {progress:?}"),
            }
        }
        while let Some(batch) = compiler.pull_batch() {
            events.extend(batch.into_events());
        }
        let terminal = compiler
            .take_terminal()
            .expect("drained compiler must expose its terminal disposition");
        (events, terminal)
    }

    fn finish_progressive_compiler(compiler: &mut ProgressiveCompiler) -> ProgressiveDisposition {
        while compiler.is_backpressured() {
            compiler
                .pull_batch()
                .expect("backpressure must expose a pending batch");
        }
        loop {
            match compiler.finish().expect("finish state should be valid") {
                ProgressiveLifecycleProgress::Backpressured { .. } => {
                    compiler
                        .pull_batch()
                        .expect("finish backpressure must expose a pending batch");
                }
                ProgressiveLifecycleProgress::Draining { .. }
                | ProgressiveLifecycleProgress::TerminalReady => break,
                progress => panic!("unexpected finish progress: {progress:?}"),
            }
        }
        while compiler.pull_batch().is_some() {}
        compiler
            .take_terminal()
            .expect("drained compiler must expose its terminal disposition")
    }

    #[test]
    fn progressive_batches_match_final_event_order_and_payloads() {
        let source = concat!(
            "aeon:header = { mode = \"transport\", profile = \"core\" }\n",
            "first:uint32 = 1\n",
            "nested@{note:string = \"kept\"} = { child:string = \"yes\", items = [2, 3] }\n",
            "last = true",
        );
        for options in [
            CompileOptions::default(),
            CompileOptions {
                shallow_event_values: true,
                ..CompileOptions::default()
            },
            CompileOptions {
                include_event_annotations: false,
                ..CompileOptions::default()
            },
        ] {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            assert!(expected.errors.is_empty(), "{:?}", expected.errors);

            let (mut batches, finished) = collect_progressive(source, &options, 2);
            assert!(finished.parse_valid);
            assert!(!finished.retention_fallback);
            batches.extend(finished.final_batches);

            let mut next_event_index = 0;
            for (sequence, batch) in batches.iter().enumerate() {
                assert_eq!(batch.sequence(), sequence);
                assert_eq!(batch.first_event_index(), next_event_index);
                assert!(!batch.events().is_empty());
                assert!(batch.events().len() <= 2);
                assert!(
                    batch
                        .events()
                        .iter()
                        .all(|event| event.source_plane == SourcePlane::Body)
                );
                next_event_index += batch.events().len();
            }

            let actual = batches
                .into_iter()
                .flat_map(ProvisionalEventBatch::into_events)
                .collect::<Vec<_>>();
            assert_eq!(actual, expected.events);
        }
    }

    #[test]
    fn progressive_batches_are_withheld_in_recovery_mode() {
        let source = "first = 1\nsecond = 2";
        let options = CompileOptions {
            recovery: true,
            ..CompileOptions::default()
        };
        let (batches, finished) = collect_progressive(source, &options, 1);
        assert!(batches.is_empty());
        assert!(finished.final_batches.is_empty());
        assert!(finished.parse_valid);
    }

    #[test]
    fn later_parse_failure_invalidates_earlier_provisional_batches() {
        let source = "first = 1\nbroken = [2,,3]";
        let options = CompileOptions::default();
        let (batches, finished) = collect_progressive(source, &options, 1);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].events()[0].key, "first");
        assert!(!finished.parse_valid);
        assert!(!finished.parse_errors.is_empty());
        assert!(finished.final_batches.is_empty());
    }

    #[test]
    fn owned_provisional_batches_are_mutation_isolated() {
        let source = "first = 1\nsecond = 2\nthird = 3";
        let options = CompileOptions::default();
        let (mut batches, finished) = collect_progressive(source, &options, 1);
        batches.extend(finished.final_batches);
        assert_eq!(batches.len(), 3);

        let second_key = batches[1].events()[0].key.clone();
        let mut first = batches.remove(0).into_events();
        first[0].key.push_str("-mutated");

        assert_eq!(second_key, "second");
        assert_eq!(batches[0].events()[0].key, second_key);
        assert_eq!(batches[1].events()[0].key, "third");
    }

    #[test]
    fn bounded_pending_queue_applies_lossless_pull_backpressure() {
        let first_chunk = "wide = [1, 2, 3, 4, 5]\nnext =";
        let retry_chunk = " 6";
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        );

        assert_eq!(
            compiler.push_str(first_chunk),
            Ok(ProgressiveLifecycleProgress::BatchAvailable {
                pending_batches: 2,
                backpressured: true,
            })
        );
        assert_eq!(compiler.pending_batches(), 2);
        let accepted_bytes = compiler.buffered_bytes();
        assert_eq!(
            compiler.finish(),
            Ok(ProgressiveLifecycleProgress::Backpressured { pending_batches: 2 })
        );
        assert_eq!(compiler.state(), ProgressiveLifecycleState::Accepting);
        assert_eq!(
            compiler.push_str(retry_chunk),
            Ok(ProgressiveLifecycleProgress::Backpressured { pending_batches: 2 })
        );
        assert_eq!(compiler.buffered_bytes(), accepted_bytes);

        let mut events = Vec::new();
        while compiler.is_backpressured() {
            events.extend(
                compiler
                    .pull_batch()
                    .expect("backpressured compiler must expose a batch")
                    .into_events(),
            );
            assert!(compiler.pending_batches() <= 2);
        }

        assert!(matches!(
            compiler.push_str(retry_chunk),
            Ok(ProgressiveLifecycleProgress::BatchAvailable {
                backpressured: false,
                ..
            })
        ));
        assert!(matches!(
            compiler.finish(),
            Ok(ProgressiveLifecycleProgress::Draining { .. })
        ));
        assert!(compiler.take_terminal().is_err());

        while let Some(batch) = compiler.pull_batch() {
            events.extend(batch.into_events());
        }
        assert_eq!(compiler.state(), ProgressiveLifecycleState::TerminalReady);
        let ProgressiveDisposition::Accepted {
            result,
            event_count,
        } = compiler.take_terminal().expect("terminal should be ready")
        else {
            panic!("valid stream should be accepted");
        };
        assert_eq!(event_count, result.events.len());
        assert_eq!(events, result.events);
        assert_eq!(compiler.state(), ProgressiveLifecycleState::Complete);
        assert_eq!(
            compiler.push_str("ignored"),
            Err(ProgressiveLifecycleError {
                operation: "push",
                state: ProgressiveLifecycleState::Complete,
            })
        );
        assert_eq!(
            compiler.finish(),
            Err(ProgressiveLifecycleError {
                operation: "finish",
                state: ProgressiveLifecycleState::Complete,
            })
        );
    }

    #[test]
    fn semantic_failure_clears_queued_output_and_invalidates_exposed_events() {
        let source = "first = 1\nsecond = 2\ncopy = ~missing";
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(4).expect("four is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::BatchAvailable {
                pending_batches: 2,
                backpressured: false,
            })
        ));
        let exposed = compiler
            .pull_batch()
            .expect("first provisional batch should be available");
        assert_eq!(exposed.events()[0].key, "first");

        assert_eq!(
            compiler.finish(),
            Ok(ProgressiveLifecycleProgress::TerminalReady)
        );
        assert_eq!(compiler.pending_batches(), 0);
        assert!(compiler.pull_batch().is_none());
        let ProgressiveDisposition::Invalidated {
            result,
            exposed_event_count,
        } = compiler
            .take_terminal()
            .expect("invalidation should be ready")
        else {
            panic!("unresolved reference should invalidate the stream");
        };
        assert_eq!(exposed_event_count, 1);
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "MISSING_REFERENCE_TARGET");
    }

    #[test]
    fn recovery_mode_reaches_acceptance_without_provisional_delivery() {
        let source = "first = 1\nsecond = 2";
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions {
                recovery: true,
                ..CompileOptions::default()
            },
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(1).expect("one is non-zero"),
        );
        assert_eq!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::NeedMoreInput { pending_batches: 0 })
        );
        assert_eq!(
            compiler.finish(),
            Ok(ProgressiveLifecycleProgress::TerminalReady)
        );
        assert!(compiler.pull_batch().is_none());
        let ProgressiveDisposition::Accepted {
            result,
            event_count,
        } = compiler.take_terminal().expect("result should be accepted")
        else {
            panic!("valid recovery-mode document should be accepted");
        };
        assert_eq!(event_count, 2);
        assert_eq!(result.events.len(), 2);
    }

    #[test]
    fn lifecycle_terminal_results_match_one_shot_sofia_across_outcomes() {
        let cases = [
            (
                "valid nested",
                concat!(
                    "aeon:mode = \"transport\"\n",
                    "root = { child:string = \"yes\", items = [1, 2, 3] }\n",
                    "copy = ~root.child",
                ),
                CompileOptions::default(),
            ),
            (
                "shallow without annotations",
                "root@{note:string = \"x\"} = { child = [1, 2] }",
                CompileOptions {
                    shallow_event_values: true,
                    include_event_annotations: false,
                    ..CompileOptions::default()
                },
            ),
            (
                "recovery withholding",
                "first = 1\nsecond = 2",
                CompileOptions {
                    recovery: true,
                    ..CompileOptions::default()
                },
            ),
            (
                "semantic invalidation",
                "first = 1\ncopy = ~missing",
                CompileOptions::default(),
            ),
            (
                "syntax invalidation",
                "first = 1\nbroken = [2,,3]",
                CompileOptions::default(),
            ),
            (
                "event limit invalidation",
                "first = 1\nsecond = 2",
                CompileOptions {
                    max_events: Some(1),
                    ..CompileOptions::default()
                },
            ),
            (
                "active token fallback",
                "first = 1\nlarge = 1234",
                CompileOptions {
                    max_numeric_literal_characters: 3,
                    ..CompileOptions::default()
                },
            ),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            let (events, disposition) =
                compile_through_progressive_lifecycle(source, options.clone());
            match disposition {
                ProgressiveDisposition::Accepted {
                    result,
                    event_count,
                } => {
                    assert!(expected.errors.is_empty(), "{name}");
                    assert_eq!(result, expected, "{name}");
                    assert_eq!(event_count, result.events.len(), "{name}");
                    if options.recovery {
                        assert!(events.is_empty(), "{name}");
                    } else {
                        assert_eq!(events, result.events, "{name}");
                    }
                }
                ProgressiveDisposition::Invalidated { result, .. } => {
                    assert!(!expected.errors.is_empty(), "{name}");
                    assert_eq!(result, expected, "{name}");
                }
            }
        }
    }

    #[test]
    fn conservative_internal_fallback_invalidates_but_preserves_valid_result() {
        let source = "first = 1";
        let options = CompileOptions {
            max_numeric_literal_characters: 1,
            ..CompileOptions::default()
        };
        let expected = compile_owned_with_implementation(
            source.to_owned(),
            options.clone(),
            ParserImplementation::Sofia,
        );
        assert!(expected.errors.is_empty());

        let (events, disposition) = compile_through_progressive_lifecycle(source, options);
        assert!(events.is_empty());
        let ProgressiveDisposition::Invalidated {
            result,
            exposed_event_count,
        } = disposition
        else {
            panic!("internal fallback must invalidate the progressive stream");
        };
        assert_eq!(exposed_event_count, 0);
        assert_eq!(result, expected);
    }

    #[test]
    fn compact_mode_discards_source_while_matching_validation_only_results() {
        let cases = [
            ("valid", "first = 1\nsecond:string = \"two\""),
            ("semantic invalidation", "first = 1\ncopy = ~missing"),
            ("syntax invalidation", "first = 1\nbroken = [2,,3]"),
        ];

        for (name, source) in cases {
            let validation_options = CompileOptions {
                shallow_event_values: true,
                emit_binding_projections: false,
                include_header: false,
                include_event_annotations: false,
                ..CompileOptions::default()
            };
            let mut expected = compile_owned_with_implementation(
                source.to_owned(),
                validation_options,
                ParserImplementation::Sofia,
            );
            expected.source.clear();

            let mut compiler = ProgressiveCompiler::new_compact(
                CompileOptions::default(),
                NonZeroUsize::new(2).expect("two is non-zero"),
                NonZeroUsize::new(8).expect("eight is non-zero"),
            );
            let mut accepted_bytes = 0;
            for scalar in source.chars() {
                let mut encoded = [0; 4];
                let chunk = scalar.encode_utf8(&mut encoded);
                assert!(!compiler.is_backpressured(), "{name}");
                compiler.push_str(chunk).expect("push should succeed");
                accepted_bytes += chunk.len();
                assert_eq!(compiler.buffered_bytes(), 0, "{name}");
                assert_eq!(compiler.accepted_input_bytes(), accepted_bytes, "{name}");
                let retained = compiler.retention();
                assert!(retained.compact_output, "{name}");
                assert!(!retained.source_retained, "{name}");
                assert_eq!(retained.source_bytes, 0, "{name}");
                assert_eq!(retained.source_capacity_bytes, 0, "{name}");
            }

            match finish_progressive_compiler(&mut compiler) {
                ProgressiveDisposition::Accepted {
                    result,
                    event_count,
                } => {
                    assert_eq!(name, "valid");
                    assert_eq!(event_count, 2);
                    assert_eq!(result, expected);
                }
                ProgressiveDisposition::Invalidated { result, .. } => {
                    assert_ne!(name, "valid");
                    assert_eq!(result, expected);
                }
            }
            let retained = compiler.retention();
            assert_eq!(retained.accepted_input_bytes, source.len(), "{name}");
            assert_eq!(retained.terminal_source_capacity_bytes, 0, "{name}");
            assert_eq!(retained.terminal_event_count, 0, "{name}");
        }
    }

    #[test]
    fn rich_mode_applies_terminal_source_retention_policy() {
        let source = "first = 1\nsecond = 2";
        let options = CompileOptions::default();
        let expected = compile_owned_with_implementation(
            source.to_owned(),
            options.clone(),
            ParserImplementation::Sofia,
        );

        for source_retention in [SourceRetention::Retain, SourceRetention::Discard] {
            let mut compiler = ProgressiveCompiler::new_rich(
                options.clone(),
                source_retention,
                NonZeroUsize::new(2).expect("two is non-zero"),
                NonZeroUsize::new(8).expect("eight is non-zero"),
            );
            compiler.push_str(source).expect("push should succeed");
            assert_eq!(compiler.buffered_bytes(), source.len());
            assert_eq!(compiler.accepted_input_bytes(), source.len());
            let retained = compiler.retention();
            assert!(!retained.compact_output);
            assert!(retained.source_retained);

            let ProgressiveDisposition::Accepted { result, .. } =
                finish_progressive_compiler(&mut compiler)
            else {
                panic!("valid rich stream should be accepted");
            };
            let mut expected_for_policy = expected.clone();
            if source_retention == SourceRetention::Discard {
                expected_for_policy.source.clear();
                assert_eq!(result.source.capacity(), 0);
            }
            assert_eq!(result, expected_for_policy);
        }
    }

    #[test]
    fn compact_mode_preserves_input_limit_precedence_without_source_replay() {
        let source = "broken = [";
        let options = CompileOptions {
            max_input_bytes: Some(5),
            ..CompileOptions::default()
        };
        let mut expected_options = options.clone();
        expected_options.shallow_event_values = true;
        expected_options.emit_binding_projections = false;
        expected_options.include_header = false;
        expected_options.include_event_annotations = false;
        let mut expected = compile_owned_with_implementation(
            source.to_owned(),
            expected_options,
            ParserImplementation::Sofia,
        );
        expected.source.clear();

        let mut compiler = ProgressiveCompiler::new_compact(
            options,
            NonZeroUsize::new(2).expect("two is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        );
        compiler.push_str(source).expect("push should succeed");
        let ProgressiveDisposition::Invalidated { result, .. } =
            finish_progressive_compiler(&mut compiler)
        else {
            panic!("oversized stream should be invalidated");
        };
        assert_eq!(result, expected);
        assert_eq!(result.errors[0].code, "INPUT_SIZE_EXCEEDED");
        assert_eq!(compiler.buffered_bytes(), 0);
    }

    #[test]
    fn compact_mode_reports_when_internal_fallback_would_require_replay() {
        let mut compiler = ProgressiveCompiler::new_compact(
            CompileOptions {
                max_numeric_literal_characters: 1,
                ..CompileOptions::default()
            },
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        );
        compiler.push_str("first = 1").expect("push should succeed");
        let ProgressiveDisposition::Invalidated {
            result,
            exposed_event_count,
        } = finish_progressive_compiler(&mut compiler)
        else {
            panic!("fallback without retained source must invalidate");
        };
        assert_eq!(exposed_event_count, 0);
        assert_eq!(result.source, "");
        assert_eq!(result.events, Vec::new());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "SOFIA_INCREMENTAL_REPLAY_REQUIRED");
        assert_eq!(compiler.buffered_bytes(), 0);
    }

    #[cfg(feature = "sofia-bench")]
    #[test]
    fn compact_benchmark_driver_streams_split_utf8_without_source_retention() {
        let source = "first = \"🌊\"\nsecond = ~first";
        let report = benchmark_compact_progressive_sofia(
            std::io::Cursor::new(source.as_bytes()),
            CompileOptions::default(),
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        )
        .expect("valid UTF-8 stream should compile");

        assert!(report.accepted);
        assert!(report.result.errors.is_empty());
        assert_eq!(report.accepted_event_count, Some(2));
        assert_eq!(report.delivered_event_count, 2);
        assert_eq!(report.exposed_event_count, 2);
        assert_eq!(report.retention_bounds.max_lexer_active_bytes, 1_024);
        assert_eq!(report.retention_bounds.max_ready_batch_count, 2);
        assert_eq!(report.retention_bounds.max_ready_event_count, 2);
        assert_eq!(
            report.retention_bounds.max_ready_event_slot_bytes,
            2 * std::mem::size_of::<crate::AssignmentEvent>()
        );
        report
            .retention_bounds
            .validate(report.retention_peaks)
            .expect("reported compact retention must satisfy its bounds");
        assert_eq!(report.retention_peaks.accepted_input_bytes, source.len());
        assert!(report.retention_peaks.compact_output);
        assert!(!report.retention_peaks.source_retained);
        assert_eq!(report.retention_peaks.source_bytes, 0);
        assert_eq!(report.retention_peaks.source_capacity_bytes, 0);
        assert_eq!(report.retention_peaks.terminal_source_capacity_bytes, 0);
        assert_eq!(report.retention_peaks.terminal_event_count, 0);
    }

    #[test]
    fn compact_retention_bounds_reject_every_constant_bound_violation() {
        let bounds = ProgressiveRetentionBounds::new(
            &CompileOptions::default(),
            NonZeroUsize::new(2).expect("two is non-zero"),
            NonZeroUsize::new(3).expect("three is non-zero"),
        );
        let retention = ProgressiveRetentionSnapshot {
            compact_output: true,
            source_retained: true,
            lexer_active_bytes: bounds.max_lexer_active_bytes + 1,
            completed_binding_count: 1,
            completed_binding_storage_bytes: 1,
            ready_batch_count: bounds.max_ready_batch_count + 1,
            ready_event_count: bounds.max_ready_event_count + 1,
            ready_event_slot_bytes: bounds.max_ready_event_slot_bytes + 1,
            staged_event_slot_bytes: 1,
            terminal_event_count: 1,
            ..ProgressiveRetentionSnapshot::default()
        };

        let error = bounds
            .validate(retention)
            .expect_err("every configured compact retention bound is exceeded");
        for category in [
            "lexer active bytes",
            "ready batches",
            "ready events",
            "ready event slots",
            "staged events",
            "completed bindings",
            "compact output",
        ] {
            assert!(error.contains(category), "missing {category}: {error}");
        }
    }

    #[test]
    fn retention_snapshot_separates_ready_staged_parser_ast_and_source_state() {
        let first_chunk = "wide = [1, 2, 3, 4, 5]\nnext =";
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(1).expect("one is non-zero"),
            NonZeroUsize::new(2).expect("two is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(first_chunk),
            Ok(ProgressiveLifecycleProgress::BatchAvailable {
                backpressured: true,
                ..
            })
        ));

        let retained = compiler.retention();
        assert_eq!(retained.source_bytes, first_chunk.len());
        assert!(retained.source_capacity_bytes >= retained.source_bytes);
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.completed_binding_storage_bytes, 0);
        assert_eq!(retained.released_completed_binding_count, 1);
        assert_eq!(retained.validation_event_count, 6);
        assert_eq!(retained.validation_seen_path_count, 6);
        assert!(retained.validation_seen_path_string_bytes > 0);
        assert_eq!(retained.prevalidation_error_count, 0);
        assert!(retained.parser_token_count <= 4);
        assert_eq!(retained.ready_batch_count, 2);
        assert_eq!(retained.ready_event_count, 2);
        assert_eq!(retained.staged_batch_count, 4);
        assert_eq!(retained.staged_cursor_count, 1);
        assert_eq!(retained.staged_event_count, 4);
        assert!(retained.ready_event_slot_bytes > 0);
        assert_eq!(retained.staged_event_slot_bytes, 0);
        assert!(retained.staged_ast_slot_bytes > 0);
        assert!(retained.accounted_shallow_bytes() >= retained.source_capacity_bytes);

        let before_events = retained.ready_event_count + retained.staged_event_count;
        let _ = compiler
            .pull_batch()
            .expect("retained snapshot fixture must expose a batch");
        let after_pull = compiler.retention();
        assert_eq!(
            after_pull.ready_event_count + after_pull.staged_event_count,
            before_events - 1
        );
        assert!(after_pull.ready_batch_count <= 2);
    }

    #[test]
    fn flat_stream_releases_completed_ast_while_bounding_tokens() {
        let bindings = (0..128)
            .map(|index| format!("key_{index} = {index}\n"))
            .collect::<String>();
        let source = format!("{bindings}pending =");
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(16).expect("sixteen is non-zero"),
            NonZeroUsize::new(1).expect("one is non-zero"),
        );

        for scalar in source.chars() {
            let mut encoded = [0; 4];
            let chunk = scalar.encode_utf8(&mut encoded);
            loop {
                match compiler.push_str(chunk).expect("push should remain valid") {
                    ProgressiveLifecycleProgress::Backpressured { .. } => {
                        let _ = compiler
                            .pull_batch()
                            .expect("backpressure must expose a batch");
                    }
                    ProgressiveLifecycleProgress::NeedMoreInput { .. }
                    | ProgressiveLifecycleProgress::BatchAvailable { .. } => break,
                    progress => panic!("unexpected accepting progress: {progress:?}"),
                }
            }
        }

        let retained = compiler.retention();
        assert_eq!(retained.source_bytes, source.len());
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.completed_binding_storage_bytes, 0);
        assert_eq!(retained.released_completed_binding_count, 128);
        assert_eq!(retained.validation_event_count, 128);
        assert_eq!(retained.validation_seen_path_count, 128);
        assert!(retained.validation_seen_path_string_bytes > 0);
        assert!(
            retained.parser_token_count <= 4,
            "flat parser retained {} tokens",
            retained.parser_token_count
        );
        assert!(retained.parser_token_storage_bytes > 0);
        assert!(retained.parser_frame_count > 0);
        assert!(retained.ready_batch_count <= 1);
    }

    #[test]
    fn compact_prevalidation_matches_authoritative_resource_and_uniqueness_errors() {
        let string_limited = CompileOptions {
            max_string_codepoints: 3,
            ..CompileOptions::default()
        };
        let event_limited = CompileOptions {
            max_events: Some(1),
            ..CompileOptions::default()
        };
        let depth_limited = CompileOptions {
            max_path_depth: 1,
            ..CompileOptions::default()
        };
        let cases = [
            (
                "duplicate path",
                "same = 1\nsame = 2",
                CompileOptions::default(),
            ),
            ("string resource", "name = \"long\"", string_limited),
            ("event count", "first = 1\nsecond = 2", event_limited),
            ("path depth", "root = { child = 1 }", depth_limited),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            assert!(!expected.errors.is_empty(), "{name}");
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
        }
    }

    #[test]
    fn compact_prevalidation_matches_structured_comment_limits_and_precedence() {
        let comment_limited = CompileOptions {
            max_structured_comment_characters: 2,
            ..CompileOptions::default()
        };
        let binding_precedes_comment = CompileOptions {
            max_structured_comment_characters: 1,
            max_key_segment_codepoints: 2,
            ..CompileOptions::default()
        };
        let cases = [
            (
                "line comment unicode boundary",
                "//@🌊🌊\nvalue = 1",
                comment_limited.clone(),
                1,
            ),
            (
                "line comment unicode overflow",
                "//@🌊🌊🌊\nvalue = 1",
                comment_limited.clone(),
                1,
            ),
            (
                "block comment overflow",
                "/@abc@/\nvalue = 1",
                comment_limited.clone(),
                1,
            ),
            (
                "plain comments are not structured",
                "//plain text\n/*plain block*/\nvalue = 1",
                comment_limited,
                0,
            ),
            (
                "binding resource error precedes structured comment error",
                "//@abc\nlong = 1",
                binding_precedes_comment,
                1,
            ),
        ];

        for (name, source, options, expected_comment_count) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
            assert_eq!(
                finished.prevalidated_structured_comment_count, expected_comment_count,
                "{name}",
            );
        }
    }

    #[test]
    fn compact_prevalidation_matches_authoritative_header_errors() {
        let cases = [
            (
                "mixed header forms",
                concat!(
                    "aeon:header = { profile = \"core\" }\n",
                    "aeon:mode = \"strict\"\n",
                    "value:int32 = 1",
                ),
            ),
            (
                "late structured header",
                "value = 1\naeon:header = { mode = \"transport\" }",
            ),
            (
                "non-object structured header",
                "aeon:header = \"transport\"\nvalue = 1",
            ),
        ];

        for (name, source) in cases {
            let options = CompileOptions::default();
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            assert!(!expected.errors.is_empty(), "{name}");
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
        }
    }

    #[test]
    fn compact_prevalidation_matches_object_and_typed_mode_errors() {
        let transport_override = CompileOptions {
            mode: Some(BehaviorMode::Transport),
            ..CompileOptions::default()
        };
        let cases = [
            (
                "nested duplicate object member",
                "root = { same = 1, same = 2 }",
                CompileOptions::default(),
            ),
            (
                "shorthand strict mode",
                "aeon:mode = \"strict\"\nvalue = 1",
                CompileOptions::default(),
            ),
            (
                "structured custom mode",
                "aeon:header = { mode = \"custom\" }\nvalue = 1",
                CompileOptions::default(),
            ),
            (
                "late shorthand strict mode",
                "value = 1\naeon:mode = \"strict\"",
                CompileOptions::default(),
            ),
            (
                "transport option overrides strict header",
                "aeon:mode = \"strict\"\nvalue = 1",
                transport_override,
            ),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
            assert_eq!(
                finished.prevalidated_effective_mode,
                options.mode.unwrap_or_else(|| {
                    if source.contains("strict") {
                        BehaviorMode::Strict
                    } else if source.contains("custom") {
                        BehaviorMode::Custom
                    } else {
                        BehaviorMode::Transport
                    }
                }),
                "{name}",
            );
        }
    }

    #[test]
    fn compact_prevalidation_matches_direct_datatype_and_profile_errors() {
        let gp_option = CompileOptions {
            profile: Some(String::from("aeon.gp.profile.v1")),
            ..CompileOptions::default()
        };
        let validation_only = CompileOptions {
            shallow_event_values: true,
            emit_binding_projections: false,
            include_header: false,
            include_event_annotations: false,
            ..CompileOptions::default()
        };
        let cases = [
            (
                "literal mismatch",
                "value:string = 1",
                CompileOptions::default(),
            ),
            (
                "late strict reserved policy",
                "value:custom = 1\naeon:mode = \"strict\"",
                CompileOptions::default(),
            ),
            (
                "attribute mismatch",
                "value@{note:string=1}:n = 3",
                CompileOptions::default(),
            ),
            (
                "event errors precede attribute errors",
                concat!("first@{note:string=1}:string = 2\n", "second:string = 3",),
                CompileOptions::default(),
            ),
            (
                "late GP profile",
                "value:n[3] = 3\naeon:profile = \"aeon.gp.profile.v1\"",
                CompileOptions::default(),
            ),
            ("GP profile option", "value:n[3] = 3", gp_option),
            (
                "fail-closed duplicate suppresses event datatypes",
                "same:string = 1\nsame:string = 2",
                CompileOptions::default(),
            ),
            (
                "validation-only duplicate retains event datatypes",
                "same:string = 1\nsame:string = 2",
                validation_only,
            ),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            assert!(!expected.errors.is_empty(), "{name}");
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
        }
    }

    #[test]
    fn compact_prevalidation_resolves_reference_dependent_datatypes() {
        let strict_allow_custom = CompileOptions {
            datatype_policy: Some(crate::DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        };
        let validation_only = CompileOptions {
            shallow_event_values: true,
            emit_binding_projections: false,
            include_header: false,
            include_event_annotations: false,
            ..CompileOptions::default()
        };
        let cases = [
            (
                "valid backward reference",
                "target:string = \"x\"\ncopy:string = ~target",
                CompileOptions::default(),
            ),
            (
                "backward mismatch",
                "target:number = 1\ncopy:string = ~target",
                CompileOptions::default(),
            ),
            (
                "chained backward mismatch",
                "a:number = 1\nb:number = ~a\nc:string = ~b",
                CompileOptions::default(),
            ),
            (
                "forward mismatch precedes reference error",
                "copy:string = ~target\ntarget:number = 1",
                CompileOptions::default(),
            ),
            (
                "missing target retains reference kind",
                "copy:string = ~missing",
                CompileOptions::default(),
            ),
            (
                "self target retains reference kind",
                "copy:string = ~copy",
                CompileOptions::default(),
            ),
            (
                "pointer reference resolves target",
                "target:number = 1\ncopy:string = ~>target",
                CompileOptions::default(),
            ),
            (
                "attribute target mismatch",
                "target@{note = \"x\"}:number = 1\ncopy:number = ~target.@.note",
                CompileOptions::default(),
            ),
            (
                "container target matches generic custom datatype",
                "target:list = [1]\ncopy:items<number> = ~target",
                CompileOptions::default(),
            ),
            (
                "resolved and direct event errors retain source order",
                "target:number = 1\nfirst:string = ~target\nsecond:string = 2",
                CompileOptions::default(),
            ),
            (
                "late strict toggle alias",
                "target:toggle = on\ncopy:myToggle = ~target\naeon:mode = \"strict\"",
                strict_allow_custom,
            ),
            (
                "validation-only duplicate resolves last target",
                "same:number = 1\nsame:string = \"x\"\ncopy:number = ~same",
                validation_only,
            ),
            (
                "normal duplicate suppresses resolved event diagnostics",
                "same:number = 1\nsame:string = \"x\"\ncopy:number = ~same",
                CompileOptions::default(),
            ),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            let (_, finished) = collect_progressive(source, &options, 1);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
            assert!(
                finished.prevalidated_reference_datatype_claim_count > 0,
                "{name}",
            );
        }
    }

    #[test]
    fn compact_prevalidation_matches_authoritative_reference_errors() {
        let cases = [
            (
                "backward top-level reference",
                "target = 1\ncopy = ~target",
                CompileOptions::default(),
            ),
            (
                "forward top-level reference",
                "copy = ~target\ntarget = 1",
                CompileOptions::default(),
            ),
            (
                "missing top-level reference",
                "copy = ~missing",
                CompileOptions::default(),
            ),
            (
                "self top-level reference",
                "copy = ~copy",
                CompileOptions::default(),
            ),
            (
                "forward sequence reference",
                "items = [~items[1], 1]",
                CompileOptions::default(),
            ),
            (
                "attribute sibling ordering",
                "value@{first = ~value.@.later, later = 1} = 1",
                CompileOptions::default(),
            ),
            (
                "payload references own attribute",
                "value@{note = 1} = ~value.@.note",
                CompileOptions::default(),
            ),
            (
                "node attribute self reference",
                "widget:node = <card@{lookup = ~widget}:node>",
                CompileOptions::default(),
            ),
            (
                "reference attribute depth",
                "target = 1\ncopy = ~target.@.note.@.deep",
                CompileOptions::default(),
            ),
            (
                "profile reference and typed-mode phase order",
                concat!(
                    "aeon:mode = \"custom\"\n",
                    "aeon:profile = \"aeon.gp.profile.v1\"\n",
                    "profiled:n[3] = 3\n",
                    "copy = ~missing\n",
                    "untyped = 1",
                ),
                CompileOptions::default(),
            ),
        ];

        for (name, source, options) in cases {
            let expected = compile_owned_with_implementation(
                source.to_owned(),
                options.clone(),
                ParserImplementation::Sofia,
            );
            let (_, finished) = collect_progressive(source, &options, 8);
            assert!(finished.parse_valid, "{name}");
            assert_eq!(finished.prevalidation_errors, expected.errors, "{name}");
        }
    }

    #[test]
    fn retention_snapshot_counts_compact_reference_state() {
        let source = concat!(
            "target = 1\n",
            "backward = ~target\n",
            "forward = ~later\n",
            "later = 2\n",
            "pending =",
        );
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(8).expect("eight is non-zero"),
            NonZeroUsize::new(8).expect("eight is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::BatchAvailable { .. })
        ));

        let retained = compiler.retention();
        assert_eq!(retained.validation_reference_target_count, 4);
        assert!(retained.validation_reference_target_string_bytes > 0);
        assert_eq!(retained.validation_reference_step_count, 6);
        assert_eq!(retained.validation_reference_claim_count, 2);
        assert!(retained.validation_reference_step_string_bytes > 0);
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.released_completed_binding_count, 4);
        assert_eq!(retained.prevalidation_error_count, 1);
    }

    #[test]
    fn retention_snapshot_counts_datatype_profile_candidate_state() {
        let source = concat!(
            "value:string = 1\n",
            "profiled:n[3] = 3\n",
            "aeon:profile = \"aeon.gp.profile.v1\"\n",
            "copy:string = ~value\n",
            "pending =",
        );
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(8).expect("eight is non-zero"),
            NonZeroUsize::new(8).expect("eight is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::BatchAvailable { .. })
        ));

        let retained = compiler.retention();
        assert!(retained.validation_gp_profile_active);
        assert_eq!(retained.validation_reference_datatype_claim_count, 1);
        assert_eq!(retained.validation_datatype_target_count, 3);
        assert!(retained.validation_datatype_target_string_bytes > 0);
        assert!(retained.validation_reference_datatype_claim_string_bytes > 0);
        assert!(retained.validation_retained_candidate_error_count >= 4);
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.released_completed_binding_count, 4);
        assert_eq!(retained.prevalidation_error_count, 3);
    }

    #[test]
    fn retention_snapshot_counts_structured_comments_without_payload_storage() {
        let source = concat!(
            "//@ok\n",
            "// plain\n",
            "/@abc@/\n",
            "//!toolong\n",
            "pending =",
        );
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions {
                max_structured_comment_characters: 3,
                ..CompileOptions::default()
            },
            NonZeroUsize::new(8).expect("eight is non-zero"),
            NonZeroUsize::new(8).expect("eight is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::NeedMoreInput { .. })
        ));

        let retained = compiler.retention();
        assert_eq!(retained.validation_structured_comment_count, 3);
        assert!(retained.validation_has_structured_comment_error);
        assert_eq!(retained.prevalidation_error_count, 1);
        assert!(retained.lexer_active_bytes <= 1);
        assert_eq!(retained.completed_binding_count, 0);
    }

    #[test]
    fn retention_snapshot_counts_compact_header_mode_state() {
        let source = concat!(
            "aeon:header = { mode = \"strict\", profile = \"core\" }\n",
            "value:string = \"kept\"\n",
            "pending =",
        );
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(8).expect("eight is non-zero"),
            NonZeroUsize::new(8).expect("eight is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::BatchAvailable { .. })
        ));

        let retained = compiler.retention();
        assert_eq!(
            retained.validation_effective_mode,
            Some(BehaviorMode::Strict)
        );
        assert!(retained.validation_has_declared_profile);
        assert_eq!(retained.validation_header_field_count, 2);
        assert!(retained.validation_header_string_bytes >= "core".len());
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.released_completed_binding_count, 2);
        assert_eq!(retained.prevalidation_error_count, 0);
    }

    #[test]
    fn retention_snapshot_counts_required_structural_identity_state() {
        let source = "first\\one\\ = 1\nsecond\\two\\ = 2\npending =";
        let mut compiler = ProgressiveCompiler::new(
            CompileOptions::default(),
            NonZeroUsize::new(8).expect("eight is non-zero"),
            NonZeroUsize::new(8).expect("eight is non-zero"),
        );
        assert!(matches!(
            compiler.push_str(source),
            Ok(ProgressiveLifecycleProgress::BatchAvailable { .. })
        ));

        let retained = compiler.retention();
        assert_eq!(retained.structural_identity_count, 2);
        assert!(retained.structural_identity_storage_bytes > 0);
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.released_completed_binding_count, 2);
    }
}
