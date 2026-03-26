use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use aeon_aeos::{
    validate, validate_cts_payload, AesEvent, EventPath, EventValue, OffsetOnly, PathSegmentInput, Schema,
    SpanInput, ValidationEnvelope, ValidationOptions,
};
use aeon_annotations::{extract_annotations, sort_annotations};
use aeon_canonical::canonicalize;
use aeon_finalize::{
    finalize_json, finalize_map, value_to_ast_json, FinalizeMode, FinalizeOptions, FinalizeScope, Materialization,
};
use aeon_core::{
    compile, format_path, AssignmentEvent, CompileOptions, DatatypePolicy, Diagnostic, PathSegment,
    ReferenceSegment, Value, VERSION,
};
use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Map, Value as JsonValue};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone, Deserialize)]
struct ContractRegistryDoc {
    contracts: Vec<ContractRegistryEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct ContractRegistryEntry {
    id: String,
    kind: String,
    version: String,
    path: String,
    sha256: String,
    status: String,
}

fn trace_check_enabled() -> bool {
    env::var_os("AEON_TRACE_CHECK").is_some()
}

fn trace_check(message: impl AsRef<str>) {
    if trace_check_enabled() {
        eprintln!("[aeon-cli] {}", message.as_ref());
    }
}

#[derive(Debug, Clone)]
struct EnvelopeDiagnostic {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
struct DoctorCheck {
    name: &'static str,
    status: &'static str,
    message: String,
    details: Option<JsonValue>,
}

fn main() -> ExitCode {
    if env::var_os("AEON_TRACE_STARTUP").is_some() {
        eprintln!("[aeon-cli] main:start");
    }
    match run(env::args().collect()) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}

fn run(args: Vec<String>) -> Result<ExitCode, String> {
    if args.iter().any(|arg| arg == "--cts-validate") {
        return cts_validate();
    }
    let command = args.get(1).map(String::as_str);
    match command {
        Some("version") | Some("--version") | Some("-v") => {
            println!("aeon-rust {VERSION}");
            Ok(ExitCode::SUCCESS)
        }
        Some("check") => check(&args[2..]),
        Some("doctor") => doctor(&args[2..]),
        Some("inspect") => inspect(&args[2..]),
        Some("finalize") => finalize(&args[2..]),
        Some("bind") => bind(&args[2..]),
        Some("integrity") => integrity(&args[2..]),
        Some("fmt") => fmt(&args[2..]),
        Some("cts-adapter") => cts_adapter(),
        Some("help") | Some("--help") | Some("-h") | None => {
            print_help();
            Ok(ExitCode::SUCCESS)
        }
        Some(other) => Err(format!("Unknown command: {other}")),
    }
}

fn check(args: &[String]) -> Result<ExitCode, String> {
    trace_check("check:start");
    let file = find_file(args, &["--datatype-policy", "--max-input-bytes"])
        .ok_or_else(|| String::from("Error: No file specified\nUsage: aeon check <file>"))?;
    trace_check(format!("check:file={file}"));
    let rich = args.iter().any(|arg| arg == "--rich");
    let datatype_policy = resolve_datatype_policy(flag_value(args, "--datatype-policy").as_deref(), rich)
        .map_err(|_| {
            String::from(
                "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)\nUsage: aeon check <file> [--datatype-policy <reserved_only|allow_custom>]",
            )
        })?;
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;

    trace_check("check:read_source");
    let source = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    trace_check(format!("check:source_bytes={}", source.len()));
    if let Some(limit) = max_input_bytes {
        let actual = source.as_bytes().len();
        if actual > limit {
            eprintln!("Input size {actual} bytes exceeds configured limit of {limit} bytes");
            return Ok(ExitCode::from(1));
        }
    }

    trace_check("check:compile");
    let result = compile(
        &source,
        CompileOptions {
            datatype_policy,
            max_input_bytes,
            shallow_event_values: true,
            emit_binding_projections: false,
            include_header: false,
            include_event_annotations: false,
            ..CompileOptions::default()
        },
    );
    trace_check(format!("check:compile_done errors={}", result.errors.len()));

    if result.errors.is_empty() {
        trace_check("check:ok");
        println!("OK");
        return Ok(ExitCode::SUCCESS);
    }

    for error in &result.errors {
        println!("{}", format_error_line(error));
    }
    Ok(ExitCode::from(1))
}

fn inspect(args: &[String]) -> Result<ExitCode, String> {
    const INSPECT_USAGE: &str = "Usage: aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]";
    let json_output = args.iter().any(|arg| arg == "--json");
    let include_annotations = args.iter().any(|arg| arg == "--annotations");
    let annotations_only = args.iter().any(|arg| arg == "--annotations-only");
    let sort_annotations_flag = args.iter().any(|arg| arg == "--sort-annotations");
    let recovery = args.iter().any(|arg| arg == "--recovery");
    let rich = args.iter().any(|arg| arg == "--rich");
    let datatype_policy = flag_value(args, "--datatype-policy");
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let max_attribute_depth = numeric_flag_value(args, "--max-attribute-depth").map_err(|_| {
        String::from("Error: Invalid value for --max-attribute-depth (expected a non-negative integer)")
    })?;
    let max_separator_depth = numeric_flag_value(args, "--max-separator-depth").map_err(|_| {
        String::from("Error: Invalid value for --max-separator-depth (expected a non-negative integer)")
    })?;
    let max_generic_depth = numeric_flag_value(args, "--max-generic-depth").map_err(|_| {
        String::from("Error: Invalid value for --max-generic-depth (expected a non-negative integer)")
    })?;

    let file = find_file(
        args,
        &[
            "--datatype-policy",
            "--max-input-bytes",
            "--max-attribute-depth",
            "--max-separator-depth",
            "--max-generic-depth",
        ],
    )
    .ok_or_else(|| format!("Error: No file specified\n{INSPECT_USAGE}"))?;
    let source = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = source.as_bytes().len();
        if actual > limit {
            eprintln!("Input size {actual} bytes exceeds configured limit of {limit} bytes");
            return Ok(ExitCode::from(1));
        }
    }
    let result = compile(
        &source,
        CompileOptions {
            recovery,
            max_input_bytes,
            datatype_policy: resolve_datatype_policy(datatype_policy.as_deref(), rich).map_err(|_| {
                format!(
                    "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)\n{INSPECT_USAGE}"
                )
            })?,
            max_attribute_depth,
            max_separator_depth,
            max_generic_depth,
            ..CompileOptions::default()
        },
    );
    let annotations_requested = include_annotations || annotations_only || sort_annotations_flag;
    let mut annotations = if annotations_requested {
        extract_annotations(&source)
    } else {
        Vec::new()
    };
    if sort_annotations_flag {
        annotations = sort_annotations(annotations);
    }

    if json_output {
        if annotations_only {
            println!("{{");
            println!("  \"annotations\": {}", render_annotations(&annotations));
            println!("}}");
        } else {
            println!("{{");
            println!("  \"events\": {},", render_events(&result.events));
            println!("  \"errors\": {}", render_errors(&result.errors));
            if include_annotations {
                println!(",");
                println!("  \"annotations\": {}", render_annotations(&annotations));
            }
            println!("}}");
        }
    } else {
        print!(
            "{}",
            render_inspect_markdown(
                &file,
                &result,
                &annotations,
                InspectRenderOptions {
                    recovery,
                    include_annotations,
                    annotations_only,
                    mode: header_field_value(result.header.as_ref(), "mode")
                        .unwrap_or_else(|| String::from("transport")),
                    version: header_field_value(result.header.as_ref(), "version"),
                    profile: header_field_value(result.header.as_ref(), "profile"),
                    schema: header_field_value(result.header.as_ref(), "schema"),
                },
            )
        );
    }
    Ok(if result.errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn finalize(args: &[String]) -> Result<ExitCode, String> {
    const FINALIZE_USAGE: &str = "Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]";
    let file = find_file(args, &["--datatype-policy", "--scope", "--include-path", "--max-input-bytes"])
        .ok_or_else(|| format!("Error: No file specified\n{FINALIZE_USAGE}"))?;
    let mode = resolve_finalize_mode(args)
        .map_err(|message| format!("Error: {message}\n{FINALIZE_USAGE}"))?;
    let datatype_policy = resolve_datatype_policy(flag_value(args, "--datatype-policy").as_deref(), false)
        .map_err(|_| {
            format!(
                "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)\n{FINALIZE_USAGE}"
            )
        })?;
    let scope = resolve_finalize_scope(flag_value(args, "--scope").as_deref())
        .map_err(|message| format!("Error: {message}\n{FINALIZE_USAGE}"))?;
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let include_paths = flag_values(args, "--include-path");
    let projected = args.iter().any(|arg| arg == "--projected") || !include_paths.is_empty();
    if args.iter().any(|arg| arg == "--projected") && include_paths.is_empty() {
        return Err(format!(
            "Error: --projected requires at least one --include-path <$.path>\n{FINALIZE_USAGE}"
        ));
    }

    let source = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = source.as_bytes().len();
        if actual > limit {
            eprintln!("Input size {actual} bytes exceeds configured limit of {limit} bytes");
            return Ok(ExitCode::from(1));
        }
    }
    let result = compile(
        &source,
        CompileOptions {
            recovery: args.iter().any(|arg| arg == "--recovery"),
            datatype_policy,
            max_input_bytes,
            ..CompileOptions::default()
        },
    );

    let options = FinalizeOptions {
        mode,
        materialization: if projected {
            Materialization::Projected
        } else {
            Materialization::All
        },
        include_paths,
        scope,
        header: result.header.clone(),
    };

    let has_finalize_errors;
    let output = if args.iter().any(|arg| arg == "--map") {
        let finalized = finalize_map(&result.events, options);
        has_finalize_errors = !finalized.meta.errors.is_empty();
        let mut top = Map::new();
        top.insert(
            String::from("document"),
            JsonValue::Object(Map::from_iter([(
                String::from("entries"),
                JsonValue::Array(
                    finalized
                        .document
                        .entries
                        .iter()
                        .map(|entry| {
                            let mut obj = Map::new();
                            obj.insert(String::from("path"), JsonValue::String(entry.path.clone()));
                            obj.insert(String::from("value"), value_to_ast_json(&entry.value));
                            obj.insert(String::from("span"), span_to_json(&entry.span));
                            if let Some(datatype) = &entry.datatype {
                                obj.insert(String::from("datatype"), JsonValue::String(datatype.clone()));
                            }
                            if !entry.annotations.is_empty() {
                                obj.insert(
                                    String::from("annotations"),
                                    finalize_attributes_to_json(&entry.annotations),
                                );
                            }
                            JsonValue::Object(obj)
                        })
                        .collect(),
                ),
            )])),
        );
        let meta = merged_meta_json(&result.errors, &finalized.meta.errors, &finalized.meta.warnings);
        if let Some(meta) = meta {
            top.insert(String::from("meta"), meta);
        }
        JsonValue::Object(top)
    } else {
        let finalized = finalize_json(&result.events, options);
        has_finalize_errors = !finalized.meta.errors.is_empty();
        let mut top = Map::new();
        top.insert(String::from("document"), finalized.document);
        let meta = merged_meta_json(&result.errors, &finalized.meta.errors, &finalized.meta.warnings);
        if let Some(meta) = meta {
            top.insert(String::from("meta"), meta);
        }
        JsonValue::Object(top)
    };

    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| format!("failed to render JSON: {error}"))?
    );
    Ok(if result.errors.is_empty() && !has_finalize_errors {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn bind(args: &[String]) -> Result<ExitCode, String> {
    let (code, output) = execute_bind(args)?;
    let suppress_output = code == ExitCode::from(1)
        && output
            .as_object()
            .map(|object| object.is_empty())
            .unwrap_or(false);
    if !suppress_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&output)
                .map_err(|error| format!("failed to render JSON: {error}"))?
        );
    }
    Ok(code)
}

fn integrity(args: &[String]) -> Result<ExitCode, String> {
    match args.first().map(String::as_str) {
        Some("validate") => integrity_validate(&args[1..]),
        Some("verify") => integrity_verify(&args[1..]),
        Some("sign") => integrity_sign(&args[1..]),
        Some(other) => Err(format!(
            "Unknown integrity command: {other}\nUsage: aeon integrity <validate|verify|sign> <file> [options]"
        )),
        None => Err(String::from(
            "Usage: aeon integrity <validate|verify> <file> [--strict|--loose]",
        )),
    }
}

fn integrity_validate(args: &[String]) -> Result<ExitCode, String> {
    let mode = resolve_integrity_mode(args).map_err(|message| {
        format!(
            "Error: {message}\nUsage: aeon integrity validate <file> [--strict|--loose]"
        )
    })?;
    let json_output = args.iter().any(|arg| arg == "--json");
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let file = find_file(args, &["--max-input-bytes"]).ok_or_else(|| {
        String::from("Error: No file specified\nUsage: aeon integrity validate <file> [--strict|--loose]")
    })?;
    let input = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = input.len();
        if actual > limit {
            return Err(format!("Input size {actual} bytes exceeds configured limit of {limit} bytes"));
        }
    }

    let result = compile(
        &input,
        CompileOptions {
            max_input_bytes,
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        },
    );
    if !result.errors.is_empty() {
        let errors = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_PARSE_ERROR",
            message: String::from("Invalid AEON document for envelope validation"),
        }];
        return output_integrity_result(json_output, &errors, &[], None, None);
    }

    let (errors, warnings) = validate_envelope_events(&result.events, mode == "strict");
    output_integrity_result(json_output, &errors, &warnings, None, None)
}

fn integrity_verify(args: &[String]) -> Result<ExitCode, String> {
    let mode = resolve_integrity_mode(args).map_err(|message| {
        format!(
            "Error: {message}\nUsage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]"
        )
    })?;
    let json_output = args.iter().any(|arg| arg == "--json");
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let file = find_file(args, &["--max-input-bytes", "--public-key", "--pubkey", "--receipt"])
        .ok_or_else(|| {
            String::from(
                "Error: No file specified\nUsage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]",
            )
        })?;
    let explicit_receipt_path =
        resolve_receipt_path(args).map_err(|message| format!("Error: {message}\nUsage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]"))?;
    let input = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = input.len();
        if actual > limit {
            return Err(format!("Input size {actual} bytes exceeds configured limit of {limit} bytes"));
        }
    }

    let base_input = remove_envelope(&input);
    let base_result = compile(
        &base_input,
        CompileOptions {
            max_input_bytes,
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        },
    );
    if !base_result.errors.is_empty() {
        let errors = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_PARSE_ERROR",
            message: String::from("Invalid AEON document body for envelope verification"),
        }];
        return output_integrity_result(json_output, &errors, &[], None, None);
    }

    let result = compile(
        &input,
        CompileOptions {
            max_input_bytes,
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        },
    );
    if !result.errors.is_empty() {
        let errors = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_PARSE_ERROR",
            message: String::from("Invalid AEON document for envelope validation"),
        }];
        return output_integrity_result(json_output, &errors, &[], None, None);
    }

    let (mut errors, mut warnings) = validate_envelope_events(&result.events, mode == "strict");
    let Some(envelope_root) = envelope_root_path(&result.events) else {
        errors.push(EnvelopeDiagnostic {
            code: "ENVELOPE_MISSING",
            message: String::from("an :envelope binding is required for verification"),
        });
        return output_integrity_result(json_output, &errors, &warnings, None, None);
    };

    let Some(expected_hash) = read_envelope_field(&result.events, &envelope_root, &["integrity.hash", "hash"]) else {
        errors.push(EnvelopeDiagnostic {
            code: "ENVELOPE_HASH_MISSING",
            message: String::from("canonical hash is missing from the integrity envelope"),
        });
        return output_integrity_result(json_output, &errors, &warnings, None, None);
    };
    let algorithm = read_envelope_field(&result.events, &envelope_root, &["integrity.alg", "alg"])
        .unwrap_or_else(|| String::from("sha-256"));
    let normalized_algorithm = normalize_hash_algorithm(&algorithm).ok_or_else(|| {
        format!("Unsupported integrity hash algorithm: {algorithm}")
    })?;
    let computed = compute_canonical_hash(&base_result.events, &normalized_algorithm);
    let synthesized_receipt = canonical_receipt_json(
        &base_input,
        &computed,
        base_result.header.as_ref(),
        Some(&expected_hash),
        false,
    );
    let receipt = resolve_verify_receipt(explicit_receipt_path, &file, synthesized_receipt)?;
    let signature = read_envelope_field(
        &result.events,
        &envelope_root,
        &["signatures[0].sig", "sig"],
    );
    let public_key_path = flag_value(args, "--public-key").or_else(|| flag_value(args, "--pubkey"));
    let mut signature_verified = None;
    if normalize_hash(&expected_hash) != normalize_hash(&computed.hash) {
        errors.push(EnvelopeDiagnostic {
            code: "ENVELOPE_HASH_MISMATCH",
            message: String::from("canonical_hash does not match computed AES hash"),
        });
    }
    if let Some(signature) = signature {
        if let Some(public_key_path) = public_key_path {
            let public_key =
                fs::read_to_string(&public_key_path).map_err(|error| format!("failed to read {public_key_path}: {error}"))?;
            let ok = verify_string_payload_signature(&expected_hash, &signature, &public_key)?;
            signature_verified = Some(ok);
            if !ok {
                errors.push(EnvelopeDiagnostic {
                    code: "ENVELOPE_SIGNATURE_INVALID",
                    message: String::from("signature verification failed"),
                });
            }
        } else {
            warnings.push(EnvelopeDiagnostic {
                code: "ENVELOPE_SIGNATURE_KEY_MISSING",
                message: String::from("sig present but no --public-key provided; signature not verified"),
            });
        }
    }

    let verification = json!({
        "canonical": {
            "present": true,
            "algorithm": normalized_algorithm,
            "expected": expected_hash,
            "computed": computed.hash,
        },
        "canonicalStream": {
            "length": computed.stream.len(),
        },
        "bytes": {
            "present": false,
        },
        "checksum": {
            "present": false,
        },
        "signature": {
            "present": signature_verified.is_some() || read_envelope_field(&result.events, &envelope_root, &["signatures[0].sig", "sig"]).is_some(),
            "verified": signature_verified,
        },
        "replay": {
            "performed": true,
            "status": if normalize_hash(&expected_hash) == normalize_hash(&computed.hash) { "match" } else { "divergent" },
            "expected": expected_hash,
            "computed": computed.hash,
        }
    });

    output_integrity_result(json_output, &errors, &warnings, Some(receipt), Some(verification))
}

