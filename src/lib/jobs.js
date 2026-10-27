// Long-running work (installs, mirrors, runtime downloads) as jobs the UI can
// list: what is running, how far along it is, what it logged, and why it failed.
// Before this, progress lived only in the detail dialog and errors in a status
// line the dialog covered, so a failed mirror looked like nothing happened.

const KEEP = 40; // finished jobs kept for the panel
const LOG_LINES = 200;
const EMIT_EVERY_MS = 150; // download progress arrives per chunk

export function createJobs({ emit = () => {}, now = () => Date.now() } = {}) {
  const jobs = new Map();
  let seq = 0;
  let lastEmit = 0;
  let timer = null;

  // Newest first; `seq` breaks ties between jobs started in the same millisecond.
  const newestFirst = (a, b) => b.startedAt - a.startedAt || b.seq - a.seq;
  const snapshot = () => [...jobs.values()].map((j) => ({ ...j, log: [...j.log] })).sort(newestFirst);

  function changed({ force = false } = {}) {
    const t = now();
    if (force || t - lastEmit >= EMIT_EVERY_MS) {
      lastEmit = t;
      clearTimeout(timer);
      timer = null;
      emit('jobs:changed', snapshot());
    } else if (!timer) {
      timer = setTimeout(() => changed({ force: true }), EMIT_EVERY_MS);
      timer.unref?.();
    }
  }

  function prune() {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort(newestFirst);
    for (const job of finished.slice(KEEP)) jobs.delete(job.id);
  }

  // Run `work(handle)` as a job. The returned promise settles with the work's
  // result or rethrows its error, so callers keep their own error handling.
  async function run({ title, kind = 'task', target = null }, work) {
    const job = { id: `job-${++seq}`, seq, title, kind, target, status: 'running', message: '', received: 0, total: 0, log: [], error: '', startedAt: now(), finishedAt: 0 };
    jobs.set(job.id, job);
    const handle = {
      id: job.id,
      log(line) {
        job.log.push(String(line));
        if (job.log.length > LOG_LINES) job.log.shift();
        job.message = String(line);
        changed();
      },
      progress({ message, received, total } = {}) {
        if (message) job.message = message;
        job.received = received ?? 0;
        job.total = total ?? 0;
        changed();
      },
    };
    changed({ force: true });
    try {
      const result = await work(handle);
      job.status = 'done';
      job.message = job.message || 'Done';
      return result;
    } catch (error) {
      job.status = 'failed';
      job.error = error?.message ?? String(error);
      job.log.push(`Failed: ${job.error}`);
      throw error;
    } finally {
      job.finishedAt = now();
      job.received = 0;
      job.total = 0;
      prune();
      changed({ force: true });
    }
  }

  function clearFinished() {
    for (const job of [...jobs.values()]) if (job.status !== 'running') jobs.delete(job.id);
    changed({ force: true });
    return snapshot();
  }

  return { run, list: snapshot, clearFinished };
}
