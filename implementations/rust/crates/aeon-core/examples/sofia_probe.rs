use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(feature = "sofia-bench")]
use aeon_core::benchmark_compile_sofia;
use aeon_core::{CompileOptions, CompileResult, compile};
use serde_json::json;

#[derive(Debug)]
struct Args {
    input: PathBuf,
    parser: Parser,
    profile: Profile,
    expected_valid: bool,
    max_value_nesting_depth: Option<usize>,
    hold_ms: u64,
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
}

#[derive(Debug, Clone, Copy)]
enum Parser {
    Baseline,
    Sofia,
}

impl Parser {
    const fn label(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Sofia => "sofia",
        }
    }

    fn compile(self, source: &str, options: CompileOptions) -> Result<CompileResult, String> {
        match self {
            Self::Baseline => Ok(compile(source, options)),
            Self::Sofia => compile_sofia(source, options),
        }
    }
}

#[cfg(feature = "sofia-bench")]
fn compile_sofia(source: &str, options: CompileOptions) -> Result<CompileResult, String> {
    Ok(benchmark_compile_sofia(source, options))
}

#[cfg(not(feature = "sofia-bench"))]
fn compile_sofia(_source: &str, _options: CompileOptions) -> Result<CompileResult, String> {
    Err(String::from(
        "the Sofia parser requires rebuilding this example with --features sofia-bench",
    ))
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
    let mut options = args.profile.options();
    if let Some(limit) = args.max_value_nesting_depth {
        options.max_value_nesting_depth = Some(limit);
    }

    let started = Instant::now();
    let result = args.parser.compile(black_box(&source), options)?;
    let elapsed_ns = started.elapsed().as_nanos();
    let valid = result.errors.is_empty();
    if valid != args.expected_valid {
        let mut codes = result
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect::<Vec<_>>();
        codes.sort_unstable();
        codes.dedup();
        return Err(format!(
            "{} was expected to be {} but compile returned {} (codes: {})",
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

    black_box(&result);
    if args.hold_ms > 0 {
        thread::sleep(Duration::from_millis(args.hold_ms));
    }
    let mut error_codes = result
        .errors
        .iter()
        .map(|error| error.code.as_str())
        .collect::<Vec<_>>();
    error_codes.sort_unstable();
    error_codes.dedup();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema": "aeon.sofia.native-probe.v1",
            "input": args.input,
            "parser": args.parser.label(),
            "profile": args.profile.label(),
            "bytes": source.len(),
            "expected": if args.expected_valid { "valid" } else { "invalid" },
            "max_value_nesting_depth": args.max_value_nesting_depth,
            "hold_ms": args.hold_ms,
            "elapsed_ns": elapsed_ns,
            "result": {
                "valid": valid,
                "events": result.events.len(),
                "bindings": result.bindings.len(),
                "errors": result.errors.len(),
                "error_codes": error_codes,
                "warnings": result.warnings.len(),
            },
        }))
        .map_err(|error| format!("failed to serialize probe result: {error}"))?
    );
    Ok(())
}

fn parse_args() -> Result<Args, String> {
    let mut input = None;
    let mut parser = Parser::Baseline;
    let mut profile = Profile::Full;
    let mut expected_valid = true;
    let mut max_value_nesting_depth = None;
    let mut hold_ms = 0;
    let mut raw = env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--parser" => {
                parser = match required_value(&mut raw, "--parser")?.as_str() {
                    "baseline" => Parser::Baseline,
                    "sofia" => Parser::Sofia,
                    other => return Err(format!("invalid --parser value: {other}")),
                };
            }
            "--profile" => {
                profile = match required_value(&mut raw, "--profile")?.as_str() {
                    "full" => Profile::Full,
                    "check" => Profile::Check,
                    other => return Err(format!("invalid --profile value: {other}")),
                };
            }
            "--expected" => {
                expected_valid = match required_value(&mut raw, "--expected")?.as_str() {
                    "valid" => true,
                    "invalid" => false,
                    other => return Err(format!("invalid --expected value: {other}")),
                };
            }
            "--max-value-nesting-depth" => {
                max_value_nesting_depth = Some(
                    required_value(&mut raw, "--max-value-nesting-depth")?
                        .parse::<usize>()
                        .map_err(|error| format!("invalid nesting-depth limit: {error}"))?,
                );
            }
            "--hold-ms" => {
                hold_ms = required_value(&mut raw, "--hold-ms")?
                    .parse::<u64>()
                    .map_err(|error| format!("invalid hold duration: {error}"))?;
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
        parser,
        profile,
        expected_valid,
        max_value_nesting_depth,
        hold_ms,
    })
}

fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{option} requires a value"))
}

fn usage() -> String {
    String::from(
        "usage: sofia_probe [--parser baseline|sofia] [--profile full|check] [--expected valid|invalid] [--max-value-nesting-depth N] [--hold-ms N] <input>",
    )
}
