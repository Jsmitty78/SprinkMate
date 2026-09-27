import { randomUUID } from 'node:crypto';
import { resolveSfNfpa13Edition, type Evidence, type Fact, type SfProjectFacts, type WorkPackageSnapshot } from '@field-agent/core';
import { conceptHits, conflicts as findConflicts, expand, planQuery, relevant, type Conflict, type Retrieved, type Role } from './retrieve.js';
import type { SourceStore } from './store.js';
import { pipeDuctClearance, straightCutLength, toMm, type Box, type CalculationResult, type Origin, type Point } from './tools.js';
import { QUALITY_LABEL, SOURCE_TYPE_LABEL, type ExplanationCondition, type SourceDocument } from './types.js';

export const NO_SOURCE = "I couldn't find a supporting source in the project library.";

export interface AskRequest {
  question: string;
  packageId?: string;
  /** Piece selected on the drawing workspace. Defaults to the site condition's affected piece. */
  selectedElementId?: string;
  /** Values the user typed in the Ask panel, e.g. {name: "obstructionWidth", value: 450, unit: "mm"}. */
  measurements?: Array<{ name: string; value: number; unit: string }>;
  /** Answers to focused follow-up questions. Kept for this question only, not saved to the package. */
  answers?: { nfpa13Edition?: string; jurisdiction?: string };
}

export interface ContextFact { name: string; label: string; value: string | number | null; unit: string | null; origin: Origin | 'document'; detail: string }
export interface FollowUp { id: string; question: string; kind: 'choice' | 'measurement'; field: string; options?: Array<{ value: string; label: string }>; unit?: string }
export interface Citation {
  key: string; docId: string; docTitle: string; publisher: string; type: SourceDocument['type']; typeLabel: string; edition: string;
  sectionId: string; heading: string; kind: string; label: string; role: Role; via?: string;
  pageStart: number | null; pageEnd: number | null; demonstration: boolean;
  flags: Array<{ flag: string; label: string }>;
  quote: string | null; quoteNote: string | null; table: string[][] | null;
  notes: Array<{ text: string; author: string }>;
  link: string; original: string | null;
}
export interface Claim { id: string; text: string; citations: string[]; kind: 'note' | 'pointer'; status: 'supported' | 'unresolved'; reason?: string }
export interface ConditionCheck { question: string; name: string; value: number | null; unit: string; origin: ContextFact['origin'] | null; detail: string | null; op: string; limit: number; result: 'met' | 'not_met' | 'unknown' }
export interface ExceptionStatus { key: string; sectionId: string; parentSectionId: string; status: 'applies' | 'does_not_apply' | 'unknown'; checks: ConditionCheck[]; note: string }
export interface AskAnswer {
  id: string; question: string; askedAt: string;
  classification: { kind: 'source' | 'calculation' | 'both'; reason: string };
  context: {
    projectId: string | null; packageTitle: string | null; standard: string | null;
    edition: { value: string | null; status: 'resolved' | 'answered' | 'unknown'; reason: string; script?: string };
    jurisdiction: string | null; selectedElementId: string | null;
    siteCondition: { id: string; description: string } | null;
    facts: ContextFact[];
  };
  status: 'answered' | 'needs_input' | 'no_source' | 'calculation_only';
  summary: string;
  explanation: Claim[];
  unresolved: Claim[];
  exceptions: ExceptionStatus[];
  missing: string[];
  followUps: FollowUp[];
  sources: Citation[];
  conflicts: Array<Conflict & { items: Array<{ key: string; position: string; label: string }> }>;
  excluded: Array<{ docId: string; title: string; edition: string; reason: string }>;
  calculation: CalculationResult | null;
  timings: { retrievalMs: number; calculationMs: number; totalMs: number };
}

/** Pluggable explanation writer. The default uses stored notes; any writer's claims are re-validated. */
export type Composer = (items: Retrieved[]) => Array<Omit<Claim, 'status' | 'reason' | 'id'>>;

export const notesComposer: Composer = items => items
  .filter(r => ['main', 'referenced', 'amendment', 'related'].includes(r.role))
  .map(r => r.notes.length
    ? { text: r.notes[0].text, citations: [r.section.key], kind: 'note' as const }
    : { text: `${r.section.sectionId}: ${r.section.heading}. Read the source wording.`, citations: [r.section.key], kind: 'pointer' as const });

// ------------------------------------------------------------------ classification

