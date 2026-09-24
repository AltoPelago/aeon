#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Utf8DecodeError {
    pub(crate) valid_up_to: usize,
    pub(crate) error_len: Option<usize>,
}

#[derive(Debug, Default)]
pub(crate) struct Utf8Decoder {
    pending: [u8; 4],
    pending_len: usize,
    pending_start: usize,
    received_bytes: usize,
}

impl Utf8Decoder {
    pub(crate) fn push(
        &mut self,
        chunk: &[u8],
        mut emit: impl FnMut(usize, &str),
    ) -> Result<(), Utf8DecodeError> {
        let chunk_start = self.received_bytes;
        self.received_bytes += chunk.len();
        let mut consumed = 0;

        if self.pending_len != 0 {
            while consumed < chunk.len() && self.pending_len < self.pending.len() {
                self.pending[self.pending_len] = chunk[consumed];
                self.pending_len += 1;
                consumed += 1;

                match std::str::from_utf8(&self.pending[..self.pending_len]) {
                    Ok(text) => {
                        emit(self.pending_start, text);
                        self.pending_len = 0;
                        break;
                    }
                    Err(error) if error.error_len().is_none() => {}
                    Err(error) => {
                        return Err(Utf8DecodeError {
                            valid_up_to: self.pending_start + error.valid_up_to(),
                            error_len: error.error_len(),
                        });
                    }
                }
            }

            if self.pending_len != 0 {
                debug_assert!(self.pending_len <= 3);
                return Ok(());
            }
        }

        let remaining = &chunk[consumed..];
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                if !text.is_empty() {
                    emit(chunk_start + consumed, text);
                }
            }
            Err(error) => {
                let valid_end = error.valid_up_to();
                if valid_end != 0 {
                    let text = std::str::from_utf8(&remaining[..valid_end])
                        .expect("the UTF-8 validator's valid prefix must decode");
                    emit(chunk_start + consumed, text);
                }

                let suffix_start = consumed + valid_end;
                if let Some(error_len) = error.error_len() {
                    return Err(Utf8DecodeError {
                        valid_up_to: chunk_start + suffix_start,
                        error_len: Some(error_len),
                    });
                }

                let suffix = &chunk[suffix_start..];
                debug_assert!(!suffix.is_empty());
                debug_assert!(suffix.len() <= 3);
                self.pending[..suffix.len()].copy_from_slice(suffix);
                self.pending_len = suffix.len();
                self.pending_start = chunk_start + suffix_start;
            }
        }

        Ok(())
    }

    pub(crate) fn push_str(
        &mut self,
        chunk: &str,
        mut emit: impl FnMut(usize, &str),
    ) -> Result<(), Utf8DecodeError> {
        if self.pending_len != 0 {
            return self.push(chunk.as_bytes(), emit);
        }

        let start = self.received_bytes;
        self.received_bytes += chunk.len();
        if !chunk.is_empty() {
            emit(start, chunk);
        }
        Ok(())
    }

    pub(crate) const fn finish(&self) -> Result<(), Utf8DecodeError> {
        if self.pending_len == 0 {
            Ok(())
        } else {
            Err(Utf8DecodeError {
                valid_up_to: self.pending_start,
                error_len: None,
            })
        }
    }

    #[cfg(feature = "sofia")]
    pub(crate) const fn received_bytes(&self) -> usize {
        self.received_bytes
    }

    #[cfg(test)]
    pub(crate) const fn pending_bytes(&self) -> usize {
        self.pending_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> Result<(String, Vec<usize>, usize), Utf8DecodeError> {
        let mut decoder = Utf8Decoder::default();
        let mut output = String::new();
        let mut offsets = Vec::new();
        for chunk in chunks {
            decoder.push(chunk, |offset, text| {
                offsets.push(offset);
                output.push_str(text);
            })?;
            assert!(decoder.pending_bytes() <= 3);
        }
        decoder.finish()?;
        Ok((output, offsets, decoder.pending_bytes()))
    }

    #[test]
    fn every_byte_split_preserves_utf8_and_absolute_offsets() {
        let source = "A¢€🌊Z";
        for split in 0..=source.len() {
            let (decoded, offsets, pending) =
                decode(&[&source.as_bytes()[..split], &source.as_bytes()[split..]])
                    .expect("every split must decode");
            assert_eq!(decoded, source, "split at byte {split}");
            assert_eq!(offsets.first().copied().unwrap_or(0), 0);
            assert_eq!(pending, 0);
        }

        let one_byte_chunks = source
            .as_bytes()
            .iter()
            .map(std::slice::from_ref)
            .collect::<Vec<_>>();
        let (decoded, offsets, pending) =
            decode(&one_byte_chunks).expect("byte-at-a-time UTF-8 must decode");
        assert_eq!(decoded, source);
        assert_eq!(offsets, [0, 1, 3, 6, 10]);
        assert_eq!(pending, 0);
    }

    #[test]
    fn incomplete_scalar_retains_at_most_three_bytes() {
        let mut decoder = Utf8Decoder::default();
        decoder
            .push(&[0xf0, 0x9f, 0x8c], |_, _| {})
            .expect("an incomplete scalar is not invalid");
        assert_eq!(decoder.pending_bytes(), 3);
        assert_eq!(
            decoder.finish(),
            Err(Utf8DecodeError {
                valid_up_to: 0,
                error_len: None,
            })
        );
    }

    #[test]
    fn complete_invalid_sequence_reports_absolute_offset_immediately() {
        let mut decoder = Utf8Decoder::default();
        decoder
            .push(b"ok ", |_, _| {})
            .expect("ASCII prefix must decode");
        let error = decoder
            .push(&[0xf0, b'('], |_, _| {})
            .expect_err("a complete invalid sequence must fail");
        assert_eq!(error.valid_up_to, 3);
        assert!(error.error_len.is_some());
    }

    #[test]
    fn invalid_continuation_after_pending_prefix_uses_stream_offset() {
        let mut decoder = Utf8Decoder::default();
        decoder
            .push(&[b'a', 0xf0, 0x9f], |_, _| {})
            .expect("the split scalar remains pending");
        assert_eq!(decoder.pending_bytes(), 2);

        let error = decoder
            .push(b"x", |_, _| {})
            .expect_err("the non-continuation byte makes the prefix invalid");
        assert_eq!(error.valid_up_to, 1);
        assert!(error.error_len.is_some());
    }

    #[test]
    fn valid_string_chunks_take_the_already_valid_fast_path() {
        let mut decoder = Utf8Decoder::default();
        let mut output = String::new();
        let mut offsets = Vec::new();
        decoder
            .push_str("Sofía ", |offset, text| {
                offsets.push(offset);
                output.push_str(text);
            })
            .expect("first string chunk is valid");
        decoder
            .push_str("🌊", |offset, text| {
                offsets.push(offset);
                output.push_str(text);
            })
            .expect("second string chunk is valid");
        assert_eq!(decoder.finish(), Ok(()));
        assert_eq!(output, "Sofía 🌊");
        assert_eq!(offsets, [0, "Sofía ".len()]);
    }
}
