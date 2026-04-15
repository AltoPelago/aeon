#![no_main]

use aeon_core::benchmark_token_parse;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let _ = benchmark_token_parse(&input);
});
