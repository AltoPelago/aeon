# Canonical Corpus

Drop valid, real-world `.aeon` documents anywhere below this directory. The
canonical corpus stress test discovers them recursively, formats each document
with the TypeScript, Python, and Rust implementations, and requires all three
commands to succeed with byte-identical canonical output.

When the sibling `aeon-php` checkout is available, add `--php`. This also
requires PHP and TypeScript to emit byte-identical canonical Telex assignment
streams for every valid document:

```bash
npm run test:canonical:corpus:php -- --brief
```

Run the corpus from the repository root:

```bash
npm run test:canonical:corpus
```

To exercise a corpus outside this repository while curating new fixtures:

```bash
python3 ./scripts/stress-canonical-corpus.py --corpus ../path/to/corpus
```

The initial `altopelago-website/` fixtures are snapshots of production content
from the AltoPelago AEON website. Keep source names intact when refreshing the
snapshot so failures remain easy to trace upstream.
