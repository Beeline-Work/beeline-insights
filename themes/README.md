# Themes

One file per underlying weakness in Beeline. A theme explains several symptoms
from at least two sources (feedback, Sentry, walk, snapshots, velocity, problems).

Fields: `id`, `weakness` (one sentence), `mechanism` (how it causes the symptoms),
`evidence[{source, text}]`, `against[]`, `prediction`, `falsifiedIf`,
`confidence` (`low`, `medium`, `high`), `firstSeen`, `lastReviewed`,
`status` (`open`, `merged`, `retired`), `track` (one number tracked daily; see the
root README, Themes).

Feedback tracks are keyword or word-overlap matches on report summaries, not a
reading of each report; `track.definition` says so. Feedback history before
2026-09-30 has `samples: 0` because no reports were recorded then.

The 07:00 triage weakness step strengthens, weakens, merges or retires themes each
day. A Sunday fresh pass derives themes without reading this folder, then compares.
Experiments name the theme they test. Aggregate only: no names, quotes or ids.
