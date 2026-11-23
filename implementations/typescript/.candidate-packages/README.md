# Historical SANSA development archives

The active0.17.0 preparation now consumes the exact verified SANSA0.15.0-rc.2
registry provider. See[the registry artifact record](../../../docs/releases/sansa-0.15.0-rc.2.json).
The private pnpm override is removed; source archives are not registry provenance.

Earlier development tarballs are removed from the current tracked tree and remain
in Git at`26467ad880837db7adec419f1dcb544e0b30009f`. Their hashes and the previous
selection are retained in[provenance.json](provenance.json). Existing local ignored
copies may remain as cache/evidence; they are not runtime/release inputs. No
historical bytes or Git history are rewritten by this cleanup.

Use normal exact registry pins and frozen consumers for release acceptance.
Independent provider/adoption QA and the final combination's artifact/platform
checks remain required. This archive history grants no reference, mutation or
other capability admission and changes no compatibility or resource budgets.
