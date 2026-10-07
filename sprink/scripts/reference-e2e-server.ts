/** Local software-test server. Never uses real rules, keys or provider calls. */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FieldService } from '../apps/server/src/service.js';
import { createApp } from '../apps/server/src/api.js';
import { SourceStore, SourceError } from '../apps/server/src/sources/store.js';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const dir = mkdtempSync(join(tmpdir(), 'sprink-browser-fixtures-'));
const field = new FieldService(dir);
const sources = new SourceStore(field.store.db);
for (const id of ['fixture-a', 'fixture-b']) sources.import({
  id, title: `TEST ONLY reference ${id}`, publisher: 'Browser test fixture', edition: id === 'fixture-a' ? 'Test edition A' : 'Test edition B',
  type: 'published_code', scope: { standard: 'test-only' }, demonstration: false,
  filename: `${id}.md`, authorization: { basis: 'Authored test fixture only', storeAndIndex: true, useWithAi: true, display: 'full' },
  content: '<!-- page: 1 -->\n## TEST-1 Main clause\nTest fixture: review the synthetic part. Not a real installation rule.\n## TEST-1 Exception\nTest fixture exception: synthetic condition only. Not a real installation rule.\n',
});
const app = createApp(field, { token: 'sprinkmate-browser-test-only', sources, webDir: resolve('apps/web/dist'), sourceSearch: {
  async select(question, passages) {
    if (question.includes('unconfigured')) throw new SourceError(503, 'source_search_not_configured', 'Unconfigured test');
    if (question.includes('absent')) return [];
    const keys: string[] = [];
    for (const passage of passages) keys.push(passage.section.key);
    return keys;
  },
} });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4337 }, () => console.log('Reference test server on 4337; test fixtures only'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => {
  field.store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0);
}));
