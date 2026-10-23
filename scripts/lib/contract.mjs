import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERIES, isDate, readJSON } from './analysis.mjs';

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));
export const SCHEMA_FILES = ['insights', 'experiment', 'reach', 'digest', 'feed'].map((name) => `${name}.schema.json`);
const schemas = Object.fromEntries(await Promise.all(SCHEMA_FILES.map(async (file) => [file, JSON.parse(await readFile(join(SCHEMA_DIR, file), 'utf8'))])));

const typeOf = (value) => value === null ? 'null' : Array.isArray(value) ? 'array'
  : Number.isInteger(value) ? 'integer' : typeof value;
export const isTimestamp = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const FORMATS = {
  date: isDate,
  'date-time': isTimestamp,
  month: (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
};

// Checks the JSON Schema subset used in schemas/. Unknown fields fail through additionalProperties: false.
function check(value, schema, root, path, errors) {
  if (schema.$ref) {
    const [file, pointer] = schema.$ref.split('#');
    const base = file ? schemas[file] : root;
    const target = pointer ? pointer.split('/').slice(1).reduce((node, key) => node[key], base) : base;
    return check(value, target, base, path, errors);
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((option) => {
      const found = [];
      check(value, option, root, path, found);
      return found;
    });
    if (!attempts.some((found) => found.length === 0)) errors.push(...attempts.at(-1));
    return;
  }
  const fail = (message) => errors.push(`${path || '(root)'}: ${message}`);
  if (schema.enum && !schema.enum.includes(value)) return fail(`expected one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return fail(`expected ${types.join(' or ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) return fail('expected nonempty text');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return fail(`longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return fail(`does not match ${schema.pattern}`);
    if (schema.format && !FORMATS[schema.format](value)) return fail(`expected ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('expected a finite number');
    if (schema.minimum !== undefined && value < schema.minimum) return fail(`expected at least ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => check(item, schema.items, root, `${path}[${i}]`, errors));
  if (typeOf(value) === 'object' && schema.properties) {
    for (const key of schema.required ?? []) if (!(key in value)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (schema.properties[key]) check(item, schema.properties[key], root, child, errors);
      else if (schema.additionalProperties === false) errors.push(`${child}: unknown field`);
    }
  }
}

export function schemaErrors(value, file) {
  const errors = [];
  check(value, schemas[file], schemas[file], '', errors);
  return errors;
}

// Aggregate-only rule: no emails, @handles or long identifiers in anything shown to people.
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const HANDLE = /(^|[^\w.@])@[a-z0-9_][\w-]*/i;
const IDENTIFIER = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/i;
export function privacyErrors(text, path) {
  if (EMAIL.test(text)) return [`${path}: contains an email address`];
  if (HANDLE.test(text)) return [`${path}: contains an @handle`];
  if (IDENTIFIER.test(text)) return [`${path}: contains an identifier`];
  return [];
}

function strings(value, path, skip = []) {
  if (typeof value === 'string') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).filter(([key]) => !skip.includes(key))
    .flatMap(([key, item]) => strings(item, Array.isArray(value) ? `${path}[${key}]` : (path ? `${path}.${key}` : key), skip));
}
const privacy = (value, skip) => strings(value, '', skip).flatMap(([path, text]) => privacyErrors(text, path || '(root)'));
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);

export function insightsErrors(insights) {
  const errors = schemaErrors(insights, 'insights.schema.json');
  if (errors.length) return errors;
  const { window, errors: errorBlock, feedback, velocity } = insights;
  if (window.from > window.through) errors.push('window.through: must be on or after window.from');
  if (sum(errorBlock.areas, 'count') > errorBlock.total) errors.push('errors.areas: counts exceed errors.total');
  if (sum(feedback.areas, 'count') > feedback.total) errors.push('feedback.areas: counts exceed feedback.total');
  if (feedback.people + feedback.agents !== feedback.total) errors.push('feedback.total: must equal people plus agents');
  if (sum(velocity.items, 'hours') > velocity.hoursLost + 1e-9) errors.push('velocity.items: hours exceed velocity.hoursLost');
  return [...errors, ...privacy(insights)];
}

export const snapshotSeries = (metric) => SERIES.includes(metric.numerator)
  && (metric.denominator === undefined || SERIES.includes(metric.denominator));

export function experimentErrors(experiment, file) {
  const errors = schemaErrors(experiment, 'experiment.schema.json');
  if (errors.length) return errors;
  const e = experiment;
  if (file && basename(file) !== `${e.id}.json`) errors.push('id: must match the filename');
  if (e.before.from > e.before.through) errors.push('before.through: must be on or after before.from');
  if (e.metric.denominator !== undefined && SERIES.includes(e.metric.numerator) !== SERIES.includes(e.metric.denominator)) {
    errors.push('metric.denominator: do not mix snapshot and agent-written series');
  }
  if (e.status === 'proposed') {
    for (const field of ['startedOn', 'progress', 'verdict']) if (e[field] !== null) errors.push(`${field}: must be null while proposed`);
  } else {
    // Nothing goes out without the owner's approval message.
    if (e.approval === null) errors.push(`approval: ${e.status} requires approval.messageId`);
    if (e.startedOn === null) errors.push(`startedOn: ${e.status} requires a start date`);
    else if (e.startedOn > e.decideAt.date) errors.push('decideAt.date: must be on or after startedOn');
  }
  if (e.status === 'running' && e.verdict !== null) errors.push('verdict: must be null while running');
  if (e.status === 'concluded') {
    if (e.verdict === null) errors.push('verdict: concluded requires a verdict');
    else {
      const { result, decision, value, samples } = e.verdict;
      if (samples < e.decideAt.samples && result !== 'not_enough_data') errors.push('verdict.result: below decideAt.samples must be not_enough_data');
      if (result === 'not_enough_data' && decision !== e.ifUnclear) errors.push('verdict.decision: not_enough_data follows ifUnclear');
      if (result === 'supported' && decision !== 'keep') errors.push('verdict.decision: supported keeps the change');
      if (result === 'not_supported' && decision !== 'undo') errors.push('verdict.decision: not_supported undoes the change');
      if (result !== 'not_enough_data' && value === null) errors.push('verdict.value: a supported or not_supported verdict needs a value');
      if (e.startedOn !== null && e.verdict.on < e.startedOn) errors.push('verdict.on: must be on or after startedOn');
    }
  }
  if (e.progress && e.startedOn && e.progress.asOf < e.startedOn) errors.push('progress.asOf: must be on or after startedOn');
  return [...errors, ...privacy(e, ['approval'])];
}

export function reachErrors(reach) {
  const errors = schemaErrors(reach, 'reach.schema.json');
  if (errors.length) return errors;
  return privacy(reach);
}

// Front matter is three plain lines: title, findings and proposals.
export function parseDigest(text, file) {
  const errors = [];
  const name = basename(file);
  const date = name.slice(0, -3);
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name) || !isDate(date)) return { errors: ['filename: expected digests/YYYY-MM-DD.md'] };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return { errors: ['front matter: expected --- fenced title, findings and proposals'] };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!pair) { errors.push(`front matter: cannot read line ${JSON.stringify(line)}`); continue; }
    const [, key, raw] = pair;
    if (key in fields) errors.push(`${key}: duplicate`);
    fields[key] = key === 'title' ? raw.replace(/^(["'])(.*)\1$/, '$2') : (/^\d+$/.test(raw) ? Number(raw) : raw);
  }
  const entry = { date, ...fields, path: `digests/${name}` };
  errors.push(...schemaErrors(entry, 'digest.schema.json'));
  if (!match[2].trim()) errors.push('body: expected the digest text');
  errors.push(...privacyErrors(String(fields.title ?? ''), 'title'), ...privacyErrors(match[2], 'body'));
  return { entry: { date, title: fields.title, findings: fields.findings, proposals: fields.proposals, path: entry.path }, errors };
}

async function optionalJSON(path) {
  try {
    await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return readJSON(path);
}

async function list(directory, suffix) {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(suffix)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Reads every contract input under root. Problems are collected as "file: field: message".
export async function loadContract(root) {
  const problems = [];
  const add = (file, errors) => problems.push(...errors.map((error) => `${file}: ${error}`));
  const insightsFile = join(root, 'insights/latest.json');
  const insights = await optionalJSON(insightsFile) ?? null;
  if (insights !== null) add('insights/latest.json', insightsErrors(insights));
  const experiments = [];
  for (const file of await list(join(root, 'experiments'), '.json')) {
    const experiment = await readJSON(join(root, 'experiments', file));
    const errors = experimentErrors(experiment, file);
    add(`experiments/${file}`, errors);
    experiments.push(experiment);
  }
  const reachFile = join(root, 'reach/latest.json');
  const reach = await optionalJSON(reachFile) ?? null;
  if (reach !== null) add('reach/latest.json', reachErrors(reach));
  const digests = [];
  for (const file of await list(join(root, 'digests'), '.md')) {
    const { entry, errors } = parseDigest(await readFile(join(root, 'digests', file), 'utf8'), file);
    add(`digests/${file}`, errors);
    if (entry) digests.push(entry);
  }
  digests.sort((a, b) => b.date.localeCompare(a.date));
  if (insights !== null && !problems.some((problem) => problem.startsWith('insights/'))) {
    const ids = new Set(experiments.map((experiment) => experiment.id));
    insights.links.forEach((link, i) => {
      if (!ids.has(link.experimentId)) problems.push(`insights/latest.json: links[${i}].experimentId: no experiments/${link.experimentId}.json`);
    });
  }
  return { insights, experiments, reach, digests, problems };
}

const STATUS_ORDER = ['proposed', 'running', 'concluded'];
export function sortExperiments(experiments) {
  return [...experiments].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id.localeCompare(b.id));
}
