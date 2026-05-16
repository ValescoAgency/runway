---
name: triage
description: Triage one incoming Linear issue end-to-end — grill the spec, decide in-scope vs reject, advance to the agent-ready state on accept, or eject to `.out-of-scope/` with a written rationale on reject. Triggered when the user types `/triage` or asks to "triage an issue". When the issue carries the `runway-meta-promoted` label, additionally load the source meta-review context and surface the IRA's predicted-effect before grilling.
---

# /triage

The runway operator's gate between Linear issues and the agent queue. Every
issue — whether hand-filed by the operator or promoted by the Independent
Review Agent (IRA, VA-400) — passes through this skill before it earns the
`ready-for-agent` label that drains pick up.

Triage has two outcomes:

- **Accept** — the issue is well-scoped, acceptance criteria are
  enumerated, and the change is worth runway's iteration budget. Apply
  the `ready-for-agent` label so the next drain picks it up.
- **Reject** — the issue is out-of-scope, premature, duplicative, or
  the hypothesis is too weak. Cancel the Linear issue *and* drop a
  rationale file into `.out-of-scope/` so the IRA's next Weekly Review
  (VA-408) doesn't re-promote the same theme.

There is no "maybe" state. Issues that need clarification get grilled
until they're ready to accept or reject; nothing sits half-graded.

## Inputs

Before grilling:

1. Read the Linear issue's title, body, labels, and any prior comments.
2. **If the issue carries the `runway-meta-promoted` label** (filed by
   the IRA's Weekly Review per VA-408), load the additional context
   block below before asking the operator anything. The IRA-promoted
   issues are different in kind: they're hypotheses with falsifiable
   predicted effects, sourced from corroborated patterns across many
   prior runs, and the operator should be reading the IRA's reasoning
   *before* grilling on the change itself.

## Grilling protocol

Standard issues:

- Is the problem statement specific enough that a coding agent can
  satisfy it without follow-up clarification?
- Are the acceptance criteria enumerated and individually testable?
- Is the change scope ≤ one agent iteration cycle (rule of thumb:
  fewer than ~5 files touched, no schema migration unless that *is*
  the change)?
- Is there a hidden dependency this issue silently requires? (Blocked
  issues should be filed as blocked, not as Todo.)
- Is the change worth doing *now*, given what else is in the backlog?

The grilling is adversarial but in service of the issue. Push back on
hand-wavy specs; offer concrete rewrites the operator can accept or
counter-edit.

## Special case: `runway-meta-promoted` issues (VA-408 / VA-409 / VA-410)

When the label is present, the issue body carries three machine-
readable markers and two narrative sections that the IRA stamped:

```text
<!-- runway-meta-theme-key: <target>:<fragment>:<sha8> -->
<!-- runway-meta-predicted-effect: <JSON blob> -->

**Target taxonomy**: `prompt` | `workflow` | `sandcastle` | `issue-body` | `tooling`
**Category**: `Bug` | `Feature` | `Improvement`
**Source meta-reviews**: [VA-1001](url), [VA-1002](url), …

## Change
…operator-facing change spec…

## Acceptance criteria
- [ ] …testable criterion…

## Predicted effect

> **Claim**: <falsifiable prediction>
> **Minimum sample size**: n ≥ <N> <sample description>
```

Before grilling these issues, do the following — in order, no skipping:

### 1. Read the source meta-reviews

Parse the `**Source meta-reviews**` line from the issue body. Each
entry is a Linear identifier (e.g. `VA-1001`) corresponding to a Run
Review in the `runway-meta` project. Open each source meta-review and
read the IRA's grading + recommendation that corroborated this theme.

If `**Source meta-reviews**` is absent (legacy or hand-edited body),
note that and proceed without the source context. The theme is still
graded on its own merits.

### 2. Surface the predicted-effect explicitly

Read the `## Predicted effect` section out of the body verbatim. If
the `<!-- runway-meta-predicted-effect: -->` marker is also present,
parse its JSON for the structured `attribution` block (metric +
direction + threshold + baseline). Surface ALL of this to the operator
*before* asking any grilling questions:

> The IRA predicts this change will produce:
>
> > **Claim**: <verbatim claim text>
> >
> > **Minimum sample size**: n ≥ <N> <sample description>
>
> Structured attribution (when present):
> - metric: `<metric_name>`
> - direction: `<decrease|increase>`
> - baseline: `<baseline_value>`
> - threshold: `<threshold_value>`
>
> The next Weekly Review will grade this against post-ship metrics.
> Is this prediction worth committing the workspace to? Push back if
> the claim is too vague, the sample size too small, or the predicted
> effect doesn't justify the cost of the change.

Operators should treat the predicted effect as the load-bearing
artifact. A `runway-meta-promoted` issue with a weak prediction is a
weak issue *regardless* of how well-written the change spec is — the
whole point of the attribution loop (VA-409) is to hold the IRA
accountable for its hypotheses. If the prediction is unfalsifiable, push
back to the IRA at triage time by ejecting (see Rejection path) rather
than accepting a claim you can't grade.

### 3. Grill normally, but with the extra context

After steps 1–2, run the standard grilling protocol from above. The
source meta-reviews + predicted effect become part of the operator's
information when deciding to accept or reject.

## Acceptance path

When accepting:

1. Apply the `ready-for-agent` label to the Linear issue.
2. For IRA-promoted issues: do NOT remove the `runway-meta-promoted`
   label — it stays through to the issue's terminal state. The
   attribution loop (VA-409) reads it back when the issue moves to
   Done.
3. Leave a one-sentence acceptance comment on the issue noting the
   triage outcome (operator vibes + key context, not a re-write of the
   spec).

## Rejection path

When rejecting:

1. Cancel the Linear issue (set state to `canceled`, not `archived` —
   archived hides the row from the open-promoted-queue scan, but a
   cancelled state explicitly marks it as decided-against).
2. **Write a markdown file to `.out-of-scope/`** capturing the
   rejection rationale. Filename should be terse and unique
   (`reject-<theme-key-or-short-slug>.md`). Body should be plain prose
   explaining *why* this theme is out of scope — substring-matching
   against the IRA's next promoter pass is fuzzy (see
   `src/meta/out-of-scope.ts`), so wording overlap with the rejected
   theme matters more than fancy structure.
