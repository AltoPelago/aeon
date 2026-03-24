Publish instructions for @aeon/annotation-cts-runner

1. Verify Node >= 20 is active.
2. From repository root or package folder run:

```bash
cd implementations/typescript/tools/annotation-cts-runner
pnpm install
pnpm run typecheck
pnpm run build
```

3. Confirm `dist/index.js` and types exist.
4. Bump `version` in `package.json` and commit with changelog entry.
5. Tag and push:

```bash
git tag -a vX.Y.Z -m "release annotation-cts-runner vX.Y.Z"
git push --tags
```

6. Publish with pnpm (or your preferred registry automation):

```bash
pnpm publish --access public
```

If you use a scoped private registry, adjust `--access` accordingly.
