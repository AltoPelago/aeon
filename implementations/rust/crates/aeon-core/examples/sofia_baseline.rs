use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use aeon_core::{CompileOptions, PhaseTiming, benchmark_validation_phases, compile};
use serde_json::{Value as JsonValue, json};

const SCHEMA: &str = "aeon.sofia.native-baseline.v1";

#[derive(Debug)]
struct Args {
    input: PathBuf,
    profile: Profile,
    expected: Expected,
    iterations: usize,
    warmup: usize,
}

#[derive(Debug, Clone, Copy)]
enum Profile {
    Full,
    Check,
}

impl Profile {
    const fn label(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Check => "check",
        }
    }

    fn options(self) -> CompileOptions {
        match self {
            Self::Full => CompileOptions::default(),
            Self::Check => CompileOptions {
                shallow_event_values: true,
                emit_binding_projections: false,
                include_header: false,
                include_event_annotations: false,
                ..CompileOptions::default()
            },
        }
    }

    const fn supports_phase_timing(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Clone, Copy)]
enum Expected {
    Valid,
    Invalid,
}

impl Expected {
    const fn label(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Invalid => "invalid",
        }
    }
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

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let source = fs::read_to_string(&args.input)
        .map_err(|error| format!("failed to read {}: {error}", args.input.display()))?;
    let options = args.profile.options();
    let preflight = compile(&source, options.clone());
    let valid = preflight.errors.is_empty();
    let expected_valid = matches!(args.expected, Expected::Valid);
    if valid != expected_valid {
        let mut codes = preflight
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect::<Vec<_>>();
        codes.sort_unstable();
        codes.dedup();
        return Err(format!(
            "{} was expected to be {} but compile returned {} ({} errors; codes: {})",
            args.input.display(),
            args.expected.label(),
            if valid { "valid" } else { "invalid" },
            preflight.errors.len(),
            if codes.is_empty() {
                String::from("none")
            } else {
                codes.join(", ")
            }
        ));
    }

    for _ in 0..args.warmup {
        let result = compile(black_box(&source), options.clone());
        black_box(result.events.len());
    }

    let mut compile_samples = Vec::with_capacity(args.iterations);
    for _ in 0..args.iterations {
        let started = Instant::now();
        let result = compile(black_box(&source), options.clone());
        let elapsed = started.elapsed().as_nanos();
        black_box(result.events.len());
        compile_samples.push(elapsed);
    }

    let phase_samples = if valid && args.profile.supports_phase_timing() {
        for _ in 0..args.warmup {
            black_box(benchmark_validation_phases(
                black_box(&source),
                options.clone(),
            ))
            .map_err(|error| format!("phase warmup failed with {}", error.code))?;
        }
        let mut samples = Vec::with_capacity(args.iterations);
        for _ in 0..args.iterations {
            samples.push(
                benchmark_validation_phases(black_box(&source), options.clone())
                    .map_err(|error| format!("phase timing failed with {}", error.code))?,
            );
        }
        Some(samples)
    } else {
        None
    };

    let error_codes = preflight
        .errors
        .iter()
        .map(|error| JsonValue::String(error.code.clone()))
        .collect::<Vec<_>>();
    let compile_summary = timing_summary(&compile_samples);
    let median_ns = compile_summary["median_ns"].as_u64().unwrap_or(0) as f64;
    let throughput_mib_per_second = if median_ns > 0.0 {
        (source.len() as f64 / (1024.0 * 1024.0)) / (median_ns / 1_000_000_000.0)
    } else {
        0.0
    };

    let output = json!({
        "schema": SCHEMA,
        "input": args.input,
        "bytes": source.len(),
        "profile": args.profile.label(),
        "expected": args.expected.label(),
        "iterations": args.iterations,
        "warmup": args.warmup,
        "preflight": {
            "valid": valid,
            "events": preflight.events.len(),
            "bindings": preflight.bindings.len(),
            "errors": error_codes,
            "warnings": preflight.warnings.len(),
        },
        "compile": compile_summary,
        "throughput_mib_per_second": throughput_mib_per_second,
        "phases": phase_samples.as_deref().map(phase_summaries),
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output)
            .map_err(|error| format!("failed to serialize result: {error}"))?
    );
    Ok(())
}

fn parse_args() -> Result<Args, String> {
    let mut input = None;
    let mut profile = Profile::Full;
    let mut expected = Expected::Valid;
    let mut iterations = 30_usize;
    let mut warmup = 5_usize;
    let mut raw = env::args().skip(1);

    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--profile" => {
                profile = match required_value(&mut raw, "--profile")?.as_str() {
                    "full" => Profile::Full,
                    "check" => Profile::Check,
                    other => return Err(format!("invalid --profile value: {other}")),
                };
            }
            "--expected" => {
                expected = match required_value(&mut raw, "--expected")?.as_str() {
                    "valid" => Expected::Valid,
                    "invalid" => Expected::Invalid,
                    other => return Err(format!("invalid --expected value: {other}")),
                };
            }
            "--iterations" => {
                iterations = parse_positive(&required_value(&mut raw, "--iterations")?)?;
            }
            "--warmup" => {
                warmup = required_value(&mut raw, "--warmup")?
                    .parse::<usize>()
                    .map_err(|error| format!("invalid --warmup value: {error}"))?;
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
        profile,
        expected,
        iterations,
        warmup,
    })
}

fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{option} requires a value"))
}

fn parse_positive(raw: &str) -> Result<usize, String> {
    let value = raw
        .parse::<usize>()
        .map_err(|error| format!("invalid positive integer {raw:?}: {error}"))?;
    if value == 0 {
        return Err(String::from("iterations must be greater than zero"));
    }
    Ok(value)
}

fn usage() -> String {
    String::from(
        "usage: sofia_baseline [--profile full|check] [--expected valid|invalid] [--iterations N] [--warmup N] <input>",
    )
}

fn timing_summary(samples: &[u128]) -> JsonValue {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let total = sorted.iter().copied().sum::<u128>();
    json!({
        "unit": "nanoseconds",
        "min_ns": sorted.first().copied().unwrap_or_default(),
        "median_ns": percentile(&sorted, 50),
        "p95_ns": percentile(&sorted, 95),
        "max_ns": sorted.last().copied().unwrap_or_default(),
        "mean_ns": total / sorted.len() as u128,
        "samples_ns": samples,
    })
}

fn percentile(sorted: &[u128], percentile: usize) -> u128 {
    let index = (sorted.len() * percentile).div_ceil(100).saturating_sub(1);
    sorted[index]
}

fn phase_summaries(samples: &[PhaseTiming]) -> JsonValue {
    json!({
        "parse": timing_summary(&samples.iter().map(|sample| sample.parse_ns).collect::<Vec<_>>()),
        "lower_header": timing_summary(&samples.iter().map(|sample| sample.lower_header_ns).collect::<Vec<_>>()),
        "flatten": timing_summary(&samples.iter().map(|sample| sample.flatten_ns).collect::<Vec<_>>()),
        "datatype_validation": timing_summary(&samples.iter().map(|sample| sample.datatype_validation_ns).collect::<Vec<_>>()),
        "reference_validation": timing_summary(&samples.iter().map(|sample| sample.reference_validation_ns).collect::<Vec<_>>()),
        "mode_validation": timing_summary(&samples.iter().map(|sample| sample.mode_validation_ns).collect::<Vec<_>>()),
    })
}
