# AltoPelago Website Corpus

These fixtures were copied from `AltoPelago/aeon-website/content` at commit
`9c2e1479652a634b67cd2f8733a739cac732b0f3` on 8 September 2026.

This initial positive corpus contains the 27 website documents that all three
canonical formatters accept and render identically. The following website
documents exposed pre-existing parser or canonicalization differences during
import and remain pending until those differences are resolved:

- `developer-start.aeon`
- `language.aeon`
- `orthogonal-composition.aeon`
- `playground.aeon`
- `templating.aeon`
- `value-types.aeon`
- `walkthrough-advanced.aeon`
- `walkthrough.aeon`

Keeping pending documents out of the positive corpus ensures the lane remains
a regression gate. They should be added as their cross-implementation behavior
is aligned.
