# AGENTS.md

## 1. Project overview

This repository is a Node.js Cordis plugin implementing policy-based auto-approval. It is written in JavaScript and managed with pnpm.

Source code lives in `src/`:
- `src/client.js` — client module
- `src/policy.js` — policy module
- `src/records.js` — records module
- `src/index.js` — plugin entrypoint

Tests live in `tests/` and use Vitest. Vitest configuration is in `vitest.config.js`, and the test environment setup is in `tests/setup-env.js`.

Documentation and supporting files include `README.md`, `README.zh.md`, `docs/`, `prompts/review.md`, `prompts/rule.md`, `cordis.patch.yml`, `debug.log`, `screenshots.json`, and `LICENSE`.

## 2. Build and test commands

- Package manager: pnpm, using `pnpm-lock.yaml`.
- Install dependencies: `pnpm install`.
- Test runner: Vitest, configured by `vitest.config.js`.
- Run all tests: `pnpm vitest run`, or the equivalent test script defined in `package.json`.
- Run tests in watch mode: `pnpm vitest`.
- Run a single test file: `pnpm vitest run tests/<name>.spec.js`.
- No dedicated build tool is listed in the repository structure. Do not add build steps or change package scripts without checking `package.json` and the existing Vitest setup.

## 3. Code style guidelines

- Use JavaScript and preserve the existing Cordis plugin structure.
- Keep `client`, `policy`, and `records` responsibilities separated. The plugin entrypoint is `src/index.js`.
- Follow the module format, export style, indentation, and naming already used in `src/`.
- Test files use the `*.spec.js` suffix and live in `tests/`.
- Prefer small, focused changes. Do not reformat unrelated code.
- No linter or formatter configuration is present in the listed repository structure. Do not introduce new linting or formatting tooling unless the task explicitly requires it.
- Keep documentation current when behavior, commands, or structure changes.
- Consult `prompts/review.md` and `prompts/rule.md` when working on review or rule-related behavior.

## 4. Testing instructions

- Tests use Vitest and live in `tests/`.
- Run the full test suite before finishing a task.
- Add or update tests for any behavior change, especially policy decisions, client behavior, and record handling.
- Place new tests in the appropriate `tests/*.spec.js` file, or create a new spec following the existing naming pattern.
- `tests/setup-env.js` is part of the Vitest setup. Do not bypass or delete it.
- Run targeted tests while iterating, then run the full suite.
- If tests cannot be run, state exactly what was not run and why.

## 5. Security considerations

- This plugin implements policy-based auto-approval, so approval decisions, policy evaluation, and record storage are security-sensitive.
- Do not weaken or bypass policy checks. Preserve existing gate semantics unless the task explicitly requires a change.
- Keep approval records accurate and auditable. Do not silently drop, rewrite, or fabricate records.
- Treat `debug.log`, `screenshots.json`, and any runtime or client data as potentially sensitive. Do not commit secrets, tokens, credentials, or private user data.
- Avoid logging sensitive values. Preserve any existing input or output sanitization.
- Review changes to `src/client.js`, `src/policy.js`, `src/records.js`, and `src/index.js` with extra care because they affect the approval pipeline.

## 6. AI agent guidelines

- Read this `AGENTS.md` before making changes.
- Inspect `package.json`, `vitest.config.js`, and the relevant `src/` and `tests/` files before assuming commands or conventions.
- Do not invent APIs, files, scripts, dependencies, or configuration. If something is unclear, check the repository.
- Keep changes minimal and scoped to the task. Follow existing module boundaries and test patterns.
- Run the relevant tests and, when possible, the full test suite.
- Update documentation when behavior, commands, or structure changes.
- After completing every task, review this `AGENTS.md` and correct it if the repository structure, commands, conventions, security notes, or testing instructions have changed. Keep it accurate as the project evolves.