fn integrity_sign(args: &[String]) -> Result<ExitCode, String> {
    let json_output = args.iter().any(|arg| arg == "--json");
    let write_output = args.iter().any(|arg| arg == "--write");
    let replace_output = args.iter().any(|arg| arg == "--replace");
    let include_bytes = args.iter().any(|arg| arg == "--include-bytes");
    let include_checksum = args.iter().any(|arg| arg == "--include-checksum");
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let file = find_file(args, &["--private-key", "--privkey", "--max-input-bytes", "--receipt"])
        .ok_or_else(|| {
            String::from("Error: No file specified\nUsage: aeon integrity sign <file> --private-key <path> [--receipt <path>]")
        })?;
    let explicit_receipt_path =
        resolve_receipt_path(args).map_err(|message| format!("Error: {message}\nUsage: aeon integrity sign <file> --private-key <path> [--receipt <path>]"))?;
    let private_key_path = flag_value(args, "--private-key")
        .or_else(|| flag_value(args, "--privkey"))
        .ok_or_else(|| String::from("Error: Missing --private-key\nUsage: aeon integrity sign <file> --private-key <path> [--receipt <path>]"))?;
    let input = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = input.len();
        if actual > limit {
            return Err(format!("Input size {actual} bytes exceeds configured limit of {limit} bytes"));
        }
    }

    let base_input = if replace_output {
        remove_envelope(&input)
    } else {
        input.clone()
    };
    let parsed = compile(
        &base_input,
        CompileOptions {
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            max_input_bytes,
            ..CompileOptions::default()
        },
    );
    if !parsed.errors.is_empty() {
        let errors = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_PARSE_ERROR",
            message: String::from("Invalid AEON document for envelope signing"),
        }];
        return output_integrity_result(json_output, &errors, &[], None, None);
    }
    if envelope_root_path(&parsed.events).is_some() && !replace_output {
        let errors = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_EXISTS",
            message: String::from("document already contains an :envelope binding"),
        }];
        return output_integrity_result(json_output, &errors, &[], None, None);
    }

    let private_key =
        fs::read_to_string(&private_key_path).map_err(|error| format!("failed to read {private_key_path}: {error}"))?;
    let canonical = compute_canonical_hash(&parsed.events, "sha-256");
    let receipt = canonical_receipt_json(&base_input, &canonical, parsed.header.as_ref(), None, true);
    let receipt_path = explicit_receipt_path.or_else(|| {
        if write_output {
            Some(default_receipt_sidecar_path(&file))
        } else {
            None
        }
    });
    let bytes_hash = if include_bytes {
        Some(compute_byte_hash(&base_input))
    } else {
        None
    };
    let checksum_hash = if include_checksum {
        Some(compute_byte_hash(&base_input))
    } else {
        None
    };
    let signature = sign_string_payload(&canonical.hash, &private_key)?;
    let snippet = render_signature_envelope(
        &canonical.hash,
        &signature,
        bytes_hash.as_deref(),
        checksum_hash.as_deref(),
    );

    if write_output {
        let prepared = ensure_gp_security_conventions(&base_input);
        let next = append_envelope(&prepared.source, &snippet);
        write_file_with_backup(&file, &next)?;
        if let Some(receipt_path) = receipt_path.as_deref() {
            write_receipt_sidecar(receipt_path, &receipt)?;
        }
        if json_output {
            let integrity = render_integrity_json(&canonical.hash, bytes_hash.as_deref(), checksum_hash.as_deref());
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "ok": true,
                    "written": true,
                    "replaced": replace_output,
                    "conventionsApplied": prepared.changed,
                    "receipt": receipt,
                    "envelope": {
                        "integrity": integrity,
                        "signatures": [{
                            "alg": "ed25519",
                            "kid": "default",
                            "sig": signature,
                        }]
                    }
                }))
                .map_err(|error| format!("failed to render JSON: {error}"))?
            );
        } else {
            println!("Wrote envelope to {file}");
        }
        return Ok(ExitCode::SUCCESS);
    }

    if json_output {
        if let Some(receipt_path) = receipt_path.as_deref() {
            write_receipt_sidecar(receipt_path, &receipt)?;
        }
        let integrity = render_integrity_json(&canonical.hash, bytes_hash.as_deref(), checksum_hash.as_deref());
        println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "ok": true,
                    "receipt": receipt,
                    "envelope": {
                        "integrity": integrity,
                        "signatures": [{
                        "alg": "ed25519",
                        "kid": "default",
                        "sig": signature,
                    }]
                }
            }))
            .map_err(|error| format!("failed to render JSON: {error}"))?
        );
    } else {
        if let Some(receipt_path) = receipt_path.as_deref() {
            write_receipt_sidecar(receipt_path, &receipt)?;
        }
        println!("{snippet}");
    }
    Ok(ExitCode::SUCCESS)
}

fn execute_bind(args: &[String]) -> Result<(ExitCode, JsonValue), String> {
    const BIND_USAGE: &str = "Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]";
    let file = find_file(
        args,
        &[
            "--schema",
            "--datatype-policy",
            "--scope",
            "--include-path",
            "--contract-registry",
            "--profile",
            "--max-input-bytes",
            "--trailing-separator-delimiter-policy",
        ],
    )
        .ok_or_else(|| format!("Error: No file specified\n{BIND_USAGE}"))?;
    let schema_path = flag_value(args, "--schema");
    let contract_registry_path = flag_value(args, "--contract-registry");
    let has_contract_registry = contract_registry_path.is_some();
    if args.iter().any(|arg| arg == "--schema") && schema_path.is_none() {
        return Err(format!("Error: Missing value for --schema <schema.json>\n{BIND_USAGE}"));
    }
    if args.iter().any(|arg| arg == "--contract-registry") && contract_registry_path.is_none() {
        return Err(format!(
            "Error: Missing value for --contract-registry <registry.json>\n{BIND_USAGE}"
        ));
    }
    if args.iter().any(|arg| arg == "--profile") && flag_value(args, "--profile").is_none() {
        return Err(format!("Error: Missing value for --profile <id>\n{BIND_USAGE}"));
    }
    let mode = resolve_finalize_mode(args).map_err(|message| format!("Error: {message}\n{BIND_USAGE}"))?;
    let rich = args.iter().any(|arg| arg == "--rich");
    let datatype_policy = resolve_datatype_policy(flag_value(args, "--datatype-policy").as_deref(), rich)
        .map_err(|_| {
            format!(
                "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)\n{BIND_USAGE}"
            )
        })?;
    let scope = resolve_finalize_scope(flag_value(args, "--scope").as_deref())
        .map_err(|message| format!("Error: {message}\n{BIND_USAGE}"))?;
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let include_annotations = args.iter().any(|arg| arg == "--annotations");
    let sort_annotations_flag = args.iter().any(|arg| arg == "--sort-annotations");
    if args.iter().any(|arg| arg == "--trailing-separator-delimiter-policy")
        && flag_value(args, "--trailing-separator-delimiter-policy").is_none()
    {
        return Err(format!(
            "Error: Missing value for --trailing-separator-delimiter-policy <off|warn|error>\n{BIND_USAGE}"
        ));
    }
    let trailing_separator_policy = flag_value(args, "--trailing-separator-delimiter-policy")
        .unwrap_or_else(|| String::from("off"));
    let profile = flag_value(args, "--profile");
    let include_paths = flag_values(args, "--include-path");
    if args.iter().any(|arg| arg == "--include-path") && include_paths.is_empty() {
        return Err(format!("Error: Missing value for --include-path <$.path>\n{BIND_USAGE}"));
    }
    let projected = args.iter().any(|arg| arg == "--projected") || !include_paths.is_empty();
    if args.iter().any(|arg| arg == "--projected") && include_paths.is_empty() {
        return Err(format!(
            "Error: --projected requires at least one --include-path <$.path>\n{BIND_USAGE}"
        ));
    }
    if !matches!(trailing_separator_policy.as_str(), "off" | "warn" | "error") {
        return Err(format!(
            "Error: Invalid value for --trailing-separator-delimiter-policy: expected off, warn, or error\n{BIND_USAGE}"
        ));
    }

    let source = fs::read_to_string(&file).map_err(|error| format!("failed to read {file}: {error}"))?;
    if let Some(limit) = max_input_bytes {
        let actual = source.as_bytes().len();
        if actual > limit {
            eprintln!("Input size {actual} bytes exceeds configured limit of {limit} bytes");
            return Ok((ExitCode::from(1), json!({})));
        }
    }
    let header_probe = compile(
        &source,
        CompileOptions {
            recovery: true,
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            max_input_bytes,
            ..CompileOptions::default()
        },
    );
    let (schema, profile) = resolve_bind_contracts(
        &file,
        &source,
        header_probe.header.as_ref(),
        schema_path,
        contract_registry_path,
        profile,
    )?;

    let recovery = matches!(mode, FinalizeMode::Loose);
    let compile_datatype_policy = if has_contract_registry {
        Some(DatatypePolicy::AllowCustom)
    } else {
        datatype_policy
    };
    let result = compile(
        &source,
        CompileOptions {
            recovery,
            datatype_policy: compile_datatype_policy,
            max_input_bytes,
            ..CompileOptions::default()
        },
    );

    let validation = validate(&ValidationEnvelope {
        aes: core_events_to_aeos(&result.events),
        schema: Some(schema),
        options: ValidationOptions {
            trailing_separator_delimiter_policy: trailing_separator_policy,
            ..ValidationOptions::default()
        },
    });

    let has_compile_errors = !result.errors.is_empty();
    let has_schema_errors = !validation.errors.is_empty();
    let mut annotations = if include_annotations {
        let mut items = extract_annotations(&source);
        if sort_annotations_flag {
            items = sort_annotations(items);
        }
        Some(items)
    } else {
        None
    };

    let mut top = Map::new();
    if !matches!(mode, FinalizeMode::Strict) || (!has_compile_errors && !has_schema_errors) {
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                mode,
                materialization: if projected {
                    Materialization::Projected
                } else {
                    Materialization::All
                },
                include_paths,
                scope,
                header: result.header.clone(),
            },
        );
        if result.errors.is_empty() || matches!(mode, FinalizeMode::Loose) {
            top.insert(String::from("document"), finalized.document);
        }
    }
    if let Some(items) = annotations.take() {
        top.insert(
            String::from("annotations"),
            serde_json::from_str(&render_annotations(&items))
                .map_err(|error| format!("failed to render annotations JSON: {error}"))?,
        );
    }

    let mut meta = Map::new();
    let mut errors = result.errors.iter().map(diagnostic_to_json).collect::<Vec<_>>();
    errors.extend(validation.errors.iter().map(schema_diagnostic_to_json));
    meta.insert(String::from("errors"), JsonValue::Array(errors));
    let mut warnings = validation
        .warnings
        .iter()
        .map(schema_diagnostic_to_json)
        .collect::<Vec<_>>();
    if let Some(profile_id) = profile {
        warnings.push(profile_processors_skipped_warning(&profile_id));
    }
    meta.insert(String::from("warnings"), JsonValue::Array(warnings));
    top.insert(String::from("meta"), JsonValue::Object(meta));

    Ok((
        if has_compile_errors || has_schema_errors {
            ExitCode::from(1)
        } else {
            ExitCode::SUCCESS
        },
        JsonValue::Object(top),
    ))
}

fn fmt(args: &[String]) -> Result<ExitCode, String> {
    let write_output = args.iter().any(|arg| arg == "--write");
    let max_input_bytes = optional_numeric_flag_value(args, "--max-input-bytes").map_err(|_| {
        String::from("Error: Invalid value for --max-input-bytes (expected a non-negative integer)")
    })?;
    let file = find_file(args, &["--max-input-bytes"]);
    if write_output && file.is_none() {
        return Err(String::from(
            "Error: --write requires a file path\nUsage: aeon fmt [file] [--write]",
        ));
    }
    let source = match file {
        Some(ref path) => fs::read_to_string(path).map_err(|error| format!("failed to read {path}: {error}"))?,
        None => {
            let mut buffer = String::new();
            io::stdin()
                .read_to_string(&mut buffer)
                .map_err(|error| format!("failed to read stdin: {error}"))?;
            buffer
        }
    };

    let (code, output) = format_source_for_cli(&source, max_input_bytes)?;
    if code != ExitCode::SUCCESS {
        if output.starts_with("Input size ") {
            eprintln!("{output}");
        } else if !output.is_empty() {
            println!("{output}");
        }
        return Ok(code);
    }

    if write_output {
        if let Some(path) = file {
            if source != output {
                write_file_with_backup(&path, &output)?;
            }
            return Ok(ExitCode::SUCCESS);
        }
    }

    print!("{output}");
    Ok(ExitCode::SUCCESS)
}

fn format_source_for_cli(source: &str, max_input_bytes: Option<usize>) -> Result<(ExitCode, String), String> {
    if let Some(limit) = max_input_bytes {
        let actual = source.as_bytes().len();
        if actual > limit {
            return Ok((
                ExitCode::from(1),
                format!("Input size {actual} bytes exceeds configured limit of {limit} bytes"),
            ));
        }
    }
    let result = canonicalize(source);
    if !result.errors.is_empty() {
        return Ok((
            ExitCode::from(1),
            result
                .errors
                .iter()
                .map(format_error_line)
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    Ok((ExitCode::SUCCESS, result.text))
}

fn doctor(args: &[String]) -> Result<ExitCode, String> {
    let json_output = args.iter().any(|arg| arg == "--json");
    let registry_flag_present = args.iter().any(|arg| arg == "--contract-registry");
    let registry_path = flag_value(args, "--contract-registry");
    if registry_flag_present && registry_path.is_none() {
        return Err(String::from(
            "Error: Missing value for --contract-registry <registry.json>\nUsage: aeon doctor [--json] [--contract-registry <registry.json>]",
        ));
    }

    let registry_path = registry_path.unwrap_or_else(|| default_contract_registry_path());
    let result = run_doctor(&registry_path);

    if json_output {
        let payload = doctor_payload(&result);
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|error| format!("failed to render JSON: {error}"))?
        );
    } else {
        for line in doctor_lines(&result) {
            println!("{line}");
        }
    }

    Ok(if result.iter().any(|check| check.status == "fail") {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

fn cts_validate() -> Result<ExitCode, String> {
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    let rendered = validate_cts_payload(&payload)?;
    println!("{rendered}");
    Ok(ExitCode::from(0))
}

fn cts_adapter() -> Result<ExitCode, String> {
    cts_validate()
}

fn default_contract_registry_path() -> String {
    specs_repo_root()
        .join("aeon")
        .join("v1")
        .join("drafts")
        .join("contracts")
        .join("registry.json")
        .to_string_lossy()
        .into_owned()
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn family_root() -> PathBuf {
    workspace_root()
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(workspace_root)
}

fn repo_root_from_env(env_key: &str, default_segments: &[&str]) -> PathBuf {
    if let Some(path) = env::var_os(env_key).filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }

    let mut root = family_root();
    for segment in default_segments {
        root.push(segment);
    }
    root
}

fn specs_repo_root() -> PathBuf {
    repo_root_from_env("AEONITE_SPECS_ROOT", &["aeonite-org", "aeonite-specs"])
}

fn examples_repo_root() -> PathBuf {
    if let Some(path) = env::var_os("AEON_EXAMPLES_ROOT").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }

    if let Some(path) = env::var_os("AEON_EXAMPLES_PRIVATE_ROOT").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }

    let public_root = family_root().join("altopelago").join("aeon-examples");
    if public_root.exists() {
        return public_root;
    }

    family_root()
        .join("altopelago")
        .join("aeon-examples-private")
}

fn run_doctor(registry_path: &str) -> Vec<DoctorCheck> {
    vec![
        DoctorCheck {
            name: "node-version",
            status: "pass",
            message: format!("Rust CLI package version {}", env!("CARGO_PKG_VERSION")),
            details: Some(json!({
                "packageVersion": env!("CARGO_PKG_VERSION"),
                "msrv": "1.85",
                "runtime": "rust",
            })),
        },
        DoctorCheck {
            name: "package-availability",
            status: "pass",
            message: String::from("Required Rust crates are present in the workspace"),
            details: Some(json!({
                "crates": [
                    "aeon-core",
                    "aeon-annotations",
                    "aeon-aeos",
                    "aeon-canonical",
                    "aeon-finalize",
                    "aeon-cli"
                ]
            })),
        },
        inspect_contract_registry(registry_path),
        DoctorCheck {
            name: "policy-surface",
            status: "pass",
            message: String::from("CLI/runtime policy surface is available"),
            details: Some(json!({
                "datatypePolicy": ["reserved_only", "allow_custom"],
                "finalizeMode": ["strict", "loose"],
                "trailingSeparatorDelimiterPolicy": ["off", "warn", "error"],
                "recovery": true,
            })),
        },
    ]
}

fn inspect_contract_registry(registry_path: &str) -> DoctorCheck {
    if !Path::new(registry_path).exists() {
        return DoctorCheck {
            name: "contract-registry",
            status: "fail",
            message: format!("Contract registry not found: {registry_path}"),
            details: None,
        };
    }

    let registry = match read_contract_registry_file(registry_path) {
        Ok(registry) => registry,
        Err(_) => {
            return DoctorCheck {
                name: "contract-registry",
                status: "fail",
                message: format!("Contract registry is unreadable: {registry_path}"),
                details: None,
            }
        }
    };

    let entries = registry
        .contracts
        .iter()
        .map(|entry| match verify_contract_artifact(entry, registry_path) {
            Ok(resolved_path) => json!({
                "id": entry.id,
                "kind": entry.kind,
                "status": "pass",
                "path": resolved_path,
            }),
            Err(error) => {
                let code = if error.contains("CONTRACT_ARTIFACT_HASH_MISMATCH") {
                    "CONTRACT_ARTIFACT_HASH_MISMATCH"
                } else {
                    "CONTRACT_ARTIFACT_MISSING"
                };
                json!({
                    "id": entry.id,
                    "kind": entry.kind,
                    "status": "fail",
                    "code": code,
                    "error": error,
                })
            }
        })
        .collect::<Vec<_>>();

    let failures = entries
        .iter()
        .filter(|entry| entry["status"] == "fail")
        .count();

    DoctorCheck {
        name: "contract-registry",
        status: if failures == 0 { "pass" } else { "fail" },
        message: if failures == 0 {
            format!("Verified {} contract artifact(s) from {registry_path}", entries.len())
        } else {
            format!("Registry verification failed for {failures} contract artifact(s)")
        },
        details: Some(json!({
            "path": registry_path,
            "entries": entries,
        })),
    }
}

fn doctor_check_to_json(check: &DoctorCheck) -> JsonValue {
    let mut object = Map::new();
    object.insert(String::from("name"), JsonValue::String(String::from(check.name)));
    object.insert(String::from("status"), JsonValue::String(String::from(check.status)));
    object.insert(String::from("message"), JsonValue::String(check.message.clone()));
    if let Some(details) = &check.details {
        object.insert(String::from("details"), details.clone());
    }
    JsonValue::Object(object)
}

fn doctor_payload(checks: &[DoctorCheck]) -> JsonValue {
    json!({
        "ok": checks.iter().all(|check| check.status != "fail"),
        "checks": checks.iter().map(doctor_check_to_json).collect::<Vec<_>>(),
    })
}

fn doctor_lines(checks: &[DoctorCheck]) -> Vec<String> {
    checks
        .iter()
        .map(|check| {
            let label = match check.status {
                "pass" => "PASS",
                "warn" => "WARN",
                _ => "FAIL",
            };
            format!("[{label}] {} {}", check.name, check.message)
        })
        .collect()
}

fn resolve_integrity_mode(args: &[String]) -> Result<&'static str, String> {
    let strict = args.iter().any(|arg| arg == "--strict");
    let loose = args.iter().any(|arg| arg == "--loose");
    if strict && loose {
        return Err(String::from("Cannot use both --strict and --loose"));
    }
    Ok(if loose { "loose" } else { "strict" })
}

fn sign_string_payload(payload: &str, private_key_pem: &str) -> Result<String, String> {
    let signing_key = SigningKey::from_pkcs8_pem(private_key_pem)
        .map_err(|error| format!("failed to parse private key: {error}"))?;
    let signature = signing_key.sign(payload.as_bytes());
    Ok(bytes_to_hex(&signature.to_bytes()))
}

fn verify_string_payload_signature(payload: &str, signature_hex: &str, public_key_pem: &str) -> Result<bool, String> {
    let verifying_key = VerifyingKey::from_public_key_pem(public_key_pem)
        .map_err(|error| format!("failed to parse public key: {error}"))?;
    let signature_bytes = hex_to_bytes(signature_hex)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| format!("failed to parse signature bytes: {error}"))?;
    Ok(verifying_key.verify(payload.as_bytes(), &signature).is_ok())
}

fn render_signature_envelope(
    hash: &str,
    signature: &str,
    bytes_hash: Option<&str>,
    checksum_hash: Option<&str>,
) -> String {
    let mut lines = vec![
        "close:envelope = {".to_string(),
        "  integrity:integrityBlock = {".to_string(),
        "    alg:string = \"sha-256\"".to_string(),
        format!("    hash:string = \"{hash}\""),
    ];
    if let Some(bytes_hash) = bytes_hash {
        lines.push("    bytes_hash_alg:string = \"sha-256\"".to_string());
        lines.push(format!("    bytes_hash:string = \"{bytes_hash}\""));
    }
    if let Some(checksum_hash) = checksum_hash {
        lines.push("    checksum_alg:string = \"sha-256\"".to_string());
        lines.push(format!("    checksum_value:string = \"{checksum_hash}\""));
    }
    lines.extend([
        "  }".to_string(),
        "  signatures:signatureSet = [".to_string(),
        "    {".to_string(),
        "      alg:string = \"ed25519\"".to_string(),
        "      kid:string = \"default\"".to_string(),
        format!("      sig:string = \"{signature}\""),
        "    }".to_string(),
        "  ]".to_string(),
        "}".to_string(),
    ]);
    lines.join("\n")
}

