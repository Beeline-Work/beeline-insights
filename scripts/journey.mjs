// Legacy lifetime funnel, used only until period snapshots are available.
export const JOURNEY = [
  ['signup', 'Signed up'],
  ['workspace', 'Joined a workspace'],
  ['free_agent_messaged', 'Messaged their free agent'],
  ['free_agent_replied', 'Free agent replied'],
];

export function journeyFromSnapshot(snapshot) {
  const funnel = snapshot?.body?.periods?.['7d']?.funnel;
  if (funnel !== undefined) {
    if (!Array.isArray(funnel?.steps) || funnel.steps.some((step) =>
      typeof step?.key !== 'string' || typeof step.label !== 'string' || !step.label.trim()
      || !Number.isInteger(step.count) || step.count < 0)) {
      throw new Error('periods.7d.funnel.steps: expected labeled nonnegative counts');
    }
    const steps = funnel.steps.map(({ label, count }) => ({ label, count }));
    let biggestDrop = null;
    if (funnel.biggestDrop !== null) {
      const drop = funnel.biggestDrop;
      const step = funnel.steps.find((item) => item.key === drop?.key);
      if (!step || !Number.isInteger(drop?.lost) || drop.lost < 1) {
        throw new Error('periods.7d.funnel.biggestDrop: expected a step key and positive loss or null');
      }
      biggestDrop = { label: step.label, lost: drop.lost };
    }
    return { steps, biggestDrop, state: 'measured' };
  }
  if (snapshot?.body?.periods != null) {
    throw new Error('periods.7d.funnel: missing from period snapshot');
  }
  const usage = snapshot?.body?.usage;
  const people = Array.isArray(usage?.people) ? usage.people : [];
  const steps = [];
  if (usage?.state === 'measured') {
    for (const [stage, label] of JOURNEY) {
      const row = people.find((item) => item.stage === stage);
      if (!Number.isInteger(row?.count) || row.count < 0) break;
      steps.push({ label, count: row.count });
    }
  }
  let biggestDrop = null;
  for (let i = 1; i < steps.length; i += 1) {
    const lost = steps[i - 1].count - steps[i].count;
    if (lost > 0 && lost > (biggestDrop?.lost ?? 0)) biggestDrop = { label: steps[i].label, lost };
  }
  return { steps, biggestDrop, state: 'limited' };
}
