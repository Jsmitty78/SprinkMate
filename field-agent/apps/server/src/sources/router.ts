import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { WorkPackageSnapshot } from '@field-agent/core';
import { ask, AskInputError, type AskRequest } from './ask.js';
import { loadDemoSources } from './demo.js';
import { SourceError, type SourceStore } from './store.js';
import type { ExplanationFile, SourceDocumentInput } from './types.js';

const TEXT_FILE = /\.(md|markdown|txt)$/i;

/** Mount only under the authenticated /api middleware. */
export function sourceRouter(store: SourceStore, loadPackage?: (id: string) => WorkPackageSnapshot) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof SourceError) return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
    if (error instanceof AskInputError) return c.json({ error: error.message, code: 'invalid_question' }, 400);
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON', code: 'invalid_json' }, 400);
    return c.json({ error: 'Source library operation failed', code: 'internal_error' }, 500);
  });

  app.get('/sources', c => c.json({ documents: store.documents() }));
  app.post('/sources', async c => {
    const body = await c.req.json() as { document?: SourceDocumentInput; explanations?: ExplanationFile };
    const doc = body?.document;
    if (!doc || typeof doc !== 'object') throw new SourceError(400, 'invalid_document', 'Send { document: {...metadata, content, filename} }.');
    if (typeof doc.filename !== 'string' || !TEXT_FILE.test(doc.filename))
      throw new SourceError(415, 'unsupported_file', 'Import text or Markdown (.md, .txt). PDF text extraction and OCR are not part of the current stack; extract the text first and mark it as OCR if it came from a scan.');
    return c.json(store.import(doc, body.explanations), 201);
  });
  app.post('/sources/demo', async c => {
    const body = await c.req.json().catch(() => ({})) as { projectId?: string };
    const projectId = typeof body.projectId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(body.projectId) ? body.projectId : undefined;
    return c.json({ documents: loadDemoSources(store, projectId) }, 201);
  });
  app.get('/sources/:docId', c => {
    const doc = store.document(c.req.param('docId'));
    if (!doc) throw new SourceError(404, 'not_found', 'Document not found.');
    return c.json({ document: doc, sections: store.sections(doc.id).map(s => view(doc.authorization, s)) });
  });
  app.get('/sources/:docId/sections/:key', c => {
    const doc = store.document(c.req.param('docId'));
    const section = store.section(c.req.param('key'));
    if (!doc || !section || section.docId !== doc.id) throw new SourceError(404, 'not_found', 'Passage not found.');
    const all = store.sections(doc.id);
    const top = section.parentKey ? all.find(s => s.key === section.parentKey)! : section;
    // The passage in place: its section, its exceptions and notes, and the neighbouring sections.
    const i = all.findIndex(s => s.key === top.key);
    const around = all.filter((s, j) => s.parentKey === top.key || s.key === top.key || (s.parentKey === null && Math.abs(j - i) <= 3));
    return c.json({ document: doc, target: section.key, sections: around.map(s => ({ ...view(doc.authorization, s), notes: store.notes(s.key).map(n => ({ text: n.text, author: n.author })) })) });
  });
  app.get('/sources/:docId/file', c => {
    const doc = store.document(c.req.param('docId'));
    if (!doc) throw new SourceError(404, 'not_found', 'Document not found.');
    if (doc.authorization.display !== 'full') throw new SourceError(403, 'display_limited', 'This source limits display. Use the original link.');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return c.body(store.content(doc.id)!);
  });
  app.post('/ask', async c => {
    const body = await c.req.json() as AskRequest;
    if (!body || typeof body !== 'object') throw new AskInputError('Send a question.');
    let snapshot: WorkPackageSnapshot | null = null;
    if (body.packageId) {
      if (!loadPackage) throw new AskInputError('Work packages are not available on this server.');
      try { snapshot = loadPackage(body.packageId); } catch { throw new AskInputError('That work package could not be opened.'); }
    }
    return c.json(ask(store, body, snapshot));
  });
  return app;
}

function view(a: import('./types.js').SourceAuthorization, s: import('./types.js').SourceSection) {
  if (a.display === 'reference_only') return { ...s, text: '', table: null, limited: 'reference_only' };
  if (a.display === 'excerpt' && s.text.length > a.maxQuoteChars!) return { ...s, text: `${s.text.slice(0, a.maxQuoteChars)}…`, table: null, limited: 'excerpt' };
  return { ...s, limited: null };
}
