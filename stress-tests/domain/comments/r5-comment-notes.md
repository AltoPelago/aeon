# r5 Comment Notes

Target comment forms for current alignment are taken from:

- `specs/03-releases/r5/AEON-spec-r5.md` section 13 (Comments and Annotation Stream)
- `specs/03-releases/r5/AEON-spec-r5.md` section 15 (Grammar)

## Structured channels (line + block)

- `doc`
  - line: `//# ...`
  - block: `/# ... #/`
- `annotation`
  - line: `//@ ...`
  - block: `/@ ... @/`
- `hint`
  - line: `//? ...`
  - block: `/? ... ?/`
- `reserved`
  - structure:
    - line: `//{ ...`
    - block: `/{ ... }/`
  - profile:
    - line: `//[ ...`
    - block: `/[ ... ]/`
  - instructions:
    - line: `//( ...`
    - block: `/( ... )/`

## Non-structured comments

- plain line: `// ...`
- plain block: `/* ... */`
- host directive: `//! ...` (first line only)

## Stress fixture coverage

- `stress-tests/domain/comments/comment-stress-slash-channels.aeon` exercises all channel variants above.
- This fixture is intentionally allowed to fail on current implementation until lexer/parser support is updated.
