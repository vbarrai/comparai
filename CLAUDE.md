# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`comparai` is an npm CLI that tests Claude Code skills. For each `_test.yml`, it runs a duel between two versions of a skill directory: **A** (by default the working copy) vs **B** (by default the same directory on the main branch). The judge is Jev (`typesafe-ai/jev`, through Vercel AI Gateway and the AI SDK's `experimental_evaluate`). Skills are never executed: Jev reads their instructions. The README documents the YAML format, the statuses and how to read results from the user's side.

## Commands

```bash
npm test                                        # node --test test/*.test.ts (fake Jev, no network)
node --test --test-name-pattern="<name>" test/duel.test.ts   # a single test
npm run typecheck                               # tsc --noEmit (src + test)
npm run comparai -- <path>                      # CLI from sources; really calls Jev
npm run build                                   # tsc -p tsconfig.build.json → dist/ (also run by prepare)
```

Running the real CLI requires `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`), read from the shell, then `.env.local`, then `.env` (`process.loadEnvFile`, which does not override the shell).

## TypeScript without a dev build

Node ≥ 22 runs `.ts` files directly (type stripping); `tsc` is only used to typecheck and to produce `dist/` for publishing. Consequences:

- Relative imports carry the `.ts` extension (`./config.ts`); `rewriteRelativeImportExtensions` rewrites it to `.js` at build time.
- `erasableSyntaxOnly` and `verbatimModuleSyntax`: no `enum`, `namespace` or parameter properties; type imports use `import type` / `type X`.

## Architecture

The flow goes `cli.ts` → `config.ts` (loading) → `duel.ts` (orchestration) → `jev.ts` (model call).

- **`config.ts`** resolves each side of the duel into a `SkillSource` (`local` with an optional git `ref`, or `github`), then into a `Skill` = list of text files. `buildSkill` is the filter shared by the three sources (disk, `git ls-tree`/`git show`, GitHub API): `SKILL.md` is required and placed first, hidden files/directories and binaries are skipped, and the test file itself is excluded if it sits in the skill directory. The sentinel revision `MAIN_BRANCH` (`@main-branch`) is resolved lazily by `mainBranch()` (`origin`'s HEAD, else `main`, else `master`). A directory missing from the revision throws `NotInRevision`, which the CLI turns into the "nouveau" (new) status rather than an error.
- **`jev.ts`** builds the `state` (both skills anonymized as `skill_1`/`skill_2`, names never sent) and, per test, three questions: a 0–4 score (comparison) and two booleans (does each skill meet the requirement). Every question of every test goes out in **a single call**. Guard: ~32,000 tokens max (estimated at 4 characters/token), checked before sending.
- **`duel.ts`** makes two parallel calls with the presentation order swapped to measure position bias, brings both back to B's point of view (`100 - score` for the B→A order) and averages them. A test is `consistent` if both orders land in the same zone (<40, 40–60, >60). `regressions()` = consistent tests with score > 60; an inconsistent test is never a regression. `sameContent()` skips the call when A and B are identical.
- **`cli.ts`** collects the `_test.yml` files (excluding hidden directories and `node_modules`), runs the duels sequentially, prints the gauge and the summary; exit code 1 if there is a regression or an error.

Direction convention everywhere: cursor **0 = A clearly better, 100 = B clearly better**.

## Tests

`test/duel.test.ts` builds its fixtures on the fly (temporary directories, temporary git repos via `execFileSync`) and replaces Jev with `Experimental_EvaluationMockModelV4` from `ai/test`, passed as `runDuel`'s `model` parameter. No test may depend on the network or on examples versioned in the repo.

## Publishing

Pushing a `v*` tag runs `.github/workflows/publish.yml`: tag/`package.json` version check, typecheck, tests, an `npm publish --dry-run` that fails if npm auto-corrects `package.json`, then `npm publish` through trusted publishing (OIDC, no token, automatic provenance).

## Language conventions

- Docs, JSDoc/comments, test names and CI messages are in **English**.
- User-facing strings stay in **French**: CLI output, statuses (`inchangé`, `nouveau`, `ok`, `régression`, `erreur`) and thrown error messages. Some tests assert on these messages with regexes.
- The prompts sent to Jev (`LEVELS`, questions and `note` in `jev.ts`) are in French; changing their wording changes the judge's behavior, so do not translate them casually.
