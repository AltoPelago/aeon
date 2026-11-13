# Local SANSA development candidate

The workspace override pins the reviewed SANSA `e21278c` archive until official
release coordination. Package manifests retain the intended `0.15.0-rc.1`
dependency; this local install does not assert that the registry has these bytes.

The exact reviewed archive is retained on the integration branch, so a checkout
can verify it and install directly from `implementations/typescript`:

```sh
node tools/stage-sansa-candidate.mjs
pnpm install --offline --frozen-lockfile --ignore-scripts
```

Use the workspace's pinned pnpm 10.34.4. Running the helper without an argument
verifies the staged archive. It refuses different bytes; it never fetches,
publishes, repacks or silently substitutes another candidate.

SHA-256: `b403acd70ca3349e53041f46af63eecd781e5b7337d22a67d77706138eb4d59e`.
Only this reviewed archive is versioned; other tarballs remain ignored. The
staging helper can also restore it from the retained readiness archive after
checking its checksum. Release preparation must remove the override/archive and qualify actual final
registry versions/integrities, rather than reusing the local archive's checksum
as a registry claim. Official releases and deployment remain on hold.
