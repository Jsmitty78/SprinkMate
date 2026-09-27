import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { parseDocument } from './parse.js';
import {
  SOURCE_TYPES, type ExplanationFile, type ExplanationNote, type QualityFlag, type SourceDocument,
  type SourceDocumentInput, type SourceSection,
} from './types.js';

export class SourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new SourceError(status, code, message); };
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const text = (v: unknown, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Stored in the application's existing SQLite database, beside work packages. */
export class SourceStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_documents (id TEXT PRIMARY KEY, data TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_sections (key TEXT PRIMARY KEY, doc_id TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS source_sections_doc ON source_sections(doc_id, ord);
      CREATE TABLE IF NOT EXISTS source_notes (section_key TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(section_key UNINDEXED, doc_id UNINDEXED, section_id, heading, body, tokenize = 'porter unicode61');
    `);
  }

  /** Validates authorization and metadata, splits the text, and stores it. Same id and bytes is a no-op. */
  import(input: SourceDocumentInput, notes?: ExplanationFile): SourceDocument {
    validate(input);
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const prior = this.db.prepare('SELECT sha256 FROM source_documents WHERE id=?').get(input.id) as { sha256: string } | undefined;
    if (prior) {
      if (prior.sha256 !== sha256) fail(409, 'document_id_conflict', `A different document is already stored as ${input.id}. Import a new edition or revision under its own id.`);
      return this.document(input.id)!;
    }
    const sections = parseDocument(input);
    if (!sections.length) fail(400, 'no_sections', 'No sections were found. Use headings such as "## 8.2 Title" and page markers "<!-- page: 12 -->".');
    const docFlags = [...new Set(sections.flatMap(s => s.flags))] as QualityFlag[];
    const { content, ...meta } = input;
    const doc: SourceDocument = { ...meta, sha256, importedAt: new Date().toISOString(), sectionCount: sections.length, flags: docFlags };
    const resolvedNotes = notes ? resolveNotes(sections, notes) : [];
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO source_documents(id,data,content,sha256) VALUES(?,?,?,?)').run(doc.id, JSON.stringify(doc), content, sha256);
      const ins = this.db.prepare('INSERT INTO source_sections(key,doc_id,ord,data) VALUES(?,?,?,?)');
      const fts = this.db.prepare('INSERT INTO source_fts(section_key,doc_id,section_id,heading,body) VALUES(?,?,?,?,?)');
      for (const s of sections) {
        ins.run(s.key, s.docId, s.order, JSON.stringify(s));
        fts.run(s.key, s.docId, s.sectionId, s.heading, s.text);
      }
      const note = this.db.prepare('INSERT INTO source_notes(section_key,data) VALUES(?,?)');
      for (const n of resolvedNotes) note.run(n.sectionKey, JSON.stringify(n));
    })();
    return doc;
  }

  documents(): SourceDocument[] {
    return (this.db.prepare('SELECT data FROM source_documents ORDER BY id').all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  document(id: string): SourceDocument | undefined {
    const row = this.db.prepare('SELECT data FROM source_documents WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  content(id: string): string | undefined {
    return (this.db.prepare('SELECT content FROM source_documents WHERE id=?').get(id) as { content: string } | undefined)?.content;
  }
  sections(docId: string): SourceSection[] {
    return (this.db.prepare('SELECT data FROM source_sections WHERE doc_id=? ORDER BY ord').all(docId) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  section(key: string): SourceSection | undefined {
    const row = this.db.prepare('SELECT data FROM source_sections WHERE key=?').get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  notes(key: string): ExplanationNote[] {
    return (this.db.prepare('SELECT data FROM source_notes WHERE section_key=?').all(key) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  /** Full-text search with BM25 ranking. The query is built by retrieve.ts from escaped terms only. */
  search(match: string, limit = 60, docIds?: string[]): Array<{ key: string; docId: string; rank: number }> {
    if (docIds) return (this.db.prepare('SELECT section_key AS key, doc_id AS docId, bm25(source_fts, 0, 0, 4, 3, 1) AS rank FROM source_fts WHERE source_fts MATCH ? AND doc_id IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT ?')
      .all(match, JSON.stringify(docIds), limit) as Array<{ key: string; docId: string; rank: number }>);
    return (this.db.prepare('SELECT section_key AS key, doc_id AS docId, bm25(source_fts, 0, 0, 4, 3, 1) AS rank FROM source_fts WHERE source_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(match, limit) as Array<{ key: string; docId: string; rank: number }>);
  }
  /** Records where each passage sits on its uploaded page images, for highlighting in the viewer. */
  setRegions(docId: string, regions: Record<string, NonNullable<SourceSection['regions']>>) {
    const upd = this.db.prepare('UPDATE source_sections SET data=? WHERE key=? AND doc_id=?');
    this.db.transaction(() => {
      for (const s of this.sections(docId)) if (regions[s.key]) upd.run(JSON.stringify({ ...s, regions: regions[s.key] }), s.key, docId);
    })();
  }
  /** True when every section of the document is in the full-text index and a search finds it. */
  searchable(docId: string): boolean {
    const sections = this.sections(docId);
    const indexed = (this.db.prepare('SELECT count(*) AS n FROM source_fts WHERE doc_id=?').get(docId) as { n: number }).n;
    if (!sections.length || indexed !== sections.length) return false;
    const probe = sections.map(s => `${s.heading} ${s.text}`.toLowerCase().match(/[a-z]{5,}/g) ?? []).flat()[0];
    if (!probe) return true;
    return this.search(`"${probe}"`, 200).some(h => h.docId === docId);
  }
  remove(id: string) {
    this.db.transaction(() => {
      const keys = (this.db.prepare('SELECT key FROM source_sections WHERE doc_id=?').all(id) as { key: string }[]).map(r => r.key);
      for (const k of keys) this.db.prepare('DELETE FROM source_notes WHERE section_key=?').run(k);
      this.db.prepare('DELETE FROM source_fts WHERE doc_id=?').run(id);
      this.db.prepare('DELETE FROM source_sections WHERE doc_id=?').run(id);
      this.db.prepare('DELETE FROM source_documents WHERE id=?').run(id);
    })();
  }
}

function validate(d: SourceDocumentInput) {
  if (!d || typeof d !== 'object') fail(400, 'invalid_document', 'Document metadata is required.');
  if (!ID.test(d.id ?? '')) fail(400, 'invalid_id', 'Document id must be 1-120 letters, digits, dots, dashes or underscores.');
  for (const f of ['title', 'publisher', 'edition', 'filename'] as const) if (!text(d[f])) fail(400, `missing_${f}`, `The document ${f} is required.`);
  if (!SOURCE_TYPES.includes(d.type)) fail(400, 'invalid_type', `Document type must be one of: ${SOURCE_TYPES.join(', ')}.`);
  if (typeof d.demonstration !== 'boolean') fail(400, 'missing_demonstration', 'Say whether this is a demonstration document.');
  const a = d.authorization;
  // Authorization is stated by the importer and never assumed (for example from a subscription).
  if (!a || !text(a.basis, 2000)) fail(400, 'authorization_required', 'State who authorized storing and using this document, and on what basis.');
  if (a.storeAndIndex !== true) fail(403, 'not_authorized_to_store', 'This document is not authorized for storage and indexing, so it was not imported.');
  if (a.useWithAi !== true) fail(403, 'not_authorized_for_ai', 'This document is not authorized for use with AI features, so it was not imported.');
  if (!['full', 'excerpt', 'reference_only'].includes(a.display)) fail(400, 'invalid_display', 'Display must be full, excerpt or reference_only.');
  if (a.display === 'excerpt' && !(Number.isInteger(a.maxQuoteChars) && a.maxQuoteChars! > 0)) fail(400, 'invalid_quote_limit', 'An excerpt display needs a positive maxQuoteChars.');
  if (d.url !== undefined && !/^https?:\/\//.test(d.url)) fail(400, 'invalid_url', 'The source link must be an http(s) URL.');
  if (typeof d.content !== 'string' || !d.content.trim() || d.content.length > 5_000_000) fail(400, 'invalid_content', 'The document text is empty or too large.');
  const s = d.scope ?? {};
  if ((d.type === 'published_code' || d.type === 'local_amendment') && !text(s.standard, 60)) fail(400, 'missing_standard', 'Codes and amendments need scope.standard (for example nfpa13).');
  if (d.type === 'local_amendment' && (!text(s.jurisdiction, 60) || !text(s.amendsEdition, 60))) fail(400, 'missing_jurisdiction', 'Local amendments need scope.jurisdiction and scope.amendsEdition.');
  if (d.type === 'project_document' && !text(s.projectId, 120)) fail(400, 'missing_project', 'Project documents need scope.projectId.');
  if (d.type === 'manufacturer' && !(Array.isArray(s.productIds) && s.productIds.length)) fail(400, 'missing_products', 'Manufacturer documents need scope.productIds.');
}

const validCondition = (c: unknown): boolean => {
  const x = c as ExplanationNote['conditions'] extends (infer T)[] | undefined ? Partial<T> : never;
  return !!x && typeof x === 'object' && text(x.id, 120) && text(x.question, 400) && !!x.input && text(x.input.name, 60) && (x.input.unit === 'mm' || x.input.unit === 'count')
    && !!x.appliesWhen && ['<=', '<', '>=', '>'].includes(x.appliesWhen.op) && typeof x.appliesWhen.value === 'number' && Number.isFinite(x.appliesWhen.value);
};

function resolveNotes(sections: SourceSection[], file: ExplanationFile): ExplanationNote[] {
  if (!text(file.author, 200) || !Array.isArray(file.notes)) fail(400, 'invalid_notes', 'Explanation notes need an author and a notes list.');
  return file.notes.map(n => {
    const target = sections.find(s => s.sectionId === n.sectionId);
    if (!target) fail(400, 'note_section_missing', `Explanation note refers to section ${n.sectionId}, which is not in the document.`);
    if (!text(n.text, 4000)) fail(400, 'invalid_note', `The note for ${n.sectionId} needs text (up to 4000 characters).`);
    if ((n.topic !== undefined && !text(n.topic, 120)) || (n.position !== undefined && !text(n.position, 400))) fail(400, 'invalid_note', `The note for ${n.sectionId} has an invalid topic or position.`);
    if (n.conditions !== undefined && !(Array.isArray(n.conditions) && n.conditions.every(validCondition))) fail(400, 'invalid_note', `The note for ${n.sectionId} has an invalid condition. Each needs an id, a question, an input name with unit mm or count, and a comparison with a number.`);
    return { sectionKey: target!.key, text: n.text, author: file.author, topic: n.topic, position: n.position, conditions: n.conditions };
  });
}
