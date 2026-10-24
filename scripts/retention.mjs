import { aggregateErrors } from './lib/contract.mjs';

// Only the server can classify people by their first agent; never infer it from walk counts.
export function retentionFromSnapshot(snapshot) {
  const block = snapshot?.body?.overview?.retention;
  if (block?.state !== 'measured' || block.data?.byFirstAgentSource === undefined) return null;
  const value = {
    generatedAt: block.measuredAt,
    source: 'GET /v1/admin/dashboard overview.retention.data.byFirstAgentSource',
    day: block.data.day,
    window: { from: block.data.from, through: block.data.through },
    groups: block.data.byFirstAgentSource,
  };
  const errors = aggregateErrors(value, 'retention');
  if (errors.length) throw new Error(errors.join('\n'));
  return value;
}
