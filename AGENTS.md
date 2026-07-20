# Geulbat Public Repository Working Rules

## Repository role

- This is a generated, sanitized, runnable public snapshot licensed under MIT.
- The public remote keeps only the `main` branch.
- Private/local source remains the development, review, and merge source of truth.
- Fixes flow one way: private/local source -> sanitized export -> public `main`.
- Never add credentials, personal data, private history, private audit output, or local-machine paths.

## Environment and startup

- Use Node.js 24 or newer and install from the lockfile with `npm ci`.
- Start `npm run dev -w apps/daemon` and `npm run dev -w apps/web-shell` in separate terminals.
- Provider credentials are supplied by each user and remain local to that machine.

## Change workflow

1. Inspect current code, tests, static imports, and the relevant current-truth document before changing behavior.
2. Keep changes scoped to one coherent capability or bug fix; keep its code, tests, and current-truth documentation together.
3. Prefer real store, file, route, process, and integration boundaries. Use mocks only when the real boundary cannot prove the contract.
4. Do not hide canonical-path failures with silent fallback, weaken tests to make them pass, or introduce unexplained product limits.
5. Reuse existing owners and import seams before adding helpers, wrappers, files, or aliases.

## Required verification

For source, config, test, or generated-runtime changes:

1. `npm run format:check`
2. `npm run lint`
3. Run every affected workspace check:
   - `npm run check -w apps/daemon`
   - `npm run check -w apps/web-shell`
   - `npm run check -w packages/agent-loop`
   - `npm run check -w packages/artifact-runtime-policy`
   - `npm run check -w packages/content-identity`
   - `npm run check -w packages/protocol`
4. Run focused behavior tests with `GEULBAT_TEST_JOBS=1` where the test runner supports it.
5. Run `git diff --check -- <changed-files...>`.

For Markdown-only changes, run Oxfmt on the changed documents, `npm run check:docs-current-truth` when current-truth documents change, and `git diff --check` on those files.

Run one heavy verification command at a time and wait for its real exit code. A timeout or interrupted command is not a pass.

## Formatting and generated files

- Oxfmt is canonical for code, config, and docs. Prettier is canonical only for `package-lock.json`.
- Apply formatter writes only to explicit changed files; do not run a repository-wide auto-fix.
- When web-shell artifact runtime sources change, run `npm run sync:artifact-runtime-sources -w apps/web-shell` and then the web-shell check.

## Git and publishing safety

- Preserve existing dirty work. Stage explicit paths; do not use `git add -A`, destructive reset/clean, or force-push.
- Keep commits coherent and reviewable. Do not split code from the tests and current-truth updates that prove it.
- Publish only a sanitized, verified snapshot to public `main` with a normal fast-forward update.
- Do not publish temporary export branches or reverse-merge public mirror commits into the source repository.
