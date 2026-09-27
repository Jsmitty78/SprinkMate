/** Developer-only visual/CSV verification. Synthetic fixture, never production intake. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportFixture } from '../apps/server/test/fixtures/export-package.js';
import { renderPdf } from '../apps/server/src/exports/pdf.js';
import { csvFiles } from '../apps/server/src/exports/csv.js';
import { validateSnapshot } from '../apps/server/src/exports/snapshot.js';

const output = resolve(process.argv[2] ?? 'tmp/export-fixtures');
await mkdir(output, { recursive: true });
for (const name of ['drawing', 'adaptation', 'negative-pagination'] as const) {
  const snapshot = exportFixture(name !== 'drawing');
  if (name === 'negative-pagination') {
    Object.assign(snapshot.cuts[0], { length: null, status: 'unresolved', unresolvedReason: 'Missing manufacturer endpoint makeup: do not substitute zero.' });
    snapshot.findings.push({ id: 'SOURCE-PENDING', status: 'unknown', description: 'Required verification source is unavailable.', subjectIds: ['P1'], sourceIds: [] });
    snapshot.materials = Array.from({ length: 45 }, (_, i) => ({ ...snapshot.materials[i % 2], id: `M-LONG-${i}`, description: `Pagination fixture row ${i + 1}: lengthy material description with quoted text "sample", and multiple source references for review.` }));
    snapshot.sources[0].reference += ' Long source reference: ' + 'Review this synthetic source and confirm dimensions before use. '.repeat(80);
  }
  validateSnapshot(snapshot);
  const pdf = await renderPdf(snapshot);
  const csv = csvFiles(snapshot);
  await writeFile(resolve(output, name + '.pdf'), pdf);
  await writeFile(resolve(output, name + '-bom.csv'), csv.bom);
  await writeFile(resolve(output, name + '-cuts.csv'), csv.cuts);
  console.log(`${name}: ${pdf.length} PDF bytes; ${snapshot.materials.length} material rows`);
}
