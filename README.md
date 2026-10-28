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
| `feed/` | `latest.json`: the validated dashboard feed, including problems, walk counts and retention. | `npm run build-feed` |
| `retention/` | Optional `latest.json`: measured day-seven cohorts grouped by first agent acquisition. | Aggregate admin data |
| `schemas/` | JSON Schemas for the files above. | By hand; a field change breaks the dashboard |
| `loop/` | [Daily headline feed](loop/README.md): headline values and normal ranges. | `Daily snapshot` workflow |
| `problems/` | One file per problem: people hurt per day, trend, cause tag and stage. | 10 AM triage |
| `walk/` | The fixed codebook of goals and friction codes, plus redacted daily counts. | 6 AM walk |
| `themes/` | One file per underlying weakness, with one tracked number and its daily history. | Daily weakness step; history by `npm run track-themes` |

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
| `insights/latest.json` | `generatedAt`, `window {from, through}`, `errors {total, changePct, areas[{area, count}], lead}`, `feedback {total, people, agents, areas[{area, count}], lead}`, `journey {steps[{label, count}], biggestDrop {label, lost} \| null, state?}`, `velocity {hoursLost, items[{label, hours}]}`, `links[{section, experimentId}]` |
| `experiments/<id>.json` | `id, title, source {section, text}, change, metric {label, numerator, denominator?}, before {value, samples, from, through}, predict {value, direction}, guardrail, decideAt {samples, date}, ifUnclear, status, approval {messageId} \| null, startedOn, progress {value, samples, asOf} \| null, verdict {result, decision, value, samples, on} \| null`, optional `theme` (a theme id) |
| `reach/latest.json` | `month, spent, cap, costPerSignup \| null, recommendations[{kind, channel, title, detail}], posts[{title, channel, date, views, clicks, spend, status}]` |
| `digests/<YYYY-MM-DD>.md` | Front matter `title`, `findings`, `proposals`, then the digest text. |
| `digests/index.json` | `[{date, title, findings, proposals, path}]`, newest first. |
| `feed/latest.json` | `{generatedAt, insights, experiments[], reach, digests[], problems[], walk[], themes[], retention}`. `insights` and `reach` are `null` until their files exist. Experiments are sorted proposed, running, concluded. |

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
- The journey maps the newest snapshot's `periods["7d"].funnel` steps and
  server-selected `biggestDrop` (key mapped to its step label), with `state: "measured"`.
  Without periods, the existing lifetime people funnel is preserved with
  `state: "limited"`; missing counts stay missing. A malformed period funnel
  fails the build rather than silently publishing lifetime numbers as weekly.
  The optional journey state is confined to the journey schema; legacy inputs remain valid.

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

### Ranked problems, walk counts and retention

The feed adds `problems[]` (rank ascending), `walk[]` (newest date first) and
`retention` (null until measured). Existing feed fields keep their meanings.
Legacy feeds without these additions remain schema-valid. New builds always
include the three fields; missing input folders produce empty arrays/null.

- `problems/<id>.json`: `id`, `kind` (`problem` or `regression`), `rank`, `date`,
  `title`, `peoplePerDay`, `trend` (`up`, `flat`, `down`), `cause`, `stage`,
  `source`. A regression also requires `regression {causedByPr, report}`;
  `causedByPr` is the full GitHub pull request URL that caused it.
- `walk/<YYYY-MM-DD>.json`: `date`, `source`, `counts[{goal, friction, count}]`.
  Goals and friction codes are lowercase slugs. Each pair appears once per day;
  counts are anonymous totals, never individual events or message transcripts.
- `retention/latest.json`: `generatedAt`, `source`, `day: 7`,
  `window {from, through}`, overall `cohort` and `retained`,
  `groups {addedOwnAgent, freeAgent, noAgent}`. Each group has
  `cohort` and `retained` counts (retained cannot exceed cohort). Consumers can
  calculate retained/cohort; a zero cohort has no rate. Group cohorts must sum
  to the overall cohort, and group retained counts to the overall retained count.

The build also accepts the same groups from the newest measured snapshot's
`overview.retention.data.byFirstAgentSource`, using that block's `measuredAt`,
`day`, `from`, `through`, `cohort` and `retained`. These server aggregates take precedence over a
manually supplied retention file. A malformed split fails the build. No split
is inferred from the overall retention or the walk; dates identify staleness.

As checked against the live admin endpoint on 2026-10-24, only combined
retention is available. The server follow-up must classify each person's
**earliest agent acquisition** as added-own-agent or free-agent, group the
existing eligible day-seven cohort query by that classification, and return
`byFirstAgentSource: {addedOwnAgent: {cohort, retained}, freeAgent: {cohort, retained}, noAgent: {cohort, retained}}`.
Keep the existing production exclusions, return activity definition and cohort
window. The `noAgent` baseline includes people who have not acquired an agent;
the three groups must cover the complete cohort without double counting. Only aggregates may be stored here. Until that field exists,
the live feed reports `retention: null`.