const CALC = /\b(how long|cut length|cut it|what length|cent(er|re)[- ]to[- ]cent(er|re)|c-c|calculate|compute|will (it|the pipe|this|the branch) (still )?(clear|fit)|does (it|the pipe|this|the branch) clear|how (much|far) (room|gap|space|clearance)|gap between|clear the duct|if (i|we) (drop|lower|raise|move))\b/i;
const SOURCE = /\b(rules?|requirements?|required|code|allowed|permitted|may (i|we)|can (i|we)|need to|have to|shall|must|standard|spec(ification)?|procedure|exception|minimum|maximum|what does|which|before|who)\b/i;

export function classify(question: string): AskAnswer['classification'] {
  const calc = CALC.test(question), source = SOURCE.test(question);
  if (calc && source) return { kind: 'both', reason: 'The question asks for a value and for the rule behind it.' };
  if (calc) return { kind: 'calculation', reason: 'The question asks for a computed value.' };
  return { kind: 'source', reason: 'The question asks what the documents require.' };
}

// ------------------------------------------------------------------ context

const LENGTH_UNITS = new Set(['mm', 'm', 'in', 'ft']);
const MEASUREMENTS: Record<string, { label: string; kind: 'length' | 'count' }> = {
  obstructionWidth: { label: 'Duct width along the original pipe', kind: 'length' },
  addedFittings: { label: 'Fittings the new route adds', kind: 'count' },
  verticalOffset: { label: 'Vertical move of the pipe (negative is down)', kind: 'length' },
  centerToCenter: { label: 'Center-to-center length', kind: 'length' },
};

export class AskInputError extends Error {}

interface Context {
  snapshot: WorkPackageSnapshot | null;
  facts: ContextFact[];
  values: Map<string, ContextFact>;
  standard: string | null;
  edition: AskAnswer['context']['edition'];
  jurisdiction: string | null;
  productIds: string[];
  selected: { id: string; start: Point | null; end: Point | null; origin: Origin; detail: string } | null;
  duct: { box: Box; origin: Origin; detail: string } | null;
}

function packageFact(s: WorkPackageSnapshot, field: string) {
  const all = [...s.detailing, ...s.siteFacts].filter(f => f.field === field && f.subjectIds.length === 0);
  return all.length === 1 ? all[0] : undefined;
}
const isSample = (f: { source: { description: string } }) => f.source.description.startsWith('SAMPLE');
const originOf = (f: { source: { description: string } }): Origin => isSample(f) ? 'sample' : 'project';

