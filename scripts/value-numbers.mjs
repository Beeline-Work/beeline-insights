import { addDays, isDate, isMain } from './lib/analysis.mjs';

// The value loop's three numbers, computed the same way on every run so a
// before window and an after window are comparable. Experiments on these numbers
// name `value:<metric>` as their source and are graded only from this SQL.
//
// Outside only: workspaces that are not internal and never had a team member;
// people who are not team. Team is every human in an internal workspace, plus any
// human whose handle or name contains a team handle (test accounts).
export const RULES = {
  horizonDays: 7, // a workspace or signup is followed this long before it counts
  returnGapHours: 6, // a return message comes on a later Eastern day and this long after the first
  extraAgentAfterHours: 1, // agents present in a workspace's first hour came with signup
  minTeamHandle: 6, // shorter team handles are not matched inside other handles
};

// metric: [what it counts, horizon in days]. Each metric gives last7, prior7 and
// last28 windows of cohorts whose horizon closed by the end of `through`.
export const METRICS = {
  return1: ['people who wrote again the Eastern day after their first message', 1],
  return7: ['people who wrote again within 7 days of their first message', 7],
  return28: ['people who wrote again within 28 days of their first message', 28],
  active: ['outside people who wrote at least one message', 0],
  secondHuman: ['new workspaces that added a second human within 7 days', RULES.horizonDays],
  extraAgent: ['new workspaces that added an agent after their first hour within 7 days, free agents excluded', RULES.horizonDays],
  invitesUsed: ['single-use invites created that were used', 0],
  repoLinked: ['new workspaces that linked a repository within 7 days', RULES.horizonDays],
  repoCardLinked: ['workspaces shown a repository card that linked a repository in the same window', 0],
  funnelWrote: ['signups who wrote within 24 hours', RULES.horizonDays],
  funnelReplied: ['of those, people an agent replied to within 24 hours of their first message', RULES.horizonDays],
  funnelReturned: ['of those, people who wrote again within 7 days', RULES.horizonDays],
  funnelInvited: ['of those, people whose workspace added a human or extra agent within 7 days', RULES.horizonDays],
  funnelRepo: ['of those, people who linked a repository within 7 days', RULES.horizonDays],
};
export const FUNNEL = ['funnelWrote', 'funnelReplied', 'funnelReturned', 'funnelInvited', 'funnelRepo'];

const TZ = 'America/New_York';
const day = (column) => `(${column} AT TIME ZONE '${TZ}')::date`;
const norm = (column) => `regexp_replace(lower(coalesce(${column}, '')), '[^a-z0-9]', '', 'g')`;

export function windows(through) {
  return Object.entries(METRICS).flatMap(([metric, [, horizon]]) => {
    const end = addDays(through, -horizon);
    return [['last7', addDays(end, -6), end], ['prior7', addDays(end, -13), addDays(end, -7)], ['last28', addDays(end, -27), end]]
      .map(([name, from, to]) => ({ metric, window: name, from, through: to }));
  });
}

