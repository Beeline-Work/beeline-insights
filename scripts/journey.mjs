// The signup journey from the newest snapshot's lifetime usage funnel (people, not agents).
export const JOURNEY = [
  ['signup', 'Signed up'],
  ['workspace', 'Joined a workspace'],
  ['free_agent_messaged', 'Messaged their free agent'],
  ['free_agent_replied', 'Free agent replied'],
];

export function journeyFromSnapshot(snapshot) {
  const usage = snapshot?.body.usage;
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
  return { steps, biggestDrop };
}