function buildContext(req: AskRequest, snapshot: WorkPackageSnapshot | null): Context {
  const facts: ContextFact[] = [];
  const values = new Map<string, ContextFact>();
  const put = (f: ContextFact, key = f.name) => { facts.push(f); if (!values.has(key) || f.origin === 'you') values.set(key, f); };
  let standard: string | null = null, jurisdiction: string | null = null;
  let edition: Context['edition'] = { value: null, status: 'unknown', reason: 'No project is open, so the code edition is not known.' };
  let selected: Context['selected'] = null, duct: Context['duct'] = null;
  const productIds: string[] = [];

  if (snapshot) {
    const confirmed = (field: string) => { const f = packageFact(snapshot, field); return f && f.confirmation === 'confirmed' && f.value !== null ? f : undefined; };
    for (const [field, label] of [['jurisdiction', 'Jurisdiction'], ['standard', 'Standard'], ['permitKind', 'Permit kind'], ['originalNfpa13Edition', 'NFPA 13 edition of the original permit'], ['originalFirePermitNumber', 'Original fire permit number']] as const) {
      const f = packageFact(snapshot, field);
      if (!f) continue;
      put({ name: field, label, value: f.value as string, unit: null, origin: originOf(f), detail: f.confirmation === 'confirmed' ? `Confirmed in the work package: ${f.source.description}` : `Proposed, not confirmed: ${f.source.description}` });
    }
    standard = (confirmed('standard')?.value as string) ?? null;
    jurisdiction = (confirmed('jurisdiction')?.value as string) ?? null;
    edition = resolveEdition(snapshot);
    for (const e of snapshot.baselinePlan?.entities ?? []) if (e.productId && !productIds.includes(e.productId)) productIds.push(e.productId);
    const sampleRun = snapshot.sourceDrawing?.drawingId.startsWith('SAMPLE') === true;
    const findPipe = (id: string | null | undefined) => snapshot.baselinePlan?.entities.find(e => e.id === id && e.kind === 'pipe');
    let piece = findPipe(req.selectedElementId ?? snapshot.changeRequest?.affectedEntityIds[0]);
    if (req.selectedElementId && !piece) {
      // A piece of a generated route is not part of the confirmed run; fall back to the affected piece and say so.
      piece = findPipe(snapshot.changeRequest?.affectedEntityIds[0]);
      put({ name: 'selectionNote', label: 'Selection', value: `${req.selectedElementId} is not a piece of the confirmed run`, unit: null, origin: 'project',
        detail: piece ? `Used the site condition's affected piece ${piece.id} instead.` : 'No piece was used.' });
    }
    if (piece) {
      const [a, b] = piece.ports;
      selected = { id: piece.id, start: a?.position ?? null, end: b?.position ?? null, origin: sampleRun ? 'sample' : 'project',
        detail: `From the ${snapshot.baselinePlan!.confirmation} run on drawing ${snapshot.sourceDrawing?.drawingId ?? '(none)'}` };
      put({ name: 'selectedElement', label: 'Selected piece', value: piece.id, unit: null, origin: selected.origin, detail: selected.detail });
    }
    const boxFacts = ['min.x', 'min.y', 'min.z', 'max.x', 'max.y', 'max.z'].map(k => packageFact(snapshot, `duct.${k}`));
    if (boxFacts.every(f => f && f.confirmation === 'confirmed' && typeof f.value === 'number' && f.unit === 'mm')) {
      const v = boxFacts.map(f => f!.value as number);
      const origin = boxFacts.some(f => isSample(f!)) ? 'sample' : 'project';
      duct = { box: { min: { x: v[0], y: v[1], z: v[2] }, max: { x: v[3], y: v[4], z: v[5] } }, origin, detail: 'Measured duct box confirmed in the work package' };
      put({ name: 'ductBox', label: 'Measured duct box', value: `x ${v[0]}–${v[3]}, y ${v[1]}–${v[4]}, z ${v[2]}–${v[5]}`, unit: 'mm', origin, detail: duct.detail });
      // Derived: how wide the duct is along the selected piece, for exceptions that depend on it.
      if (selected?.start && selected.end) {
        const axes = (['x', 'y', 'z'] as const).filter(k => selected!.start![k] !== selected!.end![k]);
        if (axes.length === 1) {
          const k = axes[0];
          put({ name: 'obstructionWidth', label: MEASUREMENTS.obstructionWidth.label, value: v[3 + 'xyz'.indexOf(k)] - v['xyz'.indexOf(k)], unit: 'mm', origin: 'derived',
            detail: `Duct box extent along piece ${selected.id} (${k} axis), from the measured duct box` });
        }
      }
    }
    if (snapshot.changeRequest) put({ name: 'siteCondition', label: 'Site condition', value: snapshot.changeRequest.description, unit: null, origin: originOf({ source: { description: snapshot.changeRequest.description } }), detail: 'Reported in the work package' });
  }

  // Answers to follow-ups apply to this question only.
  if (req.answers?.jurisdiction && !jurisdiction) {
    jurisdiction = req.answers.jurisdiction;
    put({ name: 'jurisdiction', label: 'Jurisdiction', value: jurisdiction, unit: null, origin: 'you', detail: 'Answered in Ask Sprink (not saved to the package)' });
  }
  const answered = req.answers?.nfpa13Edition;
  if (answered && answered !== 'unsure') {
    if (edition.status === 'resolved' && edition.value !== answered)
      edition = { ...edition, reason: `${edition.reason} Your answer (${answered}) differs from the project records, so it was not used. Fix the project inputs if the records are wrong.` };
    else if (edition.status !== 'resolved') {
      edition = { value: answered, status: 'answered', reason: `You said NFPA 13 ${answered} applies. This answer is not saved to the package.` };
      standard = standard ?? 'nfpa13';
    }
  }
  for (const m of req.measurements ?? []) {
    const spec = MEASUREMENTS[m.name];
    if (!spec) throw new AskInputError(`Unknown measurement "${m.name}".`);
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) throw new AskInputError(`${spec.label} must be a number.`);
    if (spec.kind === 'length' && !LENGTH_UNITS.has(m.unit)) throw new AskInputError(`${spec.label} needs a length unit (mm, m, in or ft).`);
    if (spec.kind === 'count' && (m.unit !== 'count' || !Number.isInteger(m.value) || m.value < 0)) throw new AskInputError(`${spec.label} must be a whole number.`);
    if (spec.kind === 'length' && m.name !== 'verticalOffset' && m.value <= 0) throw new AskInputError(`${spec.label} must be greater than 0.`);
    put({ name: m.name, label: spec.label, value: m.value, unit: m.unit, origin: 'you', detail: 'Entered by you in Ask Sprink' });
  }
  return { snapshot, facts, values, standard, edition, jurisdiction, productIds, selected, duct };
}

