import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { SourceStore } from '../src/sources/store.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-import-test-'));
  temporary.push(root);
  const packages = join(root, 'packages');
  const data = join(root, 'destination');
  mkdirSync(packages);
  return { root, packages, data };
}
function source(dir: string, id: string, allowed = true) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `## TEST-1 Fixture clause\nTest-only text for ${id}; not a construction requirement.\n`);
  writeFileSync(join(dir, `${id}.source.json`), JSON.stringify({ file: `${id}.md`, document: {
    id, title: `Test-only ${id}`, publisher: 'Test fixture', type: 'published_code', edition: 'fixture',
    scope: { standard: 'test' }, demonstration: false,
    authorization: { basis: 'Test fixture', storeAndIndex: allowed, useWithAi: allowed, display: 'full' },
  } }));
}
function run(data: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-sources.ts', ...args], {
    cwd: workspace, env: { ...process.env, SPRINK_DATA_DIR: data }, encoding: 'utf8', timeout: 20_000,
  });
}
function documents(data: string) {
  const db = new Store(data);
  try { return new SourceStore(db.db).documents(); } finally { db.close(); }
}

it('validates without touching the destination and imports nested folders idempotently', () => {
  const { packages, data } = fixture();
  source(packages, 'one'); source(join(packages, 'nested'), 'two');
  const check = run(data, packages, '--check');
  expect(check.status, check.stderr).toBe(0);
  expect(existsSync(data)).toBe(false);
  const imported = run(data, packages);
  expect(imported.status, imported.stderr).toBe(0);
  expect(documents(data)).toHaveLength(2);
  expect(run(data, packages, join(packages, 'one.source.json')).status).toBe(0);
  expect(documents(data)).toHaveLength(2);
});

it('rolls back a mixed batch and preserves previously imported documents', () => {
  const { root, packages, data } = fixture();
  source(packages, 'existing');
  expect(run(data, packages).status).toBe(0);
  const batch = join(root, 'batch');
  source(batch, 'a-valid'); source(batch, 'z-unlicensed', false);
  const rejected = run(data, batch);
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).not.toContain('imported ');
  expect(documents(data).map(d => d.id)).toEqual(['existing']);
});

it('keeps bundled demonstrations out of real imports and validation destinations', () => {
  const { packages, data } = fixture();
  expect(run(data, '--demo', '--check').status).toBe(0);
  expect(existsSync(data)).toBe(false);
  expect(run(data, '--demo', packages).status).toBe(1);
  expect(existsSync(data)).toBe(false);
});
