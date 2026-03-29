# Security Policy

AEON includes parsing, canonicalization, validation, finalization, and
integrity-related surfaces. Security-sensitive reports should be handled
privately where possible.

## Reporting a vulnerability

- do not open a public GitHub issue for a suspected vulnerability
- prefer GitHub private vulnerability reporting for this repository when it is
  available
- include a minimal reproduction, affected implementation surface, expected
  impact, and any known workarounds

## Good report content

- affected package, crate, or implementation
- exact input or fixture that triggers the issue
- whether the issue affects parsing, canonical bytes, reference handling,
  finalization, signatures, or trust boundaries
- whether the behavior is spec, CTS, or implementation specific

## Scope examples

Security-relevant reports may include:

- trust-boundary violations
- integrity or signing bypasses
- canonicalization mismatches with security impact
- unsafe reference or projection behavior
- denial-of-service vectors such as pathological inputs or unbounded work

## Disclosure

Please allow time for triage and mitigation before public disclosure. Once a
fix or mitigation exists, public documentation can follow in the normal repo
history.