/** Uses the existing San Francisco edition resolver. The newest edition is never assumed. */
function resolveEdition(s: WorkPackageSnapshot): AskAnswer['context']['edition'] {
  const f = (field: string): Fact<never> | undefined => {
    const x = packageFact(s, field);
    return x ? { value: x.value as never, confirmed: x.confirmation === 'confirmed', evidenceIds: [x.id], source: 'manual' } : undefined;
  };
  const j = packageFact(s, 'jurisdiction');
  if (!j || j.confirmation !== 'confirmed') return { value: null, status: 'unknown', reason: 'The jurisdiction is not confirmed in the project inputs, so the adopted edition is not known.' };
  if (j.value !== 'san_francisco') return { value: null, status: 'unknown', reason: `No edition resolver exists for jurisdiction "${j.value}". Confirm the adopted edition.` };
  const facts = { jurisdiction: f('jurisdiction')!, standard: f('standard')!, permitKind: f('permitKind')!,
    ...Object.fromEntries(['sitePermitCodeCycle', 'architecturalPermitCodeCycle', 'editionElection', 'ownerRequestedEdition', 'originalFirePermitNumber', 'originalNfpa13Edition']
      .map(k => [k, f(k)]).filter(([, v]) => v)) } as SfProjectFacts;
  const observations: Evidence[] = [...s.detailing, ...s.siteFacts].map(x => ({ id: x.id, targetId: s.projectId }));
  const r = resolveSfNfpa13Edition(facts, { targetId: s.projectId, taskRevision: s.inputRevision, observations });
  const script = 'resolveSfNfpa13Edition (@field-agent/core, SFFD AB 2.04 Note 1)';
  if (r.status === 'resolved') return { value: r.nfpa13Edition, status: 'resolved', reason: `${r.reason} Resolved from the package's confirmed permit facts; no permit record is attached.`, script };
  return { value: null, status: 'unknown', reason: `${r.reason}${r.missingInputs.length ? ` Missing: ${r.missingInputs.join(', ')}.` : ''}`, script };
}

// ------------------------------------------------------------------ applicability of documents

function applicability(doc: SourceDocument, ctx: Context): { ok: boolean; reason: string; blockedBy?: 'edition' | 'jurisdiction' | 'standard' } {
  switch (doc.type) {
    case 'published_code':
      if (!ctx.standard) return { ok: false, reason: 'The project standard is not confirmed.', blockedBy: 'standard' };
      if (doc.scope.standard !== ctx.standard) return { ok: false, reason: `This document covers ${doc.scope.standard}, not the project standard ${ctx.standard}.` };
      if (!ctx.edition.value) return { ok: false, reason: 'The applicable edition is not confirmed, so no edition was chosen.', blockedBy: 'edition' };
      if (doc.edition !== ctx.edition.value) return { ok: false, reason: `Edition ${doc.edition} is not the project's edition (${ctx.edition.value}). It was not substituted.` };
      return { ok: true, reason: '' };
    case 'local_amendment':
      if (!ctx.jurisdiction) return { ok: false, reason: 'The jurisdiction is not confirmed.', blockedBy: 'jurisdiction' };
      if (doc.scope.jurisdiction !== ctx.jurisdiction) return { ok: false, reason: `This amendment is for ${doc.scope.jurisdiction}, not ${ctx.jurisdiction}.` };
      if (!ctx.edition.value) return { ok: false, reason: 'The applicable edition is not confirmed.', blockedBy: 'edition' };
      if (doc.scope.amendsEdition !== ctx.edition.value) return { ok: false, reason: `This amends the ${doc.scope.amendsEdition} edition, not ${ctx.edition.value}.` };
      return { ok: true, reason: '' };
    case 'manufacturer':
      if (ctx.productIds.length && !doc.scope.productIds!.some(p => ctx.productIds.includes(p))) return { ok: false, reason: 'None of the products it covers are in this run.' };
      return { ok: true, reason: '' };
    case 'project_document':
      if (!ctx.snapshot) return { ok: false, reason: 'No project is open.' };
      if (doc.scope.projectId !== ctx.snapshot.projectId) return { ok: false, reason: 'It belongs to a different project.' };
      return { ok: true, reason: '' };
    case 'company_procedure':
      return { ok: true, reason: '' };
  }
}

// ------------------------------------------------------------------ claims

const CLAIM_STOP = new Set('about after again along also because before being below between both could does each either from have into least more most must only other over same shall should since some such than that their them then there these they this those through under until upon very were what when where which while with within without would your after the and for not may'.split(' '));
const numberTokens = (t: string) => [...t.matchAll(/(\d+(?:\.\d+)?)\s*(mm|m|psi|hours?|ft|in)?\b/gi)].map(m => ({ n: m[1], unit: (m[2] ?? '').toLowerCase() }));