3. Add a Linear comment that mirrors the rationale so anyone scanning
   the issue understands the call.

The `.out-of-scope/*.md` files are the **only** mechanism the IRA has
to learn from operator rejections. The Weekly Review's promoter
(VA-408) substring-matches new themes against every rationale before
ranking — re-promotion of a rejected theme is the failure mode this
guards against. Be specific in your rejection text.

## Provenance

This skill governs operator-side triage decisions. The IRA writes the
inputs (Linear issues + source meta-reviews); the operator runs this
skill to decide what's worth runway's time. The IRA never auto-accepts
its own promotions — operator gates novelty (VA-400 PRD, "out of
scope: closed-loop self-modification").

## See also

- `src/meta/passes/weekly-review.ts` — the IRA pass that emits
  `runway-meta-promoted` issues and stamps the body markers.
- `src/meta/out-of-scope.ts` — the reader that turns `.out-of-scope/*.md`
  into the promoter's rejection filter.
- `src/meta/attribution.ts` — parses the predicted-effect marker back
  out of shipped-promotion bodies for VA-409's *What we shipped*
  verdicts.
- `src/meta/templates.ts` — the `RUNWAY_META_THEME_KEY_MARKER` and
  `RUNWAY_META_PREDICTED_EFFECT_MARKER` constants, plus the
  `Promotion` / `PredictedEffect` schemas.
- VA-400 (parent PRD), VA-408 (Weekly Review + promoter), VA-409
  (attribution loop), VA-410 (this skill).
