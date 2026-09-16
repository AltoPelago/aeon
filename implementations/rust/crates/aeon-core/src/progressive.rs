#![allow(dead_code)]

use std::num::NonZeroUsize;

use crate::flatten::flatten_document;
use crate::token_parser::{IncrementalSofiaFrontend, IncrementalSofiaResult};
use crate::{Binding, CanonicalPath, CompileOptions, EventBatch, EventBatches};

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

#[derive(Debug)]
struct ProgressiveEventAssembler {
    max_batch_events: NonZeroUsize,
    shallow_event_values: bool,
    include_event_annotations: bool,
    enabled: bool,
    observed_bindings: usize,
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
            observed_bindings: 0,
            next_sequence: 0,
            next_event_index: 0,
        }
    }

    fn push_completed_bindings(&mut self, bindings: &[Binding]) -> Vec<ProvisionalEventBatch> {
        self.observed_bindings += bindings.len();
        self.batch_bindings(bindings)
    }

    fn finish_bindings(&mut self, bindings: &[Binding]) -> Vec<ProvisionalEventBatch> {
        debug_assert!(self.observed_bindings <= bindings.len());
        let remaining = &bindings[self.observed_bindings..];
        self.observed_bindings = bindings.len();
        self.batch_bindings(remaining)
    }

    fn batch_bindings(&mut self, bindings: &[Binding]) -> Vec<ProvisionalEventBatch> {
        if !self.enabled {
            return Vec::new();
        }

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
}

pub(crate) struct ProgressiveSofiaFrontend {
    parser: IncrementalSofiaFrontend,
    events: ProgressiveEventAssembler,
}

pub(crate) struct ProgressiveSofiaFinish {
    pub(crate) incremental: IncrementalSofiaResult,
    pub(crate) final_batches: Vec<ProvisionalEventBatch>,
    /// This only means the provisional stream can proceed to semantic
    /// validation. It is not final whole-document acceptance.
    pub(crate) parse_valid: bool,
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
        self.events.push_completed_bindings(&bindings)
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
        ProgressiveSofiaFinish {
            incremental,
            final_batches,
            parse_valid,
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
            assert!(!finished.incremental.retention_fallback);
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
        assert!(!finished.incremental.parsed.errors.is_empty());
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
}
