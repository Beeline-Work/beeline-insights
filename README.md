# beeline-insights

The memory of the Beeline insights loop. Everything here is aggregate or
redacted: no message text, names, emails or identity IDs.

| Folder | What it holds | Written by |
| --- | --- | --- |
| `snapshots/` | One file per Eastern calendar day: the operator dashboard aggregate (`GET /v1/admin/dashboard`). | `Daily snapshot` workflow, 10:30 UTC with 12:30 UTC backup |
| `bets/` | One file per bet: the metric, the expected change, the deadline and the grade. | 9 AM brief |
| `loop/` | [Daily dashboard feed and schema contract](loop/README.md): headline values, normal ranges and open bets. | `Daily snapshot` workflow |
| `problems/` | One file per problem: people hurt per day, trend, cause tag and stage. | 10 AM triage |
| `walk/` | The fixed codebook of goals and friction codes, plus redacted daily counts. | 6 AM walk |

Git history is the audit trail: it shows how each number and each judgment changed.

## Snapshot

`npm test` checks the script. `npm run snapshot` needs `BEELINE_DASHBOARD_SECRET`
(an Actions secret here; the same value is in the vault as
`beeline-dashboard-api / production`). The workflow also runs on demand from
the Actions tab.

## Bets

Record a shipped fix with one command (use aggregate descriptions, no names):

```sh
npm run new-bet -- --id reply-friction --title "Improve first replies" \
  --problem "Reply friction" --numerator firstReply --denominator signups \
  --window-days 3 --target 0.5 --direction up --grade-on 2026-11-02
```

The command measures the baseline with the shared metrics function over the
window ending on the latest snapshot on or before Eastern today. It saves
`bets/<id>.json` exclusively and refuses an existing id. Missing or invalid
measurements and zero denominators fail clearly without creating a bet.
`--denominator` is optional for count bets; `--min-samples` defaults to 10.
`--today`, `--bets` and `--snapshots` support offline fixtures. The release date
is today and the grading date must be on or after it. Validation uses the same
validator as grading. The saved fields are:


| Field | Meaning |
| --- | --- |
| `id`, `title`, `problem` | Slug, short title and aggregate problem description or id. |
| `metric.numerator`, optional `metric.denominator` | Series names: `dau`, `downloads`, `firstReply`, `friendsJoined`, `signups`, `wau`, `workspaces`. |
| `metric.windowDays` | Inclusive window ending on the grading date (integer from 1 to 90). |
| `baseline` | Starting `value`, `from` and `through` dates. |
| `target` | Numeric `value` and `direction` (`up` means at least, `down` means at most). Rates use fractions, so 50% is `0.5`. |
| `releasedOn`, `gradeOn` | Release date or `null`, and grading date, as `YYYY-MM-DD`. |
| `minSamples` | Minimum denominator sum, or numerator sum for a count bet. |
| `status`, `grade` | Start with `"open"` and `null`; the script fills these. |

```sh
npm run grade-bets -- --today 2026-09-02
npm run grade-bets -- --today 2026-09-02 --write
```

The script prints JSON. Without `--write` it changes nothing. Dates default to
today in America/New_York. `--bets <directory>` and `--snapshots <directory>`
override the input directories. The newest snapshot on or before today is used;
no network or secret is needed. Invalid bets fail with the filename and field
before any bet is written. An empty `bets/` yields an empty list.

Before the deadline, each open bet shows its value over the window ending today
and `daysLeft`. Due bets use the window ending on `gradeOn`, including when run
late. Counts are sums; rates are ratios of sums. Equality meets the target in
either direction. Each result includes the target, measured value, sample size
and snapshot filename. Missing days, duplicate dates, invalid values and blocks
without `state: measured` produce a `reason` and leave the bet unchanged.

A zero denominator or samples below `minSamples` grades `unclear`. The script
moves `gradeOn` forward seven days once and saves `extensionUsed: true` and
`retryPending: true`. At that deadline it grades the new window and clears
`retryPending`, even if still unclear. These explicit flags distinguish an
unclear bet awaiting its retry from a final unclear grade, including late runs.
`grade` records `value`, `samples`, `snapshot` and `gradedOn`. Hit, miss and final
unclear files are left unchanged on later runs. Commit written files to preserve
the previous grade in the audit trail.

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
demonstrations, grading arithmetic and range calculations. The `Tests` workflow
runs it on every pull request and push to `main` with read-only permissions.
