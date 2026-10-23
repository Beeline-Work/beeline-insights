# beeline-insights

The memory of the Beeline insights loop. Everything here is aggregate or
redacted: no message text, names, emails or identity IDs.

| Folder | What it holds | Written by |
| --- | --- | --- |
| `snapshots/` | One file per Eastern calendar day: the operator dashboard aggregate (`GET /v1/admin/dashboard`). | `Daily snapshot` workflow, 10:30 UTC with 12:30 UTC backup |
| `insights/` | `latest.json`: errors and feedback by product area, the signup journey and velocity time lost. | Digest run; journey by `npm run build-feed` |
| `experiments/` | One file per experiment: the insight behind it, the change, the prediction, the decision point and the verdict. | Digest run proposes; grading script |
| `reach/` | `latest.json`: ad spend against the cap, content and boost recommendations, per-post results. | Ruby, by hand from YouTube Studio and X screens |
| `digests/` | One Markdown file per digest sent to the owner, plus `index.json`. | Digest run; index by `npm run build-feed` |
| `feed/` | `latest.json`: the Insights, Experiments, Reach and Digests feed for the dashboard. | `npm run build-feed` |
| `schemas/` | JSON Schemas for the files above. | By hand; a field change breaks the dashboard |
| `loop/` | [Daily headline feed](loop/README.md): headline values and normal ranges. | `Daily snapshot` workflow |
| `problems/` | One file per problem: people hurt per day, trend, cause tag and stage. | 10 AM triage |
| `walk/` | The fixed codebook of goals and friction codes, plus redacted daily counts. | 6 AM walk |

Git history is the audit trail: it shows how each number and each judgment changed.

## Snapshot

`npm test` checks the script. `npm run snapshot` needs `BEELINE_DASHBOARD_SECRET`
(an Actions secret here; the same value is in the vault as
`beeline-dashboard-api / production`). The workflow also runs on demand from
the Actions tab.

## Insights feed contract

The dashboard reads `feed/latest.json` and fetches one digest body from its
`path` when a person opens it. Every file is checked against `schemas/`; an
unknown field fails. Keep the feed clean: no per-row tags or extra metrics.

| File | Fields |
| --- | --- |
| `insights/latest.json` | `generatedAt`, `window {from, through}`, `errors {total, changePct, areas[{area, count}], lead}`, `feedback {total, people, agents, areas[{area, count}], lead}`, `journey {steps[{label, count}], biggestDrop {label, lost} \| null}`, `velocity {hoursLost, items[{label, hours}]}`, `links[{section, experimentId}]` |
| `experiments/<id>.json` | `id, title, source {section, text}, change, metric {label, numerator, denominator?}, before {value, samples, from, through}, predict {value, direction}, guardrail, decideAt {samples, date}, ifUnclear, status, approval {messageId} \| null, startedOn, progress {value, samples, asOf} \| null, verdict {result, decision, value, samples, on} \| null` |
| `reach/latest.json` | `month, spent, cap, costPerSignup \| null, recommendations[{kind, channel, title, detail}], posts[{title, channel, date, views, clicks, spend, status}]` |
| `digests/<YYYY-MM-DD>.md` | Front matter `title`, `findings`, `proposals`, then the digest text. |
| `digests/index.json` | `[{date, title, findings, proposals, path}]`, newest first. |
| `feed/latest.json` | `{generatedAt, insights, experiments[], reach, digests[]}`. `insights` and `reach` are `null` until their files exist. Experiments are sorted proposed, running, concluded. |

`test/fixtures/v3/` holds a complete example tree with the placeholders from
dashboard mock v3, including the built `feed/latest.json`.

Rules the validator enforces beyond the schemas:

- An experiment is `proposed` until the owner approves it. `running` and
  `concluded` need a nonempty `approval.messageId` and `startedOn`.
- `decideAt.samples` is at least 10. A verdict below it is `not_enough_data`,
  and its decision is `ifUnclear`. `supported` keeps the change; `not_supported` undoes it.
