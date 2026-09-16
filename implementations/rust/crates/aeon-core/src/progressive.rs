#![allow(dead_code)]

use std::collections::{HashSet, VecDeque};
use std::mem;
use std::num::NonZeroUsize;

use crate::flatten::flatten_document;
use crate::header::IncrementalHeaderState;
use crate::resource_limits::{validate_binding_resource_limits, validate_event_path_limits};
use crate::token_parser::{
    IncrementalSofiaFrontend, IncrementalSofiaRetention, ParserImplementation,
};
use crate::validation::{
    validate_attribute_datatypes, validate_direct_event_datatypes,
    validate_duplicate_object_member_keys, validate_typed_mode_rules,
};
use crate::{
    BehaviorMode, Binding, CanonicalPath, CompileOptions, CompileResult, Diagnostic, EventBatch,
    EventBatches, SourcePlane, Value, compile_owned_with_implementation,
    event_count_exceeded_error, format_path, validate_gp_datatype_clarifiers,
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
    header: IncrementalHeaderState,
    event_count: usize,
    seen_event_paths: HashSet<(SourcePlane, String)>,
    source_resource_error: Option<Diagnostic>,
    duplicate_object_errors: Vec<Diagnostic>,
    event_path_error: Option<Diagnostic>,
    duplicate_errors: Vec<Diagnostic>,
    datatype_event_errors: ModeDiagnosticLedger,
    datatype_attribute_errors: ModeDiagnosticLedger,
    gp_profile_errors: Vec<Diagnostic>,
    deferred_reference_datatype_count: usize,
    typed_mode_errors: ModeDiagnosticLedger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct ProgressiveValidationRetention {
    effective_mode: Option<BehaviorMode>,
    has_declared_profile: bool,
    gp_profile_active: bool,
    header_field_count: usize,
    header_string_bytes: usize,
    deferred_reference_datatype_count: usize,
    retained_candidate_error_count: usize,
    event_count: usize,
    seen_path_count: usize,
    seen_path_string_bytes: usize,
    error_count: usize,
}

impl ProgressiveValidationState {
    fn new(options: &CompileOptions) -> Self {
        Self {
            options: options.clone(),
            header: IncrementalHeaderState::default(),
            event_count: 0,
            seen_event_paths: HashSet::new(),
            source_resource_error: None,
            duplicate_object_errors: Vec::new(),
            event_path_error: None,
            duplicate_errors: Vec::new(),
            datatype_event_errors: ModeDiagnosticLedger::default(),
            datatype_attribute_errors: ModeDiagnosticLedger::default(),
            gp_profile_errors: Vec::new(),
            deferred_reference_datatype_count: 0,
            typed_mode_errors: ModeDiagnosticLedger::default(),
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
            for binding in bindings.iter().filter(|binding| !binding.is_header) {
                validate_attribute_datatypes(
                    std::slice::from_ref(binding),
                    mode,
                    self.options.datatype_policy,
                    self.options.effective_max_clarifier_values(),
                    self.options.max_generic_depth,
                    self.datatype_attribute_errors.errors_mut(mode),
                );
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

    fn observe_events(&mut self, events: &[crate::AssignmentEvent]) {
        if self.event_path_error.is_none() {
            self.event_path_error = validate_event_path_limits(events, &self.options);
        }
        self.event_count = self.event_count.saturating_add(events.len());
        self.deferred_reference_datatype_count =
            self.deferred_reference_datatype_count.saturating_add(
                events
                    .iter()
                    .filter(|event| {
                        event.datatype.is_some()
                            && matches!(
                                event.value,
                                Value::CloneReference { .. } | Value::PointerReference { .. }
                            )
                    })
                    .count(),
            );
        let rendered_paths = events
            .iter()
            .map(|event| format_path(&event.path))
            .collect::<Vec<_>>();
        for (event, path) in events.iter().zip(&rendered_paths) {
            if !self
                .seen_event_paths
                .insert((event.source_plane, path.clone()))
            {
                self.duplicate_errors.push(
                    Diagnostic::new("DUPLICATE_KEY", format!("Duplicate key: '{}'", event.key))
                        .at_path(path.clone())
                        .with_span(event.span),
                );
            }
        }
        for &mode in self.candidate_modes() {
            validate_direct_event_datatypes(
                events,
                &rendered_paths,
                mode,
                self.options.datatype_policy,
                self.options.effective_max_clarifier_values(),
                self.options.max_generic_depth,
                self.datatype_event_errors.errors_mut(mode),
            );
        }
        validate_gp_datatype_clarifiers(events, &rendered_paths, &mut self.gp_profile_errors);
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
            errors.extend(self.effective_datatype_event_errors().iter().cloned());
        }
        errors.extend(self.effective_datatype_attribute_errors().iter().cloned());
        if self.gp_profile_active() && !self.fail_closed_duplicate_suppresses_events() {
            errors.extend(self.gp_profile_errors.iter().cloned());
        }
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

    fn effective_datatype_event_errors(&self) -> &[Diagnostic] {
        self.datatype_event_errors.errors(self.effective_mode())
    }

    fn effective_datatype_attribute_errors(&self) -> &[Diagnostic] {
        self.datatype_attribute_errors.errors(self.effective_mode())
    }

    fn effective_typed_mode_errors(&self) -> &[Diagnostic] {
        self.typed_mode_errors.errors(self.effective_mode())
    }

    fn retention(&self) -> ProgressiveValidationRetention {
        ProgressiveValidationRetention {
            effective_mode: Some(self.effective_mode()),
            has_declared_profile: self.header.declared_profile().is_some(),
            gp_profile_active: self.gp_profile_active(),
            header_field_count: self.header.observed_field_count(),
            header_string_bytes: self.header.retained_string_bytes(),
            deferred_reference_datatype_count: self.deferred_reference_datatype_count,
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
            error_count: usize::from(self.source_resource_error.is_some())
                + usize::from(self.header.error().is_some())
                + self.duplicate_object_errors.len()
                + usize::from(self.event_path_error.is_some())
                + self.duplicate_errors.len()
                + if self.fail_closed_duplicate_suppresses_events() {
                    0
                } else {
                    self.effective_datatype_event_errors().len()
                }
                + self.effective_datatype_attribute_errors().len()
                + if self.gp_profile_active() && !self.fail_closed_duplicate_suppresses_events() {
                    self.gp_profile_errors.len()
                } else {
                    0
                }
                + self.effective_typed_mode_errors().len(),
        }
    }
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
        }
    }

    fn push_completed_bindings(&mut self, bindings: &[Binding]) -> Vec<ProvisionalEventBatch> {
        self.batch_bindings(bindings)
    }

    fn finish_bindings(&mut self, remaining: &[Binding]) -> Vec<ProvisionalEventBatch> {
        self.batch_bindings(remaining)
    }

    fn batch_bindings(&mut self, bindings: &[Binding]) -> Vec<ProvisionalEventBatch> {
        if !self.enabled {
            return Vec::new();
        }

        self.validation.observe_bindings(bindings);
        let root = CanonicalPath::root();
        let mut events = Vec::new();
        for binding in bindings.iter().filter(|binding| !binding.is_header) {
            let flattened = flatten_document(
                std::slice::from_ref(binding),
                &root,
                self.shallow_event_values,
                false,
                self.include_event_annotations,
            );
            self.validation.observe_events(&flattened.events);
            events.extend(flattened.events);
        }

        EventBatches::new(events, self.max_batch_events)
            .map(|batch| {
                let provisional = ProvisionalEventBatch {
                    sequence: self.next_sequence,
                    first_event_index: self.next_event_index,
                    batch,
                };
                self.next_sequence += 1;
                self.next_event_index += provisional.events().len();
                provisional
            })
            .collect()
    }

    fn validation_errors(&self) -> Vec<Diagnostic> {
        self.validation.errors()
    }

    fn validation_retention(&self) -> ProgressiveValidationRetention {
        self.validation.retention()
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
    pub(crate) deferred_reference_datatype_count: usize,
}

impl ProgressiveSofiaFrontend {
    pub(crate) fn new(options: &CompileOptions, max_batch_events: NonZeroUsize) -> Self {
        Self {
            parser: IncrementalSofiaFrontend::new(options),
            events: ProgressiveEventAssembler::new(options, max_batch_events),
        }
    }

    pub(crate) fn push_str(&mut self, chunk: &str) -> Vec<ProvisionalEventBatch> {
        let bindings = self.parser.push_str(chunk);
        let batches = self.events.push_completed_bindings(bindings);
        self.parser.release_completed_bindings();
        batches
    }

    fn retention(&self) -> (IncrementalSofiaRetention, ProgressiveValidationRetention) {
        (self.parser.retention(), self.events.validation_retention())
    }

    pub(crate) fn finish(self, source: &str) -> ProgressiveSofiaFinish {
        let Self { parser, mut events } = self;
        let incremental = parser.finish(source);
        let parse_valid = !incremental.retention_fallback && incremental.parsed.errors.is_empty();
        let final_batches = if parse_valid {
            events.finish_bindings(&incremental.parsed.bindings)
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
            deferred_reference_datatype_count: validation.deferred_reference_datatype_count,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct ProgressiveRetentionSnapshot {
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
    pub validation_deferred_reference_datatype_count: usize,
    pub validation_retained_candidate_error_count: usize,
    pub validation_event_count: usize,
    pub validation_seen_path_count: usize,
    pub validation_seen_path_string_bytes: usize,
    pub prevalidation_error_count: usize,
    pub ready_batch_count: usize,
    pub ready_event_count: usize,
    pub ready_event_slot_bytes: usize,
    pub staged_batch_count: usize,
    pub staged_event_count: usize,
    pub staged_event_slot_bytes: usize,
    pub terminal_source_capacity_bytes: usize,
    pub terminal_event_count: usize,
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
            .saturating_add(self.ready_event_slot_bytes)
            .saturating_add(self.staged_event_slot_bytes)
            .saturating_add(self.terminal_source_capacity_bytes)
    }
}

pub(crate) struct ProgressiveCompiler {
    frontend: Option<ProgressiveSofiaFrontend>,
    options: Option<CompileOptions>,
    source: String,
    max_pending_batches: NonZeroUsize,
    pending: VecDeque<ProvisionalEventBatch>,
    deferred: VecDeque<ProvisionalEventBatch>,
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
        Self {
            frontend: Some(ProgressiveSofiaFrontend::new(&options, max_batch_events)),
            options: Some(options),
            source: String::new(),
            max_pending_batches,
            pending: VecDeque::new(),
            deferred: VecDeque::new(),
            exposed_event_count: 0,
            state: ProgressiveLifecycleState::Accepting,
            terminal: None,
        }
    }

    pub(crate) const fn state(&self) -> ProgressiveLifecycleState {
        self.state
    }

    pub(crate) fn buffered_bytes(&self) -> usize {
        self.source.len()
    }

    pub(crate) fn pending_batches(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn retention(&self) -> ProgressiveRetentionSnapshot {
        let (incremental, validation) = self.frontend.as_ref().map_or_else(
            || {
                (
                    IncrementalSofiaRetention::default(),
                    ProgressiveValidationRetention::default(),
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
        ProgressiveRetentionSnapshot {
            source_bytes: self.source.len(),
            source_capacity_bytes: self.source.capacity(),
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
            validation_deferred_reference_datatype_count: validation
                .deferred_reference_datatype_count,
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
            staged_batch_count: self.deferred.len(),
            staged_event_count: self.deferred.iter().map(|batch| batch.events().len()).sum(),
            staged_event_slot_bytes: self
                .deferred
                .iter()
                .map(|batch| batch.batch.retained_event_slot_bytes())
                .sum(),
            terminal_source_capacity_bytes,
            terminal_event_count,
        }
    }

    pub(crate) fn is_backpressured(&self) -> bool {
        self.pending.len() == self.max_pending_batches.get() || !self.deferred.is_empty()
    }

    pub(crate) fn push_str(
        &mut self,
        chunk: &str,
    ) -> Result<ProgressiveLifecycleProgress, ProgressiveLifecycleError> {
        self.require_state("push", ProgressiveLifecycleState::Accepting)?;
        if self.is_backpressured() {
            return Ok(self.backpressured_progress());
        }

        self.source.push_str(chunk);
        let batches = self
            .frontend
            .as_mut()
            .expect("accepting progressive compiler must retain its front end")
            .push_str(chunk);
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
        let finished = frontend.finish(&self.source);
        let options = self
            .options
            .take()
            .expect("accepting progressive compiler must retain options");
        let recovery = options.recovery;
        let source = mem::take(&mut self.source);
        // Completed streaming ASTs have already been released. Replay the
        // retained source through the authoritative Sofia pipeline so final
        // validation and rich result construction remain exactly compatible.
        let result =
            compile_owned_with_implementation(source, options, ParserImplementation::Sofia);

        if result.errors.is_empty() && finished.parse_valid && !recovery {
            debug_assert_eq!(finished.prevalidated_event_count, result.events.len());
        }
        if result.errors.is_empty()
            && finished.parse_valid
            && finished.prevalidation_errors.is_empty()
        {
            let event_count = result.events.len();
            self.enqueue(finished.final_batches);
            self.state = if self.pending.is_empty() && self.deferred.is_empty() {
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
            self.deferred.clear();
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
            && self.deferred.is_empty()
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
        self.deferred.extend(batches);
        self.refill_pending();
    }

    fn refill_pending(&mut self) {
        while self.pending.len() < self.max_pending_batches.get() {
            let Some(batch) = self.deferred.pop_front() else {
                break;
            };
            self.pending.push_back(batch);
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
            batches.extend(frontend.push_str(scalar.encode_utf8(&mut [0; 4])));
        }
        let finished = frontend.finish(source);
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
        assert_eq!(retained.staged_event_count, 4);
        assert!(retained.ready_event_slot_bytes > 0);
        assert!(retained.staged_event_slot_bytes > 0);
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
    fn reference_dependent_datatype_claims_are_explicitly_deferred() {
        let source = "target:number = 1\ncopy:string = ~target";
        let options = CompileOptions::default();
        let expected = compile_owned_with_implementation(
            source.to_owned(),
            options.clone(),
            ParserImplementation::Sofia,
        );
        assert_eq!(expected.errors.len(), 1);
        assert_eq!(expected.errors[0].code, "DATATYPE_LITERAL_MISMATCH");

        let (_, finished) = collect_progressive(source, &options, 8);
        assert!(finished.parse_valid);
        assert!(finished.prevalidation_errors.is_empty());
        assert_eq!(finished.deferred_reference_datatype_count, 1);

        let (_, disposition) = compile_through_progressive_lifecycle(source, options);
        let ProgressiveDisposition::Invalidated { result, .. } = disposition else {
            panic!("authoritative replay must invalidate the deferred mismatch");
        };
        assert_eq!(result, expected);
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
        assert_eq!(retained.validation_deferred_reference_datatype_count, 1);
        assert!(retained.validation_retained_candidate_error_count >= 4);
        assert_eq!(retained.completed_binding_count, 0);
        assert_eq!(retained.released_completed_binding_count, 4);
        assert_eq!(retained.prevalidation_error_count, 2);
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