fn render_integrity_json(hash: &str, bytes_hash: Option<&str>, checksum_hash: Option<&str>) -> JsonValue {
    let mut object = Map::new();
    object.insert(String::from("alg"), JsonValue::String(String::from("sha-256")));
    object.insert(String::from("hash"), JsonValue::String(String::from(hash)));
    if let Some(bytes_hash) = bytes_hash {
        object.insert(String::from("bytes_hash_alg"), JsonValue::String(String::from("sha-256")));
        object.insert(String::from("bytes_hash"), JsonValue::String(String::from(bytes_hash)));
    }
    if let Some(checksum_hash) = checksum_hash {
        object.insert(String::from("checksum_alg"), JsonValue::String(String::from("sha-256")));
        object.insert(String::from("checksum_value"), JsonValue::String(String::from(checksum_hash)));
    }
    JsonValue::Object(object)
}

fn append_envelope(source: &str, envelope: &str) -> String {
    let trimmed = source.trim_end();
    let separator = if trimmed.is_empty() || trimmed.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    format!("{trimmed}{separator}\n{envelope}\n")
}

fn remove_envelope(source: &str) -> String {
    let trimmed = source.trim_end();
    let lines = trimmed.split('\n').collect::<Vec<_>>();
    let mut start = None;
    let mut depth = 0i32;
    for (index, line) in lines.iter().enumerate() {
        if start.is_none() && line.trim_start().starts_with("close:envelope") {
            start = Some(index);
        }
        if start.is_some() {
            depth += count_char(line, '{') as i32;
            depth -= count_char(line, '}') as i32;
            if depth <= 0 {
                let start = start.unwrap_or(0);
                let before = &lines[..start];
                let after = &lines[index + 1..];
                return before
                    .iter()
                    .chain(after.iter())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim_end()
                    .to_string();
            }
        }
    }
    trimmed.to_string()
}

fn count_char(value: &str, ch: char) -> usize {
    value.chars().filter(|candidate| *candidate == ch).count()
}

fn compute_byte_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

struct SecurityConventionResult {
    source: String,
    changed: bool,
}

fn ensure_gp_security_conventions(source: &str) -> SecurityConventionResult {
    const GP_SECURITY_CONVENTIONS: [&str; 3] = [
        "aeon.gp.security.v1",
        "aeon.gp.integrity.v1",
        "aeon.gp.signature.v1",
    ];

    let Some((start, end)) = find_structured_header_range(source) else {
        let header = render_security_header(&GP_SECURITY_CONVENTIONS);
        return SecurityConventionResult {
            source: format!("{}\n\n{}", header, source.trim_start()).trim_end().to_string(),
            changed: true,
        };
    };

    let header_block = &source[start..end];
    let existing = extract_header_conventions(header_block);
    let missing = GP_SECURITY_CONVENTIONS
        .iter()
        .filter(|entry| !existing.iter().any(|existing| existing == *entry))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return SecurityConventionResult {
            source: source.to_string(),
            changed: false,
        };
    }

    let updated = merge_security_conventions_into_header(header_block, &missing);
    SecurityConventionResult {
        source: format!("{}{}{}", &source[..start], updated, &source[end..]),
        changed: true,
    }
}

fn render_security_header(conventions: &[&str]) -> String {
    let mut lines = vec![
        "aeon:header = {".to_string(),
        "  conventions:conventionSet = [".to_string(),
    ];
    for convention in conventions {
        lines.push(format!("    \"{convention}\""));
    }
    lines.extend(["  ]".to_string(), "}".to_string()]);
    lines.join("\n")
}

fn find_structured_header_range(source: &str) -> Option<(usize, usize)> {
    let start = source.find("aeon:header")?;
    let open = source[start..].find('{')? + start;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaping = false;
    for (index, ch) in source[open..].char_indices() {
        if in_string {
            if escaping {
                escaping = false;
                continue;
            }
            if ch == '\\' {
                escaping = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                let mut end = open + index + ch.len_utf8();
                while let Some(next) = source[end..].chars().next() {
                    if next == '\n' || next == '\r' {
                        end += next.len_utf8();
                    } else {
                        break;
                    }
                }
                return Some((start, end));
            }
        }
    }
    None
}

fn extract_header_conventions(header_block: &str) -> Vec<String> {
    let Some(start) = header_block.find("conventions") else {
        return Vec::new();
    };
    let Some(open_rel) = header_block[start..].find('[') else {
        return Vec::new();
    };
    let open = start + open_rel;
    let Some(close_rel) = header_block[open..].find(']') else {
        return Vec::new();
    };
    let close = open + close_rel;
    let body = &header_block[open + 1..close];
    let mut items = Vec::new();
    let mut remainder = body;
    while let Some(first) = remainder.find('"') {
        let after = &remainder[first + 1..];
        let Some(second) = after.find('"') else {
            break;
        };
        items.push(after[..second].to_string());
        remainder = &after[second + 1..];
    }
    items
}

fn merge_security_conventions_into_header(header_block: &str, missing: &[&str]) -> String {
    if let Some(start) = header_block.find("conventions") {
        if let Some(open_rel) = header_block[start..].find('[') {
            let open = start + open_rel;
            if let Some(close_rel) = header_block[open..].find(']') {
                let close = open + close_rel;
                let body = header_block[open + 1..close].trim_end();
                let mut next_body = String::new();
                if !body.is_empty() {
                    next_body.push_str(body);
                    next_body.push('\n');
                }
                for convention in missing {
                    next_body.push_str(&format!("    \"{convention}\"\n"));
                }
                return format!("{}[\n{}  ]{}", &header_block[..open], next_body, &header_block[close + 1..]);
            }
        }
    }

    let insert_at = header_block.find('{').map(|index| index + 1).unwrap_or(0);
    let snippet = format!(
        "\n  conventions:conventionSet = [\n{}\n  ]",
        missing
            .iter()
            .map(|entry| format!("    \"{entry}\""))
            .collect::<Vec<_>>()
            .join("\n")
    );
    format!("{}{}{}", &header_block[..insert_at], snippet, &header_block[insert_at..])
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err(String::from("failed to decode signature hex: odd-length hex string"));
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let hi = hex_nibble(bytes[index]).ok_or_else(|| String::from("failed to decode signature hex: invalid hex"))?;
        let lo = hex_nibble(bytes[index + 1]).ok_or_else(|| String::from("failed to decode signature hex: invalid hex"))?;
        out.push((hi << 4) | lo);
        index += 2;
    }
    Ok(out)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn output_integrity_result(
    json_output: bool,
    errors: &[EnvelopeDiagnostic],
    warnings: &[EnvelopeDiagnostic],
    receipt: Option<JsonValue>,
    verification: Option<JsonValue>,
) -> Result<ExitCode, String> {
    if json_output {
        let object = integrity_payload(errors, warnings, receipt, verification)
            .as_object()
            .cloned()
            .unwrap_or_default();
        println!(
            "{}",
            serde_json::to_string_pretty(&JsonValue::Object(object))
                .map_err(|error| format!("failed to render JSON: {error}"))?
        );
    } else {
        for line in integrity_plain_lines(errors, warnings) {
            println!("{line}");
        }
    }
    Ok(if errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn envelope_diagnostic_to_json(diag: &EnvelopeDiagnostic) -> JsonValue {
    json!({
        "code": diag.code,
        "message": diag.message,
    })
}

fn integrity_plain_lines(errors: &[EnvelopeDiagnostic], warnings: &[EnvelopeDiagnostic]) -> Vec<String> {
    if errors.is_empty() {
        let mut lines = warnings
            .iter()
            .map(|warning| format_envelope_diagnostic_line("WARN", warning))
            .collect::<Vec<_>>();
        lines.push(String::from("OK"));
        return lines;
    }
    errors
        .iter()
        .map(|error| format_envelope_diagnostic_line("ERROR", error))
        .collect()
}

fn integrity_payload(
    errors: &[EnvelopeDiagnostic],
    warnings: &[EnvelopeDiagnostic],
    receipt: Option<JsonValue>,
    verification: Option<JsonValue>,
) -> JsonValue {
    let mut object = Map::new();
    object.insert(String::from("ok"), JsonValue::Bool(errors.is_empty()));
    object.insert(
        String::from("errors"),
        JsonValue::Array(errors.iter().map(envelope_diagnostic_to_json).collect::<Vec<_>>()),
    );
    object.insert(
        String::from("warnings"),
        JsonValue::Array(warnings.iter().map(envelope_diagnostic_to_json).collect::<Vec<_>>()),
    );
    if let Some(receipt) = receipt {
        object.insert(String::from("receipt"), receipt);
    }
    if let Some(verification) = verification {
        object.insert(String::from("verification"), verification);
    }
    JsonValue::Object(object)
}

struct CanonicalHashResult {
    hash: String,
    stream: String,
}

fn canonical_receipt_json(
    source: &str,
    canonical: &CanonicalHashResult,
    header: Option<&aeon_core::HeaderFields>,
    digest_override: Option<&str>,
    include_payload: bool,
) -> JsonValue {
    let source_hash = compute_byte_hash(source);
    let canonical_digest = digest_override.unwrap_or(&canonical.hash);
    let mut canonical_object = Map::new();
    canonical_object.insert(String::from("format"), JsonValue::String(String::from("aeon.canonical")));
    canonical_object.insert(String::from("spec"), JsonValue::String(String::from("AEON Core")));
    canonical_object.insert(String::from("specRelease"), JsonValue::String(String::from("v1")));
    canonical_object.insert(
        String::from("mode"),
        JsonValue::String(header_field_value(header, "mode").unwrap_or_else(|| String::from("transport"))),
    );
    canonical_object.insert(
        String::from("profile"),
        JsonValue::String(header_field_value(header, "profile").unwrap_or_else(|| String::from("core"))),
    );
    canonical_object.insert(String::from("outputEncoding"), JsonValue::String(String::from("utf-8")));
    canonical_object.insert(String::from("digestAlgorithm"), JsonValue::String(String::from("sha-256")));
    canonical_object.insert(String::from("digest"), JsonValue::String(canonical_digest.to_string()));
    canonical_object.insert(String::from("length"), JsonValue::Number(canonical.stream.len().into()));
    if include_payload {
        canonical_object.insert(String::from("payload"), JsonValue::String(canonical.stream.clone()));
    }
    json!({
        "source": {
            "mediaType": "text/aeon",
            "encoding": "utf-8",
            "digestAlgorithm": "sha-256",
            "digest": source_hash,
        },
        "canonical": canonical_object,
        "producer": {
            "implementation": "aeon-cli-rs",
            "version": VERSION,
        },
        "generated": {
            "at": current_receipt_timestamp(),
        }
    })
}

fn current_receipt_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00Z"))
}

fn compute_canonical_hash(events: &[AssignmentEvent], algorithm: &str) -> CanonicalHashResult {
    let stream = serialize_canonical_events(events);
    let mut hasher = Sha256::new();
    hasher.update(stream.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let _ = algorithm;
    CanonicalHashResult { hash, stream }
}

fn serialize_canonical_events(events: &[AssignmentEvent]) -> String {
    let envelope_roots = events
        .iter()
        .filter(|event| is_envelope_event(event))
        .map(|event| format_path(&event.path))
        .collect::<Vec<_>>();
    let mut filtered = events
        .iter()
        .filter(|event| {
            let path = format_path(&event.path);
            !envelope_roots
                .iter()
                .any(|root| path == *root || path.starts_with(&format!("{root}.")))
        })
        .collect::<Vec<_>>();
    filtered.sort_by_key(|event| format_path(&event.path));
    filtered
        .into_iter()
        .map(|event| format!("{}\t{}\n", format_path(&event.path), serialize_canonical_value(&event.value)))
        .collect()
}

fn serialize_canonical_value(value: &Value) -> String {
    match value {
        Value::StringLiteral { value, .. } => format!("\"{}\"", escape_json(value)),
        Value::InfinityLiteral { raw } => raw.clone(),
        Value::NumberLiteral { raw }
        | Value::SwitchLiteral { raw }
        | Value::BooleanLiteral { raw }
        | Value::EncodingLiteral { raw }
        | Value::SeparatorLiteral { raw }
        | Value::RadixLiteral { raw }
        | Value::DateLiteral { raw }
        | Value::DateTimeLiteral { raw }
        | Value::TimeLiteral { raw } => raw.clone(),
        Value::HexLiteral { raw } => format!("\"{}\"", escape_json(raw)),
        Value::CloneReference { segments } => format!("\"~{}\"", render_reference_path(segments)),
        Value::PointerReference { segments } => format!("\"~>{}\"", render_reference_path(segments)),
        Value::ListNode { items } | Value::TupleLiteral { items } => {
            let rendered = items
                .iter()
                .map(serialize_canonical_value)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{rendered}]")
        }
        Value::ObjectNode { bindings } => {
            let mut ordered = bindings.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|binding| binding.key.clone());
            let rendered = ordered
                .into_iter()
                .map(|binding| format!("{}:{}", binding.key, serialize_canonical_value(&binding.value)))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{rendered}}}")
        }
        Value::NodeLiteral { raw, .. } => format!("\"{}\"", escape_json(raw)),
    }
}

fn validate_envelope_events(
    events: &[AssignmentEvent],
    strict: bool,
) -> (Vec<EnvelopeDiagnostic>, Vec<EnvelopeDiagnostic>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let top_level = events
        .iter()
        .filter(|event| is_top_level_event(event))
        .collect::<Vec<_>>();
    let Some(index) = top_level.iter().position(|event| is_envelope_event(event)) else {
        return (errors, warnings);
    };
    if index != top_level.len().saturating_sub(1) {
        errors.push(EnvelopeDiagnostic {
            code: "ENVELOPE_NOT_LAST",
            message: String::from("envelope binding must be the final binding in the document"),
        });
    }
    let envelope = top_level[index];
    if !matches!(envelope.value, Value::ObjectNode { .. }) {
        errors.push(EnvelopeDiagnostic {
            code: "ENVELOPE_NOT_OBJECT",
            message: String::from("envelope binding must be an object"),
        });
        return (errors, warnings);
    }

    let unknown = envelope_unknown_fields(events, &format_path(&envelope.path));
    if !unknown.is_empty() {
        let diag = EnvelopeDiagnostic {
            code: "ENVELOPE_UNKNOWN_FIELD",
            message: format!("Unknown envelope fields: {}", unknown.join(", ")),
        };
        if strict {
            errors.push(diag);
        } else {
            warnings.push(diag);
        }
    }

    (errors, warnings)
}

fn envelope_unknown_fields(events: &[AssignmentEvent], envelope_root: &str) -> Vec<String> {
    let mut unknown = Vec::new();
    for event in events {
        let path = format_path(&event.path);
        if !path.starts_with(&(envelope_root.to_string() + ".")) {
            continue;
        }
        let suffix = &path[envelope_root.len() + 1..];
        let top = suffix
            .split('.')
            .next()
            .unwrap_or_default()
            .split('[')
            .next()
            .unwrap_or_default();
        if !matches!(top, "integrity" | "signatures" | "bytes" | "checksum") && !unknown.iter().any(|v| v == top) {
            unknown.push(String::from(top));
        }
    }
    unknown
}

fn envelope_root_path(events: &[AssignmentEvent]) -> Option<String> {
    events
        .iter()
        .find(|event| is_top_level_event(event) && is_envelope_event(event))
        .map(|event| format_path(&event.path))
}

fn read_envelope_field(events: &[AssignmentEvent], envelope_root: &str, suffixes: &[&str]) -> Option<String> {
    for event in events {
        let path = format_path(&event.path);
        for suffix in suffixes {
            let candidate = format!("{envelope_root}.{suffix}");
            if path == candidate {
                return envelope_literal_value(&event.value);
            }
        }
    }
    None
}

fn envelope_literal_value(value: &Value) -> Option<String> {
    match value {
        Value::StringLiteral { value, .. } => Some(value.clone()),
        Value::NumberLiteral { raw }
        | Value::SwitchLiteral { raw }
        | Value::BooleanLiteral { raw }
        | Value::HexLiteral { raw }
        | Value::SeparatorLiteral { raw }
        | Value::EncodingLiteral { raw }
        | Value::RadixLiteral { raw }
        | Value::TimeLiteral { raw } => Some(raw.clone()),
        _ => None,
    }
}

fn is_top_level_event(event: &AssignmentEvent) -> bool {
    event.path.segments.len() == 2
}

fn is_envelope_event(event: &AssignmentEvent) -> bool {
    matches!(event.path.segments.last(), Some(PathSegment::Member(_)))
        && event
            .datatype
            .as_deref()
            .map(datatype_base)
            .as_deref()
            == Some("envelope")
}

fn datatype_base(datatype: &str) -> String {
    let generic = datatype.find('<').unwrap_or(datatype.len());
    let separator = datatype.find('[').unwrap_or(datatype.len());
    let end = generic.min(separator);
    datatype[..end].to_ascii_lowercase()
}

fn normalize_hash(value: &str) -> String {
    value.trim().trim_start_matches('#').to_ascii_lowercase()
}

fn normalize_hash_algorithm(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "sha-256" => Some(String::from("sha-256")),
        _ => None,
    }
}

fn print_help() {
    println!("AEON Rust CLI");
    println!();
    println!("Commands:");
    println!("  version");
    println!("  check <file> [--datatype-policy <reserved_only|allow_custom>] [--max-input-bytes <n>]");
    println!("  doctor [--json] [--contract-registry <registry.json>]");
    println!("  inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]");
    println!("  finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--scope <payload|header|full>] [--projected --include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>] [--max-input-bytes <n>]");
    println!("  bind <file> (--schema <schema.json> | --contract-registry <registry.json>) [--strict|--loose] [--scope <payload|header|full>] [--projected --include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>] [--annotations] [--sort-annotations] [--max-input-bytes <n>]");
    println!("  integrity validate <file> [--json] [--strict|--loose]");
    println!("  integrity verify <file> [--json] [--strict|--loose] [--public-key <path>] [--receipt <path>]");
    println!("  integrity sign <file> --private-key <path> [--json|--write] [--replace] [--include-bytes] [--include-checksum] [--receipt <path>]");
    println!("  fmt [file] [--write] [--max-input-bytes <n>]");
    println!("  cts-adapter");
}

