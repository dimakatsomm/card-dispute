import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const evaluateTasks = (described) => {
  const failures = described?.failures ?? [];
  const tasks = described?.tasks ?? [];
  if (failures.length > 0 || tasks.length === 0) {
    const reasons = failures.map((f) => f.reason).join(', ') || 'empty';
    return { ok: false, error: `describe-tasks returned no task (${reasons})` };
  }
  const bad = tasks.flatMap((t) => {
    const containers = t.containers ?? [];
    if (containers.length === 0) return ['task has no containers'];
    return containers
      .filter((c) => c.exitCode !== 0)
      .map((c) => `${c.name}: exit ${c.exitCode ?? 'none'}${t.stoppedReason ? ` (${t.stoppedReason})` : ''}`);
  });
  return bad.length === 0 ? { ok: true } : { ok: false, error: bad.join('; ') };
};

const main = () => {
  const result = evaluateTasks(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
