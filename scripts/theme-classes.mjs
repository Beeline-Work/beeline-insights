import { addDays, isDate, isMain } from './lib/analysis.mjs';

// One tracked number per theme. Feedback classes are keyword matches on the report
// summary (PostgreSQL ~*, case-insensitive), so a report can fall in more than one class.
export const FEEDBACK_CLASSES = {
  'wakes-without-causality': String.raw`\m(wake|wakes|woke|woken|waking|redispatch\w*|dispatch\w*|idle-corner|idle corner|unreported.order|review assignment|reviewer request|notifier)`,
  'state-copies-diverge': String.raw`(stale|head moved|stale_head|checks? (read|summary|rollup|status|suite)|pr_checks_status|merge gate|live gate|review gate|stage (stays|reports)|pending checks|mergeallowed|not (yet )?indexed|unpublished|corner not found|differs from github)`,
  'surface-capabilities-unstated': String.raw`(emulator|\madb\M|\mavd\M|sandbox|\mgrants?\M|checkout|worktree|\mgh\M|github cli|\mshell\M|launcher|unavailable|in (this|a|the) room|systemd|namespace|mounted|host)`,
  'tool-contracts-unstated': String.raw`(schema|invalid.?arguments|unknown field|\mlimit\M|argument|parameter|advertis|documented|tool description|one sentence|characters|rejects?\M|rejected)`,
};

// A repeat is a report whose exact summary the same reporter filed at least
// this many times on the same Eastern day (the report itself included).
export const REPEAT = { theme: 'repeats-without-failure-budget', times: 3 };
export const SIGNUP_THEME = 'loop-hears-only-agents';
export const THEME_IDS = [...Object.keys(FEEDBACK_CLASSES), REPEAT.theme, SIGNUP_THEME].sort();

const TZ = 'America/New_York';
const literal = (text) => {
  if (text.includes("'")) throw new Error('class patterns cannot contain a single quote');
  return `'${text}'`;
};
const start = (date) => `(DATE '${date}'::timestamp AT TIME ZONE '${TZ}')`;
const column = (id) => id.replace(/-/g, '_');

// Read-only SQL. Each row is one Eastern day D from `from` through `through`:
// `values` is the track-themes input for D; `evidence` holds numbers kept out of the tracks.
// Feedback shares cover reports on D-6..D. The signup rate covers people who signed up
// on D-7..D-1, so every 24-hour window has closed by the end of D.
export function themeSQL({ from, through }) {
  if (!isDate(from) || !isDate(through) || from > through) throw new Error('expected --from and --through dates, from on or before through');
  const ids = Object.keys(FEEDBACK_CLASSES);
  const share = (key, count) => `'${key}', json_build_object('value', round(${count}::numeric / nullif(fb.total, 0), 4), 'samples', fb.total)`;
  return `WITH days AS (
  SELECT generate_series(DATE '${from}', DATE '${through}', interval '1 day')::date d
), f AS (
  SELECT id, reporter_identity_id r, summary, (created_at AT TIME ZONE '${TZ}')::date d FROM feedback_items
  WHERE created_at >= ${start(addDays(from, -6))} AND created_at < ${start(addDays(through, 1))}
), repeats AS (
  SELECT id FROM (SELECT id, count(*) OVER (PARTITION BY r, d, summary) n FROM f) same WHERE n >= ${REPEAT.times}
), tagged AS (
  SELECT f.d, ${ids.map((id) => `f.summary ~* ${literal(FEEDBACK_CLASSES[id])} ${column(id)}`).join(',\n    ')},
    rp.id IS NOT NULL ${column(REPEAT.theme)}
  FROM f LEFT JOIN repeats rp ON rp.id = f.id
), fb AS (
  SELECT days.d, count(t.d) total, ${[...ids, REPEAT.theme].map((id) => `count(*) FILTER (WHERE t.${column(id)}) ${column(id)}`).join(', ')}
  FROM days LEFT JOIN tagged t ON t.d BETWEEN days.d - 6 AND days.d GROUP BY days.d
), production_workspaces AS (
  SELECT id FROM workspaces WHERE NOT internal
), production_identities AS (
  SELECT i.id FROM identities i WHERE NOT i.hidden_from_roster
    AND i.id <> encode(sha256('beeline:play-review-identity'::bytea), 'hex')
    AND (NOT EXISTS (SELECT 1 FROM memberships m WHERE m.identity_id = i.id AND m.room_id IS NULL)
      OR EXISTS (SELECT 1 FROM memberships m JOIN production_workspaces w ON w.id = m.workspace_id
        WHERE m.identity_id = i.id AND m.room_id IS NULL))
), signups AS (
  SELECT i.id, (i.created_at AT TIME ZONE '${TZ}')::date d,
    EXISTS (SELECT 1 FROM messages msg JOIN rooms r ON r.id = msg.room_id JOIN production_workspaces w ON w.id = r.workspace_id
      WHERE msg.author_id = i.id AND msg.presentation = 'message' AND msg.deleted_at IS NULL
        AND msg.created_at >= i.created_at AND msg.created_at < i.created_at + interval '24 hours') sent,
    EXISTS (SELECT 1 FROM messages msg JOIN rooms r ON r.id = msg.room_id JOIN production_workspaces w ON w.id = r.workspace_id
      WHERE msg.author_id = i.id AND msg.presentation = 'message' AND msg.deleted_at IS NULL
        AND (msg.created_at AT TIME ZONE '${TZ}')::date = (i.created_at AT TIME ZONE '${TZ}')::date + 1) returned
  FROM identities i JOIN production_identities pi ON pi.id = i.id
  WHERE i.kind = 'human' AND i.created_at >= ${start(addDays(from, -7))} AND i.created_at < ${start(through)}
), sg AS (
  SELECT days.d, count(s.id) cohort, count(*) FILTER (WHERE s.sent) sent, count(*) FILTER (WHERE s.returned) returned
  FROM days LEFT JOIN signups s ON s.d BETWEEN days.d - 7 AND days.d - 1 GROUP BY days.d
)
SELECT fb.d::text date, json_build_object(
  ${[...ids, REPEAT.theme].map((id) => share(id, `fb.${column(id)}`)).join(',\n  ')},
  '${SIGNUP_THEME}', json_build_object('value', round(sg.sent::numeric / nullif(sg.cohort, 0), 4), 'samples', sg.cohort)
) "values", json_build_object('returnedNextDay', json_build_object('value', round(sg.returned::numeric / nullif(sg.cohort, 0), 4), 'samples', sg.cohort)) evidence
FROM fb JOIN sg USING (d) ORDER BY fb.d`;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (['--from', '--through'].includes(flag) && args[0]) options[flag.slice(2)] = args.shift();
    else {
      console.error(`unknown or incomplete option: ${flag}`);
      process.exit(1);
    }
  }
  try {
    console.log(themeSQL({ from: options.from, through: options.through ?? options.from }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
