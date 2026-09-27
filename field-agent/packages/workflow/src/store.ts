import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, RunStore } from './contracts.js';

/** One local server only. Stores run summaries, never output-readiness flags or transcripts. */
export class JsonRunStore implements RunStore {
  private runs: Record<string, RunRecord>;
  constructor(private readonly path: string) {
    try { this.runs = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.runs = {};
    }
  }
  get(id: string): RunRecord | undefined {
    const run = this.runs[id];
    return run ? structuredClone(run) : undefined;
  }
  save(run: RunRecord): void {
    const updated = { ...this.runs, [run.id]: structuredClone(run) };
    this.write(updated);
  }
  interruptRunning(): void {
    const updated = structuredClone(this.runs);
    for (const run of Object.values(updated)) if (run.status === 'running') {
      run.status = 'interrupted'; run.reason = 'server_restarted; rerun explicitly from saved inputs';
      run.endedAt = new Date().toISOString();
    }
    this.write(updated);
  }
  private write(updated: Record<string, RunRecord>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(updated, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    this.runs = updated;
  }
}
