#![no_main]

use aeon_core::fuzz_sofia_token_parse;
use libfuzzer_sys::fuzz_target;

const MAX_INPUT_BYTES: usize = 1 << 20;

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_INPUT_BYTES {
        return;
    }

    let input = String::from_utf8_lossy(data);
    fuzz_sofia_token_parse(&input);
});
