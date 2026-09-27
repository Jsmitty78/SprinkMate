import type { Plan, Version, WorkSnapshot, Goal } from './contracts.js';
import { sameVersion } from './contracts.js';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const CLARIFY = 'needs_clarification';
export interface ChoiceRequest {
  model: typeof JEV_MODEL;
  state: Version & {
    intent: WorkSnapshot['intent']; goal: Goal; planId: string; stage: string;
    gaps: { id: string; description: string }[];
    recentResult?: string;
  };
  questions: { next_action: { type: 'choice'; instructions: string; criteria: Record<string, string> } };
}
// Version is local request correlation, NOT a field claimed to be echoed by the HTTP API.
export interface ChoiceEnvelope extends Version { response: unknown }
export interface ChoiceClient {
  choose(request: ChoiceRequest, signal: AbortSignal): Promise<ChoiceEnvelope>;
}
export function choiceRequest(s: WorkSnapshot, goal: Goal, plan: Plan, recentResult?: string): ChoiceRequest {
  if (plan.eligible.length > 254) throw new Error('too_many_eligible_actions');
  const ids = plan.eligible.map(a => a.id);
  if (new Set(ids).size !== ids.length || ids.includes(CLARIFY)) throw new Error('invalid_eligible_ids');
  return {
    model: JEV_MODEL,
    state: { inputRevision: s.inputRevision, configVersion: s.configVersion, intent: s.intent, goal,
      planId: s.selectedPlanId ?? s.baselinePlanId, stage: plan.stage,
      gaps: s.gaps.map(g => ({ id: g.id, description: g.description })), recentResult },
    questions: { next_action: {
      type: 'choice',
      instructions: 'Choose the most useful eligible next operation for this goal. Arguments are already bound by the server. Use needs_clarification when the supplied context cannot distinguish the operations. Do not confirm evidence, adopt a plan, invent dimensions, approve construction, waive checks or declare completion.',
      criteria: Object.fromEntries([...plan.eligible.map(a => [a.id, a.description]),
        [CLARIFY, 'The context is insufficient to distinguish the eligible next operations.']]),
    } },
  };
}
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const probability = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
export class ChoiceFailure extends Error {}
export function validateChoice(envelope: ChoiceEnvelope, request: ChoiceRequest): { id: string; confidence: number } {
  const fail = (reason: string): never => { throw new ChoiceFailure(reason); };
  if (!object(envelope) || !sameVersion(envelope, request.state)) return fail('choice_version_mismatch');
  const r = envelope.response;
  if (!object(r) || r.model !== request.model) return fail('choice_model_mismatch');
  if (!object(r.answers) || Object.keys(r.answers).length !== 1) return fail('invalid_answers');
  const a = r.answers.next_action;
  if (!object(a) || a.type !== 'choice' || typeof a.choice !== 'string' || !probability(a.confidence)) return fail('invalid_choice_shape');
  // Reject generated arguments and other unsupported answer fields.
  if (Object.keys(a).some(k => !['type', 'choice', 'confidence', 'probabilities'].includes(k))) return fail('unexpected_choice_fields');
  const ids = Object.keys(request.questions.next_action.criteria);
  if (!ids.includes(a.choice)) return fail('ineligible_choice');
  const p = a.probabilities;
  if (!object(p) || Object.keys(p).length !== ids.length || ids.some(id => !Object.hasOwn(p, id) || !probability(p[id]))) return fail('invalid_distribution');
  const values = ids.map(id => p[id] as number);
  if (Math.abs(values.reduce((sum, n) => sum + n, 0) - 1) > 1e-6) return fail('distribution_sum');
  const maximum = Math.max(...values);
  if (p[a.choice] !== maximum) return fail('choice_not_maximum');
  if (a.choice === CLARIFY) return fail('needs_clarification');
  if (values.filter(n => n === maximum).length !== 1) return fail('ambiguous_distribution');
  return { id: a.choice, confidence: a.confidence };
}

/** Official HTTP endpoint, one request, no retries or generative fallback. */
export class JevHttpClient implements ChoiceClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
  }
  async choose(request: ChoiceRequest, signal: AbortSignal): Promise<ChoiceEnvelope> {
    let response: Response;
    try {
      response = await this.fetcher(JEV_ENDPOINT, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request) });
    } catch { throw new ChoiceFailure(signal.aborted ? 'choice_aborted' : 'choice_network_error'); }
    if (!response.ok) throw new ChoiceFailure(`choice_http_${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new ChoiceFailure('choice_invalid_json'); }
    return { inputRevision: request.state.inputRevision, configVersion: request.state.configVersion, response: body };
  }
}
