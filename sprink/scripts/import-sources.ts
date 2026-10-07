/** Import reviewed packages (or folders of packages) as one atomic batch. */
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../apps/server/src/store.js';
import { SourceStore } from '../apps/server/src/sources/store.js';
import { DEMO_DIR, readSourcePackage } from '../apps/server/src/sources/demo.js';

const usage = `Usage: pnpm sources:import <file.source.json | directory> [...] [--project id] [--check]
       pnpm sources:import --demo [--project id] [--check]

Directories are scanned recursively for *.source.json (symlinks and hidden folders are skipped).
--check validates the complete batch in temporary storage without changing the library.
Real imports commit together or roll back together. Existing IDs must have identical content and metadata.
Each package must include its actual source permissions. Demo sources remain marked as demonstrations.`;

function packagesIn(path: string): string[] {
  if (!statSync(path).isDirectory()) return [realpathSync(path)];
  const files: string[] = [];
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || entry.name === 'node_modules') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...packagesIn(child));
    else if (entry.isFile() && entry.name.endsWith('.source.json')) files.push(realpathSync(child));
  }
  return files;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, demo: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || (!positionals.length && !values.demo)) { console.log(usage); return; }
  if (values.project !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(values.project)) throw new Error('--project needs a valid project id.');
  if (values.demo && positionals.length) throw new Error('Use --demo separately from a real source import.');
  if (process.env.SPRINK_DATA_DIR !== undefined && (!process.env.SPRINK_DATA_DIR.trim() || !isAbsolute(process.env.SPRINK_DATA_DIR))) throw new Error('SPRINK_DATA_DIR must be an absolute path to persistent storage.');
  const files: string[] = [];
  const seen = new Set<string>();
  const paths = values.demo ? [DEMO_DIR] : positionals;
  for (const path of paths) {
    for (const file of packagesIn(resolve(path))) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  if (!files.length) throw new Error('No .source.json packages found in the selected folders.');
  const packages: NonNullable<ReturnType<typeof readSourcePackage>>[] = [];
  for (const file of files) {
    const pkg = readSourcePackage(file, values.project);
    if (!pkg) {
      if (values.demo) continue;
      throw new Error(`${file}: project documents need --project <projectId>. No sources were imported.`);
    }
    packages.push(pkg);
  }
  const temporary = values.check ? mkdtempSync(join(tmpdir(), 'sprink-source-check-')) : undefined;
  const dataDir = temporary ?? resolve(process.env.SPRINK_DATA_DIR ?? fileURLToPath(new URL('../.data/', import.meta.url)));
  let database: Store | undefined;
  try {
    database = new Store(dataDir);
    const store = new SourceStore(database.db);
    const documents = database.db.transaction(() => {
      const imported = [];
      for (const pkg of packages) imported.push(store.import(pkg.input, pkg.notes));
      return imported;
    })();
    for (const d of documents) console.log(`${values.check ? 'checked' : 'imported'}  ${d.id}  ${d.sectionCount} sections${d.demonstration ? '  DEMONSTRATION' : ''}${d.flags.length ? `  flags: ${d.flags.join(', ')}` : ''}`);
    console.log(`${documents.length} source package(s) ${values.check ? 'validated. The destination library was not changed; conflicts with existing documents are checked during import.' : 'imported successfully.'}`);
  } finally {
    database?.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Source import failed.'); process.exitCode = 1; }