// Read-only SQL. One row per metric and window: numerator, denominator and, where it
// applies, the median hours to the event among those counted. Funnel rows are
// cumulative: each step's denominator is the step before.
export function valueSQL({ through }) {
  if (!isDate(through)) throw new Error('expected --through YYYY-MM-DD');
  const h = RULES.horizonDays;
  const values = windows(through).map((w) => `('${w.metric}', '${w.window}', DATE '${w.from}', DATE '${w.through}')`).join(',\n  ');
  const earliest = addDays(through, -(28 + 27 + 1));
  const since = `(DATE '${earliest}'::timestamp AT TIME ZONE '${TZ}')`;
  const until = `((DATE '${through}' + 1)::timestamp AT TIME ZONE '${TZ}')`;
  const row = (metric, source, condition, denominator = 'count(x.d)', hours = 'NULL::numeric') => `SELECT w.metric, w.win, w.f, w.t, (count(*) FILTER (WHERE ${condition}))::int numerator, ${denominator}::int denominator, ${hours} median_hours
FROM win w LEFT JOIN ${source} x ON x.d BETWEEN w.f AND w.t WHERE w.metric = '${metric}' GROUP BY w.metric, w.win, w.f, w.t`;
  const median = (at, base) => `round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM x.${at} - x.${base}) / 3600) FILTER (WHERE x.${at} <= x.${base} + interval '${h} days'))::numeric, 1)`;
  const funnel = FUNNEL.map((metric, i) => row(metric, 'funnel', FUNNEL.slice(0, i + 1).map((step) => `x.${step}`).join(' AND '),
    i ? `count(*) FILTER (WHERE ${FUNNEL.slice(0, i).map((step) => `x.${step}`).join(' AND ')})` : 'count(x.d)'));
  return `WITH win(metric, win, f, t) AS (VALUES
  ${values}
), team_keys AS (
  SELECT DISTINCT ${norm('i.handle')} k FROM identities i
  JOIN memberships m ON m.identity_id = i.id AND m.room_id IS NULL JOIN workspaces ws ON ws.id = m.workspace_id AND ws.internal
  WHERE i.kind = 'human' AND length(${norm('i.handle')}) >= ${RULES.minTeamHandle}
), team AS (
  SELECT m.identity_id id FROM memberships m JOIN workspaces ws ON ws.id = m.workspace_id AND ws.internal
  JOIN identities i ON i.id = m.identity_id AND i.kind = 'human' WHERE m.room_id IS NULL
  UNION
  SELECT i.id FROM identities i JOIN team_keys tk ON strpos(${norm('i.handle')}, tk.k) > 0 OR strpos(${norm('i.name')}, tk.k) > 0
  WHERE i.kind = 'human'
), outside_workspaces AS MATERIALIZED (
  SELECT ws.id, ws.created_at FROM workspaces ws WHERE NOT ws.internal
    AND NOT EXISTS (SELECT 1 FROM memberships m JOIN team ON team.id = m.identity_id WHERE m.workspace_id = ws.id)
), outside_identities AS MATERIALIZED (
  SELECT i.id, i.kind, i.created_at FROM identities i WHERE NOT i.hidden_from_roster
    AND i.id <> encode(sha256('beeline:play-review-identity'::bytea), 'hex')
    AND NOT EXISTS (SELECT 1 FROM team WHERE team.id = i.id)
    AND (NOT EXISTS (SELECT 1 FROM memberships m WHERE m.identity_id = i.id AND m.room_id IS NULL)
      OR EXISTS (SELECT 1 FROM memberships m JOIN outside_workspaces ow ON ow.id = m.workspace_id
        WHERE m.identity_id = i.id AND m.room_id IS NULL))
), msgs AS MATERIALIZED (
  SELECT msg.author_id, msg.room_id, r.workspace_id, msg.created_at, ${day('msg.created_at')} d, oi.kind
  FROM messages msg JOIN rooms r ON r.id = msg.room_id JOIN outside_workspaces ow ON ow.id = r.workspace_id
  JOIN outside_identities oi ON oi.id = msg.author_id
  WHERE msg.presentation = 'message' AND msg.deleted_at IS NULL AND msg.created_at >= ${since} AND msg.created_at < ${until}
), people AS MATERIALIZED (
  SELECT oi.id, oi.created_at, ${day('oi.created_at')} d,
    (SELECT min(m.created_at) FROM msgs m WHERE m.author_id = oi.id) first_at
  FROM outside_identities oi WHERE oi.kind = 'human' AND oi.created_at >= ${since} AND oi.created_at < ${until}
), returns AS (
  SELECT p.*, (SELECT min(m.d) FROM msgs m WHERE m.author_id = p.id AND m.d > ${day('p.first_at')}
    AND m.created_at >= p.first_at + interval '${RULES.returnGapHours} hours') return_day
  FROM people p
), writers AS (
  -- Coming back is counted only for people who came once, by the day of their first message.
  SELECT r.id, ${day('r.first_at')} d, r.return_day FROM returns r WHERE r.first_at IS NOT NULL
), active AS (
  SELECT w.metric, w.win, w.f, w.t, count(DISTINCT m.author_id)::int numerator, NULL::int denominator, NULL::numeric median_hours
  FROM win w LEFT JOIN msgs m ON m.kind = 'human' AND m.d BETWEEN w.f AND w.t WHERE w.metric = 'active' GROUP BY w.metric, w.win, w.f, w.t
), creators AS (
  SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.identity_id FROM memberships m JOIN identities i ON i.id = m.identity_id AND i.kind = 'human'
  WHERE m.room_id IS NULL ORDER BY m.workspace_id, m.joined_at, m.id
), spaces AS MATERIALIZED (
  SELECT ow.id, ow.created_at, ${day('ow.created_at')} d, c.identity_id creator,
    (SELECT min(m.joined_at) FROM memberships m JOIN outside_identities oi ON oi.id = m.identity_id AND oi.kind = 'human'
      WHERE m.workspace_id = ow.id AND m.room_id IS NULL AND m.removed_at IS NULL AND m.identity_id <> c.identity_id) human_at,
    (SELECT min(m.joined_at) FROM memberships m JOIN outside_identities oi ON oi.id = m.identity_id AND oi.kind = 'agent'
      WHERE m.workspace_id = ow.id AND m.room_id IS NULL AND m.joined_at > ow.created_at + interval '${RULES.extraAgentAfterHours} hour'
        AND NOT EXISTS (SELECT 1 FROM free_agents fa WHERE fa.agent_id = m.identity_id)) agent_at,
    (SELECT min(l.first_linked_at) FROM repository_link_successes l WHERE l.workspace_id = ow.id) repo_at
  FROM outside_workspaces ow LEFT JOIN creators c ON c.workspace_id = ow.id
  WHERE ow.created_at >= ${since} AND ow.created_at < ${until}
), invites_made AS (
  -- The invites creation column is new and null for older rows. Every single-use
  -- invite expires 7 days after creation, so that gives the creation time for all.
  SELECT ${day('inv.made_at')} d, inv.used FROM (
    SELECT coalesce(i.onboarding_created_at, i.expires_at - interval '7 days') made_at, i.consumed_at IS NOT NULL used
    FROM invites i JOIN outside_workspaces ow ON ow.id = i.workspace_id JOIN outside_identities oi ON oi.id = i.created_by
    WHERE i.public_token IS NULL
  ) inv WHERE inv.made_at >= ${since} AND inv.made_at < ${until}
), cards AS (
  SELECT DISTINCT r.workspace_id, ${day('msg.created_at')} d FROM messages msg JOIN rooms r ON r.id = msg.room_id
  JOIN outside_workspaces ow ON ow.id = r.workspace_id
  WHERE msg.card_type = 'repository-onboarding' AND msg.card->>'kind' = 'repository' AND msg.deleted_at IS NULL
    AND msg.created_at >= ${since} AND msg.created_at < ${until}
), card_windows AS (
  SELECT w.metric, w.win, w.f, w.t,
    (count(DISTINCT c.workspace_id) FILTER (WHERE EXISTS (SELECT 1 FROM repository_link_successes l
      WHERE l.workspace_id = c.workspace_id AND ${day('l.first_linked_at')} BETWEEN w.f AND w.t)))::int numerator,
    count(DISTINCT c.workspace_id)::int denominator, NULL::numeric median_hours
  FROM win w LEFT JOIN cards c ON c.d BETWEEN w.f AND w.t WHERE w.metric = 'repoCardLinked' GROUP BY w.metric, w.win, w.f, w.t
), funnel AS (
  SELECT p.d,
    p.first_at IS NOT NULL AND p.first_at < p.created_at + interval '24 hours' "funnelWrote",
    EXISTS (SELECT 1 FROM msgs a JOIN memberships m ON m.workspace_id = a.workspace_id AND m.room_id IS NULL AND m.identity_id = p.id
      WHERE a.kind = 'agent' AND a.created_at > p.first_at AND a.created_at <= p.first_at + interval '24 hours') "funnelReplied",
    p.return_day IS NOT NULL AND p.return_day <= p.d + ${h} "funnelReturned",
    EXISTS (SELECT 1 FROM spaces s WHERE s.creator = p.id AND (s.human_at <= s.created_at + interval '${h} days'
      OR s.agent_at <= s.created_at + interval '${h} days')) "funnelInvited",
    EXISTS (SELECT 1 FROM repository_link_successes l JOIN outside_workspaces ow ON ow.id = l.workspace_id
      WHERE l.identity_id = p.id AND l.first_linked_at <= p.created_at + interval '${h} days') "funnelRepo"
  FROM returns p
)
${row('return1', 'writers', 'x.return_day <= x.d + 1')}
UNION ALL
${row('return7', 'writers', 'x.return_day <= x.d + 7')}
UNION ALL
${row('return28', 'writers', 'x.return_day <= x.d + 28')}
UNION ALL
SELECT * FROM active
UNION ALL
${row('secondHuman', 'spaces', `x.human_at <= x.created_at + interval '${h} days'`, 'count(x.d)', median('human_at', 'created_at'))}
UNION ALL
${row('extraAgent', 'spaces', `x.agent_at <= x.created_at + interval '${h} days'`, 'count(x.d)', median('agent_at', 'created_at'))}
UNION ALL
${row('invitesUsed', 'invites_made', 'x.used')}
UNION ALL
${row('repoLinked', 'spaces', `x.repo_at <= x.created_at + interval '${h} days'`, 'count(x.d)', median('repo_at', 'created_at'))}
UNION ALL
SELECT * FROM card_windows
UNION ALL
${funnel.map((sql) => sql.replace(/x\.(funnel\w+)/g, 'x."$1"')).join('\nUNION ALL\n')}
ORDER BY 1, 2`;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--through' && args[0]) options.through = args.shift();
    else {
      console.error(`unknown or incomplete option: ${flag}`);
      process.exit(1);
    }
  }
  try {
    console.log(valueSQL(options));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
