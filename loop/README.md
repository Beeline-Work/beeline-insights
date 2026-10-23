# Daily Loop feed

The dashboard reads `loop/latest.json`. Build it offline with `npm run build-loop`.
Like the metrics and grading CLIs, it accepts `--today YYYY-MM-DD`,
`--snapshots <directory>` and `--bets <directory>`. Dates default to Eastern
today. The output path is relative to the working directory; the imported
`buildLoop` function also accepts `output` and a fixed `now` for fixtures.
The CLI prints the saved JSON. Input validation completes before replacement;
failure leaves the previous feed intact and exits nonzero.

## Contract: schemaVersion 1

All fields below are always present. A breaking change requires a version bump
and updates to the shape tests and dashboard consumer.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | UTC ISO generation timestamp |
| `date` | Requested Eastern calendar day, `YYYY-MM-DD` |
| `snapshotDate`, `snapshot` | Actual source date and filename; never relabeled when stale |
| `headline` | `firstReply/signups`, a key in `metrics` |
| `method`, `minSamples`, `minHistory` | Unchanged range description and thresholds from `metrics.mjs` |
| `metrics` | Object keyed by `firstReply/signups`, `signups`, `dau`, `wau`, `retention7` |
| `openBets` | Array sorted by bet filename; empty when there are no open bets |

Every metric contains the unchanged metrics-script fields `value`, `samples`,
`reason`, `normal`, `historySamples`, `flags` and `outside`, plus `state` and
`smallSample`. Retention also has `from` and `through` (dates or `null`).
`normal` is `null` or `{ low, high, median, mad }`. Numeric readings and samples
can be `null`; no missing value becomes zero. Rates are fractions.
`smallSample` directly reflects the metrics script's `small sample` flag; it
does not mean an unavailable reading has sufficient samples. Consumers must
respect `flags` and `reason` before interpreting `outside: false` as normal.

`state` preserves the first non-measured source block state in numerator then
denominator order (or the retention block state), defaulting to `missing` for
an absent block. When blocks are measured but the script cannot read the
requested date or valid data, it is `unavailable`; otherwise `measured`.
Non-measured readings retain `value: null` and the script's explanation.

Each open bet contains `id`, `title`, `metric`, `baseline`, `target`, `gradeOn`,
`status`, `retryPending`, `value`, `samples`, `reason` and `state`. `metric`,
`baseline` and `target` retain the validated bet objects unchanged. The current
reading uses the shared measurement function over the window ending on `date`,
including overdue bets. It never grades, extends deadlines or writes bet files.
An `unclear` bet awaiting its one retry is still open and included; hit, miss
and final unclear bets are excluded. Only aggregate bet titles belong here.

## Daily workflow

After the snapshot is saved and committed locally, the workflow builds the feed
and amends that **unpublished** snapshot commit to include it. When the snapshot
is unchanged, a feed refresh gets its own commit. One final push saves the
result. Feed generation is allowed to fail; the final push still saves the
already committed snapshot, leaving the previous feed in place. Consumers can
detect a stale feed through `date`, `generatedAt` and `snapshotDate`.
The workflow does not run bet grading. It keeps the existing snapshot capture,
schedule and secret unchanged.