/** A cited passage supports a claim when every number (with its unit) and most content words appear in it. */
export function supports(claim: string, passages: string[]): { ok: boolean; reason?: string } {
  const hay = passages.join('\n').toLowerCase().replace(/\s+/g, ' ');
  for (const t of numberTokens(claim)) {
    const re = new RegExp(`(^|[^\\d.])${t.n.replace('.', '\\.')}${t.unit ? `\\s*${t.unit}` : '(?![\\d.])'}`, 'i');
    if (!re.test(hay)) return { ok: false, reason: `The value ${t.n}${t.unit ? ` ${t.unit}` : ''} does not appear in the cited passage.` };
  }
  const words = [...new Set(claim.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [])].filter(w => !CLAIM_STOP.has(w));
  if (!words.length) return { ok: true };
  const found = words.filter(w => hay.includes(w.slice(0, Math.max(5, w.length - 3))));
  return found.length / words.length >= 0.6 ? { ok: true } : { ok: false, reason: 'The cited passage does not contain most of the terms this statement uses.' };
}

export function validateClaims(drafts: ReturnType<Composer>, retrieved: Map<string, Retrieved>): { supported: Claim[]; unresolved: Claim[] } {
  const supported: Claim[] = [], unresolved: Claim[] = [];
  drafts.forEach((d, i) => {
    const id = `c${i + 1}`;
    const cited = d.citations.map(k => retrieved.get(k));
    if (!d.citations.length) return unresolved.push({ ...d, id, status: 'unresolved', reason: 'No source was cited.' });
    // Citation ids are resolved against stored, retrieved records only; anything else is rejected.
    if (cited.some(c => !c)) return unresolved.push({ ...d, id, citations: d.citations.filter(k => retrieved.has(k)), status: 'unresolved', reason: 'A cited section is not one of the retrieved source records.' });
    if (d.kind === 'pointer') return supported.push({ ...d, id, status: 'supported' });
    const check = supports(d.text, cited.map(c => `${c!.section.heading}\n${c!.section.text}`));
    if (!check.ok) return unresolved.push({ ...d, id, status: 'unresolved', reason: check.reason });
    supported.push({ ...d, id, status: 'supported' });
  });
  return { supported, unresolved };
}

// ------------------------------------------------------------------ citations

const ROLE_ORDER: Role[] = ['main', 'amendment', 'exception', 'referenced', 'footnote', 'related', 'definition', 'commentary'];
function citation(r: Retrieved): Citation {
  const a = r.doc.authorization;
  let quote: string | null = r.section.text, quoteNote: string | null = null, table = r.section.table;
  if (a.display === 'reference_only') { quote = null; table = null; quoteNote = 'The source permits reference only. Open the original to read the wording.'; }
  else if (a.display === 'excerpt' && quote.length > a.maxQuoteChars!) { quote = `${quote.slice(0, a.maxQuoteChars!)}…`; table = null; quoteNote = `Shortened to the ${a.maxQuoteChars} characters the source permits. Open the original for the full text.`; }
  const label = r.section.kind === 'commentary' ? 'Explanatory, not a requirement'
    : r.section.kind === 'definition' ? 'Definition'
    : r.section.kind === 'exception' ? 'Exception'
    : r.section.kind === 'table' ? 'Table'
    : r.section.kind === 'footnote' ? 'Note to the passage above'
    : r.doc.type === 'company_procedure' ? 'Company procedure'
    : r.doc.type === 'manufacturer' ? 'Manufacturer instruction'
    : r.doc.type === 'project_document' ? 'Project requirement'
    : r.doc.type === 'local_amendment' ? 'Local amendment'
    : r.section.kind === 'requirement' ? 'Requirement text' : 'Source text';
  return {
    key: r.section.key, docId: r.doc.id, docTitle: r.doc.title, publisher: r.doc.publisher, type: r.doc.type, typeLabel: SOURCE_TYPE_LABEL[r.doc.type], edition: r.doc.edition,
    sectionId: r.section.sectionId, heading: r.section.heading, kind: r.section.kind, label, role: r.role, via: r.via,
    pageStart: r.section.pageStart, pageEnd: r.section.pageEnd, demonstration: r.doc.demonstration,
    flags: r.section.flags.map(f => ({ flag: f, label: QUALITY_LABEL[f] })),
    quote, quoteNote, table, notes: r.notes.map(n => ({ text: n.text, author: n.author })),
    link: `/api/sources/${encodeURIComponent(r.doc.id)}/sections/${encodeURIComponent(r.section.key)}`,
    original: r.doc.url ?? (a.display === 'full' ? `/api/sources/${encodeURIComponent(r.doc.id)}/file` : null),
  };
}

