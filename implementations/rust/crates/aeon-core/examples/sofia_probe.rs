use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use aeon_core::{CompileOptions, compile};
use serde_json::json;

#[derive(Debug)]
struct Args {
    input: PathBuf,
    expected_valid: bool,
    max_value_nesting_depth: Option<usize>,
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
    let mut options = CompileOptions::default();
    if let Some(limit) = args.max_value_nesting_depth {
        options.max_value_nesting_depth = Some(limit);
    }

    let started = Instant::now();
    let result = compile(black_box(&source), options);
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
            "bytes": source.len(),
            "expected": if args.expected_valid { "valid" } else { "invalid" },
            "max_value_nesting_depth": args.max_value_nesting_depth,
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
    let mut expected_valid = true;
    let mut max_value_nesting_depth = None;
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
            "--max-value-nesting-depth" => {
                max_value_nesting_depth = Some(
                    required_value(&mut raw, "--max-value-nesting-depth")?
                        .parse::<usize>()
                        .map_err(|error| format!("invalid nesting-depth limit: {error}"))?,
                );
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
        max_value_nesting_depth,
    })
}

fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{option} requires a value"))
}

fn usage() -> String {
    String::from(
        "usage: sofia_probe [--expected valid|invalid] [--max-value-nesting-depth N] <input>",
    )
}