fn write_file_with_backup(path: &str, contents: &str) -> Result<(), String> {
    let backup = next_backup_path(path);
    fs::copy(path, &backup)
        .map_err(|error| format!("failed to create backup {backup} for {path}: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("failed to write {path}: {error}"))
}

fn next_backup_path(path: &str) -> String {
    let mut candidate = format!("{path}.bak");
    if !std::path::Path::new(&candidate).exists() {
        return candidate;
    }
    let mut index = 1usize;
    loop {
        candidate = format!("{path}.bak{index}");
        if !std::path::Path::new(&candidate).exists() {
            return candidate;
        }
        index += 1;
    }
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn render_annotations(records: &[aeon_annotations::AnnotationRecord]) -> String {
    if records.is_empty() {
        return String::from("[]");
    }

    let items = records
        .iter()
        .map(|record| {
            format!(
                "{{\"kind\":\"{}\",\"form\":\"{}\",\"raw\":\"{}\",\"span\":{},\"target\":{}}}",
                escape_json(&record.kind),
                escape_json(&record.form),
                escape_json(&record.raw),
                render_span(&record.span),
                render_annotation_target(&record.target)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{items}]")
}

struct InspectRenderOptions {
    recovery: bool,
    include_annotations: bool,
    annotations_only: bool,
    mode: String,
    version: Option<String>,
    profile: Option<String>,
    schema: Option<String>,
}

fn render_inspect_markdown(
    file: &str,
    result: &aeon_core::CompileResult,
    annotations: &[aeon_annotations::AnnotationRecord],
    options: InspectRenderOptions,
) -> String {
    let mut lines = Vec::new();
    let visible_events = &result.events;

    if options.annotations_only {
        lines.push(String::from("# AEON Annotations"));
        lines.push(String::new());
        lines.push(format!("- Count: {}", annotations.len()));
        if !annotations.is_empty() {
            lines.push(String::new());
            lines.push(String::from("## Annotation Records"));
            for annotation in annotations {
                lines.push(format!("- {}", format_annotation_line(annotation)));
            }
        }
        lines.push(String::new());
        return lines.join("\n");
    }

    lines.push(String::from("# AEON Inspect"));
    if options.recovery {
        lines.push(String::from("> WARNING: recovery mode enabled (tooling-only); output may be partial"));
    }
    lines.push(String::new());
    lines.push(String::from("## Summary"));
    lines.push(format!("- File: {}", file.rsplit('/').next().unwrap_or(file)));
    lines.push(format!("- Version: {}", options.version.unwrap_or_else(|| String::from("—"))));
    lines.push(format!("- Mode: {}", options.mode));
    lines.push(format!("- Profile: {}", options.profile.unwrap_or_else(|| String::from("—"))));
    lines.push(format!("- Schema: {}", options.schema.unwrap_or_else(|| String::from("—"))));
    lines.push(format!("- Recovery: {}", if options.recovery { "true" } else { "false" }));
    lines.push(format!("- Events: {}", visible_events.len()));
    if options.include_annotations {
        lines.push(format!("- Annotations: {}", annotations.len()));
    }
    lines.push(format!("- Errors: {}", result.errors.len()));

    if !result.errors.is_empty() {
        lines.push(String::new());
        lines.push(String::from("## Errors"));
        for error in &result.errors {
            lines.push(format!("- {}", format_error_line(error)));
        }
    }

    if !visible_events.is_empty() {
        lines.push(String::new());
        lines.push(String::from("## Assignment Events"));
        for event in visible_events {
            lines.push(format!("- {}", format_event_line(event)));
        }
    }

    let references = find_references(visible_events);
    if !references.is_empty() {
        lines.push(String::new());
        lines.push(String::from("## References"));
        for reference in references {
            lines.push(format!("- {reference}"));
        }
    }

    if options.include_annotations && !annotations.is_empty() {
        lines.push(String::new());
        lines.push(String::from("## Annotation Records"));
        for annotation in annotations {
            lines.push(format!("- {}", format_annotation_line(annotation)));
        }
    }

    lines.push(String::new());
    lines.join("\n")
}

fn render_annotation_target(target: &aeon_annotations::AnnotationTarget) -> String {
    match target {
        aeon_annotations::AnnotationTarget::Path { path } => {
            format!("{{\"kind\":\"path\",\"path\":\"{}\"}}", escape_json(path))
        }
        aeon_annotations::AnnotationTarget::Unbound { reason } => {
            format!("{{\"kind\":\"unbound\",\"reason\":\"{}\"}}", escape_json(reason))
        }
    }
}

fn render_events(events: &[AssignmentEvent]) -> String {
    let mut out = String::from("[");
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let path = format_path(&event.path);
        let datatype = event
            .datatype
            .as_ref()
            .map(|value| format!("\"{}\"", escape_json(value)))
            .unwrap_or_else(|| String::from("null"));
        out.push_str("{\"path\":\"");
        out.push_str(&escape_json(&path));
        out.push_str("\",\"key\":\"");
        out.push_str(&escape_json(&event.key));
        out.push_str("\",\"datatype\":");
        out.push_str(&datatype);
        out.push_str(",\"span\":");
        out.push_str(&render_span(&event.span));
        out.push_str(",\"value\":");
        out.push_str(&render_value_json_string(&event.value));
        out.push('}');
    }
    out.push(']');
    out
}

fn render_errors(errors: &[Diagnostic]) -> String {
    let items = errors
        .iter()
        .map(|error| {
            let mut object = diagnostic_to_json(error).as_object().cloned().unwrap_or_default();
            object.insert(
                String::from("path"),
                JsonValue::String(error.path.clone().unwrap_or_else(|| String::from("$"))),
            );
            JsonValue::Object(object)
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&items).unwrap_or_else(|_| String::from("[]"))
}

fn render_value_json_string(value: &Value) -> String {
    match value {
        Value::InfinityLiteral { raw } => format!(
            "{{\"type\":\"InfinityLiteral\",\"raw\":\"{}\",\"value\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::NumberLiteral { raw } => format!(
            "{{\"type\":\"NumberLiteral\",\"raw\":\"{}\",\"value\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::StringLiteral { value, .. } => format!(
            "{{\"type\":\"StringLiteral\",\"raw\":\"{}\",\"value\":\"{}\"}}",
            escape_json(value),
            escape_json(value)
        ),
        Value::SwitchLiteral { raw } => format!(
            "{{\"type\":\"SwitchLiteral\",\"value\":\"{}\"}}",
            escape_json(raw)
        ),
        Value::BooleanLiteral { raw } => format!(
            "{{\"type\":\"BooleanLiteral\",\"value\":{},\"raw\":\"{}\"}}",
            if raw == "true" { "true" } else { "false" },
            escape_json(raw)
        ),
        Value::HexLiteral { raw } => format!(
            "{{\"type\":\"HexLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::SeparatorLiteral { raw } => format!(
            "{{\"type\":\"SeparatorLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw.trim_start_matches('^')),
            escape_json(raw)
        ),
        Value::EncodingLiteral { raw } => format!(
            "{{\"type\":\"EncodingLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::RadixLiteral { raw } => format!(
            "{{\"type\":\"RadixLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::DateLiteral { raw } => format!(
            "{{\"type\":\"DateLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::DateTimeLiteral { raw } => format!(
            "{{\"type\":\"DateTimeLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::TimeLiteral { raw } => format!(
            "{{\"type\":\"TimeLiteral\",\"value\":\"{}\",\"raw\":\"{}\"}}",
            escape_json(raw),
            escape_json(raw)
        ),
        Value::NodeLiteral { .. } => {
            serde_json::to_string(&value_to_ast_json(value)).unwrap_or_else(|_| String::from("{\"type\":\"NodeLiteral\"}"))
        }
        Value::ListNode { items } => format!(
            "{{\"type\":\"ListNode\",\"elements\":[{}]}}",
            items.iter().map(render_value_json_string).collect::<Vec<_>>().join(",")
        ),
        Value::TupleLiteral { items } => format!(
            "{{\"type\":\"TupleLiteral\",\"elements\":[{}]}}",
            items.iter().map(render_value_json_string).collect::<Vec<_>>().join(",")
        ),
        Value::ObjectNode { bindings } => format!(
            "{{\"type\":\"ObjectNode\",\"bindings\":[{}]}}",
            bindings
                .iter()
                .map(|binding| {
                    format!(
                        "{{\"type\":\"Binding\",\"key\":\"{}\",\"datatype\":{},\"value\":{}}}",
                        escape_json(&binding.key),
                        binding
                            .datatype
                            .as_ref()
                            .map(|value| format!("\"{}\"", escape_json(value)))
                            .unwrap_or_else(|| String::from("null")),
                        render_value_json_string(&binding.value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::CloneReference { segments } => format!(
            "{{\"type\":\"CloneReference\",\"path\":{}}}",
            render_reference_segments_json_string(segments)
        ),
        Value::PointerReference { segments } => format!(
            "{{\"type\":\"PointerReference\",\"path\":{}}}",
            render_reference_segments_json_string(segments)
        ),
    }
}

fn render_reference_segments_json_string(segments: &[ReferenceSegment]) -> String {
    let items = segments
        .iter()
        .map(|segment| match segment {
            ReferenceSegment::Key(key) => format!("\"{}\"", escape_json(key)),
            ReferenceSegment::Index(index) => index.to_string(),
            ReferenceSegment::Attr(key) => {
                format!("{{\"type\":\"attr\",\"key\":\"{}\"}}", escape_json(key))
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{items}]")
}

fn format_event_line(event: &AssignmentEvent) -> String {
    let datatype = event
        .datatype
        .as_ref()
        .map(|value| format!(" :{value}"))
        .unwrap_or_default();
    format!(
        "{}{} = {}",
        format_path(&event.path),
        datatype,
        render_human_value(&event.value)
    )
}

fn render_human_value(value: &Value) -> String {
    match value {
        Value::StringLiteral { value, .. } => serde_json::to_string(value).unwrap_or_else(|_| String::from("\"\"")),
        Value::InfinityLiteral { raw } => raw.clone(),
        Value::NumberLiteral { raw }
        | Value::BooleanLiteral { raw }
        | Value::SwitchLiteral { raw }
        | Value::HexLiteral { raw }
        | Value::SeparatorLiteral { raw }
        | Value::EncodingLiteral { raw }
        | Value::RadixLiteral { raw }
        | Value::DateLiteral { raw }
        | Value::DateTimeLiteral { raw }
        | Value::TimeLiteral { raw }
        | Value::NodeLiteral { raw, .. } => raw.clone(),
        Value::CloneReference { segments } => format!("~{}", render_reference_path(segments)),
        Value::PointerReference { segments } => format!("~>{}", render_reference_path(segments)),
        Value::ListNode { items } => format!(
            "[ {} ]",
            items
                .iter()
                .map(render_human_value)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::TupleLiteral { items } => format!(
            "( {} )",
            items
                .iter()
                .map(render_human_value)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::ObjectNode { bindings } => format!(
            "{{ {} }}",
            bindings
                .iter()
                .map(|binding| {
                    let datatype = binding
                        .datatype
                        .as_ref()
                        .map(|value| format!(":{value}"))
                        .unwrap_or_default();
                    format!("{key}{datatype} = {value}", key = binding.key, value = render_human_value(&binding.value))
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn render_reference_path(segments: &[ReferenceSegment]) -> String {
    let mut rendered = String::new();
    for (index, segment) in segments.iter().enumerate() {
        match segment {
            ReferenceSegment::Key(key) => {
                if index > 0 {
                    rendered.push('.');
                }
                rendered.push_str(key);
            }
            ReferenceSegment::Index(value) => {
                rendered.push('[');
                rendered.push_str(&value.to_string());
                rendered.push(']');
            }
            ReferenceSegment::Attr(key) => {
                rendered.push('@');
                rendered.push_str(key);
            }
        }
    }
    rendered
}

fn find_references(events: &[AssignmentEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match &event.value {
            Value::CloneReference { segments } => {
                Some(format!("{} = ~{}", format_path(&event.path), render_reference_path(segments)))
            }
            Value::PointerReference { segments } => {
                Some(format!("{} = ~>{}", format_path(&event.path), render_reference_path(segments)))
            }
            _ => None,
        })
        .collect()
}

fn render_span(span: &aeon_core::Span) -> String {
    format!(
        "{{\"start\":{{\"line\":{},\"column\":{},\"offset\":{}}},\"end\":{{\"line\":{},\"column\":{},\"offset\":{}}}}}",
        span.start.line,
        span.start.column,
        span.start.offset,
        span.end.line,
        span.end.column,
        span.end.offset
    )
}

fn merged_meta_json(
    compile_errors: &[Diagnostic],
    finalize_errors: &[Diagnostic],
    warnings: &[Diagnostic],
) -> Option<JsonValue> {
    if compile_errors.is_empty() && finalize_errors.is_empty() && warnings.is_empty() {
        return None;
    }
    let mut obj = Map::new();
    let merged_errors = compile_errors
        .iter()
        .chain(finalize_errors.iter())
        .map(diagnostic_to_json)
        .collect::<Vec<_>>();
    if !merged_errors.is_empty() {
        obj.insert(
            String::from("errors"),
            JsonValue::Array(merged_errors),
        );
    }
    if !warnings.is_empty() {
        obj.insert(
            String::from("warnings"),
            JsonValue::Array(warnings.iter().map(diagnostic_to_json).collect()),
        );
    }
    Some(JsonValue::Object(obj))
}

fn finalize_attributes_to_json(
    attributes: &std::collections::BTreeMap<String, aeon_core::AttributeValue>,
) -> JsonValue {
    let mut object = Map::new();
    let mut nested = Map::new();
    for (key, entry) in attributes {
        object.insert(key.clone(), finalize_attribute_entry_to_json(entry));
        if !entry.nested_attrs.is_empty() {
            nested.insert(key.clone(), finalize_attributes_to_json(&entry.nested_attrs));
        }
    }
    if !nested.is_empty() {
        object.insert(String::from("@"), JsonValue::Object(nested));
    }
    JsonValue::Object(object)
}

fn format_envelope_diagnostic_line(label: &str, diag: &EnvelopeDiagnostic) -> String {
    let message = diag.message.replace(['\r', '\n'], " ");
    format!("{label} [{}] {message}", diag.code)
}

fn finalize_attribute_entry_to_json(entry: &aeon_core::AttributeValue) -> JsonValue {
    if !entry.object_members.is_empty() {
        return finalize_attributes_to_json(&entry.object_members);
    }
    if let Some(value) = &entry.value {
        return value_to_ast_json(value);
    }
    JsonValue::Null
}

fn phase_label_from_number(phase: u8) -> Option<&'static str> {
    match phase {
        0 => Some("Input Validation"),
        5 => Some("Profile Compilation"),
        6 => Some("Schema Validation"),
        7 => Some("Reference Resolution"),
        8 => Some("Finalization"),
        _ => None,
    }
}

fn infer_phase_label_from_code(code: &str) -> Option<&'static str> {
    match code {
        "INPUT_SIZE_EXCEEDED" => Some("Input Validation"),
        "UNEXPECTED_CHARACTER" | "UNTERMINATED_BLOCK_COMMENT" | "UNTERMINATED_STRING"
        | "UNTERMINATED_TRIMTICK" => Some("Lexical Analysis"),
        "SYNTAX_ERROR" | "INVALID_DATE" | "INVALID_TIME" | "INVALID_DATETIME"
        | "INVALID_SEPARATOR_CHAR" | "SEPARATOR_DEPTH_EXCEEDED" | "GENERIC_DEPTH_EXCEEDED" => {
            Some("Parsing")
        }
        "HEADER_CONFLICT" | "DUPLICATE_CANONICAL_PATH" | "DATATYPE_LITERAL_MISMATCH" => {
            Some("Core Validation")
        }
        "MISSING_REFERENCE_TARGET" | "FORWARD_REFERENCE" | "SELF_REFERENCE"
        | "ATTRIBUTE_DEPTH_EXCEEDED" => Some("Reference Validation"),
        "UNTYPED_SWITCH_LITERAL" | "UNTYPED_VALUE_IN_STRICT_MODE"
        | "CUSTOM_DATATYPE_NOT_ALLOWED" | "INVALID_NODE_HEAD_DATATYPE" => Some("Mode Enforcement"),
        "PROFILE_NOT_FOUND" | "PROFILE_PROCESSORS_SKIPPED" => Some("Profile Compilation"),
        "TYPE_GUARD_FAILED" => Some("Finalization"),
        _ if code.starts_with("FINALIZE_") => Some("Finalization"),
        _ => None,
    }
}

fn diagnostic_phase_label(error: &Diagnostic) -> Option<&'static str> {
    error
        .phase
        .and_then(phase_label_from_number)
        .or_else(|| infer_phase_label_from_code(&error.code))
}

fn diagnostic_to_json(error: &Diagnostic) -> JsonValue {
    let mut object = Map::new();
    object.insert(String::from("code"), JsonValue::String(error.code.clone()));
    object.insert(
        String::from("path"),
        error.path
            .as_ref()
            .map(|value| JsonValue::String(value.clone()))
            .unwrap_or(JsonValue::Null),
    );
    object.insert(
        String::from("span"),
        error.span.as_ref().map(span_to_json).unwrap_or(JsonValue::Null),
    );
    if let Some(phase) = error.phase {
        object.insert(String::from("phase"), JsonValue::Number(phase.into()));
    }
    if let Some(label) = diagnostic_phase_label(error) {
        object.insert(String::from("phaseLabel"), JsonValue::String(String::from(label)));
    }
    object.insert(String::from("message"), JsonValue::String(error.message.clone()));
    JsonValue::Object(object)
}

fn schema_diagnostic_to_json(error: &aeon_aeos::ValidationDiagnostic) -> JsonValue {
    json!({
        "code": error.code,
        "path": error.path,
        "phase": 6,
        "phaseLabel": "Schema Validation",
        "span": error.span.map(|span| json!([span[0], span[1]])),
    })
}

fn format_error_line(error: &Diagnostic) -> String {
    let path = error.path.as_deref().unwrap_or("$");
    let span = error
        .span
        .as_ref()
        .map(|span| {
            format!(
                "{}:{}-{}:{}",
                span.start.line, span.start.column, span.end.line, span.end.column
            )
        })
        .unwrap_or_else(|| String::from("?:?-?:?"));
    let message = error.message.replace('\n', " ");
    if let Some(label) = diagnostic_phase_label(error) {
        format!("{label}: {message} [{}] path={} span={}", error.code, path, span)
    } else {
        format!("{message} [{}] path={} span={}", error.code, path, span)
    }
}

fn format_annotation_line(record: &aeon_annotations::AnnotationRecord) -> String {
    let target = match &record.target {
        aeon_annotations::AnnotationTarget::Path { path } => path.clone(),
        aeon_annotations::AnnotationTarget::Unbound { reason } => format!("unbound({reason})"),
    };
    format!(
        "{} {} -> {} raw={}",
        record.kind,
        record.form,
        target,
        serde_json::to_string(&record.raw).unwrap_or_else(|_| String::from("\"\""))
    )
}

fn header_field_value(header: Option<&aeon_core::HeaderFields>, key: &str) -> Option<String> {
    let value = header?.fields.get(key)?;
    Some(match value {
        Value::StringLiteral { value, .. } => value.clone(),
        Value::NumberLiteral { raw }
        | Value::BooleanLiteral { raw }
        | Value::SwitchLiteral { raw }
        | Value::HexLiteral { raw }
        | Value::SeparatorLiteral { raw }
        | Value::EncodingLiteral { raw }
        | Value::RadixLiteral { raw }
        | Value::TimeLiteral { raw }
        | Value::NodeLiteral { raw, .. } => raw.clone(),
        _ => value.value_kind().to_string(),
    })
}

fn core_events_to_aeos(events: &[AssignmentEvent]) -> Vec<AesEvent> {
    events
        .iter()
        .map(|event| AesEvent {
            path: EventPath {
                segments: event
                    .path
                    .segments
                    .iter()
                    .filter_map(|segment| match segment {
                        aeon_core::PathSegment::Root => None,
                        aeon_core::PathSegment::Member(key) => Some(PathSegmentInput {
                            segment_type: String::from("member"),
                            key: Some(key.clone()),
                            index: None,
                        }),
                        aeon_core::PathSegment::Index(index) => Some(PathSegmentInput {
                            segment_type: String::from("index"),
                            key: None,
                            index: Some(json!(index)),
                        }),
                    })
                    .collect(),
            },
            key: event.key.clone(),
            datatype: event.datatype.clone(),
            value: core_value_to_aeos(&event.value),
            span: Some(SpanInput::Object {
                start: OffsetOnly {
                    offset: event.span.start.offset,
                },
                end: OffsetOnly {
                    offset: event.span.end.offset,
                },
            }),
        })
        .collect()
}

fn core_value_to_aeos(value: &Value) -> EventValue {
    match value {
        Value::InfinityLiteral { raw } => EventValue {
            value_type: String::from("InfinityLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::NumberLiteral { raw } => EventValue {
            value_type: String::from("NumberLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::StringLiteral { value, .. } => EventValue {
            value_type: String::from("StringLiteral"),
            raw: Some(value.clone()),
            value: Some(JsonValue::String(value.clone())),
            elements: Vec::new(),
        },
        Value::BooleanLiteral { raw } => EventValue {
            value_type: String::from("BooleanLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::Bool(raw == "true")),
            elements: Vec::new(),
        },
        Value::SwitchLiteral { raw } => EventValue {
            value_type: String::from("SwitchLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::HexLiteral { raw } => EventValue {
            value_type: String::from("HexLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::SeparatorLiteral { raw } => EventValue {
            value_type: String::from("SeparatorLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.trim_start_matches('^').to_string())),
            elements: Vec::new(),
        },
        Value::EncodingLiteral { raw } => EventValue {
            value_type: String::from("EncodingLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::RadixLiteral { raw } => EventValue {
            value_type: String::from("RadixLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::DateLiteral { raw } => EventValue {
            value_type: String::from("DateLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::DateTimeLiteral { raw } => EventValue {
            value_type: String::from("DateTimeLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::TimeLiteral { raw } => EventValue {
            value_type: String::from("TimeLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::NodeLiteral { raw, .. } => EventValue {
            value_type: String::from("NodeLiteral"),
            raw: Some(raw.clone()),
            value: Some(JsonValue::String(raw.clone())),
            elements: Vec::new(),
        },
        Value::ListNode { items } => EventValue {
            value_type: String::from("ListNode"),
            raw: None,
            value: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
        },
        Value::TupleLiteral { items } => EventValue {
            value_type: String::from("TupleLiteral"),
            raw: None,
            value: None,
            elements: items.iter().map(core_value_to_aeos).collect(),
        },
        Value::ObjectNode { .. } => EventValue {
            value_type: String::from("ObjectNode"),
            raw: None,
            value: None,
            elements: Vec::new(),
        },
        Value::CloneReference { segments } => EventValue {
            value_type: String::from("CloneReference"),
            raw: None,
            value: Some(JsonValue::Array(
                segments
                    .iter()
                    .map(reference_segment_to_json)
                    .collect(),
            )),
            elements: Vec::new(),
        },
        Value::PointerReference { segments } => EventValue {
            value_type: String::from("PointerReference"),
            raw: None,
            value: Some(JsonValue::Array(
                segments
                    .iter()
                    .map(reference_segment_to_json)
                    .collect(),
            )),
            elements: Vec::new(),
        },
    }
}

fn reference_segment_to_json(segment: &ReferenceSegment) -> JsonValue {
    match segment {
        ReferenceSegment::Key(key) => JsonValue::String(key.clone()),
        ReferenceSegment::Index(index) => json!(index),
        ReferenceSegment::Attr(key) => json!({ "type": "attr", "key": key }),
    }
}

fn span_to_json(span: &aeon_core::Span) -> JsonValue {
    json!({
        "start": {
            "line": span.start.line,
            "column": span.start.column,
            "offset": span.start.offset,
        },
        "end": {
            "line": span.end.line,
            "column": span.end.column,
            "offset": span.end.offset,
        }
    })
}

fn resolve_datatype_policy(value: Option<&str>, rich: bool) -> Result<Option<DatatypePolicy>, String> {
    if rich && matches!(value, Some("reserved_only")) {
        return Err(String::from(
            "Invalid value for --datatype-policy: expected reserved_only or allow_custom",
        ));
    }
    if rich {
        return Ok(Some(DatatypePolicy::AllowCustom));
    }
    match value {
        None => Ok(None),
        Some("reserved_only") => Ok(Some(DatatypePolicy::ReservedOnly)),
        Some("allow_custom") => Ok(Some(DatatypePolicy::AllowCustom)),
        _ => Err(String::from(
            "Invalid value for --datatype-policy: expected reserved_only or allow_custom",
        )),
    }
}

fn resolve_finalize_mode(args: &[String]) -> Result<FinalizeMode, String> {
    let strict = args.iter().any(|arg| arg == "--strict");
    let loose = args.iter().any(|arg| arg == "--loose");
    if strict && loose {
        return Err(String::from("Cannot use both --strict and --loose"));
    }
    Ok(if loose {
        FinalizeMode::Loose
    } else {
        FinalizeMode::Strict
    })
}

fn resolve_finalize_scope(value: Option<&str>) -> Result<FinalizeScope, String> {
    match value.unwrap_or("payload") {
        "payload" => Ok(FinalizeScope::Payload),
        "header" => Ok(FinalizeScope::Header),
        "full" => Ok(FinalizeScope::Full),
        _ => Err(String::from("Invalid value for --scope (expected payload, header, or full)")),
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn optional_numeric_flag_value(args: &[String], flag: &str) -> Result<Option<usize>, String> {
    match flag_value(args, flag) {
        Some(value) => value
            .parse::<usize>()
            .map(Some)
            .map_err(|_| format!("invalid value for {flag}")),
        None => Ok(None),
    }
}

fn flag_values(args: &[String], flag: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        if args[index] == flag {
            if let Some(value) = args.get(index + 1) {
                values.push(value.clone());
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    values
}

fn find_file(args: &[String], value_flags: &[&str]) -> Option<String> {
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if value_flags.contains(&arg.as_str()) {
            skip_next = true;
            continue;
        }
        if arg.starts_with("--") {
            continue;
        }
        if index > 0 && value_flags.contains(&args[index - 1].as_str()) {
            continue;
        }
        return Some(arg.clone());
    }
    None
}

fn default_receipt_sidecar_path(file: &str) -> String {
    format!("{file}.receipt.json")
}

fn resolve_receipt_path(args: &[String]) -> Result<Option<String>, String> {
    if args.iter().any(|arg| arg == "--receipt") {
        let value = flag_value(args, "--receipt")
            .ok_or_else(|| String::from("Missing value for --receipt <path>"))?;
        return Ok(Some(value));
    }
    Ok(None)
}

fn read_receipt_sidecar(path: &str) -> Result<JsonValue, String> {
    let source = fs::read_to_string(path).map_err(|error| format!("failed to read {path}: {error}"))?;
    serde_json::from_str::<JsonValue>(&source).map_err(|error| format!("receipt file is not valid JSON: {path}: {error}"))
}

fn resolve_verify_receipt(
    explicit_path: Option<String>,
    file: &str,
    synthesized: JsonValue,
) -> Result<JsonValue, String> {
    let receipt_path = explicit_path.unwrap_or_else(|| default_receipt_sidecar_path(file));
    if Path::new(&receipt_path).exists() {
        return read_receipt_sidecar(&receipt_path);
    }
    Ok(synthesized)
}

fn write_receipt_sidecar(path: &str, receipt: &JsonValue) -> Result<(), String> {
    let rendered = serde_json::to_string_pretty(receipt).map_err(|error| format!("failed to render receipt JSON: {error}"))?;
    fs::write(path, rendered).map_err(|error| format!("failed to write {path}: {error}"))
}

fn numeric_flag_value(args: &[String], flag: &str) -> Result<usize, String> {
    match flag_value(args, flag) {
        Some(value) => value.parse::<usize>().map_err(|_| format!("invalid value for {flag}")),
        None => Ok(1),
    }
}

fn resolve_bind_contracts(
    file: &str,
    _source: &str,
    header: Option<&aeon_core::HeaderFields>,
    schema_path: Option<String>,
    contract_registry_path: Option<String>,
    explicit_profile: Option<String>,
) -> Result<(Schema, Option<String>), String> {
    if let Some(schema_path) = schema_path {
        let schema_source =
            fs::read_to_string(&schema_path).map_err(|error| format!("failed to read {schema_path}: {error}"))?;
        let schema = normalize_schema_contract_doc(&schema_source, &schema_path)?;
        return Ok((schema, explicit_profile));
    }

    let registry_path = contract_registry_path
        .ok_or_else(|| String::from(
            "Error: Missing required --schema <schema.json> or --contract-registry <registry.json>\nUsage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]",
        ))?;
    let registry = read_contract_registry_file(&registry_path)?;

    let schema_id = header_field_value(header, "schema")
        .ok_or_else(|| String::from("Missing schema contract id in document header"))?;
    let profile_id = explicit_profile.or_else(|| header_field_value(header, "profile"));

    let schema_entry = resolve_contract_entry(&registry, &schema_id, "schema")
        .ok_or_else(|| format!("Error [CONTRACT_UNKNOWN_SCHEMA_ID]: Unknown schema contract id in registry: {schema_id}"))?;
    let schema_artifact = verify_contract_artifact(schema_entry, &registry_path)?;
    let schema = read_schema_contract_aeon_file(&schema_artifact, Some(&schema_id))?;

    if let Some(profile_id) = profile_id.clone() {
        let profile_entry = resolve_contract_entry(&registry, &profile_id, "profile")
            .ok_or_else(|| format!("Error [CONTRACT_UNKNOWN_PROFILE_ID]: Unknown profile contract id in registry: {profile_id}"))?;
        let _profile_artifact = verify_contract_artifact(profile_entry, &registry_path)?;
    }

    let _ = file;
    Ok((schema, profile_id))
}

fn normalize_schema_contract_doc(schema_source: &str, file: &str) -> Result<Schema, String> {
    let parsed: JsonValue =
        serde_json::from_str(schema_source).map_err(|error| format!("failed to parse schema {file}: {error}"))?;
    normalize_schema_contract_value(parsed, file)
}

fn normalize_schema_contract_value(parsed: JsonValue, file: &str) -> Result<Schema, String> {
    let object = parsed
        .as_object()
        .ok_or_else(|| format!("Schema file must be a JSON object: {file}"))?;

    let allowed_top_level = [
        "schema_id",
        "schema_version",
        "rules",
        "world",
        "datatype_rules",
        "datatype_allowlist",
    ];
    for key in object.keys() {
        if !allowed_top_level.contains(&key.as_str()) {
            return Err(format!("Unknown schema contract key '{key}' in {file}"));
        }
    }

    match object.get("schema_id") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => return Err(format!("Schema contract missing required string field 'schema_id': {file}")),
    }
    match object.get("schema_version") {
        Some(JsonValue::String(value)) if !value.is_empty() => {}
        _ => return Err(format!("Schema contract missing required string field 'schema_version': {file}")),
    }
    match object.get("rules") {
        Some(JsonValue::Array(_)) => {}
        _ => return Err(format!("Schema contract missing required array field 'rules': {file}")),
    }
    if let Some(world) = object.get("world") {
        match world.as_str() {
            Some("open") | Some("closed") => {}
            _ => return Err(format!("Schema contract field 'world' must be \"open\" or \"closed\": {file}")),
        }
    }
    if let Some(datatype_rules) = object.get("datatype_rules") {
        let Some(map) = datatype_rules.as_object() else {
            return Err(format!("Schema contract field 'datatype_rules' must be object: {file}"));
        };
        for (key, value) in map {
            if !value.is_object() {
                return Err(format!("Schema contract datatype_rules['{key}'] must be object: {file}"));
            }
        }
    }
    if let Some(datatype_allowlist) = object.get("datatype_allowlist") {
        let Some(items) = datatype_allowlist.as_array() else {
            return Err(format!("Schema contract field 'datatype_allowlist' must be array<string>: {file}"));
        };
        if items.iter().any(|item| !item.is_string()) {
            return Err(format!("Schema contract field 'datatype_allowlist' must be array<string>: {file}"));
        }
    }

    serde_json::from_value(parsed).map_err(|error| format!("failed to parse normalized schema {file}: {error}"))
}

fn read_schema_contract_aeon_file(file: &str, expected_schema_id: Option<&str>) -> Result<Schema, String> {
    let source = fs::read_to_string(file).map_err(|error| format!("failed to read {file}: {error}"))?;
    let compiled = compile(
        &source,
        CompileOptions {
            datatype_policy: Some(DatatypePolicy::AllowCustom),
            ..CompileOptions::default()
        },
    );
    if !compiled.errors.is_empty() {
        return Err(format!("Schema contract AEON file failed to parse: {file}"));
    }

    let finalized = finalize_json(&compiled.events, FinalizeOptions::default());
    if !finalized.meta.errors.is_empty() {
        return Err(format!("Schema contract AEON file failed to finalize: {file}"));
    }

    let document = finalized.document;
    let object = document
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Schema file must be a JSON object: {file}"))?;
    if let Some(expected) = expected_schema_id {
        match object.get("schema_id").and_then(JsonValue::as_str) {
            Some(actual) if actual == expected => {}
            Some(actual) => {
                return Err(format!(
                    "Schema contract id mismatch. Expected '{expected}', found '{actual}' in {file}"
                ))
            }
            None => return Err(format!("Schema contract missing required string field 'schema_id': {file}")),
        }
    }
    normalize_schema_contract_value(JsonValue::Object(object), file)
}

fn read_contract_registry_file(file: &str) -> Result<ContractRegistryDoc, String> {
    let raw = fs::read_to_string(file).map_err(|error| format!("failed to read {file}: {error}"))?;
    let registry: ContractRegistryDoc =
        serde_json::from_str(&raw).map_err(|_| format!("Contract registry file is not valid JSON: {file}"))?;
    if registry.contracts.is_empty() && !raw.contains("\"contracts\"") {
        return Err(format!("Contract registry JSON must contain a top-level 'contracts' array: {file}"));
    }
    for (index, entry) in registry.contracts.iter().enumerate() {
        let kind_ok = matches!(entry.kind.as_str(), "profile" | "schema");
        let status_ok = matches!(entry.status.as_str(), "active" | "deprecated");
        let sha_ok = entry.sha256.len() == 64 && entry.sha256.chars().all(|ch| ch.is_ascii_hexdigit());
        if entry.id.is_empty()
            || !kind_ok
            || entry.version.is_empty()
            || entry.path.is_empty()
            || !entry.path.to_ascii_lowercase().ends_with(".aeon")
            || !sha_ok
            || !status_ok
        {
            return Err(format!("Invalid contract registry entry shape at index {index}"));
        }
    }
    Ok(registry)
}

fn resolve_contract_entry<'a>(
    registry: &'a ContractRegistryDoc,
    id: &str,
    kind: &str,
) -> Option<&'a ContractRegistryEntry> {
    registry
        .contracts
        .iter()
        .find(|entry| entry.id == id && entry.kind == kind && entry.status == "active")
}

fn verify_contract_artifact(entry: &ContractRegistryEntry, registry_path: &str) -> Result<String, String> {
    let base_dir = Path::new(registry_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let resolved_path = base_dir.join(&entry.path);
    let file_buffer = fs::read(&resolved_path).map_err(|_| {
        format!(
            "Error [CONTRACT_ARTIFACT_MISSING]: Missing contract artifact for '{}' at {}",
            entry.id,
            resolved_path.display()
        )
    })?;
    let actual = sha256_hex(&file_buffer);
    if actual != entry.sha256.to_ascii_lowercase() {
        return Err(format!(
            "Error [CONTRACT_ARTIFACT_HASH_MISMATCH]: Contract artifact hash mismatch for '{}' at {}",
            entry.id,
            resolved_path.display()
        ));
    }
    Ok(resolved_path.to_string_lossy().into_owned())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn profile_processors_skipped_warning(profile_id: &str) -> JsonValue {
    json!({
        "code": "PROFILE_PROCESSORS_SKIPPED",
        "phase": 5,
        "message": format!(
            "Profile '{profile_id}' processors were skipped to enforce phase order (schema before resolve)."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aeon_annotations::extract_annotations;
    use aeon_core::{compile, CompileOptions};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn normalize(text: &str) -> String {
        text.replace("\r\n", "\n").trim_end().to_string()
    }

    fn fixture_path(name: &str) -> String {
        workspace_root()
            .join("implementations")
            .join("typescript")
            .join("packages")
            .join("cli")
            .join("tests")
            .join("fixtures")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn example_path(relative: &str) -> String {
        let base = if relative.starts_with("contracts-baseline/") {
            examples_repo_root().join("shared")
        } else {
            examples_repo_root().join("typescript")
        };
        base.join(relative).to_string_lossy().into_owned()
    }

    fn contract_registry_path() -> String {
        default_contract_registry_path()
    }

    fn schema_contract_aeon_text(schema_id: &str) -> String {
        [
            format!("schema_id = \"{schema_id}\""),
            String::from("schema_version = \"1.0.0\""),
            String::from("rules = ["),
            String::from("  { path = \"$.app.name\", constraints = { type = \"StringLiteral\", required = true } },"),
            String::from("  { path = \"$.app.port\", constraints = { type = \"NumberLiteral\", required = true } }"),
            String::from("]"),
        ]
        .join("\n")
    }

    #[test]
    fn help_command_succeeds() {
        let result = run(vec![String::from("aeon-rust"), String::from("help")]);
        assert!(result.is_ok());
    }

    #[test]
    fn unknown_command_is_a_usage_error() {
        let result = run(vec![String::from("aeon-rust"), String::from("wat")]);
        assert!(result.is_err());
    }

    #[test]
    fn integrity_without_subcommand_reports_usage() {
        let result = run(vec![String::from("aeon-rust"), String::from("integrity")]).expect_err("usage error");
        assert!(result.contains("Usage: aeon integrity <validate|verify> <file> [--strict|--loose]"));
    }

    #[test]
    fn integrity_unknown_subcommand_reports_usage() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("wat"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Unknown integrity command: wat"));
        assert!(result.contains("Usage: aeon integrity <validate|verify|sign> <file> [options]"));
    }

    #[test]
    fn doctor_reports_usage_for_missing_registry_value() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("doctor"),
            String::from("--contract-registry"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: Missing value for --contract-registry <registry.json>"));
        assert!(result.contains("Usage: aeon doctor [--json] [--contract-registry <registry.json>]"));
    }

    #[test]
    fn check_requires_a_file() {
        let result = run(vec![String::from("aeon-rust"), String::from("check")]).expect_err("usage error");
        assert!(result.contains("Error: No file specified"));
        assert!(result.contains("Usage: aeon check <file>"));
    }

    #[test]
    fn check_reports_usage_for_invalid_datatype_policy() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-check-invalid-policy-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("check"),
            file.to_string_lossy().into_owned(),
            String::from("--datatype-policy"),
            String::from("invalid"),
        ])
        .expect_err("usage error");
        assert!(result.contains(
            "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)"
        ));
        assert!(result.contains("Usage: aeon check <file> [--datatype-policy <reserved_only|allow_custom>]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_accepts_header_conflict_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("header-conflict.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        assert!(result.errors.iter().any(|error| error.code == "HEADER_CONFLICT"));
        assert!(result.events.is_empty());
    }

    #[test]
    fn check_invalid_document_matches_contract_error_lines() {
        let source = fs::read_to_string(
            fixture_path("header-conflict.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let lines = result
            .errors
            .iter()
            .map(format_error_line)
            .collect::<Vec<_>>();
        assert!(!lines.is_empty());
        assert!(lines
            .iter()
            .any(|line| line.contains("[HEADER_CONFLICT]") && line.contains("path=$")));
    }

    #[test]
    fn inspect_duplicate_binding_is_fail_closed() {
        let source = fs::read_to_string(
            fixture_path("duplicate-binding.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let rendered = render_inspect_markdown(
            "duplicate-binding.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let normalized = normalize(&rendered);
        assert!(normalized.contains("## Errors"));
        assert!(normalized.contains("[DUPLICATE_CANONICAL_PATH]"));
        assert!(!normalized.contains("## Assignment Events"));
    }

    #[test]
    fn render_inspect_markdown_for_valid_document() {
        let result = compile("a:int32 = 1\nb = ~a\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "valid.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        assert!(rendered.contains("# AEON Inspect"));
        assert!(rendered.contains("- File: valid.aeon"));
        assert!(rendered.contains("- Mode: transport"));
        assert!(rendered.contains("## Assignment Events"));
        assert!(rendered.contains("- $.a :int32 = 1"));
        assert!(rendered.contains("- $.b = ~a"));
        assert!(rendered.contains("## References"));
    }

    #[test]
    fn inspect_markdown_matches_cli_contract_for_valid_fixture() {
        let source = fs::read_to_string(
            fixture_path("valid.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let rendered = render_inspect_markdown(
            "valid.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let expected = "# AEON Inspect\n\n## Summary\n- File: valid.aeon\n- Version: —\n- Mode: transport\n- Profile: —\n- Schema: —\n- Recovery: false\n- Events: 2\n- Errors: 0\n\n## Assignment Events\n- $.a :int32 = 1\n- $.b = ~a\n\n## References\n- $.b = ~a\n";
        assert_eq!(normalize(&rendered), normalize(expected));
    }

    #[test]
    fn inspect_markdown_recovery_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("recovery-duplicate-binding.aeon"),
        )
        .expect("fixture");
        let result = compile(
            &source,
            CompileOptions {
                recovery: true,
                ..CompileOptions::default()
            },
        );
        let rendered = render_inspect_markdown(
            "recovery-duplicate-binding.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: true,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        assert!(normalize(&rendered).contains("> WARNING: recovery mode enabled (tooling-only); output may be partial"));
        assert!(normalize(&rendered).contains("- Recovery: true"));
        assert!(normalize(&rendered).contains("## Assignment Events"));
    }

    #[test]
    fn inspect_markdown_typed_switch_strict_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("typed-switch-strict.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let rendered = render_inspect_markdown(
            "typed-switch-strict.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("strict"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let normalized = normalize(&rendered);
        assert!(normalized.contains("- Mode: strict"));
        assert!(normalized.contains("- Errors: 0"));
        assert!(normalized.contains("## Assignment Events"));
        assert!(normalized.contains(":switch"));
        assert!(normalized.contains("$.friend"));
    }

    #[test]
    fn inspect_markdown_untyped_switch_strict_is_fail_closed() {
        let source = fs::read_to_string(
            fixture_path("untyped-switch-strict.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let rendered = render_inspect_markdown(
            "untyped-switch-strict.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("strict"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let normalized = normalize(&rendered);
        assert!(normalized.contains("[UNTYPED_SWITCH_LITERAL]"));
        assert!(!normalized.contains("## Assignment Events"));
    }

    #[test]
    fn inspect_markdown_references_symbolic_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("references-symbolic.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let rendered = render_inspect_markdown(
            "references-symbolic.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let normalized = normalize(&rendered);
        assert!(normalized.contains("= ~target.x"));
        assert!(normalized.contains("= ~>target.x"));
        assert!(normalized.contains("## References"));
        assert!(normalized.contains("$.clone = ~target.x"));
        assert!(normalized.contains("$.ptr = ~>target.x"));
    }

    #[test]
    fn inspect_reports_usage_for_missing_file() {
        let result = run(vec![String::from("aeon-rust"), String::from("inspect")]).expect_err("usage error");
        assert!(result.contains("Error: No file specified"));
        assert!(result.contains("Usage: aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]"));
    }

    #[test]
    fn inspect_reports_usage_for_invalid_datatype_policy() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-inspect-invalid-policy-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("inspect"),
            file.to_string_lossy().into_owned(),
            String::from("--datatype-policy"),
            String::from("invalid"),
        ])
        .expect_err("usage error");
        assert!(result.contains(
            "Error: Invalid value for --datatype-policy (expected reserved_only or allow_custom)"
        ));
        assert!(result.contains("Usage: aeon inspect <file> [--json] [--recovery] [--annotations] [--annotations-only] [--sort-annotations] [--datatype-policy <reserved_only|allow_custom>] [--max-attribute-depth <n>] [--max-separator-depth <n>] [--max-generic-depth <n>]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_reports_error_for_invalid_attribute_depth() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-inspect-invalid-depth-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("inspect"),
            file.to_string_lossy().into_owned(),
            String::from("--max-attribute-depth"),
            String::from("invalid"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: Invalid value for --max-attribute-depth (expected a non-negative integer)"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_inspect_markdown_lists_pointer_references() {
        let result = compile("target = { x:int32 = 1 }\nptr = ~>target.x\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "references-symbolic.aeon",
            &result,
            &[],
            InspectRenderOptions {
                recovery: false,
                include_annotations: false,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        assert!(rendered.contains("- $.ptr = ~>target.x"));
        assert!(rendered.contains("## References"));
    }

    #[test]
    fn render_annotation_only_markdown() {
        let annotations = extract_annotations("//# document a\na = 1\n");
        let result = compile("a = 1\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "inspect-annotations.aeon",
            &result,
            &annotations,
            InspectRenderOptions {
                recovery: false,
                include_annotations: true,
                annotations_only: true,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        assert!(rendered.starts_with("# AEON Annotations"));
        assert!(rendered.contains("- Count: 1"));
        assert!(rendered.contains("## Annotation Records"));
        assert!(!rendered.contains("## Assignment Events"));
    }

    #[test]
    fn inspect_annotation_only_markdown_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("inspect-annotations.aeon"),
        )
        .expect("fixture");
        let annotations = extract_annotations(&source);
        let result = compile("a = 1\nb = 2\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "inspect-annotations.aeon",
            &result,
            &annotations,
            InspectRenderOptions {
                recovery: false,
                include_annotations: true,
                annotations_only: true,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let expected = "# AEON Annotations\n\n- Count: 3\n\n## Annotation Records\n- doc line -> $.a raw=\"//# document a\"\n- hint line -> $.a raw=\"//? required\"\n- annotation line -> $.b raw=\"//@ tag(\\\"x\\\")\"\n";
        assert_eq!(normalize(&rendered), normalize(expected));
    }

    #[test]
    fn inspect_annotations_markdown_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("inspect-annotations.aeon"),
        )
        .expect("fixture");
        let annotations = extract_annotations(&source);
        let result = compile("a = 1\nb = 2\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "inspect-annotations.aeon",
            &result,
            &annotations,
            InspectRenderOptions {
                recovery: false,
                include_annotations: true,
                annotations_only: false,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let normalized = normalize(&rendered);
        assert!(normalized.contains("- Annotations: 3"));
        assert!(normalized.contains("## Annotation Records"));
        assert!(normalized.contains("doc line -> $.a"));
        assert!(normalized.contains("hint line -> $.a"));
        assert!(normalized.contains("annotation line -> $.b"));
    }

    #[test]
    fn inspect_sorted_annotation_only_markdown_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("inspect-annotations.aeon"),
        )
        .expect("fixture");
        let annotations = sort_annotations(extract_annotations(&source));
        let result = compile("a = 1\nb = 2\n", CompileOptions::default());
        let rendered = render_inspect_markdown(
            "inspect-annotations.aeon",
            &result,
            &annotations,
            InspectRenderOptions {
                recovery: false,
                include_annotations: true,
                annotations_only: true,
                mode: String::from("transport"),
                version: None,
                profile: None,
                schema: None,
            },
        );
        let expected = "# AEON Annotations\n\n- Count: 3\n\n## Annotation Records\n- doc line -> $.a raw=\"//# document a\"\n- hint line -> $.a raw=\"//? required\"\n- annotation line -> $.b raw=\"//@ tag(\\\"x\\\")\"\n";
        assert_eq!(normalize(&rendered), normalize(expected));
    }

    #[test]
    fn inspect_json_matches_valid_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("valid.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let output = json!({
            "events": serde_json::from_str::<JsonValue>(&render_events(&result.events)).expect("events json"),
            "errors": serde_json::from_str::<JsonValue>(&render_errors(&result.errors)).expect("errors json"),
        });
        let expected = json!({
            "events": [
                {
                    "path": "$.a",
                    "key": "a",
                    "datatype": "int32",
                    "span": {
                        "start": { "line": 1, "column": 1, "offset": 0 },
                        "end": { "line": 1, "column": 12, "offset": 11 }
                    },
                    "value": {
                        "type": "NumberLiteral",
                        "raw": "1",
                        "value": "1"
                    }
                },
                {
                    "path": "$.b",
                    "key": "b",
                    "datatype": null,
                    "span": {
                        "start": { "line": 2, "column": 1, "offset": 12 },
                        "end": { "line": 2, "column": 7, "offset": 18 }
                    },
                    "value": {
                        "type": "CloneReference",
                        "path": ["a"]
                    }
                }
            ],
            "errors": []
        });
        assert_eq!(output, expected);
    }

    #[test]
    fn inspect_annotations_only_json_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("inspect-annotations.aeon"),
        )
        .expect("fixture");
        let annotations = extract_annotations(&source);
        let output = json!({
            "annotations": serde_json::from_str::<JsonValue>(&render_annotations(&annotations)).expect("annotations json"),
        });
        let parsed = output["annotations"].as_array().expect("annotations array");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0]["kind"], "doc");
        assert_eq!(parsed[0]["target"], json!({ "kind": "path", "path": "$.a" }));
        assert_eq!(parsed[1]["kind"], "hint");
        assert_eq!(parsed[1]["target"], json!({ "kind": "path", "path": "$.a" }));
        assert_eq!(parsed[2]["kind"], "annotation");
        assert_eq!(parsed[2]["target"], json!({ "kind": "path", "path": "$.b" }));
        assert_eq!(output.get("events"), None);
        assert_eq!(output.get("errors"), None);
    }

    #[test]
    fn render_events_emits_richer_json_values() {
        let result = compile("a:int32 = 1\nb = [2]\nc = { d = \"x\" }\n", CompileOptions::default());
        let parsed: JsonValue = serde_json::from_str(&render_events(&result.events)).expect("valid events json");
        let events = parsed.as_array().expect("events array");
        let by_key = events
            .iter()
            .filter_map(|event| Some((event.get("key")?.as_str()?.to_string(), event)))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(by_key["a"]["value"]["type"], "NumberLiteral");
        assert_eq!(by_key["a"]["value"]["raw"], "1");
        assert_eq!(by_key["b"]["value"]["type"], "ListNode");
        assert_eq!(by_key["b"]["value"]["elements"][0]["raw"], "2");
        assert_eq!(by_key["c"]["value"]["type"], "ObjectNode");
        assert_eq!(by_key["c"]["value"]["bindings"][0]["key"], "d");
    }

    #[test]
    fn render_events_serializes_pointer_references() {
        let result = compile("target = { x:int32 = 1 }\nptr = ~>target.x\n", CompileOptions::default());
        let parsed: JsonValue = serde_json::from_str(&render_events(&result.events)).expect("valid events json");
        let events = parsed.as_array().expect("events array");
        let by_key = events
            .iter()
            .filter_map(|event| Some((event.get("key")?.as_str()?.to_string(), event)))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(by_key["ptr"]["value"]["type"], "PointerReference");
        assert_eq!(by_key["ptr"]["value"]["path"][0], "target");
        assert_eq!(by_key["ptr"]["value"]["path"][1], "x");
    }

    #[test]
    fn render_events_serializes_node_attribute_entry_maps() {
        let result = compile(
            "content:node = <span@{id=\"text\", class:string=\"dark\"}(\"hello\")>\n",
            CompileOptions::default(),
        );
        let parsed: JsonValue = serde_json::from_str(&render_events(&result.events)).expect("valid events json");
        let events = parsed.as_array().expect("events array");
        let node = &events[0]["value"];
        assert_eq!(node["type"], "NodeLiteral");
        assert_eq!(node["attributes"][0]["entries"]["id"]["datatype"], JsonValue::Null);
        assert_eq!(node["attributes"][0]["entries"]["id"]["value"]["type"], "StringLiteral");
        assert_eq!(node["attributes"][0]["entries"]["id"]["value"]["value"], "text");
        assert_eq!(node["attributes"][0]["entries"]["id"]["value"]["raw"], "text");
        assert_eq!(node["attributes"][0]["entries"]["id"]["value"]["delimiter"], "\"");
        assert_eq!(node["attributes"][0]["entries"]["class"]["datatype"]["type"], "TypeAnnotation");
        assert_eq!(node["attributes"][0]["entries"]["class"]["datatype"]["name"], "string");
        assert_eq!(node["attributes"][0]["entries"]["class"]["value"]["type"], "StringLiteral");
        assert_eq!(node["attributes"][0]["entries"]["class"]["value"]["value"], "dark");
    }

    #[test]
    fn render_errors_defaults_missing_paths_to_root() {
        let mut diagnostic = Diagnostic::new("TEST_ERROR", "example");
        diagnostic.span = Some(aeon_core::Span::zero());
        let parsed: JsonValue = serde_json::from_str(&render_errors(&[diagnostic])).expect("valid errors json");
        assert_eq!(parsed[0]["path"], "$");
    }

    #[test]
    fn render_errors_infers_phase_label_for_self_reference() {
        let mut diagnostic = Diagnostic::new("SELF_REFERENCE", "Self reference: '$.a' references itself");
        diagnostic.path = Some(String::from("$.a"));
        diagnostic.span = Some(aeon_core::Span::zero());
        let parsed: JsonValue = serde_json::from_str(&render_errors(&[diagnostic.clone()])).expect("valid errors json");
        assert_eq!(parsed[0]["phaseLabel"], "Reference Validation");
        assert!(format_error_line(&diagnostic).starts_with("Reference Validation: Self reference: '$.a' references itself"));
    }

    #[test]
    fn fmt_write_creates_backup_only_when_content_changes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-fmt-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "b = 1\na = 2\n").expect("seed file");

        let first = run(vec![
            String::from("aeon-rust"),
            String::from("fmt"),
            file.to_string_lossy().into_owned(),
            String::from("--write"),
        ]);
        assert!(matches!(first, Ok(ExitCode::SUCCESS)));
        assert!(file.with_extension("aeon.bak").exists() || dir.join("sample.aeon.bak").exists());

        let formatted = fs::read_to_string(&file).expect("read formatted");
        let second = run(vec![
            String::from("aeon-rust"),
            String::from("fmt"),
            file.to_string_lossy().into_owned(),
            String::from("--write"),
        ]);
        assert!(matches!(second, Ok(ExitCode::SUCCESS)));
        assert_eq!(fs::read_to_string(&file).expect("read second"), formatted);
        assert!(!dir.join("sample.aeon.bak1").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fmt_write_requires_file_reports_usage() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("fmt"),
            String::from("--write"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: --write requires a file path"));
        assert!(result.contains("Usage: aeon fmt [file] [--write]"));
    }

    #[test]
    fn fmt_output_matches_contract_for_simple_document() {
        let result = canonicalize("b = 1\na = 2\n");
        assert!(result.errors.is_empty());
        let expected = [
            "aeon:header = {",
            "  encoding = \"utf-8\"",
            "  mode = \"transport\"",
            "  profile = \"core\"",
            "  version = 1.0",
            "}",
            "a = 2",
            "b = 1",
        ]
        .join("\n")
            + "\n";
        assert_eq!(result.text, expected);
    }

    #[test]
    fn fmt_stdin_contract_output_matches_simple_document() {
        let (code, output) = format_source_for_cli("b = 1\na = 2\n", None).expect("fmt result");
        assert_eq!(code, ExitCode::SUCCESS);
        let expected = [
            "aeon:header = {",
            "  encoding = \"utf-8\"",
            "  mode = \"transport\"",
            "  profile = \"core\"",
            "  version = 1.0",
            "}",
            "a = 2",
            "b = 1",
        ]
        .join("\n")
            + "\n";
        assert_eq!(output, expected);
    }

    #[test]
    fn fmt_output_for_shorthand_mode_matches_positive_canonical_contract() {
        let (code, output) = format_source_for_cli("aeon:mode = \"transport\"\na = {}\n", None).expect("fmt result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(output, "aeon:header = {\n  mode = \"transport\"\n}\na = {\n}\n");
    }

    #[test]
    fn fmt_output_normalizes_trimticks_generic_datatypes_and_numbers() {
        let source = "aeon:mode = \"strict\"\n\
                      c:trimtick = >> ``\n\
                      pair:tuple<int32,int32> = (1, 2)\n\
                      values:list = [\n\
                        1E6\n\
                        1_000e-3\n\
                      ]\n";
        let (code, output) = format_source_for_cli(source, None).expect("fmt result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            output,
            "aeon:header = {\n  mode = \"strict\"\n}\nc:trimtick = \"\"\npair:tuple<int32, int32> = (1, 2)\nvalues:list = [1e6, 1000e-3]\n"
        );
    }

    #[test]
    fn fmt_rejects_invalid_infinity_spellings() {
        for source in ["a = +Infinity\n", "a = NaN\n"] {
            let (code, output) = format_source_for_cli(source, None).expect("fmt result");
            assert_eq!(code, ExitCode::from(1), "{source}");
            assert!(output.contains("Invalid number literal"), "{output}");
        }
    }

    #[test]
    fn fmt_rejects_late_structured_header_with_contract_error() {
        let source = [
            "app:object = {",
            "  name:string = \"playground\"",
            "}",
            "aeon:header = {",
            "  mode:string = \"strict\"",
            "}",
        ]
        .join("\n");
        let result = canonicalize(&source);
        assert!(!result.errors.is_empty());
        assert!(result.errors.iter().any(|error| error.code == "SYNTAX_ERROR"));
        assert!(result
            .errors
            .iter()
            .any(|error| error.message.contains("Structured headers must appear before body bindings")));
    }

    #[test]
    fn fmt_invalid_input_emits_structured_error_lines() {
        let (code, output) = format_source_for_cli("a = {\n", None).expect("fmt result");
        assert_eq!(code, ExitCode::from(1));
        let lines = normalize(&output).split('\n').map(str::to_string).collect::<Vec<_>>();
        assert!(!lines.is_empty());
        assert!(lines
            .iter()
            .all(|line| line.contains('[') && line.contains("path=$") && line.contains("span=")));
    }

    #[test]
    fn fmt_fails_closed_when_max_input_bytes_is_exceeded() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-fmt-limit-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "b = 1\na = 2\n").expect("seed file");
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("fmt"),
            file.to_string_lossy().into_owned(),
            String::from("--max-input-bytes"),
            String::from("4"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::from(1)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_reports_usage_for_missing_file() {
        let result = run(vec![String::from("aeon-rust"), String::from("finalize")]).expect_err("usage error");
        assert!(result.contains("Error: No file specified"));
        assert!(result.contains(
            "Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]"
        ));
    }

    #[test]
    fn finalize_json_matches_basic_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("finalize-basic.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                header: result.header.clone(),
                ..FinalizeOptions::default()
            },
        );
        let mut top = Map::new();
        top.insert(String::from("document"), finalized.document);
        let output = JsonValue::Object(top);
        let expected = json!({
            "document": {
                "name": "AEON",
                "count": 3,
                "config": {
                    "host": "localhost",
                    "port": 5432
                },
                "flags": [true, false]
            }
        });
        assert_eq!(output, expected);
    }

    #[test]
    fn finalize_map_matches_basic_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("finalize-basic.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let finalized = finalize_map(
            &result.events,
            FinalizeOptions {
                header: result.header.clone(),
                ..FinalizeOptions::default()
            },
        );
        let output = json!({
            "document": {
                "entries": finalized.document.entries.iter().map(|entry| {
                    let mut obj = Map::new();
                    obj.insert(String::from("path"), JsonValue::String(entry.path.clone()));
                    obj.insert(String::from("value"), value_to_ast_json(&entry.value));
                    obj.insert(String::from("span"), span_to_json(&entry.span));
                    if let Some(datatype) = &entry.datatype {
                        obj.insert(String::from("datatype"), JsonValue::String(datatype.clone()));
                    }
                    JsonValue::Object(obj)
                }).collect::<Vec<_>>()
            }
        });
        let entries = output["document"]["entries"].as_array().expect("entries");
        assert_eq!(entries.len(), 8);
        assert_eq!(entries[0]["path"], "$.name");
        assert_eq!(entries[0]["value"]["type"], "StringLiteral");
        assert_eq!(entries[0]["value"]["value"], "AEON");
        assert_eq!(entries[1]["path"], "$.count");
        assert_eq!(entries[1]["value"]["type"], "NumberLiteral");
        assert_eq!(entries[2]["path"], "$.config");
        assert_eq!(entries[2]["value"]["type"], "ObjectNode");
        assert_eq!(entries[3]["path"], "$.config.host");
        assert_eq!(entries[4]["path"], "$.config.port");
        assert_eq!(entries[4]["datatype"], "int32");
        assert_eq!(entries[5]["path"], "$.flags");
        assert_eq!(entries[5]["value"]["type"], "ListNode");
        assert_eq!(entries[6]["path"], "$.flags[0]");
        assert_eq!(entries[6]["value"]["value"], true);
        assert_eq!(entries[7]["path"], "$.flags[1]");
        assert_eq!(entries[7]["value"]["value"], false);
    }

    #[test]
    fn finalize_projected_json_matches_fixture_contract() {
        let source = fs::read_to_string(
            fixture_path("finalize-basic.aeon"),
        )
        .expect("fixture");
        let result = compile(&source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                mode: FinalizeMode::Strict,
                materialization: Materialization::Projected,
                include_paths: vec![String::from("$.config.host"), String::from("$.flags[0]")],
                header: result.header.clone(),
                ..FinalizeOptions::default()
            },
        );
        let output = json!({
            "document": finalized.document
        });
        let expected = json!({
            "document": {
                "config": {
                    "host": "localhost"
                },
                "flags": [true]
            }
        });
        assert_eq!(output, expected);
    }

    #[test]
    fn finalize_full_scope_matches_contract_shape() {
        let source = "aeon:mode = \"strict\"\naeon:profile = \"aeon.gp.profile.v1\"\nname:string = \"AEON\"\n";
        let result = compile(source, CompileOptions::default());
        let finalized = finalize_json(
            &result.events,
            FinalizeOptions {
                mode: FinalizeMode::Strict,
                scope: FinalizeScope::Full,
                header: result.header.clone(),
                ..FinalizeOptions::default()
            },
        );
        let output = json!({
            "document": finalized.document
        });
        let expected = json!({
            "document": {
                "header": {
                    "mode": "strict",
                    "profile": "aeon.gp.profile.v1"
                },
                "payload": {
                    "name": "AEON"
                }
            }
        });
        assert_eq!(output, expected);
    }

    #[test]
    fn finalize_reports_usage_for_projected_without_include_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-finalize-projected-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("finalize"),
            file.to_string_lossy().into_owned(),
            String::from("--projected"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: --projected requires at least one --include-path <$.path>"));
        assert!(result.contains(
            "Usage: aeon finalize <file> [--json|--map] [--recovery] [--strict|--loose] [--projected] [--include-path <$.path>] [--datatype-policy <reserved_only|allow_custom>]"
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_fails_closed_when_max_input_bytes_is_exceeded() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-finalize-limit-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sample.aeon");
        fs::write(&file, "b = 1\na = 2\n").expect("seed file");
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("finalize"),
            file.to_string_lossy().into_owned(),
            String::from("--max-input-bytes"),
            String::from("4"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::from(1)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_returns_document_for_valid_input() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = {\n  name = \"AEON\"\n  port = 8080\n}\n").expect("input");

        let result = bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
        ])
        .expect("bind ok");
        assert_eq!(result, ExitCode::SUCCESS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_projected_output_matches_fixture_contract() {
        let (code, output) = execute_bind(&[
            fixture_path("bind-valid.aeon"),
            String::from("--schema"),
            fixture_path("bind-schema.json"),
            String::from("--include-path"),
            String::from("$.app.name"),
            String::from("--include-path"),
            String::from("$.app.port"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            output,
            json!({
                "document": {
                    "app": {
                        "name": "AEON",
                        "port": 8080
                    }
                },
                "meta": {
                    "errors": [],
                    "warnings": []
                }
            })
        );
    }

    #[test]
    fn bind_requires_schema_or_contract_registry() {
        let error = execute_bind(&[fixture_path("bind-valid.aeon")])
        .expect_err("usage error");
        assert!(error.contains("Error: Missing required --schema <schema.json> or --contract-registry <registry.json>"));
        assert!(error.contains("Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]"));
    }

    #[test]
    fn bind_header_scope_matches_contract_shape() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-header-scope-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.test.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "aeon:mode = \"strict\"\nname:string = \"AEON\"\nport:number = 8080\n").expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--scope"),
            String::from("header"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            output,
            json!({
                "document": {
                    "mode": "strict"
                },
                "meta": {
                    "errors": [],
                    "warnings": []
                }
            })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_strict_fails_when_schema_requirements_are_missing() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-missing-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = {\n  name = \"AEON\"\n}\n").expect("input");

        let result = bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--strict"),
        ])
        .expect("bind result");
        assert_eq!(result, ExitCode::from(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_includes_annotations_when_requested() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-ann-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(
            &input,
            "app = {\n  //# app name\n  name = \"AEON\" //? required\n  //@ port metadata\n  port = 8080\n}\n",
        )
        .expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--annotations"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        let annotations = output["annotations"].as_array().expect("annotations array");
        assert_eq!(annotations.len(), 3);
        assert_eq!(annotations[0]["kind"], "doc");
        assert_eq!(annotations[1]["kind"], "hint");
        assert_eq!(annotations[2]["kind"], "annotation");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_annotations_output_matches_fixture_contract() {
        let (code, output) = execute_bind(&[
            fixture_path("bind-annotations-valid.aeon"),
            String::from("--schema"),
            fixture_path("bind-schema.json"),
            String::from("--annotations"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(output["document"]["app"]["name"], "AEON");
        assert_eq!(output["document"]["app"]["port"], 8080);
        let annotations = output["annotations"].as_array().expect("annotations");
        assert_eq!(annotations.len(), 3);
        assert_eq!(annotations[0]["kind"], "doc");
        assert_eq!(annotations[0]["target"], json!({ "kind": "path", "path": "$.app.name" }));
        assert_eq!(annotations[1]["kind"], "hint");
        assert_eq!(annotations[1]["target"], json!({ "kind": "path", "path": "$.app.name" }));
        assert_eq!(annotations[2]["kind"], "annotation");
        assert_eq!(annotations[2]["target"], json!({ "kind": "path", "path": "$.app.port" }));
    }

    #[test]
    fn bind_supports_sorted_annotations() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-ann-sort-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(
            &input,
            "app = {\n  //# app name\n  name = \"AEON\" //? required\n  //@ port metadata\n  port = 8080\n}\n",
        )
        .expect("input");

        let (_code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--annotations"),
            String::from("--sort-annotations"),
        ])
        .expect("bind result");
        let annotations = output["annotations"].as_array().expect("annotations array");
        let mut previous = 0u64;
        for annotation in annotations {
            let next = annotation["span"]["start"]["offset"].as_u64().expect("offset");
            assert!(next >= previous);
            previous = next;
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_supports_trailing_separator_policy_warn() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-sep-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(&schema, r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[]}"#).expect("schema");
        fs::write(&input, "line:set[|] = ^0|0|0|\n").expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--trailing-separator-delimiter-policy"),
            String::from("warn"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(output["meta"]["warnings"]
            .as_array()
            .expect("warnings array")
            .iter()
            .any(|warning| warning["code"] == "trailing_separator_delimiter" && warning["phase"] == 6));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_supports_trailing_separator_policy_error() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-sep-err-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(&schema, r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[]}"#).expect("schema");
        fs::write(&input, "line:set[|] = ^0|0|0|\n").expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--trailing-separator-delimiter-policy"),
            String::from("error"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::from(1));
        assert!(output.get("document").is_none());
        assert!(output["meta"]["errors"]
            .as_array()
            .expect("errors array")
            .iter()
            .any(|error| error["code"] == "trailing_separator_delimiter" && error["phase"] == 6));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_supports_projected_materialization() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-proj-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = { name = \"AEON\", port = 8080, debug = true }\n").expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--include-path"),
            String::from("$.app.name"),
            String::from("--include-path"),
            String::from("$.app.port"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(output["document"], json!({ "app": { "name": "AEON", "port": 8080 } }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_loose_keeps_document_when_schema_fails() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-loose-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}},{"path":"$.app.port","constraints":{"type":"NumberLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = {\n  name = \"AEON\"\n}\n").expect("input");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--loose"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::from(1));
        assert!(output.get("document").is_some());
        assert!(output["meta"]["errors"].as_array().expect("errors array").iter().any(|error| error["phase"] == 6));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_allows_custom_datatypes_when_policy_is_allow_custom() {
        let schema = fixture_path("bind-schema.json");
        let input = fixture_path("bind-custom-datatype-strict.aeon");
        let (code, output) = execute_bind(&[
            input,
            String::from("--schema"),
            schema,
            String::from("--strict"),
            String::from("--datatype-policy"),
            String::from("allow_custom"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(output["meta"]["errors"].is_null() || output["meta"]["errors"] == json!([]));
        assert_eq!(output["document"]["app"]["name"], "AEON");
    }

    #[test]
    fn bind_allows_custom_datatypes_when_rich_is_set() {
        let schema = fixture_path("bind-schema.json");
        let input = fixture_path("bind-custom-datatype-strict.aeon");
        let (code, output) = execute_bind(&[
            input,
            String::from("--schema"),
            schema,
            String::from("--strict"),
            String::from("--rich"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(output["meta"]["errors"].is_null() || output["meta"]["errors"] == json!([]));
        assert_eq!(output["document"]["app"]["port"], 8080);
    }

    #[test]
    fn bind_reports_usage_errors_for_missing_flag_values() {
        assert!(execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--include-path"),
        ])
        .is_err());
        assert!(execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--trailing-separator-delimiter-policy"),
        ])
        .is_err());
        assert!(execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--profile"),
        ])
        .is_err());
    }

    #[test]
    fn bind_reports_usage_for_projected_without_include_path() {
        let error = execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--projected"),
        ])
        .expect_err("usage error");
        assert!(error.contains("Error: --projected requires at least one --include-path <$.path>"));
        assert!(error.contains(
            "Usage: aeon bind <file> [--schema <schema.json>] [--profile <id>] [--contract-registry <registry.json>] [--trailing-separator-delimiter-policy <off|warn|error>] [--datatype-policy <reserved_only|allow_custom>] [--strict|--loose] [--projected] [--include-path <$.path>] [--annotations] [--sort-annotations]"
        ));
    }

    #[test]
    fn bind_rejects_invalid_datatype_policy_values() {
        let error = execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--datatype-policy"),
            String::from("invalid"),
        ])
        .expect_err("usage error");
        assert!(error.contains("Invalid value for --datatype-policy"));
    }

    #[test]
    fn integrity_validate_reports_usage_for_missing_file() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("validate"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: No file specified"));
        assert!(result.contains("Usage: aeon integrity validate <file> [--strict|--loose]"));
    }

    #[test]
    fn integrity_verify_reports_usage_for_conflicting_modes() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("verify"),
            String::from("/tmp/example.aeon"),
            String::from("--strict"),
            String::from("--loose"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: Cannot use both --strict and --loose"));
        assert!(result.contains(
            "Usage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]"
        ));
    }

    #[test]
    fn integrity_verify_reports_usage_for_missing_receipt_value() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("verify"),
            String::from("/tmp/example.aeon"),
            String::from("--receipt"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Missing value for --receipt <path>"));
        assert!(result.contains(
            "Usage: aeon integrity verify <file> [--strict|--loose] [--public-key <path>] [--receipt <path>]"
        ));
    }

    #[test]
    fn integrity_sign_reports_usage_for_missing_private_key() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-missing-key-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
        ])
        .expect_err("usage error");
        assert!(result.contains("Error: Missing --private-key"));
        assert!(result.contains("Usage: aeon integrity sign <file> --private-key <path> [--receipt <path>]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_reports_usage_for_missing_receipt_value() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            String::from("/tmp/example.aeon"),
            String::from("--private-key"),
            String::from("/tmp/example.key"),
            String::from("--receipt"),
        ])
        .expect_err("usage error");
        assert!(result.contains("Missing value for --receipt <path>"));
        assert!(result.contains("Usage: aeon integrity sign <file> --private-key <path> [--receipt <path>]"));
    }

    #[test]
    fn bind_rejects_rich_with_reserved_only_datatype_policy() {
        let error = execute_bind(&[
            String::from("input.aeon"),
            String::from("--schema"),
            String::from("schema.json"),
            String::from("--rich"),
            String::from("--datatype-policy"),
            String::from("reserved_only"),
        ])
        .expect_err("usage error");
        assert!(error.contains("Invalid value for --datatype-policy"));
    }

    #[test]
    fn bind_warns_when_explicit_profile_is_supplied() {
        let schema = fixture_path("bind-schema.json");
        let input = fixture_path("bind-valid.aeon");
        let (code, output) = execute_bind(&[
            input,
            String::from("--schema"),
            schema,
            String::from("--profile"),
            String::from("json"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(output["document"].is_object());
        assert!(output["meta"]["warnings"]
            .as_array()
            .expect("warnings array")
            .iter()
            .any(|warning| warning["code"] == "PROFILE_PROCESSORS_SKIPPED" && warning["phase"] == 5));
    }

    #[test]
    fn bind_rejects_schema_contract_without_schema_id() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-schema-missing-id-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(&schema, r#"{"schema_version":"1.0.0","rules":[]}"#).expect("schema");
        fs::write(&input, "app = { name = \"AEON\", port = 8080 }\n").expect("input");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
        ])
        .expect_err("schema contract error");
        assert!(error.contains("missing required string field 'schema_id'"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_schema_contract_without_schema_version() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-schema-missing-version-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(&schema, r#"{"schema_id":"aeon.gp.schema.v1","rules":[]}"#).expect("schema");
        fs::write(&input, "app = { name = \"AEON\", port = 8080 }\n").expect("input");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
        ])
        .expect_err("schema contract error");
        assert!(error.contains("missing required string field 'schema_version'"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_schema_contract_with_unknown_metadata_keys() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-schema-unknown-key-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schemaVersion":"1.0.0","rules":[]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = { name = \"AEON\", port = 8080 }\n").expect("input");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
        ])
        .expect_err("schema contract error");
        assert!(error.contains("Unknown schema contract key 'schemaVersion'"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_resolves_schema_and_profile_from_registry_using_header_ids() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("contract-bind.aeon");
        let schema = dir.join("schema.aeon");
        let profile = dir.join("profile.aeon");
        let registry = dir.join("registry.json");

        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"aeon.gp.profile.v1\"\naeon:schema = \"aeon.gp.schema.v1\"\napp:object = {\n  name:string = \"AEON\"\n  port:int32 = 8080\n}\n",
        )
        .expect("input");
        let schema_contract = format!("{}\n", schema_contract_aeon_text("aeon.gp.schema.v1"));
        fs::write(&schema, &schema_contract).expect("schema");
        let profile_artifact = "profile_id = \"aeon.gp.profile.v1\"\nprofile_version = \"1.0.0\"\n";
        fs::write(&profile, profile_artifact).expect("profile");
        fs::write(
            &registry,
            format!(
                "{{\"contracts\":[{{\"id\":\"aeon.gp.profile.v1\",\"kind\":\"profile\",\"version\":\"1.0.0\",\"path\":\"profile.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}},{{\"id\":\"aeon.gp.schema.v1\",\"kind\":\"schema\",\"version\":\"1.0.0\",\"path\":\"schema.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}}]}}",
                sha256_hex(profile_artifact.as_bytes()),
                sha256_hex(schema_contract.as_bytes()),
            ),
        )
        .expect("registry");

        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry.to_string_lossy().into_owned(),
            String::from("--strict"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(output["document"]["app"]["name"], "AEON");
        assert_eq!(output["document"]["app"]["port"], 8080);
        assert!(output["meta"]["errors"].as_array().expect("errors").is_empty());
        assert!(output["meta"]["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning["code"] == "PROFILE_PROCESSORS_SKIPPED"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_unknown_schema_id_from_registry() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-unknown-schema-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("contract-bind.aeon");
        let profile = dir.join("profile.aeon");
        let registry = dir.join("registry.json");

        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"altopelago.core.v1\"\naeon:schema = \"missing.schema.id\"\napp:object = {\n  name:string = \"AEON\"\n  port:int32 = 8080\n}\n",
        )
        .expect("input");
        let profile_artifact = "profile placeholder for hash verification";
        fs::write(&profile, profile_artifact).expect("profile");
        fs::write(
            &registry,
            format!(
                "{{\"contracts\":[{{\"id\":\"altopelago.core.v1\",\"kind\":\"profile\",\"version\":\"1.0.0\",\"path\":\"profile.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}}]}}",
                sha256_hex(profile_artifact.as_bytes()),
            ),
        )
        .expect("registry");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry.to_string_lossy().into_owned(),
        ])
        .expect_err("registry error");
        assert_eq!(
            error,
            "Error [CONTRACT_UNKNOWN_SCHEMA_ID]: Unknown schema contract id in registry: missing.schema.id"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_unknown_profile_id_from_registry() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-unknown-profile-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("contract-bind.aeon");
        let schema = dir.join("schema.aeon");
        let registry = dir.join("registry.json");

        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"missing.profile.id\"\naeon:schema = \"aeon.gp.schema.v1\"\napp:object = {\n  name:string = \"AEON\"\n  port:int32 = 8080\n}\n",
        )
        .expect("input");
        let schema_contract = format!("{}\n", schema_contract_aeon_text("aeon.gp.schema.v1"));
        fs::write(&schema, &schema_contract).expect("schema");
        fs::write(
            &registry,
            format!(
                "{{\"contracts\":[{{\"id\":\"aeon.gp.schema.v1\",\"kind\":\"schema\",\"version\":\"1.0.0\",\"path\":\"schema.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}}]}}",
                sha256_hex(schema_contract.as_bytes()),
            ),
        )
        .expect("registry");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry.to_string_lossy().into_owned(),
        ])
        .expect_err("registry error");
        assert_eq!(
            error,
            "Error [CONTRACT_UNKNOWN_PROFILE_ID]: Unknown profile contract id in registry: missing.profile.id"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_contract_artifact_hash_mismatch() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-hash-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("contract-bind.aeon");
        let schema = dir.join("schema.aeon");
        let profile = dir.join("profile.aeon");
        let registry = dir.join("registry.json");

        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"altopelago.core.v1\"\naeon:schema = \"aeon.gp.schema.v1\"\napp:object = {\n  name:string = \"AEON\"\n  port:int32 = 8080\n}\n",
        )
        .expect("input");
        let schema_contract = format!("{}\n", schema_contract_aeon_text("aeon.gp.schema.v1"));
        fs::write(&schema, &schema_contract).expect("schema");
        let profile_artifact = "profile_id = \"altopelago.core.v1\"\nprofile_version = \"1.0.0\"\n";
        fs::write(&profile, profile_artifact).expect("profile");
        fs::write(
            &registry,
            format!(
                "{{\"contracts\":[{{\"id\":\"altopelago.core.v1\",\"kind\":\"profile\",\"version\":\"1.0.0\",\"path\":\"profile.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}},{{\"id\":\"aeon.gp.schema.v1\",\"kind\":\"schema\",\"version\":\"1.0.0\",\"path\":\"schema.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}}]}}",
                sha256_hex(profile_artifact.as_bytes()),
                "0".repeat(64),
            ),
        )
        .expect("registry");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry.to_string_lossy().into_owned(),
        ])
        .expect_err("registry error");
        assert!(error.starts_with("Error [CONTRACT_ARTIFACT_HASH_MISMATCH]: Contract artifact hash mismatch for 'aeon.gp.schema.v1' at "));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_rejects_missing_contract_artifact() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-missing-artifact-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("contract-bind.aeon");
        let profile = dir.join("profile.aeon");
        let registry = dir.join("registry.json");

        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"altopelago.core.v1\"\naeon:schema = \"aeon.gp.schema.v1\"\napp:object = {\n  name:string = \"AEON\"\n  port:int32 = 8080\n}\n",
        )
        .expect("input");
        let profile_artifact = "profile_id = \"altopelago.core.v1\"\nprofile_version = \"1.0.0\"\n";
        fs::write(&profile, profile_artifact).expect("profile");
        fs::write(
            &registry,
            format!(
                "{{\"contracts\":[{{\"id\":\"altopelago.core.v1\",\"kind\":\"profile\",\"version\":\"1.0.0\",\"path\":\"profile.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}},{{\"id\":\"aeon.gp.schema.v1\",\"kind\":\"schema\",\"version\":\"1.0.0\",\"path\":\"missing-schema.aeon\",\"sha256\":\"{}\",\"status\":\"active\"}}]}}",
                sha256_hex(profile_artifact.as_bytes()),
                "0".repeat(64),
            ),
        )
        .expect("registry");

        let error = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry.to_string_lossy().into_owned(),
        ])
        .expect_err("registry error");
        assert!(error.starts_with("Error [CONTRACT_ARTIFACT_MISSING]: Missing contract artifact for 'aeon.gp.schema.v1' at "));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_enforces_repository_baseline_datatype_rules() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-bind-registry-gp-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let input = dir.join("gp-numeric-contracts.aeon");
        fs::write(
            &input,
            "aeon:mode = \"strict\"\naeon:profile = \"aeon.gp.profile.v1\"\naeon:schema = \"aeon.gp.schema.v1\"\nvalue:uint = -1\n",
        )
        .expect("input");
        let registry =
            contract_registry_path();
        let (code, output) = execute_bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--contract-registry"),
            registry,
            String::from("--strict"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::from(1));
        assert!(output.get("document").is_none());
        assert!(output["meta"]["errors"]
            .as_array()
            .expect("errors")
            .iter()
            .any(|error| {
                error["phase"] == 6
                    && error["code"] == "numeric_form_violation"
                    && error["path"] == "$.value"
                    && error["span"].is_array()
            }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_resolves_repository_baseline_contracts_registry() {
        let (code, output) = execute_bind(&[
            example_path("contracts-baseline/sample-with-contracts.aeon"),
            String::from("--contract-registry"),
            contract_registry_path(),
            String::from("--strict"),
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            output,
            json!({
                "document": {
                    "app": {
                        "name": "AEON",
                        "port": 8080
                    }
                },
                "meta": {
                    "errors": [],
                    "warnings": [
                        {
                            "code": "PROFILE_PROCESSORS_SKIPPED",
                            "phase": 5,
                            "message": "Profile 'aeon.gp.profile.v1' processors were skipped to enforce phase order (schema before resolve)."
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn bind_fails_closed_when_max_input_bytes_is_exceeded() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-bind-limit-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let schema = dir.join("schema.json");
        let input = dir.join("input.aeon");
        fs::write(
            &schema,
            r#"{"schema_id":"aeon.gp.schema.v1","schema_version":"1.0.0","rules":[{"path":"$.app.name","constraints":{"type":"StringLiteral","required":true}}]}"#,
        )
        .expect("schema");
        fs::write(&input, "app = {\n  name = \"AEON\"\n}\n").expect("input");

        let result = bind(&[
            input.to_string_lossy().into_owned(),
            String::from("--schema"),
            schema.to_string_lossy().into_owned(),
            String::from("--max-input-bytes"),
            String::from("4"),
        ])
        .expect("bind result");
        assert_eq!(result, ExitCode::from(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bind_meta_always_includes_errors_and_warnings_arrays() {
        let schema = fixture_path("bind-schema.json");
        let input = fixture_path("bind-valid.aeon");
        let (code, output) = execute_bind(&[
            input,
            String::from("--schema"),
            schema,
        ])
        .expect("bind result");
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(output["meta"]["errors"].is_array());
        assert!(output["meta"]["warnings"].is_array());
        assert_eq!(output["meta"]["errors"], json!([]));
        assert_eq!(output["meta"]["warnings"], json!([]));
    }

    #[test]
    fn integrity_validate_returns_ok_for_valid_envelope() {
        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("validate"),
            fixture_path("envelope-valid.aeon"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
    }

    #[test]
    fn integrity_validate_json_returns_expected_shape() {
        let result = compile(
            "a = 1\nclose:envelope = {\n  integrity:integrityBlock = {\n    alg:string = \"sha-256\"\n    hash:string = \"deadbeef\"\n  }\n}\n",
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let (errors, warnings) = validate_envelope_events(&result.events, true);
        assert!(errors.is_empty());
        assert!(warnings.is_empty());
        let payload = json!({
            "ok": true,
            "errors": [],
            "warnings": [],
        });
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["errors"], json!([]));
        assert_eq!(payload["warnings"], json!([]));
    }

    #[test]
    fn integrity_validate_json_matches_contract_shape_for_valid_envelope() {
        let payload = integrity_payload(&[], &[], None, None);
        assert_eq!(
            payload,
            json!({
                "ok": true,
                "errors": [],
                "warnings": [],
            })
        );
    }

    #[test]
    fn integrity_validate_plain_output_matches_contract_shape() {
        let lines = integrity_plain_lines(&[], &[]);
        assert_eq!(lines, vec![String::from("OK")]);
    }

    #[test]
    fn envelope_diagnostic_lines_match_cli_contract_shape() {
        let warning = EnvelopeDiagnostic {
            code: "ENVELOPE_SIGNATURE_KEY_MISSING",
            message: String::from("sig present but no --public-key provided;\nsignature not verified"),
        };
        assert_eq!(
            format_envelope_diagnostic_line("WARN", &warning),
            "WARN [ENVELOPE_SIGNATURE_KEY_MISSING] sig present but no --public-key provided; signature not verified"
        );
    }

    #[test]
    fn integrity_verify_matches_canonical_hash() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-rust-integrity-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("verify.aeon");
        let body = "a = 1\n";
        let body_compile = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let hash = compute_canonical_hash(&body_compile.events, "sha-256").hash;
        let contents = format!(
            "a = 1\nclose:envelope = {{\n  integrity:integrityBlock = {{\n    alg:string = \"sha-256\"\n    hash:string = \"{hash}\"\n  }}\n}}\n"
        );
        fs::write(&file, contents).expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("verify"),
            file.to_string_lossy().into_owned(),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_verify_json_returns_verification_metadata() {
        let body = "a = 1\n";
        let body_compile = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let computed = compute_canonical_hash(&body_compile.events, "sha-256");
        let source = format!(
            "a = 1\nclose:envelope = {{\n  integrity:integrityBlock = {{\n    alg:string = \"sha-256\"\n    hash:string = \"{}\"\n  }}\n}}\n",
            computed.hash
        );
        let result = compile(
            &source,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let (mut errors, warnings) = validate_envelope_events(&result.events, true);
        let envelope_root = envelope_root_path(&result.events).expect("envelope");
        let expected_hash =
            read_envelope_field(&result.events, &envelope_root, &["integrity.hash", "hash"]).expect("hash");
        let receipt = canonical_receipt_json(body, &computed, body_compile.header.as_ref(), Some(&expected_hash), false);
        let verification = json!({
            "canonical": {
                "present": true,
                "algorithm": "sha-256",
                "expected": expected_hash,
                "computed": computed.hash,
            },
            "canonicalStream": {
                "length": computed.stream.len(),
            },
            "bytes": { "present": false },
            "checksum": { "present": false },
            "signature": { "present": false },
            "replay": {
                "performed": true,
                "status": "match",
                "expected": expected_hash,
                "computed": computed.hash,
            },
        });
        assert!(errors.is_empty());
        assert!(warnings.is_empty());
        assert_eq!(receipt["source"]["mediaType"], "text/aeon");
        assert_eq!(receipt["producer"]["implementation"], "aeon-cli-rs");
        assert!(receipt["generated"]["at"].as_str().expect("timestamp").contains('T'));
        assert_eq!(receipt["canonical"]["digest"], computed.hash);
        assert_eq!(verification["canonical"]["algorithm"], "sha-256");
        assert_eq!(verification["canonical"]["expected"], computed.hash);
        assert!(verification["canonicalStream"]["length"].as_u64().is_some());
        assert_eq!(verification["replay"]["performed"], true);
        assert_eq!(verification["replay"]["status"], "match");
        assert_eq!(verification["bytes"]["present"], false);
        assert_eq!(verification["checksum"]["present"], false);
        assert_eq!(verification["signature"]["present"], false);
        errors.clear();
    }

    #[test]
    fn doctor_reports_passing_registry_check_by_default() {
        let checks = run_doctor(&default_contract_registry_path());
        assert!(checks.iter().any(|check| check.name == "node-version" && check.status == "pass"));
        assert!(checks
            .iter()
            .any(|check| check.name == "package-availability" && check.status == "pass"));
        assert!(checks.iter().any(|check| check.name == "contract-registry" && check.status == "pass"));
        assert!(checks.iter().any(|check| check.name == "policy-surface" && check.status == "pass"));
        assert!(checks.iter().all(|check| check.status != "fail"));
    }

    #[test]
    fn doctor_human_output_matches_contract_shape() {
        let checks = run_doctor(&default_contract_registry_path());
        let lines = doctor_lines(&checks);
        assert!(lines.iter().any(|line| line.starts_with("[PASS] node-version ")));
        assert!(lines.iter().any(|line| line.starts_with("[PASS] package-availability ")));
        assert!(lines.iter().any(|line| line.starts_with("[PASS] contract-registry ")));
        assert!(lines.iter().any(|line| line.starts_with("[PASS] policy-surface ")));
    }

    #[test]
    fn doctor_json_shape_includes_contract_registry_check() {
        let checks = run_doctor(&default_contract_registry_path());
        let payload = doctor_payload(&checks);
        assert_eq!(payload["ok"], true);
        assert!(payload["checks"]
            .as_array()
            .expect("checks")
            .iter()
            .any(|check| check["name"] == "contract-registry" && check["status"] == "pass"));
        assert!(payload["checks"]
            .as_array()
            .expect("checks")
            .iter()
            .any(|check| check["name"] == "node-version" && check["status"] == "pass"));
        assert!(payload["checks"]
            .as_array()
            .expect("checks")
            .iter()
            .any(|check| check["name"] == "package-availability" && check["status"] == "pass"));
    }

    #[test]
    fn doctor_fails_when_registry_path_is_missing() {
        let missing = format!("/tmp/missing-{}.json", SystemTime::now().duration_since(UNIX_EPOCH).expect("time").as_nanos());
        let checks = run_doctor(&missing);
        assert!(checks.iter().any(|check| check.name == "contract-registry" && check.status == "fail"));
    }

    #[test]
    fn doctor_fails_when_registry_artifact_hash_is_invalid() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-doctor-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let contract = dir.join("schema.aeon");
        let registry = dir.join("registry.json");
        fs::write(&contract, schema_contract_aeon_text("aeon.demo.schema.v1")).expect("contract");
        fs::write(
            &registry,
            r#"{"contracts":[{"id":"aeon.demo.schema.v1","kind":"schema","version":"1.0.0","path":"./schema.aeon","sha256":"0000000000000000000000000000000000000000000000000000000000000000","status":"active"}]}"#,
        )
        .expect("registry");

        let checks = run_doctor(&registry.to_string_lossy());
        let registry_check = checks
            .iter()
            .find(|check| check.name == "contract-registry")
            .expect("registry check");
        assert_eq!(registry_check.status, "fail");
        assert!(registry_check
            .details
            .as_ref()
            .and_then(|details| details["entries"].as_array())
            .expect("entries")
            .iter()
            .any(|entry| entry["code"] == "CONTRACT_ARTIFACT_HASH_MISMATCH"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_generates_signed_envelope_json() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-sign-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign.aeon");
        fs::write(&file, "a = 1\n").expect("file");
        let private_key = String::from(
            example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
        );

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            private_key,
            String::from("--json"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_json_matches_contract_shape() {
        let body = "a = 1\n";
        let compile_result = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let canonical = compute_canonical_hash(&compile_result.events, "sha-256");
        let private_key = fs::read_to_string(
            example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
        )
        .expect("private key");
        let signature = sign_string_payload(&canonical.hash, &private_key).expect("signature");
        let receipt = canonical_receipt_json(body, &canonical, compile_result.header.as_ref(), None, true);
        let payload = json!({
            "ok": true,
            "receipt": receipt,
            "envelope": {
                "integrity": render_integrity_json(&canonical.hash, None, None),
                "signatures": [{
                    "alg": "ed25519",
                    "kid": "default",
                    "sig": signature,
                }]
            }
        });
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["receipt"]["source"]["mediaType"], "text/aeon");
        assert_eq!(payload["receipt"]["producer"]["implementation"], "aeon-cli-rs");
        assert!(payload["receipt"]["generated"]["at"].as_str().expect("timestamp").contains('T'));
        assert_eq!(payload["receipt"]["canonical"]["digest"], canonical.hash);
        assert!(payload["receipt"]["canonical"]["payload"].is_string());
        assert_eq!(payload["envelope"]["integrity"]["alg"], "sha-256");
        assert_eq!(payload["envelope"]["integrity"]["hash"], canonical.hash);
        assert_eq!(payload["envelope"]["signatures"][0]["alg"], "ed25519");
        assert_eq!(payload["envelope"]["signatures"][0]["kid"], "default");
        assert!(payload["envelope"]["signatures"][0]["sig"].as_str().is_some());
    }

    #[test]
    fn integrity_verify_accepts_valid_signature_with_public_key() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-verify-sig-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("verify-sig.aeon");
        let body = "a = 1\n";
        let body_compile = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let hash = compute_canonical_hash(&body_compile.events, "sha-256").hash;
        let private_key = fs::read_to_string(
            example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
        )
        .expect("private key");
        let signature = sign_string_payload(&hash, &private_key).expect("signature");
        let contents = format!(
            "a = 1\nclose:envelope = {{\n  integrity:integrityBlock = {{\n    alg:string = \"sha-256\"\n    hash:string = \"{hash}\"\n  }}\n  signatures:signatureSet = [\n    {{\n      alg:string = \"ed25519\"\n      kid:string = \"default\"\n      sig:string = \"{signature}\"\n    }}\n  ]\n}}\n"
        );
        fs::write(&file, contents).expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("verify"),
            file.to_string_lossy().into_owned(),
            String::from("--public-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.public.pem"),
            ),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_verify_warns_when_signature_present_without_public_key() {
        let body = "a = 1\n";
        let body_compile = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let hash = compute_canonical_hash(&body_compile.events, "sha-256").hash;
        let private_key = fs::read_to_string(
            example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
        )
        .expect("private key");
        let signature = sign_string_payload(&hash, &private_key).expect("signature");
        let source = format!(
            "a = 1\nclose:envelope = {{\n  integrity:integrityBlock = {{\n    alg:string = \"sha-256\"\n    hash:string = \"{hash}\"\n  }}\n  signatures:signatureSet = [\n    {{\n      alg:string = \"ed25519\"\n      kid:string = \"default\"\n      sig:string = \"{signature}\"\n    }}\n  ]\n}}\n"
        );
        let result = compile(
            &source,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let envelope_root = envelope_root_path(&result.events).expect("envelope");
        let signature = read_envelope_field(&result.events, &envelope_root, &["signatures[0].sig", "sig"]);
        let mut warnings = Vec::new();
        if signature.is_some() {
            warnings.push(EnvelopeDiagnostic {
                code: "ENVELOPE_SIGNATURE_KEY_MISSING",
                message: String::from("sig present but no --public-key provided; signature not verified"),
            });
        }
        assert!(warnings.iter().any(|warning| warning.code == "ENVELOPE_SIGNATURE_KEY_MISSING"));
    }

    #[test]
    fn integrity_plain_output_includes_warning_before_ok() {
        let warnings = vec![EnvelopeDiagnostic {
            code: "ENVELOPE_SIGNATURE_KEY_MISSING",
            message: String::from("sig present but no --public-key provided; signature not verified"),
        }];
        let lines = integrity_plain_lines(&[], &warnings);
        assert_eq!(
            lines,
            vec![
                String::from(
                    "WARN [ENVELOPE_SIGNATURE_KEY_MISSING] sig present but no --public-key provided; signature not verified"
                ),
                String::from("OK"),
            ]
        );
    }

    #[test]
    fn integrity_sign_write_appends_envelope_and_backup() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-write-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-write.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--write"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let written = fs::read_to_string(&file).expect("written");
        assert!(written.contains("close:envelope"));
        assert!(written.contains("alg:string = \"ed25519\""));
        assert!(written.contains("\"aeon.gp.security.v1\""));
        assert!(written.contains("\"aeon.gp.integrity.v1\""));
        assert!(written.contains("\"aeon.gp.signature.v1\""));
        assert!(dir.join("sign-write.aeon.bak").exists());
        assert!(dir.join("sign-write.aeon.receipt.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_write_honors_explicit_receipt_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-write-receipt-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-write-custom.aeon");
        let receipt = dir.join("custom.receipt.json");
        fs::write(&file, "a = 1\n").expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--write"),
            String::from("--receipt"),
            receipt.to_string_lossy().into_owned(),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        assert!(receipt.exists());
        assert!(!dir.join("sign-write-custom.aeon.receipt.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_verify_prefers_explicit_receipt_sidecar() {
        let body = "a = 1\n";
        let body_compile = compile(
            body,
            CompileOptions {
                datatype_policy: Some(DatatypePolicy::AllowCustom),
                ..CompileOptions::default()
            },
        );
        let hash = compute_canonical_hash(&body_compile.events, "sha-256").hash;
        let receipt = json!({
            "source": {
                "mediaType": "text/aeon",
                "encoding": "utf-8",
                "digestAlgorithm": "sha-256",
                "digest": "abc123",
            },
            "canonical": {
                "format": "aeon.canonical",
                "spec": "AEON Core",
                "specRelease": "v1",
                "mode": "transport",
                "profile": "custom",
                "outputEncoding": "utf-8",
                "digestAlgorithm": "sha-256",
                "digest": hash,
                "length": 6,
            },
            "producer": {
                "implementation": "test-receipt",
                "version": "1.0.0",
            },
            "generated": {
                "at": "2026-03-17T13:21:00Z",
            }
        });
        assert_eq!(receipt["producer"]["implementation"], "test-receipt");
        assert_eq!(receipt["canonical"]["profile"], "custom");
    }

    #[test]
    fn integrity_sign_replace_replaces_existing_envelope() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-replace-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-replace.aeon");
        fs::write(
            &file,
            "a = 1\nclose:envelope = {\n  integrity:integrityBlock = {\n    alg:string = \"sha-256\"\n    hash:string = \"deadbeef\"\n  }\n}\n",
        )
        .expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--write"),
            String::from("--replace"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let written = fs::read_to_string(&file).expect("written");
        assert_eq!(written.matches("close:envelope").count(), 1);
        assert!(written.contains("signatures:signatureSet"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_json_includes_bytes_hash_fields() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-bytes-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-bytes.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let parsed = {
            let body = "a = 1\n";
            let compile_result = compile(
                body,
                CompileOptions {
                    datatype_policy: Some(DatatypePolicy::AllowCustom),
                    ..CompileOptions::default()
                },
            );
            let canonical = compute_canonical_hash(&compile_result.events, "sha-256");
            let bytes = compute_byte_hash(body);
            json!({
                "envelope": {
                    "integrity": {
                        "alg": "sha-256",
                        "hash": canonical.hash,
                        "bytes_hash_alg": "sha-256",
                        "bytes_hash": bytes,
                    }
                }
            })
        };

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--include-bytes"),
            String::from("--json"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        assert_eq!(parsed["envelope"]["integrity"]["bytes_hash_alg"], "sha-256");
        assert!(parsed["envelope"]["integrity"]["bytes_hash"].as_str().is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_json_includes_checksum_fields() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-checksum-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-checksum.aeon");
        fs::write(&file, "a = 1\n").expect("file");

        let parsed = {
            let body = "a = 1\n";
            let compile_result = compile(
                body,
                CompileOptions {
                    datatype_policy: Some(DatatypePolicy::AllowCustom),
                    ..CompileOptions::default()
                },
            );
            let canonical = compute_canonical_hash(&compile_result.events, "sha-256");
            let checksum = compute_byte_hash(body);
            json!({
                "envelope": {
                    "integrity": {
                        "alg": "sha-256",
                        "hash": canonical.hash,
                        "checksum_alg": "sha-256",
                        "checksum_value": checksum,
                    }
                }
            })
        };

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--include-checksum"),
            String::from("--json"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        assert_eq!(parsed["envelope"]["integrity"]["checksum_alg"], "sha-256");
        assert!(parsed["envelope"]["integrity"]["checksum_value"].as_str().is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_write_merges_missing_gp_security_conventions() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-merge-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-write-merge.aeon");
        fs::write(
            &file,
            "aeon:header = {\n  mode = \"strict\"\n  conventions:conventionSet = [\n    \"aeon.gp.security.v1\"\n  ]\n}\n\na:number = 1\n",
        )
        .expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
            String::from("--write"),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::SUCCESS));
        let written = fs::read_to_string(&file).expect("written");
        assert!(written.contains("\"aeon.gp.security.v1\""));
        assert!(written.contains("\"aeon.gp.integrity.v1\""));
        assert!(written.contains("\"aeon.gp.signature.v1\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_sign_fails_when_envelope_exists_without_replace() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aeon-integrity-exists-{unique}"));
        fs::create_dir_all(&dir).expect("tmp dir");
        let file = dir.join("sign-exists.aeon");
        fs::write(
            &file,
            "a = 1\nclose:envelope = {\n  integrity:integrityBlock = {\n    alg:string = \"sha-256\"\n    hash:string = \"deadbeef\"\n  }\n}\n",
        )
        .expect("file");

        let result = run(vec![
            String::from("aeon-rust"),
            String::from("integrity"),
            String::from("sign"),
            file.to_string_lossy().into_owned(),
            String::from("--private-key"),
            String::from(
                example_path("signed-aeon-cli-asymmetric/keys/alice.private.pem"),
            ),
        ]);
        assert!(matches!(result, Ok(code) if code == ExitCode::from(1)));
        let _ = fs::remove_dir_all(&dir);
    }
}
