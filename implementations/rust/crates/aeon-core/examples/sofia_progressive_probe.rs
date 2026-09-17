#![recursion_limit = "256"]

use std::process::ExitCode;

#[cfg(feature = "sofia-bench")]
use std::{env, fs::File, hint::black_box, num::NonZeroUsize, path::PathBuf, time::Instant};

#[cfg(feature = "sofia-bench")]
use aeon_core::{
    CompileOptions, ProgressiveBenchmarkReport, ProgressiveRetentionSnapshot,
    benchmark_compact_progressive_sofia,
};
#[cfg(feature = "sofia-bench")]
use serde_json::{Value, json};

#[cfg(feature = "sofia-bench")]
#[derive(Debug)]
struct Args {
    input: PathBuf,
    expected_valid: bool,
    chunk_bytes: NonZeroUsize,
    max_batch_events: NonZeroUsize,
    max_pending_batches: NonZeroUsize,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}

#[cfg(feature = "sofia-bench")]
fn run() -> Result<(), String> {
    let args = parse_args()?;
    let input = File::open(&args.input)
        .map_err(|error| format!("failed to open {}: {error}", args.input.display()))?;
    let started = Instant::now();
    let report = benchmark_compact_progressive_sofia(
        input,
        CompileOptions::default(),
        args.chunk_bytes,
        args.max_batch_events,
        args.max_pending_batches,
    )?;
    let elapsed_ns = started.elapsed().as_nanos();
    let valid = report.accepted && report.result.errors.is_empty();
    if valid != args.expected_valid {
        let mut codes = report
            .result
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect::<Vec<_>>();
        codes.sort_unstable();
        codes.dedup();
        return Err(format!(
            "{} was expected to be {} but compact progressive compilation returned {} (codes: {})",
            args.input.display(),
            if args.expected_valid {
                "valid"
            } else {
                "invalid"
            },
            if valid { "valid" } else { "invalid" },
            if codes.is_empty() {
                String::from("none")
            } else {
                codes.join(", ")
            }
        ));
    }

    black_box(&report);
    println!(
        "{}",
        serde_json::to_string_pretty(&report_json(&args, elapsed_ns, &report))
            .map_err(|error| format!("failed to serialize probe result: {error}"))?
    );
    Ok(())
}

#[cfg(not(feature = "sofia-bench"))]
fn run() -> Result<(), String> {
    Err(String::from(
        "the progressive Sofia probe requires rebuilding with --features sofia-bench",
    ))
}

#[cfg(feature = "sofia-bench")]
fn report_json(args: &Args, elapsed_ns: u128, report: &ProgressiveBenchmarkReport) -> Value {
    let mut error_codes = report
        .result
        .errors
        .iter()
        .map(|error| error.code.as_str())
        .collect::<Vec<_>>();
    error_codes.sort_unstable();
    error_codes.dedup();
    json!({
        "schema": "aeon.sofia.progressive-probe.v1",
        "input": args.input,
        "mode": "compact-validation",
        "configuration": {
            "input_chunk_bytes": args.chunk_bytes.get(),
            "max_batch_events": args.max_batch_events.get(),
            "max_pending_batches": args.max_pending_batches.get(),
        },
        "elapsed_ns": elapsed_ns,
        "result": {
            "accepted": report.accepted,
            "valid": report.accepted && report.result.errors.is_empty(),
            "accepted_event_count": report.accepted_event_count,
            "delivered_event_count": report.delivered_event_count,
            "exposed_event_count": report.exposed_event_count,
            "errors": report.result.errors.len(),
            "error_codes": error_codes,
            "warnings": report.result.warnings.len(),
            "terminal_source_bytes": report.result.source.len(),
            "terminal_events": report.result.events.len(),
            "terminal_bindings": report.result.bindings.len(),
            "terminal_has_header": report.result.header.is_some(),
        },
        "retention": {
            "bounds": {
                "verified": true,
                "max_lexer_active_bytes": report.retention_bounds.max_lexer_active_bytes,
                "max_ready_batch_count": report.retention_bounds.max_ready_batch_count,
                "max_ready_event_count": report.retention_bounds.max_ready_event_count,
                "max_ready_event_slot_bytes": report.retention_bounds.max_ready_event_slot_bytes,
                "completed_binding_count": 0,
                "completed_binding_storage_bytes": 0,
                "staged_event_slot_bytes": 0,
                "compact_source_and_terminal_storage_bytes": 0,
            },
            "peak_accounted_shallow_bytes": report.peak_accounted_shallow_bytes,
            "peaks": retention_json(report.retention_peaks),
        },
    })
}