// ------------------------------------------------------------------ question parsing for calculations

function parseQuestionNumbers(q: string): { verticalOffset?: { value: number; unit: string }; centerToCenter?: { value: number; unit: string } } {
  const unit = (u: string) => (u === '"' || u === 'inch' || u === 'inches') ? 'in' : (u === 'feet' || u === 'foot' || u === "'") ? 'ft' : u;
  const out: ReturnType<typeof parseQuestionNumbers> = {};
  const mv = /\b(drop|lower|raise|lift|move)\w*\s+(?:it|the pipe|the branch|the line)?\s*(up|down)?\s*(?:by\s+)?(\d+(?:\.\d+)?)\s*(mm|m|in|inch(?:es)?|ft|feet|foot|"|')/i.exec(q);
  if (mv) {
    const down = /drop|lower/i.test(mv[1]) || mv[2]?.toLowerCase() === 'down';
    out.verticalOffset = { value: (down ? -1 : 1) * Number(mv[3]), unit: unit(mv[4].toLowerCase()) };
  }
  const cc = /(\d+(?:\.\d+)?)\s*(mm|m|in|inch(?:es)?|ft|feet|"|')\s*(?:c-c|c to c|cent(?:er|re)[- ]to[- ]cent(?:er|re))/i.exec(q)
    ?? /(?:c-c|cent(?:er|re)[- ]to[- ]cent(?:er|re))\D{0,12}(\d+(?:\.\d+)?)\s*(mm|m|in|inch(?:es)?|ft|feet|"|')/i.exec(q);
  if (cc) out.centerToCenter = { value: Number(cc[1]), unit: unit(cc[2].toLowerCase()) };
  return out;
}

// ------------------------------------------------------------------ main flow

export function ask(store: SourceStore, req: AskRequest, snapshot: WorkPackageSnapshot | null, composer: Composer = notesComposer): AskAnswer {
  const t0 = performance.now();
  if (typeof req.question !== 'string' || !req.question.trim()) throw new AskInputError('Type a question.');
  if (req.question.length > 1000) throw new AskInputError('Keep the question under 1000 characters.');
  const question = req.question.trim();
  const ctx = buildContext(req, snapshot);
  const classification = classify(question);
  const followUps: FollowUp[] = [], missing: string[] = [];
  const excluded: AskAnswer['excluded'] = [];

  // Values typed into the question itself are the user's too.
  const parsed = parseQuestionNumbers(question);
  for (const [name, v] of Object.entries(parsed)) {
    // A value typed into the panel wins over one read from the question text.
    if (!v || ctx.values.get(name)?.origin === 'you') continue;
    if (!LENGTH_UNITS.has(v.unit)) continue;
    const f: ContextFact = { name, label: MEASUREMENTS[name].label, value: v.value, unit: v.unit, origin: 'you', detail: 'From your question' };
    ctx.facts.push(f); ctx.values.set(name, f);
  }

  // ---------------- retrieval
  const r0 = performance.now();
  let items: Retrieved[] = [];
  if (classification.kind !== 'calculation') {
    const plan = planQuery(question);
    const docs = store.documents();
    const docById = new Map(docs.map(d => [d.id, d]));
    const verdicts = new Map(docs.map(d => [d.id, applicability(d, ctx)]));
    const blocked = new Set<string>();
    const mains: Retrieved[] = [];
    const seen = new Set<string>();
    if (plan.match) for (const hit of store.search(plan.match)) {
      const section = store.section(hit.key)!, doc = docById.get(hit.docId)!;
      const top = section.parentKey ? store.section(section.parentKey)! : section;
      if (seen.has(top.key)) continue;
      const hits = conceptHits(plan, top).concat(section === top ? [] : conceptHits(plan, section));
      if (!relevant(plan, [...new Set(hits)])) continue;
      seen.add(top.key);
      const verdict = verdicts.get(doc.id)!;
      if (!verdict.ok) {
        if (verdict.blockedBy) blocked.add(verdict.blockedBy);
        if (!excluded.some(e => e.docId === doc.id)) excluded.push({ docId: doc.id, title: doc.title, edition: doc.edition, reason: verdict.reason });
        continue;
      }
      if (top.kind === 'definition' || top.kind === 'commentary') continue; // attached to the passages they explain
      if (mains.length < 8) mains.push({ section: top, doc, role: 'main', score: hit.rank, notes: store.notes(top.key) });
    }
    items = expand(store, mains, docs.filter(d => verdicts.get(d.id)!.ok));
    if (blocked.has('edition') || blocked.has('standard')) {
      const editions = [...new Set(docs.filter(d => d.type === 'published_code').map(d => d.edition))].sort().reverse();
      followUps.push({ id: 'edition', field: 'nfpa13Edition', kind: 'choice', question: 'Which NFPA 13 edition applies to this permit?',
        options: [...editions.map(e => ({ value: e, label: e })), { value: 'unsure', label: 'Not sure' }] });
      missing.push(`Applicable code edition. ${ctx.edition.reason}`);
    }
    // The project's edition is known but the library does not hold it: say so, never substitute.
    const codeMatches = excluded.filter(e => docById.get(e.docId)?.type === 'published_code' && docById.get(e.docId)?.scope.standard === ctx.standard);
    if (ctx.edition.value && codeMatches.length && !items.some(i => i.doc.type === 'published_code'))
      missing.push(`No ${ctx.standard?.toUpperCase().replace('NFPA', 'NFPA ')} ${ctx.edition.value} text is in the project library. It holds ${[...new Set(codeMatches.map(e => e.edition))].join(' and ')}, which were not substituted.`);
    if (blocked.has('jurisdiction')) {
      followUps.push({ id: 'jurisdiction', field: 'jurisdiction', kind: 'choice', question: 'Which jurisdiction is this project in?',
        options: [...new Set(docs.filter(d => d.type === 'local_amendment').map(d => d.scope.jurisdiction!))].map(j => ({ value: j, label: j.replace(/_/g, ' ') })) });
      missing.push('Jurisdiction, needed to choose local amendments.');
    }
  }
  const retrievalMs = performance.now() - r0;

  // ---------------- exceptions: evaluate the stated conditions with known facts, ask for the rest
  const exceptions: ExceptionStatus[] = [];
  for (const r of items.filter(i => i.role === 'exception')) {
    const conds: ExplanationCondition[] = r.notes.flatMap(n => n.conditions ?? []);
    if (!conds.length) {
      exceptions.push({ key: r.section.key, sectionId: r.section.sectionId, parentSectionId: r.via ?? '', status: 'unknown', checks: [], note: 'Read the exception wording to decide whether it applies.' });
      continue;
    }
    const checks: ConditionCheck[] = conds.map(cond => {
      const f = ctx.values.get(cond.input.name);
      let value: number | null = null;
      if (f && typeof f.value === 'number') value = cond.input.unit === 'mm' ? toMm(f.value, f.unit ?? 'mm') : f.value;
      const cmp = (a: number) => cond.appliesWhen.op === '<=' ? a <= cond.appliesWhen.value : cond.appliesWhen.op === '<' ? a < cond.appliesWhen.value : cond.appliesWhen.op === '>=' ? a >= cond.appliesWhen.value : a > cond.appliesWhen.value;
      return { question: cond.question, name: cond.input.name, value, unit: cond.input.unit, origin: f?.origin ?? null, detail: f?.detail ?? null, op: cond.appliesWhen.op, limit: cond.appliesWhen.value, result: value === null ? 'unknown' : cmp(value) ? 'met' : 'not_met' };
    });
    const status = checks.some(c => c.result === 'not_met') ? 'does_not_apply' : checks.every(c => c.result === 'met') ? 'applies' : 'unknown';
    exceptions.push({ key: r.section.key, sectionId: r.section.sectionId, parentSectionId: r.via ?? '', status, checks,
      note: status === 'applies' ? 'Based on the values shown, this exception appears to apply. Read its wording to confirm.'
        : status === 'does_not_apply' ? 'Based on the values shown, this exception does not appear to apply.'
        : 'Whether this exception applies depends on the missing values.' });
    if (status === 'unknown') for (const c of checks.filter(x => x.result === 'unknown')) {
      if (!followUps.some(f => f.field === c.name)) followUps.push({ id: c.name, field: c.name, kind: 'measurement', question: c.question, unit: c.unit });
      if (!missing.some(m => m.startsWith(MEASUREMENTS[c.name]?.label ?? c.name))) missing.push(`${MEASUREMENTS[c.name]?.label ?? c.name}, to decide whether ${r.section.sectionId} applies.`);
    }
  }

  // ---------------- calculation through the validated tool registry
  const c0 = performance.now();
  let calculation: CalculationResult | null = null;
  if (classification.kind !== 'source') {
    const wantsCut = /\bcut\b|cent(er|re)[- ]to[- ]cent(er|re)|c-c|length/i.test(question);
    if (wantsCut) {
      const cc = ctx.values.get('centerToCenter');
      calculation = straightCutLength({ centerToCenter: cc && typeof cc.value === 'number' ? { value: cc.value, unit: cc.unit!, origin: cc.origin as Origin, detail: cc.detail } : null });
    } else {
      const off = ctx.values.get('verticalOffset');
      const offMm = off && typeof off.value === 'number' ? toMm(off.value, off.unit ?? 'mm') : null;
      calculation = pipeDuctClearance({
        segment: ctx.selected, duct: ctx.duct,
        verticalOffsetMm: off && offMm !== null ? { value: offMm, origin: off.origin as Origin, detail: off.detail } : null,
      });
    }
    if (calculation.status === 'missing_inputs') {
      for (const m of calculation.missing) missing.push(`${m}, for the ${calculation.title.toLowerCase()} calculation.`);
      if (calculation.toolId === 'straight_cut_length') followUps.push({ id: 'centerToCenter', field: 'centerToCenter', kind: 'measurement', question: 'What is the center-to-center length between the two elbows?', unit: 'mm' });
    }
  }
  const calculationMs = performance.now() - c0;

  // ---------------- explanation, validated against the stored passages
  const byKey = new Map(items.map(i => [i.section.key, i]));
  const drafts = composer(items);
  // An exception that appears to apply qualifies the requirement it belongs to, right below it.
  for (const e of exceptions.filter(x => x.status === 'applies')) {
    const ex = byKey.get(e.key), note = ex?.notes[0]?.text;
    if (!ex || !note) continue;
    const parentKey = ex.section.parentKey;
    const at = drafts.findIndex(d => parentKey !== null && d.citations.includes(parentKey));
    drafts.splice(at < 0 ? drafts.length : at + 1, 0, { text: `${e.sectionId} appears to apply: ${note}`, citations: [e.key], kind: 'note' });
  }
  const { supported, unresolved } = validateClaims(drafts, byKey);
  const sources = items.map(citation).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const label = (key: string) => { const s = sources.find(x => x.key === key)!; return `${s.sectionId} (${s.edition})`; };
  const conflicts = findConflicts(items).map(c => ({ ...c, items: c.items.map(i => ({ ...i, label: label(i.key) })) }));

  const hasSources = items.some(i => i.role === 'main');
  let status: AskAnswer['status'];
  let summary: string;
  if (classification.kind === 'calculation') {
    status = calculation?.status === 'ok' ? 'calculation_only' : 'needs_input';
    summary = calculation?.status === 'ok' ? `${calculation.message} This is a calculation, not a check that the installation complies.` : calculation?.message ?? 'No calculation matched this question.';
  } else if (!hasSources) {
    status = followUps.length ? 'needs_input' : 'no_source';
    summary = NO_SOURCE + (followUps.length ? ' Answer the question below so the right edition or jurisdiction can be searched.' : '')
      + (excluded.length && !followUps.length ? ` Matching passages exist only in documents that do not apply here (${excluded.map(e => `${e.title} ${e.edition}`).join('; ')}).` : '');
  } else {
    status = followUps.length ? 'needs_input' : 'answered';
    const editionGap = missing.find(m => m.startsWith('No ') && m.includes('text is in the project library'));
    const docs = new Set(items.filter(i => i.role === 'main').map(i => i.doc.id)).size;
    const applied = exceptions.filter(e => e.status === 'applies');
    summary = `${supported.length} point${supported.length === 1 ? '' : 's'} from ${docs} document${docs === 1 ? '' : 's'} in the project library${ctx.edition.value ? `, project edition ${ctx.edition.value}` : ''}.`
      + (applied.length ? ` ${applied.map(e => e.sectionId).join(', ')} appears to apply and changes what is required.` : '')
      + (editionGap ? ` ${editionGap}` : '')
      + (conflicts.length ? ` ${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} between sources need${conflicts.length === 1 ? 's' : ''} resolving.` : '');
    if (calculation?.status === 'ok') summary += ` Calculation: ${calculation.message}`;
  }

  const totalMs = performance.now() - t0;
  return {
    id: randomUUID(), question, askedAt: new Date().toISOString(), classification,
    context: {
      projectId: snapshot?.projectId ?? null, packageTitle: (snapshot as { title?: string } | null)?.title ?? null, standard: ctx.standard,
      edition: ctx.edition, jurisdiction: ctx.jurisdiction, selectedElementId: ctx.selected?.id ?? null,
      siteCondition: snapshot?.changeRequest ? { id: snapshot.changeRequest.id, description: snapshot.changeRequest.description } : null,
      facts: ctx.facts,
    },
    status, summary, explanation: supported, unresolved, exceptions, missing, followUps, sources, conflicts, excluded, calculation,
    timings: { retrievalMs: round(retrievalMs), calculationMs: round(calculationMs), totalMs: round(totalMs) },
  };
}
const round = (n: number) => Math.round(n * 10) / 10;