The register permits at most **10 running experiments**, including during
grading. Validation names each excess experiment file; proposals and concluded
experiments do not consume slots. The morning card must propose retiring one
before seeking approval for a replacement when all slots are occupied.

Verdicts keep their existing wire values for dashboard compatibility:
`supported` means **worked**, `not_supported` means **didn't work**, and
`not_enough_data` means **too little data**. No other verdict is accepted.
After too little data, triage can retire the experiment (`concluded`) or extend
it once: keep it `running`, move `decideAt.date` forward, and add
`extensions: [{previousDate, date, on, result: "not_enough_data"}]`.
`on` must be at or after the original check date, and `date` must equal the new
check date. A second array entry fails. Omitted `extensions` means no extension,
keeping existing records compatible. Preserve the original baseline and
prediction. These are experiment records, never records per autonomous fix.

### Themes

The feed adds `themes[]`: every `themes/<id>.json`, open first, then merged, then
retired. Fields are in [themes/README.md](themes/README.md). Each theme has one
`track {label, unit, source, definition, target {value, direction, by}, history[{date, value, samples}]}`.
`unit` is `share`, `count` or `rate`; shares and rates are fractions. History is
one point per Eastern day, oldest first; `value` is null only when `samples` is 0.
`target` is the theme's claim as a number: while the weakness stands, the value
stays `direction` `value` through `by`. A value on the other side weakens the theme.

Validation applies the schema (unknown fields fail) and the aggregate-only check
to every text field. An experiment's optional `theme` must name a theme file.
`npm run validate` also fails when a theme's newest point is more than 2 days
before `--today`. `npm run build-feed` and `npm test` do not check that, so a
missed day never blocks the daily snapshot.

Daily step, for yesterday's Eastern date `D`:

```sh
npm run theme-sql -- --from D            # prints read-only SQL
# Run it through the vaulted read-only beeline-prod-db (Neon-Batch-Read-Only: true).
# Save the row's "values" column as values.json.
npm run track-themes -- --date D --values values.json
npm run build-feed && npm run validate
```

`scripts/theme-classes.mjs` holds the keyword classes and the SQL. Feedback
shares cover reports on `D-6` through `D`; the signup rate covers people who
signed up on `D-7` through `D-1`, so each 24-hour window has closed. The SQL
returns only counts and fractions; the `evidence` column holds numbers for
theme evidence, such as the returned-next-day rate. `--through` prints a range
for backfill; run `track-themes` once per day. Rerunning a day replaces its point.

### Value numbers

The 15:00 value loop measures three numbers with one fixed SQL, so a before
window and an after window are always measured the same way:

```sh
npm run value-sql -- --through D         # D is today's Eastern date; prints read-only SQL
# Run it through the vaulted read-only beeline-prod-db (Neon-Batch-Read-Only: true).
```

`scripts/value-numbers.mjs` holds the definitions and the SQL. Each row is one
metric and one window (`last7`, `prior7`, `last28`) with `numerator`,
`denominator` and, for workspace events, `median_hours`. Windows hold cohorts
whose follow-up time has closed by the end of `D`, so a 7-day metric's `last7` is
`D-13` through `D-7`. The SQL returns counts only.

| Metric | Counts |
| --- | --- |
| `return1`, `return7`, `return28` | People who wrote at least once, counted by the day of their first message, who wrote again on a later Eastern day at least 6 hours later, within 1, 7 or 28 days |
| `active` | Outside people who wrote at least one message (no denominator) |
| `secondHuman` | New workspaces that added a second human within 7 days |
| `extraAgent` | New workspaces that added an agent after their first hour within 7 days; free agents excluded |
| `invitesUsed` | Single-use invites created that were used. Creation time is `expires_at` minus 7 days, since older invites have no creation time |
| `repoLinked` | New workspaces that linked a repository within 7 days |
| `repoCardLinked` | Workspaces shown a repository card that linked in the same window |
| `funnelWrote` … `funnelRepo` | Signup → wrote → agent replied → came back → invited → repository; each step's denominator is the step before |

Outside only: workspaces that are not internal and never had a team member, and
people who are not team. Team is every human in an internal workspace plus any
human whose handle or name contains a team handle, which catches test accounts.

An experiment on one of these numbers names `value:<metric>` as
`metric.numerator`, records `before` from the same metric and window length,
and is graded only from this SQL. Changing a definition in this file starts a
new series: grade running experiments on the definition they started with.
