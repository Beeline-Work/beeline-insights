import { addDays, cliOptions, finiteCount, isDate, isMain, loadSnapshots, measure, windowDates } from './lib/analysis.mjs';

export const MIN_HISTORY = 7;
export const MIN_SAMPLES = 10;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(current, history, extra = {}, rate = false) {
  const values = history.filter((point) => point.reason === null && point.value !== null && (!rate || point.samples >= MIN_SAMPLES)).map((point) => point.value);
  const center = values.length ? median(values) : null;
  const mad = values.length ? median(values.map((value) => Math.abs(value - center))) : null;
  const normal = values.length ? { low: Math.max(0, center - 2 * mad), high: center + 2 * mad, median: center, mad } : null;
  const flags = [];
  if (current.reason) flags.push(current.reason);
  else if (current.value === null || current.samples < MIN_SAMPLES) flags.push('small sample');
  if (values.length < MIN_HISTORY) flags.push('insufficient history');
  return { ...current, ...extra, normal, historySamples: values.length, flags,
    outside: flags.length === 0 && (current.value < normal.low || current.value > normal.high) };
}

function retention(snapshot) {
  const block = snapshot?.body.overview?.retention;
  const data = block?.data;
  if (block?.state !== 'measured') return { value: null, samples: null, reason: `retention: state ${block?.state ?? 'missing'}` };
  if (data?.day !== 7 || !finiteCount(data.cohort) || !finiteCount(data.retained) || data.retained > data.cohort
    || !isDate(data.from) || !isDate(data.through) || data.from > data.through) {
    return { value: null, samples: null, reason: 'retention: invalid 7-day cohort' };
  }
  return { value: data.cohort === 0 ? null : data.retained / data.cohort, samples: data.cohort, reason: null };
}

export function metricsFromSnapshots(snapshots, today) {
  const latest = snapshots.at(-1);
  const historyDates = windowDates(addDays(today, -1), 28);
  const metrics = {};
  for (const [name, numerator, denominator] of [
    ['firstReply/signups', 'firstReply', 'signups'], ['signups', 'signups'], ['dau', 'dau'], ['wau', 'wau'],
  ]) {
    const metric = { numerator, ...(denominator ? { denominator } : {}), windowDays: 1 };
    const current = measure(latest, metric, today);
    metrics[name] = summarize(current, historyDates.map((date) => measure(latest, metric, date)), {}, Boolean(denominator));
  }
  // Retention is one cohort aggregate per snapshot, not a daily series. Repeated
  // cohort windows are one observation even if saved on several calendar days.
  const current = latest.date === today ? retention(latest) : { value: null, samples: null, reason: 'retention: missing snapshot for today' };
  const data = latest.body.overview?.retention?.data;
  const cohortKey = (snapshot) => {
    const cohort = snapshot.body.overview?.retention?.data;
    return `${cohort?.day}/${cohort?.from}/${cohort?.through}`;
  };
  const seen = new Set(latest.date === today ? [cohortKey(latest)] : []);
  const retentionHistory = [];
  for (const snapshot of [...snapshots].reverse()) {
    if (!historyDates.includes(snapshot.date)) continue;
    const point = retention(snapshot);
    const key = cohortKey(snapshot);
    if (!point.reason && !seen.has(key)) {
      seen.add(key);
      retentionHistory.push(point);
    }
  }
  metrics.retention7 = summarize(current, retentionHistory, { from: data?.from ?? null, through: data?.through ?? null }, true);
  return { today, snapshot: latest.file, method: 'median +/- 2 MAD; prior 28 calendar days', minSamples: MIN_SAMPLES, minHistory: MIN_HISTORY, metrics };
}

export async function dailyMetrics({ snapshots, today }) {
  return metricsFromSnapshots(await loadSnapshots(snapshots, today, { history: true }), today);
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await dailyMetrics(cliOptions()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
