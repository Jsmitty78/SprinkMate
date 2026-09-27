import type { SourceStore } from './store.js';
import type { ExplanationNote, SourceDocument, SourceSection } from './types.js';

export type Role = 'main' | 'exception' | 'footnote' | 'referenced' | 'definition' | 'commentary' | 'amendment' | 'related';
export interface Retrieved { section: SourceSection; doc: SourceDocument; role: Role; via?: string; score: number; notes: ExplanationNote[] }

/** Expands the main passages with what a reader needs to apply them correctly. */
export function expand(store: SourceStore, mains: Retrieved[], applicable: SourceDocument[]): Retrieved[] {
  const out = new Map<string, Retrieved>();
  const add = (r: Retrieved) => { if (!out.has(r.section.key)) out.set(r.section.key, r); };
  // A selected child retains its explicit parent and its exception/footnote role.
  for (const m of mains) {
    const parent = m.section.parentKey ? store.section(m.section.parentKey) : null;
    if (parent) {
      add({ ...m, section: parent, role: 'referenced', notes: store.notes(parent.key) });
      add({ ...m, role: m.section.kind === 'exception' ? 'exception' : 'footnote', via: parent.sectionId });
    } else add(m.doc.type === 'local_amendment' && m.section.amends ? { ...m, role: 'amendment', via: m.section.amends } : m);
  }
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

  for (const m of [...out.values()]) {
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
  // Local amendments that change a retrieved section of the same standard and edition.
  for (const amendDoc of applicable.filter(d => d.type === 'local_amendment')) {
    for (const s of docSections.get(amendDoc.id) ?? []) {
      if (!s.amends) continue;
      const target = [...out.values()].find(r => r.doc.type === 'published_code' && (s.amends === r.section.sectionId || s.amends!.startsWith(`${r.section.sectionId}.`)));
      if (target) add({ ...withNotes(s, amendDoc, 'amendment', target.section.sectionId) });
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
