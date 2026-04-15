#![no_main]

use aeon_core::{CompileOptions, compile};
use libfuzzer_sys::fuzz_target;

const MAX_INPUT_BYTES: usize = 1 << 20;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let options = CompileOptions {
        max_input_bytes: Some(MAX_INPUT_BYTES),
        ..CompileOptions::default()
    };

    let _ = compile(&input, options);
});