- `metric.numerator` and `metric.denominator` are snapshot series (`dau`,
  `downloads`, `firstReply`, `friendsJoined`, `signups`, `wau`, `workspaces`) or
  name their source, for example `feedback:returning-reporters`. Rates are fractions.
- Aggregate only: emails, `@handles` and long identifiers fail in insights,
  experiments, reach and digests.
- `feedback.total` is `people + agents`; area counts and velocity items do not
  exceed their totals; every `links[].experimentId` names an experiment file.
- The journey equals the people funnel in the newest snapshot (signed up, joined
  a workspace, messaged their free agent, free agent replied). `biggestDrop` is
  the step with the largest loss.

### Daily digest run

1. Write `insights/latest.json` from that day's Sentry, feedback and velocity
   reads. Leads and area counts come from the same run; `generatedAt` shows staleness.
2. Propose experiments as `experiments/<id>.json` with `status: "proposed"`.
   Experiments are for distinct changes with an uncertain payoff, not small fixes.
   After the owner approves, set `status: "running"`, `approval.messageId` and `startedOn`.
   For metrics that are not snapshot series, update `progress` and `verdict` by hand.
3. Save the sent digest as `digests/<date>.md`.
4. Run `npm run build-feed`, then `npm run validate`, and commit.

`npm run build-feed` refreshes the journey, the digest index and the feed. It
validates everything first and writes nothing when any file is invalid.
`npm run validate` also fails when a built file is stale. CI runs it on every
pull request and push to `main`. Both accept `--root <directory>` and `--today YYYY-MM-DD`.

### Grading

```sh
npm run grade-experiments
npm run grade-experiments -- --write
```

For each running experiment whose metric is a snapshot series, the script
measures the window from `startedOn` through today (or `decideAt.date`) with the
shared metrics function and saves `progress`. When samples reach
`decideAt.samples`, or on `decideAt.date`, it concludes the experiment with a
verdict. Missing or stale data leaves the file unchanged. All files are
validated before any write. `--experiments` and `--snapshots` override the input directories.

### Reach

Ruby reads YouTube Studio and X while the owner is signed in, by browser share
or Trusty Squire, and writes `reach/latest.json` by hand. No API credentials or
workflows call YouTube or X. Recommendations are proposals only; the owner
approves every post, boost and dollar before anything goes out.

## Daily headline metrics

```sh
npm run metrics
npm run metrics -- --today 2026-09-02 --snapshots snapshots
```

The JSON covers `firstReply/signups`, `signups`, `dau`, `wau` and `retention7`.
Each includes today's `value`, `samples`, `normal` (low, high, median and MAD),
`historySamples`, `outside` and `flags`. Series values come from the newest
eligible snapshot. A missing date stays missing; a stale snapshot is never
relabeled as today. Values are as of snapshot capture, so today's counts may be
partial.

Normal ranges use median plus or minus twice the median absolute deviation
over the prior 28 calendar days, excluding today; the lower bound is clamped to
zero. A zero MAD gives a zero-width range. Valid historical count days include
zeros, avoiding a bias toward busy days. Historical rates need at least ten
denominator samples. Today's sample below ten, an unavailable value or fewer
than seven usable historical observations adds a flag and makes `outside`
false. Consumers must check `flags`; false with flags is not evidence of normal
behavior. These conservative thresholds are exported in the result.

Retention is `retained / cohort` from measured day-seven aggregates. Its sample
size is the cohort, and `from`/`through` identify its cohort window. It has no
daily series, so the script reads snapshots from the previous 28 days. Repeated
cohort windows count once, using their latest observation; today's cohort window
is excluded from history. A new archive can therefore report insufficient
retention history until enough distinct windows exist.

## Tests and CI

`npm test` runs the built-in Node test runner, including fixture-driven CLI
demonstrations, contract checks, grading arithmetic and range calculations. The
`Tests` workflow runs it and `npm run validate` on every pull request and push
to `main` with read-only permissions.
