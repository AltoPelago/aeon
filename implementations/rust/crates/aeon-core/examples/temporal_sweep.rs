//! Persistent test-only batch worker, driven by scripts/temporal-sweep.py.
use aeon_core::{CompileOptions, compile};
use serde_json::json;
use std::io::{self, BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    writeln!(stdout, "{}", json!({"ready": true}))?;
    stdout.flush()?;
    for line in stdin.lock().lines() {
        let cases: Vec<(String, bool)> = serde_json::from_str(&line?)?;
        let mut mismatches = Vec::new();
        let mut accepted = 0;
        for (index, (literal, expected)) in cases.iter().enumerate() {
            let source = format!("aeon:mode = \"strict\"\nv:datetime = {literal}");
            let result = compile(&source, CompileOptions::default());
            let actual = result.errors.is_empty();
            accepted += usize::from(actual);
            if actual != *expected {
                let codes: Vec<_> = result.errors.iter().map(|error| &error.code).collect();
                mismatches.push(json!([index, actual, codes]));
            }
        }
        writeln!(
            stdout,
            "{}",
            json!({"checked": cases.len(), "accepted": accepted, "mismatches": mismatches})
        )?;
        stdout.flush()?;
    }
    Ok(())
}
