import { currentOutputs, type BoundAction, type Goal, type Operation, type Plan, type WorkSnapshot } from './contracts.js';

function action(operation: Operation, subjectId: string): BoundAction {
  return { id: `${operation}:${subjectId}`, operation, subjectId, description: `${operation} for ${subjectId}` };
}
function questions(s: WorkSnapshot, gapIds?: Set<string>): BoundAction[] {
  return s.gaps.filter(g => !gapIds || gapIds.has(g.id)).flatMap(g => g.question ? [{
    id: `request_input:${g.question.id}`, operation: 'request_input' as const,
    subjectId: g.question.subjectId, description: g.question.text, question: g.question,
  }] : []);
}
function next(s: WorkSnapshot, operation: Operation, subjectId: string): Plan {
  const blockers = s.gaps.filter(g => g.blocks.includes(operation));
  if (blockers.length) {
    const eligible = questions(s, new Set(blockers.map(g => g.id)));
    const reason = blockers.map(g => g.description).join('; ');
    return { stage: operation, eligible, blocker: reason,
      ...(!eligible.length ? { terminal: { status: 'blocked' as const, reason } } : {}) };
  }
  return { stage: operation, eligible: [action(operation, subjectId)] };
}

/** Required business dependencies are selected in code, never by JEV. */
export function planNext(s: WorkSnapshot, goal: Goal): Plan {
  const outputs = currentOutputs(s);
  const has = (kind: typeof outputs[number]['kind'], subjectId: string) =>
    outputs.some(o => o.kind === kind && o.subjectId === subjectId);
  if (!has('model', s.drawingId)) return next(s, 'prepare_drawing_model', s.drawingId);

  if (s.intent === 'adapt_to_site' && !s.selectedPlanId) {
    if (!s.changeRequestId) return { stage: 'intake', eligible: questions(s), blocker: 'A measured site discrepancy is required.' };
    const candidates = outputs.find(o => o.kind === 'candidates' && o.subjectId === s.changeRequestId);
    if (!candidates) return next(s, 'generate_change_candidates', s.changeRequestId);
    if (!has('package', candidates.id)) return next(s, 'derive_work_package', candidates.id);
    if (!has('evaluation', candidates.id)) return next(s, 'evaluate_work_package', candidates.id);
    if (!has('comparison', candidates.id)) return next(s, 'compare_candidates', candidates.id);
    return { stage: 'select_candidate', eligible: [{
      id: 'request_input:select_candidate', operation: 'request_input', subjectId: candidates.id,
      description: 'Review the comparison and select or edit a construction alternative.',
      question: { id: 'select_candidate', kind: 'candidate_selection', subjectId: candidates.id,
        order: 0, text: 'Which alternative do you want to use? Review the drawing, materials, work changes and unresolved conditions before selecting or editing a plan.' },
    }] };
  }

  const subject = s.selectedPlanId ?? s.baselinePlanId;
  if (!has('package', subject)) return next(s, 'derive_work_package', subject);
  if (!has('evaluation', subject)) return next(s, 'evaluate_work_package', subject);
  // Clarify relevant conditions while keeping already-produced materials visible.
  const optional: BoundAction[] = [
    ...questions(s),
    ...s.evidenceCandidates.map(e => ({ ...action('stage_evidence', e.id), description: e.description })),
  ];
  if (optional.length) return { stage: 'resolve_inputs', eligible: optional,
    blocker: s.gaps.map(g => g.description).join('; ') || 'Evidence still requires user review.' };
  if (goal === 'export_selected_package' && !has('export', subject)) return next(s, 'export_work_package', subject);
  return { stage: 'present_outputs', eligible: [], terminal: { status: 'completed',
    reason: s.gaps.length ? 'Current outputs are available with unresolved conditions; no eligible input question remains.' : 'Requested outputs are available; this is not construction approval.' } };
}

/** Fixed domain-question order, independent of model ranking or confidence. */
export function fallbackQuestion(actions: BoundAction[]): BoundAction | undefined {
  return actions.filter(a => a.operation === 'request_input' && a.question)
    .sort((a, b) => a.question!.order - b.question!.order || a.id.localeCompare(b.id))[0];
}
