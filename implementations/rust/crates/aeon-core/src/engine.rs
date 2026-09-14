use std::error::Error;
use std::fmt;
use std::iter::FusedIterator;
use std::mem;
use std::num::NonZeroUsize;

use crate::{AssignmentEvent, CompileOptions, CompileResult, compile_owned};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum SourceRetention {
    #[default]
    Retain,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CompilerConfig {
    pub compile: CompileOptions,
    pub source_retention: SourceRetention,
}

impl CompilerConfig {
    #[must_use]
    pub fn new(compile: CompileOptions) -> Self {
        Self {
            compile,
            source_retention: SourceRetention::Retain,
        }
    }

    #[must_use]
    pub const fn with_source_retention(mut self, source_retention: SourceRetention) -> Self {
        self.source_retention = source_retention;
        self
    }
}

impl Default for CompilerConfig {
    fn default() -> Self {
        Self::new(CompileOptions::default())
    }
}

impl From<CompileOptions> for CompilerConfig {
    fn from(value: CompileOptions) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompilerState {
    Accepting,
    Complete,
    Failed,
    Cancelled,
}

impl fmt::Display for CompilerState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accepting => f.write_str("accepting"),
            Self::Complete => f.write_str("complete"),
            Self::Failed => f.write_str("failed"),
            Self::Cancelled => f.write_str("cancelled"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompilerProgress {
    NeedMoreInput { buffered_bytes: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompilerOperation {
    Push,
    Finish,
    Cancel,
}

impl fmt::Display for CompilerOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Push => f.write_str("push"),
            Self::Finish => f.write_str("finish"),
            Self::Cancel => f.write_str("cancel"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompilerError {
    InvalidState {
        operation: CompilerOperation,
        state: CompilerState,
    },
    InvalidUtf8 {
        valid_up_to: usize,
        error_len: Option<usize>,
    },
}

impl fmt::Display for CompilerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState { operation, state } => {
                write!(f, "cannot {operation} compiler in {state} state")
            }
            Self::InvalidUtf8 {
                valid_up_to,
                error_len,
            } => match error_len {
                Some(error_len) => write!(
                    f,
                    "input is not valid UTF-8 at byte {valid_up_to} (invalid sequence length {error_len})"
                ),
                None => write!(
                    f,
                    "input ends with an incomplete UTF-8 sequence at byte {valid_up_to}"
                ),
            },
        }
    }
}

impl Error for CompilerError {}

#[derive(Debug)]
pub struct Compiler {
    options: CompileOptions,
    source_retention: SourceRetention,
    state: CompilerState,
    input: Vec<u8>,
}

impl Compiler {
    #[must_use]
    pub fn new(options: CompileOptions) -> Self {
        Self::with_config(CompilerConfig::new(options))
    }

    #[must_use]
    pub fn with_config(config: CompilerConfig) -> Self {
        Self {
            options: config.compile,
            source_retention: config.source_retention,
            state: CompilerState::Accepting,
            input: Vec::new(),
        }
    }

    #[must_use]
    pub const fn state(&self) -> CompilerState {
        self.state
    }

    #[must_use]
    pub fn buffered_bytes(&self) -> usize {
        self.input.len()
    }

    #[must_use]
    pub const fn source_retention(&self) -> SourceRetention {
        self.source_retention
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<CompilerProgress, CompilerError> {
        self.require_accepting(CompilerOperation::Push)?;
        self.input.extend_from_slice(chunk);
        Ok(CompilerProgress::NeedMoreInput {
            buffered_bytes: self.input.len(),
        })
    }

    pub fn push_str(&mut self, chunk: &str) -> Result<CompilerProgress, CompilerError> {
        self.push(chunk.as_bytes())
    }

    pub fn finish(&mut self) -> Result<CompileResult, CompilerError> {
        self.require_accepting(CompilerOperation::Finish)?;

        let input = mem::take(&mut self.input);
        let source = match String::from_utf8(input) {
            Ok(source) => source,
            Err(error) => {
                let utf8_error = error.utf8_error();
                self.options = CompileOptions::default();
                self.state = CompilerState::Failed;
                return Err(CompilerError::InvalidUtf8 {
                    valid_up_to: utf8_error.valid_up_to(),
                    error_len: utf8_error.error_len(),
                });
            }
        };

        let options = mem::take(&mut self.options);
        let mut result = compile_owned(source, options);
        self.state = if result.errors.is_empty() {
            CompilerState::Complete
        } else {
            CompilerState::Failed
        };
        if self.source_retention == SourceRetention::Discard {
            result.source = String::new();
        }
        Ok(result)
    }

    pub fn cancel(&mut self) -> Result<(), CompilerError> {
        self.require_accepting(CompilerOperation::Cancel)?;
        self.input = Vec::new();
        self.options = CompileOptions::default();
        self.state = CompilerState::Cancelled;
        Ok(())
    }

    fn require_accepting(&self, operation: CompilerOperation) -> Result<(), CompilerError> {
        if self.state == CompilerState::Accepting {
            Ok(())
        } else {
            Err(CompilerError::InvalidState {
                operation,
                state: self.state,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventBatch {
    events: Vec<AssignmentEvent>,
}

impl EventBatch {
    #[must_use]
    pub fn events(&self) -> &[AssignmentEvent] {
        &self.events
    }

    #[must_use]
    pub fn into_events(self) -> Vec<AssignmentEvent> {
        self.events
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

#[derive(Debug)]
pub struct EventBatches {
    events: std::vec::IntoIter<AssignmentEvent>,
    max_events: NonZeroUsize,
}

impl EventBatches {
    #[must_use]
    pub fn new(events: Vec<AssignmentEvent>, max_events: NonZeroUsize) -> Self {
        Self {
            events: events.into_iter(),
            max_events,
        }
    }

    #[must_use]
    pub const fn max_events(&self) -> NonZeroUsize {
        self.max_events
    }

    #[must_use]
    pub fn remaining_events(&self) -> usize {
        self.events.len()
    }
}

impl Iterator for EventBatches {
    type Item = EventBatch;

    fn next(&mut self) -> Option<Self::Item> {
        if self.events.len() == 0 {
            return None;
        }

        let batch_len = self.max_events.get().min(self.events.len());
        let mut events = Vec::with_capacity(batch_len);
        events.extend(self.events.by_ref().take(batch_len));
        Some(EventBatch { events })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let batches = self.events.len().div_ceil(self.max_events.get());
        (batches, Some(batches))
    }
}

impl ExactSizeIterator for EventBatches {}
impl FusedIterator for EventBatches {}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use super::*;
    use crate::{CompileOptions, compile, compile_owned};

    #[test]
    fn one_shot_adapter_matches_direct_baseline() {
        let source = "name = \"Sofia\"\ncount:uint32 = 2\ncopy = ~name\n";
        let options = CompileOptions {
            recovery: true,
            ..CompileOptions::default()
        };
        let expected = compile_owned(source.to_owned(), options.clone());

        assert_eq!(compile(source, options), expected);
    }

    #[test]
    fn compiler_accepts_chunks_that_split_utf8_sequences() {
        let source = "name = \"Sofía 🌊\"\ncount:uint32 = 2\n";
        let emoji_offset = source.find('🌊').expect("fixture contains the emoji");
        let split = emoji_offset + 2;
        let mut compiler = Compiler::new(CompileOptions::default());

        assert_eq!(compiler.state(), CompilerState::Accepting);
        assert_eq!(
            compiler.push(&source.as_bytes()[..split]),
            Ok(CompilerProgress::NeedMoreInput {
                buffered_bytes: split,
            })
        );
        assert_eq!(
            compiler.push(&source.as_bytes()[split..]),
            Ok(CompilerProgress::NeedMoreInput {
                buffered_bytes: source.len(),
            })
        );

        let expected = compile_owned(source.to_owned(), CompileOptions::default());
        assert_eq!(compiler.finish(), Ok(expected));
        assert_eq!(compiler.state(), CompilerState::Complete);
        assert_eq!(compiler.buffered_bytes(), 0);
    }

    #[test]
    fn compiler_copies_borrowed_chunks_before_the_caller_mutates_them() {
        let mut chunk = b"value = 7\n".to_vec();
        let mut compiler = Compiler::new(CompileOptions::default());
        compiler
            .push(&chunk)
            .expect("accepting compiler accepts input");
        chunk.fill(b'x');

        let result = compiler.finish().expect("copied source remains valid");
        assert_eq!(result.source, "value = 7\n");
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].key, "value");
    }

    #[test]
    fn compile_diagnostics_make_failure_terminal() {
        let mut compiler = Compiler::new(CompileOptions::default());
        compiler
            .push_str("value = [1, 2\n")
            .expect("accepting compiler accepts input");

        let result = compiler
            .finish()
            .expect("syntax errors are compile results");
        assert!(!result.errors.is_empty());
        assert_eq!(compiler.state(), CompilerState::Failed);
        assert_eq!(
            compiler.push_str("more = 3\n"),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Push,
                state: CompilerState::Failed,
            })
        );
        assert_eq!(
            compiler.finish(),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Finish,
                state: CompilerState::Failed,
            })
        );
        assert_eq!(
            compiler.cancel(),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Cancel,
                state: CompilerState::Failed,
            })
        );
    }

    #[test]
    fn invalid_utf8_is_a_terminal_lifecycle_error() {
        let mut compiler = Compiler::new(CompileOptions::default());
        compiler
            .push(&[0xf0, 0x9f])
            .expect("incomplete UTF-8 is allowed before final input");

        assert_eq!(
            compiler.finish(),
            Err(CompilerError::InvalidUtf8 {
                valid_up_to: 0,
                error_len: None,
            })
        );
        assert_eq!(compiler.state(), CompilerState::Failed);
        assert_eq!(compiler.buffered_bytes(), 0);
        assert_eq!(
            compiler.finish(),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Finish,
                state: CompilerState::Failed,
            })
        );
    }

    #[test]
    fn resource_limit_diagnostics_make_failure_terminal() {
        let options = CompileOptions {
            max_input_bytes: Some(4),
            ..CompileOptions::default()
        };
        let mut compiler = Compiler::new(options);
        compiler
            .push_str("value = 7\n")
            .expect("input limits are evaluated on final input");

        let result = compiler
            .finish()
            .expect("resource failures are compile results");
        assert_eq!(compiler.state(), CompilerState::Failed);
        assert!(result.events.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, "INPUT_SIZE_EXCEEDED");
    }

    #[test]
    fn cancellation_releases_input_and_is_terminal() {
        let mut compiler = Compiler::new(CompileOptions::default());
        compiler
            .push_str("value = \"retained until cancellation\"\n")
            .expect("accepting compiler accepts input");
        assert!(compiler.buffered_bytes() > 0);

        assert_eq!(compiler.cancel(), Ok(()));
        assert_eq!(compiler.state(), CompilerState::Cancelled);
        assert_eq!(compiler.buffered_bytes(), 0);
        assert_eq!(
            compiler.push(&[]),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Push,
                state: CompilerState::Cancelled,
            })
        );
        assert_eq!(
            compiler.cancel(),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Cancel,
                state: CompilerState::Cancelled,
            })
        );
    }

    #[test]
    fn source_discard_is_explicit_and_preserves_compiled_output() {
        let source = "value:uint32 = 7\n";
        let config = CompilerConfig::new(CompileOptions::default())
            .with_source_retention(SourceRetention::Discard);
        let mut compiler = Compiler::with_config(config);
        compiler
            .push_str(source)
            .expect("accepting compiler accepts input");

        let result = compiler.finish().expect("valid input compiles");
        assert_eq!(compiler.source_retention(), SourceRetention::Discard);
        assert_eq!(result.source, "");
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].key, "value");
        assert_eq!(compiler.state(), CompilerState::Complete);
        assert_eq!(
            compiler.finish(),
            Err(CompilerError::InvalidState {
                operation: CompilerOperation::Finish,
                state: CompilerState::Complete,
            })
        );
    }

    #[test]
    fn event_batches_are_bounded_ordered_and_mutation_isolated() {
        let source = "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n";
        let result = compile(source, CompileOptions::default());
        let expected_keys: Vec<_> = result
            .events
            .iter()
            .map(|event| event.key.clone())
            .collect();
        let max_events = NonZeroUsize::new(2).expect("two is non-zero");
        let mut batches = EventBatches::new(result.events, max_events);

        assert_eq!(batches.len(), 3);
        assert_eq!(batches.remaining_events(), 5);

        let first = batches.next().expect("first batch exists");
        assert_eq!(first.len(), 2);
        let mut first_events = first.into_events();
        first_events[0].key.push_str("-mutated");

        let second = batches.next().expect("second batch exists");
        assert_eq!(second.len(), 2);
        assert_eq!(second.events()[0].key, expected_keys[2]);
        assert_eq!(second.events()[1].key, expected_keys[3]);

        let final_batch = batches.next().expect("final batch exists");
        assert_eq!(final_batch.len(), 1);
        assert_eq!(final_batch.events()[0].key, expected_keys[4]);
        assert_eq!(batches.next(), None);
        assert_eq!(batches.remaining_events(), 0);
        assert_eq!(expected_keys[0], "a");
    }
}
