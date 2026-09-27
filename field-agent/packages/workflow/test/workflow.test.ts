import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { currentOutputs, JsonRunStore, WorkflowRunner, type ChoiceClient, type DomainResult, type Goal, type RunnerOptions } from '../src/index.js';
import { FixtureDomain, MemoryRunStore, RecordedChoices } from './fixtures/domain.js';
import choices from './fixtures/choices.json';

function setup(options: Partial<RunnerOptions> = {}) {
  const domain = options.domain as FixtureDomain ?? new FixtureDomain();
  const store = options.store ?? new MemoryRunStore();
  const choice = options.choice ?? new RecordedChoices();
  const events: { id: string; event: AgentEvent }[] = [];
  const runner = new WorkflowRunner({ domain, store, choice, configVersion: 'fixture-v1',
    onEvent: (id, event) => events.push({ id, event: structuredClone(event) }), ...options });
  const start = (goal: Goal = domain.data.snapshot.intent) => runner.start('fixture-package', goal, domain.read('fixture-package'));
  return { domain, store, choice, runner, start, events };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('actual pinned Pi Agent and recorded Choice responses', () => {
  it.each(['prepare_from_drawing', 'adapt_to_site'] as const)('%s runs business turns, waits and resumes with fresh Agent', async intent => {
    const s = setup({ domain: new FixtureDomain(intent) });
    let run = await s.start('export_selected_package').done;
    if (intent === 'adapt_to_site') {
      expect(run.status).toBe('waiting_input');
      expect(run.question?.kind).toBe('candidate_selection');
      expect(s.domain.data.snapshot.selectedPlanId).toBeUndefined();
      expect(s.domain.calls.map(a => a.operation)).toEqual(['prepare_drawing_model', 'generate_change_candidates',
        'derive_work_package', 'evaluate_work_package', 'compare_candidates']);
      expect((s.choice as RecordedChoices).requests).toHaveLength(0);
      s.domain.answer([], 'candidate-a');
      run = await s.start('export_selected_package').done;
    }
    expect(run.status).toBe('waiting_input');
    expect(run.question?.id).toBe('joint_datum');
    expect(run.latestDecision?.source).toBe('jev');
    expect(run.latestDecision?.confidence).toBe(0.02); // Diagnostic, never a threshold gate.
    const recorded = s.choice as RecordedChoices;
    expect(recorded.requests).toHaveLength(2);
    expect(recorded.requests[1].state.recentResult).toContain('stage_evidence');
    expect(Object.keys(recorded.requests[1].questions.next_action.criteria)).not.toContain('stage_evidence:product-sheet');
    expect(s.domain.data.stagedEvidence).toEqual(['product-sheet']);
    expect(s.domain.data.snapshot.gaps.some(g => g.id === 'joint_datum')).toBe(true);
    const snapshot = s.domain.read('fixture-package');
    const packageOutput = currentOutputs(snapshot).find(o => o.kind === 'package')!;
    expect(s.domain.data.payloads[packageOutput.id]).toMatchObject({ materials: [{ count: 2 }], cuts: [{ lengthMm: null, status: 'input_missing' }] });
    expect(snapshot.gaps.some(g => g.id === 'regulatory_source')).toBe(true);
    expect(currentOutputs(snapshot).some(o => o.kind === 'export')).toBe(false);

    const waitingId = run.id;
    const waitingEvents = s.events.filter(e => e.id === waitingId).map(e => e.event);
    expect(waitingEvents.at(-1)?.type).toBe('agent_end');
    for (const event of waitingEvents) if (event.type === 'turn_end' && event.message.role === 'assistant') {
      expect(event.message.content.filter(c => c.type === 'toolCall')).toHaveLength(1);
      expect(event.toolResults).toHaveLength(1);
    }
    const toolStart = waitingEvents.filter(e => e.type === 'tool_execution_start');
    expect(toolStart.at(-1)).toMatchObject({ toolName: 'request_input' });
    for (const event of toolStart) if (event.type === 'tool_execution_start') {
      expect(Object.keys(event.args).sort()).toEqual(['actionId', 'runId']);
      expect(event.args.runId).toBe(waitingId);
    }
    // No automatic resume when input changes. Only an explicit start creates the next Agent.
    s.domain.answer(['joint_datum', 'assembly_access']);
    expect(s.runner.get(waitingId)?.status).toBe('waiting_input');
    expect(currentOutputs(s.domain.read('fixture-package'))).toHaveLength(0);
    run = await s.start('export_selected_package').done;
    expect(run.id).not.toBe(waitingId);
    expect(run.status).toBe('completed');
    const fresh = s.events.filter(e => e.id === run.id).map(e => e.event);
    expect(fresh[0].type).toBe('agent_start');
    const end = fresh.at(-1);
    expect(end?.type).toBe('agent_end');
    if (end?.type === 'agent_end') {
      const calls = end.messages.flatMap(m => m.role === 'assistant' ? m.content.filter(c => c.type === 'toolCall') : []);
      expect(calls.every(c => c.type === 'toolCall' && c.arguments.runId === run.id)).toBe(true);
    }
    expect(currentOutputs(s.domain.read('fixture-package')).map(o => o.kind)).toEqual(['model', 'package', 'evaluation', 'export']);
    expect(s.domain.data.snapshot.baselinePlanId).toBe('baseline-1');
    expect(recorded.requests).toHaveLength(2); // All unambiguous dependencies bypass JEV.
  });

  it('falls back in fixed question order on invalid Choice without accepting generated arguments', async () => {
    const invalid = structuredClone(choices.stageEvidence);
    invalid.answers.next_action.choice = 'approve_plan';
    const s = setup({ choice: new RecordedChoices([invalid]) });
    s.domain.data.snapshot.gaps.reverse();
    const run = await s.start().done;
    expect(run.question?.id).toBe('joint_datum');
    expect(run.latestFallback).toBe('ineligible_choice');
    expect(run.latestDecision?.source).toBe('fallback');
    expect(s.domain.data.stagedEvidence).toHaveLength(0);
  });

  it('stops with the actual blocker when Choice fails and no eligible question exists', async () => {
    const s = setup({ choice: { async choose() { throw new Error('service unavailable'); } } });
    s.domain.data.snapshot.gaps = [s.domain.data.snapshot.gaps[2]];
    s.domain.data.snapshot.evidenceCandidates.push({ id: 'other-sheet', description: 'Another supplied product sheet' });
    const run = await s.start().done;
    expect(run.status).toBe('blocked');
    expect(run.reason).toContain('regulatory source is pending');
    expect(run.latestFallback).toBe('choice_service_failure');
    expect(run.question).toBeUndefined();
  });

  it('never requests Choice or executes work when a dependent prerequisite is blocked without a question', async () => {
    const choose = vi.fn();
    const s = setup({ choice: { choose } });
    s.domain.data.snapshot.gaps = [{ id: 'unsupported', description: 'The supplied drawing geometry is unsupported.', blocks: ['derive_work_package'] }];
    const run = await s.start().done;
    expect(run.status).toBe('blocked');
    expect(run.reason).toBe('The supplied drawing geometry is unsupported.');
    expect(s.domain.calls.map(a => a.operation)).toEqual(['prepare_drawing_model']);
    expect(choose).not.toHaveBeenCalled();
  });
});

describe('single-server lifecycle and stale-result barriers', () => {
  it('returns the same active handle on duplicate start', async () => {
    const s = setup();
    const first = s.start();
    const second = s.start();
    expect(second).toBe(first);
    expect((await first.done).status).toBe('waiting_input');
    expect(s.events.filter(e => e.event.type === 'agent_start')).toHaveLength(1);
  });

  it.each(['edit', 'config', 'cancel'] as const)('discards late tool results after %s, even when the service ignores abort', async mutation => {
    const entered = deferred<void>();
    const late = deferred<DomainResult>();
    const s = setup();
    let signal!: AbortSignal;
    s.domain.execute = async (_action, context) => { signal = context.signal; entered.resolve(); return late.promise; };
    const commit = vi.spyOn(s.domain, 'commit');
    const handle = s.start();
    await entered.promise;
    if (mutation === 'edit') s.domain.answer([]);
    if (mutation === 'config') s.domain.data.snapshot.configVersion = 'fixture-v2';
    if (mutation === 'cancel') s.runner.cancel('fixture-package');
    if (mutation === 'cancel') {
      expect((await handle.done).status).toBe('cancelled');
      expect(signal.aborted).toBe(true);
    }
    late.resolve({ summary: 'late result', payload: {} });
    const run = await handle.done;
    expect(run.status).toBe(mutation === 'cancel' ? 'cancelled' : 'interrupted');
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(s.domain.data.snapshot.outputs).toHaveLength(0);
    expect(s.runner.get(handle.id)?.status).toBe(run.status);
  });

  it.each(['edit', 'config', 'cancel'] as const)('does not turn a late Choice into a question after %s', async mutation => {
    const entered = deferred<void>();
    const late = deferred<Awaited<ReturnType<ChoiceClient['choose']>>>();
    const s = setup({ choice: { async choose(request) {
      entered.resolve();
      const result = await late.promise;
      return { ...result, inputRevision: request.state.inputRevision, configVersion: request.state.configVersion };
    } } });
    const handle = s.start();
    await entered.promise;
    if (mutation === 'edit') s.domain.answer([]);
    if (mutation === 'config') s.domain.data.snapshot.configVersion = 'fixture-v2';
    if (mutation === 'cancel') s.runner.cancel('fixture-package');
    late.resolve({ inputRevision: 1, configVersion: 'fixture-v1', response: choices.stageEvidence });
    const run = await handle.done;
    expect(run.status).toBe(mutation === 'cancel' ? 'cancelled' : 'interrupted');
    expect(run.question).toBeUndefined();
    expect(run.latestFallback).toBeUndefined();
    expect(s.domain.data.stagedEvidence).toHaveLength(0);
  });

  it('rejects input/config conflicts before creating an Agent', () => {
    const s = setup();
    expect(() => s.runner.start('fixture-package', 'prepare_from_drawing', { inputRevision: 0, configVersion: 'fixture-v1' })).toThrow('conflict');
    s.domain.data.snapshot.configVersion = 'fixture-v2';
    expect(() => s.start()).toThrow('conflict');
    expect(s.events).toHaveLength(0);
  });

  it('interrupts if the final domain transaction rejects its version binding', async () => {
    const s = setup();
    s.domain.commit = () => false;
    const run = await s.start().done;
    expect(run.status).toBe('interrupted');
    expect(run.reason).toBe('input_or_config_changed');
    expect(s.domain.data.snapshot.outputs).toHaveLength(0);
    expect(s.domain.calls).toHaveLength(1);
  });

  it('stops a timed-out domain operation without committing or automatically retrying it', async () => {
    const late = deferred<DomainResult>();
    const execute = vi.fn(() => late.promise);
    const s = setup({ requestTimeoutMs: 10 });
    s.domain.execute = execute;
    const run = await s.start().done;
    expect(run.status).toBe('blocked');
    expect(run.reason).toContain('request_timeout');
    expect(execute).toHaveBeenCalledTimes(1);
    late.resolve({ summary: 'too late', payload: {} });
    await Promise.resolve();
    expect(s.domain.data.snapshot.outputs).toHaveLength(0);
  });

  it('uses a fixed question fallback when the Choice request times out', async () => {
    const s = setup({ requestTimeoutMs: 10, choice: { choose: () => new Promise(() => {}) } });
    const run = await s.start().done;
    expect(run.status).toBe('waiting_input');
    expect(run.question?.id).toBe('joint_datum');
    expect(run.latestFallback).toContain('request_timeout');
  });

  it('stops after no progress instead of repeating a successful no-op', async () => {
    const s = setup();
    s.domain.commit = () => true;
    const run = await s.start().done;
    expect(run.status).toBe('blocked');
    expect(run.reason).toBe('no_progress');
    expect(s.domain.calls).toHaveLength(1);
  });

  it('enforces a maximum number of business tools', async () => {
    const s = setup({ maxSteps: 2 });
    const run = await s.start().done;
    expect(run.reason).toBe('step_limit');
    expect(s.domain.calls).toHaveLength(2);
  });

  it('finalizes service exceptions and never repeats an unknown outcome', async () => {
    const s = setup();
    s.domain.execute = vi.fn(async () => { throw new Error('private service diagnostic'); });
    const run = await s.start().done;
    expect(run.status).toBe('failed');
    expect(s.domain.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(run)).not.toContain('private service diagnostic');
    expect(s.runner.get(run.id)?.status).toBe('failed');
  });

  it('marks persisted running work interrupted on restart and retains saved inputs for explicit rerun', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-restart-'));
    const inputs = join(directory, 'fixture-inputs.json');
    const runs = join(directory, 'runs.json');
    const domain = new FixtureDomain('prepare_from_drawing', inputs);
    domain.answer(['joint_datum']);
    const store = new JsonRunStore(runs);
    store.save({ id: 'crashed-run', packageId: 'fixture-package', goal: 'prepare_from_drawing',
      inputRevision: 2, configVersion: 'fixture-v1', status: 'running', steps: 1, startedAt: new Date().toISOString() });
    const before = readFileSync(inputs, 'utf8');
    const restored = new FixtureDomain('prepare_from_drawing', inputs);
    const s = setup({ domain: restored, store: new JsonRunStore(runs), choice: new RecordedChoices([]) });
    expect(s.runner.get('crashed-run')?.status).toBe('interrupted');
    expect(readFileSync(inputs, 'utf8')).toBe(before);
    expect(s.events).toHaveLength(0); // No automatic restart/replay.
    expect(restored.data.snapshot.inputRevision).toBe(2);
    const run = await s.start().done;
    expect(run.id).not.toBe('crashed-run');
    expect(run.status).toBe('waiting_input');
    expect(run.question?.id).toBe('assembly_access');
  });
});
