import type { SourceStore } from './store.js';
import type { ExplanationNote, SourceDocument, SourceSection } from './types.js';

/**
 * Retrieval over the stored library.
 *
 * The existing stack has SQLite (FTS5, BM25) but no embedding model, so "meaning" search is a
 * curated field vocabulary: plain words a fitter uses ("duct is blocking", "move the pipe") are
 * expanded to the terms documents use ("obstruction", "relocated", "route change"). Exact
 * technical terms and section numbers are matched as typed.
 */

interface Concept { id: string; terms: string[]; patterns: RegExp[] }
const c = (id: string, terms: string[], stems: string[] = terms): Concept =>
  ({ id, terms, patterns: stems.map(s => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '\\w*')}`, 'i')) });

const CONCEPTS: Record<string, Concept> = {
  obstruction: c('obstruction', ['obstruction', 'duct', 'ductwork', 'beam'], ['obstruct*', 'duct*', 'beam']),
  branch: c('branch', ['branch line', 'branch'], ['branch']),
  route: c('route', ['route change', 'reroute', 'rerouted', 'rerouting', 'relocated', 'relocation', 'relocating', 'route'], ['route*', 'reroute*', 'relocat*']),
  hanger: c('hanger', ['hanger', 'hangers', 'support', 'supports'], ['hanger*', 'support*']),
  clearance: c('clearance', ['clearance', 'clear space'], ['clearance', 'clear space']),
  test: c('test', ['hydrostatically', 'tested', 'test'], ['hydrostatic*', 'test*']),
  record: c('record', ['record', 'revised drawing', 'as-built'], ['record*', 'revised drawing', 'as-built']),
  cut: c('cut', ['cut', 'cutting'], ['cut', 'cutting']),
  cement: c('cement', ['cement', 'cure', 'cured'], ['cement*', 'cure', 'cured', 'curing']),
  heat: c('heat', ['heat', 'hot-air'], ['heat*', 'hot-air']),
  approval: c('approval', ['approve', 'request for information', 'engineer of record', 'foreman'], ['approv*', 'request for information', 'engineer of record', 'foreman']),
  authority: c('authority', ['fire department', 'plan reviewer'], ['fire department', 'plan reviewer']),
  fitting: c('fitting', ['fitting', 'fittings', 'elbow', 'elbows'], ['fitting*', 'elbow*']),
  cpvc: c('cpvc', ['cpvc'], ['cpvc']),
  spacing: c('spacing', ['spacing', 'distance between'], ['spacing', 'distance between']),
  sidewall: c('sidewall', ['sidewall'], ['sidewall']),
};
/** Field words and phrases mapped to document concepts. Multi-word keys are matched first. */
const VOCAB: Array<[RegExp, string]> = [
  [/\bin the way\b|\bblock(s|ed|ing)?\b|\bclash(es|ing)?\b|\bobstruct\w*/g, 'obstruction'],
  [/\bduct(s|work)?\b|\bbeam(s)?\b/g, 'obstruction'],
  [/\bbranch(es| lines?)?\b/g, 'branch'],
  [/\b(re)?rout(e|es|ed|ing)\b|\breloca\w*|\bmov(e|es|ed|ing) the (pipe|line|branch)\b|\bgo around\b|\bjog\w*/g, 'route'],
  [/\bhangers?\b|\bsupports?\b|\bstraps?\b/g, 'hanger'],
  [/\bclearances?\b|\bclear(s)?\b|\bgap\b|\bspace\b/g, 'clearance'],
  [/\bhydro\w*|\bpressure test\w*|\btest(s|ing)?\b/g, 'test'],
  [/\brecord\w*|\bas-?built\b|\bmark-?up\b|\bdrawing(s)?\b/g, 'record'],
  [/\bcut(s|ting)?\b|\bcut-in\b/g, 'cut'],
  [/\bcement\w*|\bglue\w*|\bcur(e|ed|ing)\b/g, 'cement'],
  [/\bheat\w*|\bhot\b/g, 'heat'],
  [/\bapprov\w*|\bpermission\b|\bsign[- ]?off\b|\brfi\b|\bengineer\b|\bforeman\b|\bwho (can|may)\b/g, 'approval'],
  [/\bfire (department|marshal)\b|\binspector\b|\bahj\b|\bplan review\w*/g, 'authority'],
  [/\bfittings?\b|\belbows?\b/g, 'fitting'],
  [/\bcpvc\b/g, 'cpvc'],
  [/\bspacing\b/g, 'spacing'],
  [/\bsidewall\b/g, 'sidewall'],
];
const STOP = new Set(('a an and are around as at be before by can could do does for from have how i if in into is it its me my need needs of on or our should so that the their them then there these this to under was we what when where which while who why will with would you your ' +
  'rule rules requirement requirements required require code codes standard check checks checking sprinkler sprinklers pipe pipes piping line lines change changing changed ' +
  'nfpa section sections apply applies applicable allowed permitted any about want know tell please here site job work maximum minimum max min least most much many between also just still get got use used').split(' '));

export interface QueryPlan { concepts: Concept[]; exact: string[]; match: string }

export function planQuery(question: string): QueryPlan {
  let rest = question.toLowerCase();
  const ids = new Set<string>();
  // Section numbers typed by the user ("DEMO-8.2", "8.2.1", "Table 9.1") are matched exactly.
  const exact = [...question.matchAll(/\b(?:table\s+)?(?:[a-z]{1,6}-)*[a-z]?\.?\d+(?:\.\d+)+\b/gi)].map(m => m[0]);
  for (const [re, id] of VOCAB) rest = rest.replace(re, () => { ids.add(id); return ' '; });
  const concepts = [...ids].map(id => CONCEPTS[id]);
  for (const word of rest.split(/[^a-z0-9-]+/)) {
    if (word.length < 3 || STOP.has(word) || /^\d/.test(word)) continue;
    concepts.push(c(word, [word], [word.length > 5 ? `${word.slice(0, word.length - 2)}*` : word]));
  }
  const terms = [...new Set([...concepts.flatMap(x => x.terms), ...exact])];
  const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  return { concepts, exact, match };
}

export function conceptHits(plan: QueryPlan, s: SourceSection): string[] {
  const hay = `${s.sectionId}\n${s.heading}\n${s.text}`;
  const hits = plan.concepts.filter(k => k.patterns.some(p => p.test(hay))).map(k => k.id);
  if (plan.exact.some(e => s.sectionId.toLowerCase() === e.toLowerCase() || s.sectionId.toLowerCase().startsWith(`${e.toLowerCase()} `))) hits.push('exact');
  return hits;
}

/** A section is relevant when it matches enough of the question's concepts, not one generic word. */
export function relevant(plan: QueryPlan, hits: string[]): boolean {
  if (hits.includes('exact')) return true;
  // Half of the question's concepts, and at least two when it has two or more.
  const needed = plan.concepts.length >= 2 ? Math.max(2, Math.ceil(plan.concepts.length / 2)) : 1;
  return plan.concepts.length > 0 && new Set(hits).size >= needed;
}

export type Role = 'main' | 'exception' | 'footnote' | 'referenced' | 'definition' | 'commentary' | 'amendment' | 'related';
export interface Retrieved { section: SourceSection; doc: SourceDocument; role: Role; via?: string; score: number; notes: ExplanationNote[] }

/** Expands the main passages with what a reader needs to apply them correctly. */
export function expand(store: SourceStore, mains: Retrieved[], applicable: SourceDocument[]): Retrieved[] {
  const out = new Map<string, Retrieved>();
  const add = (r: Retrieved) => { if (!out.has(r.section.key)) out.set(r.section.key, r); };
  // An amendment found directly is still shown as an amendment of the section it changes.
  mains.forEach(m => add(m.doc.type === 'local_amendment' && m.section.amends ? { ...m, role: 'amendment', via: m.section.amends } : m));
  const docSections = new Map(applicable.map(d => [d.id, store.sections(d.id)]));
  const topSection = (docId: string, ref: string) => {
    const list = docSections.get(docId) ?? [];
    const exact = list.find(s => s.sectionId === ref);
    if (exact) return exact;
    // "DEMO-9.1.1" lives inside section "DEMO-9.1": use the longest section id that prefixes the reference.
    return list.filter(s => s.parentKey === null && ref.startsWith(`${s.sectionId}.`)).sort((a, b) => b.sectionId.length - a.sectionId.length)[0];
  };
  const withNotes = (section: SourceSection, doc: SourceDocument, role: Role, via: string): Retrieved =>
    ({ section, doc, role, via, score: 0, notes: store.notes(section.key) });

  for (const m of mains) {
    const list = docSections.get(m.doc.id) ?? [];
    for (const child of list.filter(s => s.parentKey === m.section.key))
      add(withNotes(child, m.doc, child.kind === 'exception' ? 'exception' : 'footnote', m.section.sectionId));
    for (const ref of m.section.references) {
      const target = topSection(m.doc.id, ref);
      if (target && target.key !== m.section.key) {
        add(withNotes(target, m.doc, 'referenced', m.section.sectionId));
        for (const child of list.filter(s => s.parentKey === target.key)) add(withNotes(child, m.doc, child.kind === 'exception' ? 'exception' : 'footnote', target.sectionId));
      }
    }
  }
  // Definitions for terms the retrieved passages use, from the same document.
  for (const r of [...out.values()]) {
    for (const def of (docSections.get(r.doc.id) ?? []).filter(s => s.kind === 'definition')) {
      const term = def.heading.replace(/\.$/, '');
      if (term.length > 2 && new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(r.section.text)) add(withNotes(def, r.doc, 'definition', r.section.sectionId));
    }
  }
  // Annex/commentary that explains a retrieved section ("DEMO-A.8.2" explains "DEMO-8.2").
  for (const r of [...out.values()]) {
    const num = /(\d+(?:\.\d+)+)$/.exec(r.section.sectionId)?.[1];
    if (!num) continue;
    for (const com of (docSections.get(r.doc.id) ?? []).filter(s => s.kind === 'commentary' && s.sectionId.endsWith(`A.${num}`)))
      add(withNotes(com, r.doc, 'commentary', r.section.sectionId));
  }
  // Local amendments that change a retrieved section of the same standard and edition.
  for (const amendDoc of applicable.filter(d => d.type === 'local_amendment')) {
    for (const s of docSections.get(amendDoc.id) ?? []) {
      if (!s.amends) continue;
      const target = [...out.values()].find(r => r.doc.type === 'published_code' && (s.amends === r.section.sectionId || s.amends!.startsWith(`${r.section.sectionId}.`)));
      if (target) add({ ...withNotes(s, amendDoc, 'amendment', target.section.sectionId) });
    }
  }
  // Passages whose notes share a topic with a retrieved passage (for example two clearance values).
  const topics = new Set([...out.values()].flatMap(r => r.notes.map(n => n.topic).filter(Boolean)));
  if (topics.size) {
    for (const d of applicable) for (const s of docSections.get(d.id) ?? []) {
      if (out.has(s.key)) continue;
      const notes = store.notes(s.key);
      const shared = notes.find(n => n.topic && topics.has(n.topic));
      if (shared) add({ section: s, doc: d, role: 'related', via: `topic: ${shared.topic}`, score: 0, notes });
    }
  }
  return [...out.values()];
}

export interface Conflict { topic: string; items: Array<{ key: string; position: string }>; resolution: string }

/** Different positions on one topic from different documents. Sprink shows them; it never picks one. */
export function conflicts(items: Retrieved[]): Conflict[] {
  const byTopic = new Map<string, Array<{ key: string; position: string; docId: string }>>();
  for (const r of items) for (const n of r.notes) {
    if (!n.topic || !n.position) continue;
    byTopic.set(n.topic, [...(byTopic.get(n.topic) ?? []), { key: r.section.key, position: n.position, docId: r.doc.id }]);
  }
  const out: Conflict[] = [];
  for (const [topic, list] of byTopic) {
    if (new Set(list.map(x => x.docId)).size < 2 || new Set(list.map(x => x.position)).size < 2) continue;
    const docTypes = new Set(list.map(x => items.find(i => i.section.key === x.key)!.doc.type));
    const resolution = docTypes.has('local_amendment')
      ? 'A local amendment changes this requirement. Confirm with the authority having jurisdiction which wording is adopted for this permit.'
      : 'These documents say different things. Confirm with the engineer of record or project manager which one governs before you work.';
    out.push({ topic, items: list.map(({ key, position }) => ({ key, position })), resolution });
  }
  return out;
}
