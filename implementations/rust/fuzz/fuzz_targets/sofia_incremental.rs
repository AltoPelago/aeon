#![no_main]

use aeon_core::fuzz_sofia_incremental;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    fuzz_sofia_incremental(data);
});