#[cfg(feature = "sofia-bench")]
fn retention_json(retention: ProgressiveRetentionSnapshot) -> Value {
    json!({
        "accepted_input_bytes": retention.accepted_input_bytes,
        "compact_output": retention.compact_output,
        "source_retained": retention.source_retained,
        "source_bytes": retention.source_bytes,
        "source_capacity_bytes": retention.source_capacity_bytes,
        "lexer_active_bytes": retention.lexer_active_bytes,
        "parser_token_count": retention.parser_token_count,
        "parser_token_storage_bytes": retention.parser_token_storage_bytes,
        "parser_frame_count": retention.parser_frame_count,
        "structural_identity_count": retention.structural_identity_count,
        "structural_identity_storage_bytes": retention.structural_identity_storage_bytes,
        "completed_binding_count": retention.completed_binding_count,
        "completed_binding_storage_bytes": retention.completed_binding_storage_bytes,
        "released_completed_binding_count": retention.released_completed_binding_count,
        "validation_effective_mode": retention.validation_effective_mode.map(|mode| format!("{mode:?}")),
        "validation_has_declared_profile": retention.validation_has_declared_profile,
        "validation_gp_profile_active": retention.validation_gp_profile_active,
        "validation_header_field_count": retention.validation_header_field_count,
        "validation_header_string_bytes": retention.validation_header_string_bytes,
        "validation_structured_comment_count": retention.validation_structured_comment_count,
        "validation_has_structured_comment_error": retention.validation_has_structured_comment_error,
        "validation_reference_datatype_claim_count": retention.validation_reference_datatype_claim_count,
        "validation_datatype_target_count": retention.validation_datatype_target_count,
        "validation_datatype_target_string_bytes": retention.validation_datatype_target_string_bytes,
        "validation_reference_datatype_claim_string_bytes": retention.validation_reference_datatype_claim_string_bytes,
        "validation_reference_target_count": retention.validation_reference_target_count,
        "validation_reference_target_string_bytes": retention.validation_reference_target_string_bytes,
        "validation_reference_step_count": retention.validation_reference_step_count,
        "validation_reference_claim_count": retention.validation_reference_claim_count,
        "validation_reference_step_string_bytes": retention.validation_reference_step_string_bytes,
        "validation_retained_candidate_error_count": retention.validation_retained_candidate_error_count,
        "validation_event_count": retention.validation_event_count,
        "validation_seen_path_count": retention.validation_seen_path_count,
        "validation_seen_path_string_bytes": retention.validation_seen_path_string_bytes,
        "prevalidation_error_count": retention.prevalidation_error_count,
        "ready_batch_count": retention.ready_batch_count,
        "ready_event_count": retention.ready_event_count,
        "ready_event_slot_bytes": retention.ready_event_slot_bytes,
        "staged_batch_count": retention.staged_batch_count,
        "staged_cursor_count": retention.staged_cursor_count,
        "staged_event_count": retention.staged_event_count,
        "staged_event_slot_bytes": retention.staged_event_slot_bytes,
        "staged_ast_slot_bytes": retention.staged_ast_slot_bytes,
        "terminal_source_capacity_bytes": retention.terminal_source_capacity_bytes,
        "terminal_event_count": retention.terminal_event_count,
    })
}

#[cfg(feature = "sofia-bench")]
fn parse_args() -> Result<Args, String> {
    let mut input = None;
    let mut expected_valid = true;
    let mut chunk_bytes = NonZeroUsize::new(4096).expect("4096 is non-zero");
    let mut max_batch_events = NonZeroUsize::new(256).expect("256 is non-zero");
    let mut max_pending_batches = NonZeroUsize::new(2).expect("two is non-zero");
    let mut raw = env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--expected" => {
                expected_valid = match required_value(&mut raw, "--expected")?.as_str() {
                    "valid" => true,
                    "invalid" => false,
                    other => return Err(format!("invalid --expected value: {other}")),
                };
            }
            "--chunk-bytes" => {
                chunk_bytes = parse_non_zero(&required_value(&mut raw, "--chunk-bytes")?)?;
            }
            "--max-batch-events" => {
                max_batch_events =
                    parse_non_zero(&required_value(&mut raw, "--max-batch-events")?)?;
            }
            "--max-pending-batches" => {
                max_pending_batches =
                    parse_non_zero(&required_value(&mut raw, "--max-pending-batches")?)?;
            }
            value if value.starts_with('-') => return Err(format!("unknown option: {value}")),
            value => {
                if input.replace(PathBuf::from(value)).is_some() {
                    return Err(String::from("only one input path may be supplied"));
                }
            }
        }
    }
    Ok(Args {
        input: input.ok_or_else(usage)?,
        expected_valid,
        chunk_bytes,
        max_batch_events,
        max_pending_batches,
    })
}

#[cfg(feature = "sofia-bench")]
fn parse_non_zero(raw: &str) -> Result<NonZeroUsize, String> {
    let value = raw
        .parse::<usize>()
        .map_err(|error| format!("invalid non-zero integer: {error}"))?;
    NonZeroUsize::new(value).ok_or_else(|| String::from("value must be greater than zero"))
}

#[cfg(feature = "sofia-bench")]
fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{option} requires a value"))
}

#[cfg(feature = "sofia-bench")]
fn usage() -> String {
    String::from(
        "usage: sofia_progressive_probe [--expected valid|invalid] [--chunk-bytes N] [--max-batch-events N] [--max-pending-batches N] <input>",
    )
}
