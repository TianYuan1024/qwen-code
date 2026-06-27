# PR Intake Evidence Gate Design

Status: draft for discussion

## Problem

Qwen triage and review intentionally do not run for ordinary external PR
authors. That protects `pull_request_target` workflows from prompt injection,
token misuse, model spend, and self-hosted runner exposure. The side effect is
that external PRs can skip the normal intake pressure that asks for reviewer
evidence, especially for user-visible CLI/TUI behavior.

The current PR template asks for before/after evidence, screenshots, recordings,
or tmux logs for user-visible changes. That requirement is not enforced before a
maintainer looks at the PR.

## Goal

Add a low-risk intake gate for all PRs, including fork PRs, that detects likely
user-visible changes and asks for missing evidence. The gate should reduce false
negatives more than false positives: asking for extra evidence is acceptable,
missing a PR that needs evidence is not.

## Non-goals

- Do not run full triage, review, or tmux testing for untrusted PR authors.
- Do not execute PR code: no install, build, test, scripts, or tmux session.
- Do not check out the PR head as a working tree.
- Do not post model-generated prose directly to GitHub.
- Do not decide whether the implementation is correct.

## Proposed Approach

Create a separate PR intake workflow that runs on `pull_request_target` for PR
open, edit, synchronize, and ready-for-review events. It runs on
`ubuntu-latest`, not ECS.

The workflow gathers PR text and code through GitHub APIs, without executing
the PR:

- PR title and body.
- Changed file list.
- Patch diff from the GitHub API.
- Capped base/head source snippets for changed files when the patch is too
  small, truncated, or ambiguous.
- Template sections relevant to reviewer evidence.

It then calls a constrained model classifier. The classifier receives the PR
metadata and diff and returns strict JSON only:

```json
{
  "evidence_required": true,
  "missing_evidence": true,
  "confidence": "medium",
  "reason_codes": ["cli_tui_behavior", "live_output_change"]
}
```

The model has no tools and no GitHub token. A deterministic script parses the
JSON and decides whether to post or update a fixed maintainer-authored comment.

## Safety Boundary

The model is allowed to classify, not act. It cannot run shell commands, call
`gh`, modify labels, or write comments. The workflow script owns all GitHub
side effects.

The workflow should:

- Use `permissions: contents: read, pull-requests: read, issues: write`.
- Read PR code through API-provided patches and capped source snippets.
- Avoid checking out PR head code as a working tree.
- Never run PR-controlled code or package lifecycle scripts.
- Treat PR text and diff as untrusted input.
- Pass untrusted input via files or JSON, not shell interpolation.
- Use a fixed marker comment such as `<!-- qwen-pr-intake:evidence -->`.
- Use fixed reason-code wording, not model-authored free-form text.

## Decision Policy

The gate should bias toward asking for evidence:

- `evidence_required: true` and `missing_evidence: true` -> post/update comment.
- `confidence` is not `high` -> post/update comment.
- Model output is invalid JSON -> post/update comment.
- Diff is unavailable or truncated -> post/update comment.
- PR claims `N/A` evidence but classifier is not high-confidence that the
  change is non-user-visible -> post/update comment.

The workflow should not fail CI at first. It should leave a visible comment that
maintainers can treat as an intake blocker during review.

## Comment Behavior

The comment should be stable and short:

- Explain that the PR appears to affect user-visible CLI/TUI behavior.
- Ask for before/after screenshots, a short recording, or tmux capture output.
- Point to the `Reviewer Test Plan` / `Evidence (Before & After)` section.
- Mention that false positives are acceptable and the author can explain why
  evidence is not applicable.

When the PR body is updated and evidence is present, the workflow should update
the marker comment to resolved text or delete it if deletion is preferred.

## Runner Choice

Use GitHub-hosted `ubuntu-latest`.

This workflow is lightweight and handles untrusted PR text. It does not need the
self-hosted ECS pool, and keeping it hosted avoids persistent-runner state risk.
If model access later requires a private network, use a separate isolated runner
rather than the current review/tmux ECS pool.

## Ponytail Defaults

These defaults keep the first implementation small and reversible.

### Model endpoint

Use the existing PR review model settings:

- `secrets.REVIEW_OPENAI_API_KEY`
- `secrets.REVIEW_OPENAI_BASE_URL`
- `vars.QWEN_PR_REVIEW_MODEL`

Do not add new secrets, vars, model routing, or a model-selection UI for the
first version. This is a PR-review-adjacent classifier, so the existing review
model is the least new machinery.

### GitHub side effects

Comment only. Do not add or remove labels in v1.

Labels introduce lifecycle questions: when to apply, when to clear, how to avoid
conflicting with maintainer labels, and how to coordinate with existing triage
labels. A marker comment is enough for intake pressure.

### Draft PRs

Skip draft PRs. Run on `ready_for_review`, `opened`, `edited`, and
`synchronize` when the PR is not draft.

Drafts are explicitly not ready for maintainer intake, so commenting on missing
evidence there is noise.

### Resolved comments

If a marker comment exists and the latest PR body now has enough evidence,
delete the marker comment. Do not leave a "resolved" bot comment.

The desired state is simple: no problem, no bot comment.

### Sufficient evidence for v1

Accept one of these in the `Evidence (Before & After)` section:

- Markdown image or HTML image.
- GitHub-uploaded attachment link.
- Video link or attachment (`.mp4`, `.mov`, `.webm`) or an asciinema link.
- A fenced code block with real terminal output, such as tmux capture output,
  before/after command output, or a short interactive transcript.
- `N/A`, but only when the classifier is high-confidence that the change is not
  user-visible.

Everything else is treated as missing evidence for user-visible or uncertain
changes.

### Failure behavior

If the classifier cannot return valid JSON, the diff/source snippets are
truncated beyond the configured cap, or confidence is not `high`, request
evidence with a fixed comment. This intentionally trades false positives for
fewer false negatives.
