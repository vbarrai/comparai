# comparai

Tests for your Claude Code skills, vitest-style. You describe in a `_test.yml` what a skill must do. On every change, `comparai` checks that the new version does no worse than the one on the main branch.

The judge is **[Jev](https://vercel.com/ai-gateway/models/jev)** (`typesafe-ai/jev`, TypeSafe AI). It does not generate text: it returns typed answers (score, boolean) in under a second, for $0.042 per million input tokens. Skills are **not executed**: Jev reads their instructions and estimates which of the two versions best leads an agent to meet each requirement.

## Installation

In the repo that holds your skills:

```bash
npm install -D comparai
echo "AI_GATEWAY_API_KEY=vck_…" >> .env.local   # Vercel AI Gateway key; remember to git-ignore .env.local
```

Node.js ≥ 22 is required. The key is read from the shell (takes precedence), then `.env.local`, then `.env`.

## Writing a test

Add a `_test.yml` to the skill's directory:

```
skills/
  collaborai-pr/
    SKILL.md
    _test.yml
```

```yaml
# skills/collaborai-pr/_test.yml
tests:
  - The skill runs the project checks (lint, typecheck, tests, build) before opening the PR
  - The skill asks for the user's approval before pushing
  - The skill stops if the working tree is clean (nothing to ship)
```

Each test is a requirement. The duel compares **A = the directory as it is** (working copy) with **B = the same directory on the main branch**. The main branch is the default branch of `origin`, else `main`, else `master`. The `_test.yml` is never sent to Jev.

## Running the tests

```bash
npx comparai                     # every _test.yml in the repo (excluding node_modules and hidden directories)
npx comparai skills/x            # under a directory
npx comparai skills/x/_test.yml  # a single file
```

Or in `package.json`: `"scripts": { "test:skills": "comparai" }`.

The CLI output is in French:

```
skills/collaborai-pr/_test.yml
  A = collaborai-pr · B = collaborai-pr#main

  Score 63.3/100  B meilleur
  3. The skill stops if the working tree is clean (nothing to ship)
      87.6  A ──────────┼──────●── B  respecté : A 50 % · B 96.5 %
            A→B 99 · B→A 76.3

Récapitulatif
  ✗ régression skills/collaborai-pr/_test.yml  B meilleur sur le(s) test(s) 3
```

| Status | Meaning | Calls Jev |
|---|---|---|
| ✓ **inchangé** (unchanged) | Content identical to the main branch | no |
| • **nouveau** (new) | The skill does not exist on the main branch yet | no |
| ✓ **ok** | No regression | yes (2 calls) |
| ✗ **régression** (regression) | The main branch wins at least one test, clearly (cursor > 60) and in both orders | yes (2 calls) |
| ✗ **erreur** (error) | Invalid YAML, branch not found, network error… | — |

The exit code is 1 if there is a regression or an error.

## In CI (GitHub Actions)

The default checkout only fetches the branch under test: the main branch must be fetched as well.

```yaml
# .github/workflows/skills.yml
name: skills
on: pull_request
jobs:
  comparai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: git fetch --depth=1 origin main:refs/remotes/origin/main
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx comparai
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
```

## Reading the result

Jev is queried twice, in parallel: once with A presented first, once with B. Each call sends the content of both versions under neutral names and asks three questions per test:

- which one best meets the requirement: a score from 0 to 4, converted to a cursor from 0 to 100;
- does each version meet it? (one probability per version).

| Element | Meaning |
|---|---|
| **Cursor** | 0 = A clearly better, 50 = tie, 100 = B clearly better. It is the mean of both orders. The overall score is the mean over tests. |
| **respecté** (met) | Probability, according to Jev, that each version meets the test. If both are below 50 %, a cursor close to 50 means "both fail". |
| **A→B / B→A** | Cursor obtained in each presentation order. Only the order changes, so both should be close. |
| **⚠ non fiable** (unreliable) | The two orders do not land on the same side (below 40, between 40 and 60, above 60): the cursor reflects the order, not the content. An unreliable test is never counted as a regression. |

## Writing good tests

Left to itself, Jev judges the overall impression. A better-structured version is seen as better everywhere, even on a requirement it does not meet. Phrase **facts that can be checked in the skill's text** ("the exact word "fix" appears in the allowed labels") rather than conditional rules ("if it's a bug, the label must be fix").

## Comparing any two skills

`skill-a` and `skill-b` can be set explicitly, and the file can then have any name (`npx comparai my-duel.yaml`):

```yaml
skill-a: ./skills/labeler-v2                                    # local directory, relative to the YAML
skill-b: vbarrai/config-provider-official/skills/collaborai-pr  # GitHub: owner/repo/path
tests:
  - …
```

| Reference | Meaning |
|---|---|
| `.`, `./x`, `../x`, `/x` | local directory, relative to the YAML, in its current state |
| `./x#rev` | local directory as it is in git revision `rev` (branch, tag, commit) |
| `owner/repo/path` | directory on GitHub, on the default branch |
| `owner/repo/path#rev` | directory on GitHub, at revision `rev` |

For a private GitHub repo, or to go beyond the limit of 60 calls per hour, set `GITHUB_TOKEN` (for example `GITHUB_TOKEN=$(gh auth token)`).

## Limitations

- Jev evaluates instructions, not an agent's actual behavior.
- 32,000 tokens at most for both versions combined: beyond that, the call is refused before sending.
- `experimental_evaluate` is an experimental AI SDK API.

## Development

```
src/cli.ts      entry point: finds _test.yml files, statuses, output
src/config.ts   reads the YAML and the skills (disk, git revision, GitHub)
src/jev.ts      state, questions, call to Jev
src/duel.ts     both orders, cursor, consistency, regressions
test/           tests with a fake Jev (no network)
```

```bash
npm test && npm run typecheck
npm run comparai -- <path>   # runs the CLI from sources
npm pack                     # builds into dist/ then creates the tarball
```

### Publishing

Pushing a `v<version>` tag publishes the package to npm (`.github/workflows/publish.yml`), after typecheck and tests. The tag must match the `package.json` version:

```bash
npm version patch        # or minor / major: updates package.json, commits and tags
git push --follow-tags
```

Publishing goes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token). On npmjs.com, in the package settings, declare the GitHub Actions trusted publisher: repository `vbarrai/comparai`, workflow `publish.yml`.
