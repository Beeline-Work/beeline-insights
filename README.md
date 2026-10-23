# beeline-insights

The memory of the Beeline insights loop. Everything here is aggregate or
redacted: no message text, names, emails or identity IDs.

| Folder | What it holds | Written by |
| --- | --- | --- |
| `snapshots/` | One file per Eastern calendar day: the operator dashboard aggregate (`GET /v1/admin/dashboard`). | `Daily snapshot` workflow, 6:30 AM Eastern |
| `bets/` | One file per bet: the metric, the expected change, the deadline and the grade. | 9 AM brief |
| `problems/` | One file per problem: people hurt per day, trend, cause tag and stage. | 10 AM triage |
| `walk/` | The fixed codebook of goals and friction codes, plus redacted daily counts. | 6 AM walk |

Git history is the audit trail: it shows how each number and each judgment changed.

## Snapshot

`npm test` checks the script. `npm run snapshot` needs `BEELINE_DASHBOARD_SECRET`
(an Actions secret here; the same value is in the vault as
`beeline-dashboard-api / production`). The workflow also runs on demand from
the Actions tab.
