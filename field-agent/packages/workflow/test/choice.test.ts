import { describe, expect, it, vi } from 'vitest';
import { choiceRequest, JevHttpClient, JEV_ENDPOINT, JEV_MODEL, validateChoice, type ChoiceEnvelope } from '../src/choice.js';
import { planNext } from '../src/policy.js';
import { WorkflowRunner } from '../src/runner.js';
import { FixtureDomain, MemoryRunStore, RecordedChoices } from './fixtures/domain.js';
import choices from './fixtures/choices.json';

function sample() {
  const domain = new FixtureDomain();
  const snapshot = domain.read('fixture-package');
  snapshot.outputs = [
    { id: 'm', kind: 'model', subjectId: snapshot.drawingId, inputRevision: 1, configVersion: 'fixture-v1' },
    { id: 'p', kind: 'package', subjectId: snapshot.baselinePlanId, inputRevision: 1, configVersion: 'fixture-v1' },
    { id: 'e', kind: 'evaluation', subjectId: snapshot.baselinePlanId, inputRevision: 1, configVersion: 'fixture-v1' },
  ];
  const request = choiceRequest(snapshot, snapshot.intent, planNext(snapshot, snapshot.intent));
  const response = structuredClone(choices.stageEvidence);
  const envelope = { inputRevision: 1, configVersion: 'fixture-v1', response };
  return { domain, snapshot, request, response, envelope };
}

describe('Choice contract', () => {
  it('sends only one bounded next_action question and no binary, transcript or arbitrary tool arguments', () => {
    const { request } = sample();
    expect(Object.keys(request.questions)).toEqual(['next_action']);
    expect(Object.keys(request.state).sort()).toEqual(['configVersion', 'gaps', 'goal', 'inputRevision', 'intent', 'planId', 'recentResult', 'stage']);
    expect(request.model).toBe('jev-1.13.0');
    const criteria = request.questions.next_action.criteria;
    for (const forbidden of ['done', 'approve', 'select_plan', 'confirm_fact', 'skip_rules', 'shell', 'edit_file']) expect(criteria).not.toHaveProperty(forbidden);
  });

  it.each([
    ['wrong type', (r: any) => { r.answers.next_action.type = 'score'; }],
    ['extra arguments', (r: any) => { r.answers.next_action.arguments = { lengthMm: 500 }; }],
    ['foreign action', (r: any) => { r.answers.next_action.choice = 'done'; }],
    ['missing option', (r: any) => { delete r.answers.next_action.probabilities.needs_clarification; }],
    ['extra option', (r: any) => { r.answers.next_action.probabilities.done = 0; }],
    ['NaN', (r: any) => { r.answers.next_action.probabilities.needs_clarification = NaN; }],
    ['Infinity', (r: any) => { r.answers.next_action.probabilities.needs_clarification = Infinity; }],
    ['negative probability', (r: any) => { r.answers.next_action.probabilities.needs_clarification = -0.1; }],
    ['sum is not one', (r: any) => { r.answers.next_action.probabilities.needs_clarification = 0.1; }],
    ['non-maximum choice', (r: any) => { r.answers.next_action.choice = 'request_input:joint_datum'; }],
    ['model alias', (r: any) => { r.model = 'jev-latest'; }],
    ['extra answer', (r: any) => { r.answers.approval = true; }],
    ['invalid confidence', (r: any) => { r.answers.next_action.confidence = 2; }],
    ['string confidence', (r: any) => { r.answers.next_action.confidence = '0.8'; }],
    ['array probabilities', (r: any) => { r.answers.next_action.probabilities = []; }],
  ])('rejects %s', (_label, mutate) => {
    const { request, envelope } = sample();
    mutate(envelope.response);
    expect(() => validateChoice(envelope, request)).toThrow();
  });

  it.each([null, [], {}, 'choice', 42])('rejects malformed payload %j', response => {
    const { request, envelope } = sample();
    expect(() => validateChoice({ ...envelope, response }, request)).toThrow();
  });

  it.each(['inputRevision', 'configVersion'] as const)('rejects stale recorded %s', field => {
    const { request, envelope } = sample();
    const invalid: ChoiceEnvelope = { ...envelope, [field]: field === 'inputRevision' ? 0 : 'old-config' };
    expect(() => validateChoice(invalid, request)).toThrow('choice_version_mismatch');
  });

  it('treats exact ties as ambiguous without a confidence threshold', () => {
    const { request, envelope } = sample();
    const answer = envelope.response.answers.next_action;
    answer.probabilities = { 'request_input:joint_datum': 0.45, 'request_input:assembly_access': 0.05,
      'stage_evidence:product-sheet': 0.45, needs_clarification: 0.05 };
    expect(() => validateChoice(envelope, request)).toThrow('ambiguous_distribution');
  });

  it('treats needs_clarification as a fallback control value, never a business tool', async () => {
    const { envelope } = sample();
    const answer = envelope.response.answers.next_action;
    answer.choice = 'needs_clarification';
    answer.probabilities = { 'request_input:joint_datum': 0, 'request_input:assembly_access': 0,
      'stage_evidence:product-sheet': 0, needs_clarification: 1 };
    const domain = new FixtureDomain();
    const runner = new WorkflowRunner({ domain, store: new MemoryRunStore(), configVersion: 'fixture-v1', choice: new RecordedChoices([envelope.response]) });
    const run = await runner.start('fixture-package', 'prepare_from_drawing', domain.read('fixture-package')).done;
    expect(run.latestFallback).toBe('needs_clarification');
    expect(run.question?.id).toBe('joint_datum');
    expect(run.status).toBe('waiting_input');
  });

  it('runs Pi with recorded decisions without any default provider fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider network'));
    try {
      const domain = new FixtureDomain();
      const runner = new WorkflowRunner({ domain, store: new MemoryRunStore(), configVersion: 'fixture-v1', choice: new RecordedChoices() });
      const run = await runner.start('fixture-package', 'prepare_from_drawing', domain.read('fixture-package')).done;
      expect(run.status).toBe('waiting_input');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
});

describe('official HTTP transport (mocked; not a live connection)', () => {
  it('uses Bearer auth, fixed model/endpoint, abort propagation, and local version correlation', async () => {
    const { request, response } = sample();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    const signal = new AbortController().signal;
    const result = await new JevHttpClient('test-only-key', transport).choose(request, signal);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal, headers: { Authorization: 'Bearer test-only-key', 'Content-Type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual(request);
    expect(JSON.parse(init!.body as string).model).toBe(JEV_MODEL);
    expect(result.inputRevision).toBe(1);
    expect(result.configVersion).toBe('fixture-v1');
    expect(validateChoice(result, request).id).toBe('stage_evidence:product-sheet');
  });

  it.each([401, 429, 500])('does not retry HTTP %s or leak raw response', async status => {
    const { request } = sample();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('private diagnostic', { status }));
    await expect(new JevHttpClient('test-only-key', transport).choose(request, new AbortController().signal)).rejects.toThrow(`choice_http_${status}`);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON without leaking its body', async () => {
    const { request } = sample();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('private invalid JSON'));
    await expect(new JevHttpClient('test-only-key', transport).choose(request, new AbortController().signal)).rejects.toThrow('choice_invalid_json');
  });
});
