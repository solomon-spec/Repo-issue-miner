# repo-issue-miner

A GitHub miner with a web dashboard that finds merged bug-fix PRs, keeps only PRs with verified closed issue links, checks that the change is non-trivial for Python, JavaScript, or TypeScript, then validates the pre-fix snapshot by building it in Docker.

## What it does

The scan pipeline is strict on purpose:

1. Search public GitHub repos by language and activity.
   - prefer non-fork, non-mirror, non-template repos
   - cap repo size up front using GitHub search qualifiers
   - try README matches for Docker and testing hints before falling back to a broader search
2. Screen each repo for:
   - Python, JavaScript, or TypeScript
   - standard package manager manifests
   - tests
   - Dockerfile
   - English-looking README
   - README build/test hints
3. Search merged PRs or start from closed issues with linked merged PRs.
4. Reject PRs that do not touch at least 5 relevant source files for the target language.
5. Reject PRs that do not have a verified closed GitHub issue link.
6. Check out the PR base SHA.
7. Infer a safe Docker build plan.
   - deterministic first
   - Gemini fallback second
8. Build the repo in Docker.
9. Save a manual repro block with the inferred Docker command and suggested test plan.
10. Emit a JSON report with accepted and rejected candidates and store results in the dashboard database.

## Issue-link policy

A PR is accepted only if GitHub shows at least one closed linked issue for it.

Accepted in practice:
- PRs returned by `linked:issue`
- issues returned by `linked:pr`
- GitHub-native PR fields like `closingIssuesReferences`

Rejected in practice:
- open issues
- plain `#123` mentions that are not real GitHub links
- references that resolve to another PR instead of an issue

## Docker-plan policy

The tool does not let Gemini invent arbitrary shell strings, and the web app does not run the repo test suite automatically.

It uses this order:
1. deterministic Docker and Compose detection from repo files
2. Gemini structured JSON fallback
3. allow-list validation
4. Docker build validation

The inferred test command is still saved in the manual repro text so you can run it yourself if you want.

Allowed command families:
- `pytest`
- `python -m pytest`
- `tox`
- `nox`
- `npm test`
- `pnpm test`
- `yarn test`
- `bun test`
- `jest`
- `vitest`
- `mocha`
- `make test`

## Project layout

```text
src/
  config.ts         CLI and env config
  docker.ts         Docker and Compose execution
  gemini.ts         deterministic + Gemini test-plan inference
  git.ts            checkout and snapshot prep
  github.ts         GitHub GraphQL + REST client
  index.ts          CLI entrypoint
  parsing.ts        issue parsing and PR non-triviality scoring
  pipeline.ts       end-to-end scan pipeline
  repo-screen.ts    repo validity checks
  types.ts          shared types
  util.ts           helpers
```

## Requirements

- Node 22+
- npm
- git
- Docker with `buildx`
- optional Gemini API key
- recommended GitHub token

## Setup

```bash
cp .env.example .env
npm install
npm run build
```

Edit `.env` before you run the app.

Minimal `.env` example:

```bash
GITHUB_TOKEN=ghp_your_token_here
GEMINI_API_KEY=your_gemini_key_here
PORT=3000
SCAN_MODE=issue-first
```

Gemini is optional. Without it, the tool only uses deterministic test-plan inference.

Important env vars:
- `GITHUB_TOKEN`: strongly recommended for GitHub search and repo metadata
- `GEMINI_API_KEY`: optional Gemini fallback for Docker-plan inference
- `PORT`: dashboard port, default `3000`
- `SCAN_MODE`: `issue-first` or `pr-first`
- `TARGET_REPO`: optional default `owner/name` deep-scan target
- `REPO_CONCURRENCY`: how many repos to process in parallel during a normal scan
- `DB_PATH`, `OUTPUT_ROOT`, `WORK_ROOT`: storage and temp-work locations

## Run The Web App

Build once, then start the dashboard:

```bash
npm install
npm run build
npm run serve
```

Open:

```text
http://localhost:3000
```

Useful commands:
- `npm run serve`: start the web app
- `npm run dev`: rebuild, then start the web app
- `npm run scan`: run a CLI scan directly

## CLI Usage

```bash
npm run build
node dist/index.js scan \
  --languages python,typescript \
  --repo-limit 10 \
  --repo-concurrency 2 \
  --pr-limit 15 \
  --min-stars 100 \
  --merged-after 2024-01-01 \
  --scan-mode issue-first \
  --target-repo owner/name \
  --output-root ./output
```

Dry-run mode skips Docker build validation but still mines and scores candidates:

```bash
node dist/index.js scan --dry-run
```

## Output

Each scan writes a JSON report to `output/scan-<timestamp>.json`.

Accepted entries include:
- repo metadata
- PR metadata
- verified linked issues
- changed-file analysis
- pre-fix SHA
- inferred Docker plan
- Docker execution result
- log file paths
- manual repro text context

Rejected entries include the same context plus rejection reasons.

## Notes and limitations

- GitHub GraphQL search is used for repo and PR discovery, so a GitHub token is strongly recommended.
- The issue-link check is intentionally strict and now prefers GitHub-native linked issues only.
- The repo-size check is done on the checked-out pre-fix snapshot, not just on GitHub metadata.
- Docker build success is required for final acceptance unless you run `--dry-run`.
- The app checks that tests exist in the repo, but it does not run those tests for you in-app.
- Compose service selection is basic in this version. Gemini can help, but the validator still enforces a narrow safe command set.
- This version assumes the repo's Dockerfile is sufficient for pre-fix execution. Multi-service repos with databases or extra infrastructure may still be rejected.
- Very large repos may need a deep-scan fallback checkout if GitHub's recursive tree API terminates early.

