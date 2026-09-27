import { randomUUID } from 'node:crypto';
import { Agent, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { bounded, ExecutionStop } from './bounded.js';
import { ChoiceFailure, choiceRequest, JEV_MODEL, validateChoice, type ChoiceClient } from './choice.js';
import { operations, sameVersion, type BoundAction, type DomainPort, type Goal, type RunRecord, type RunStore, type Version } from './contracts.js';
import { fallbackQuestion, planNext } from './policy.js';
import { decisionStream, WORKFLOW_MODEL } from './stream.js';

export interface RunHandle {
  id: string;
  done: Promise<RunRecord>;
}
interface ActiveRun { handle: RunHandle; controller: AbortController; agent?: Agent }
export interface RunnerOptions {
  domain: DomainPort;
  store: RunStore;
  choice: ChoiceClient;
  configVersion: string;
  requestTimeoutMs?: number;
  maxSteps?: number;
  // Optional observation only; used by the integration example/tests, not persisted as an audit log.
  onEvent?: (runId: string, event: AgentEvent) => void;
}

/** Construct exactly once at Node server startup; one in-process guard per package. */
export class WorkflowRunner {
  private active = new Map<string, ActiveRun>();
  private readonly timeout: number;
  private readonly maxSteps: number;
  constructor(private readonly options: RunnerOptions) {
    this.timeout = options.requestTimeoutMs ?? 15_000;
    this.maxSteps = options.maxSteps ?? 20;
    if (!options.configVersion || !Number.isSafeInteger(this.timeout) || this.timeout < 1 ||
        !Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1) throw new Error('Invalid workflow configuration');
    options.store.interruptRunning();
  }
  start(packageId: string, goal: Goal, expected: Version, runId: string = randomUUID()): RunHandle {
    const existing = this.active.get(packageId);
    if (existing) return existing.handle;
    const snapshot = this.options.domain.read(packageId);
    if (!sameVersion(snapshot, expected) || snapshot.configVersion !== this.options.configVersion) throw new Error('input_or_config_conflict');
    if (goal !== 'export_selected_package' && goal !== snapshot.intent) throw new Error('goal_intent_mismatch');
    const run: RunRecord = { id: runId, packageId, goal, inputRevision: snapshot.inputRevision,
      configVersion: snapshot.configVersion, status: 'running', steps: 0, startedAt: new Date().toISOString() };
    this.options.store.save(run);
    const active: ActiveRun = { controller: new AbortController(), handle: { id: run.id, done: Promise.resolve(run) } };
    this.active.set(packageId, active);
    active.handle.done = Promise.resolve().then(() => this.execute(run, active)).finally(() => {
      if (this.active.get(packageId) === active) this.active.delete(packageId);
    });
    return active.handle;
  }
  cancel(packageId: string): boolean {
    const active = this.active.get(packageId);
    if (!active) return false;
    active.controller.abort();
    active.agent?.abort();
    return true;
  }
  get(runId: string): RunRecord | undefined { return this.options.store.get(runId); }

  private async execute(run: RunRecord, active: ActiveRun): Promise<RunRecord> {
    const { domain, store } = this.options;
    let pending: BoundAction | undefined;
    const save = () => store.save(run);
    const finish = (status: RunRecord['status'], reason: string) => {
      run.status = status; run.reason = reason; run.endedAt = new Date().toISOString(); save();
    };
    const guard = () => {
      if (active.controller.signal.aborted) throw new ExecutionStop('cancelled');
      const current = domain.read(run.packageId);
      if (!sameVersion(current, run) || current.configVersion !== this.options.configVersion) throw new ExecutionStop('input_or_config_changed');
      return current;
    };
    const fail = (error: unknown) => {
      if (active.controller.signal.aborted) finish('cancelled', 'cancelled');
      else if (error instanceof ExecutionStop) finish(error.message === 'input_or_config_changed' ? 'interrupted' : 'blocked', error.message);
      else { run.error = 'domain_or_adapter_error'; finish('failed', 'Operation failed; no automatic retry. Inspect the domain service.'); }
    };
    const streamFn = decisionStream(run.id, async () => {
      try {
        if (run.status !== 'running') return undefined;
        const snapshot = guard();
        const plan = planNext(snapshot, run.goal);
        if (plan.terminal) { finish(plan.terminal.status, plan.terminal.reason); return undefined; }
        if (!plan.eligible.length) { finish('blocked', plan.blocker ?? 'No eligible operation for the saved inputs.'); return undefined; }
        if (run.steps >= this.maxSteps) { finish('blocked', 'step_limit'); return undefined; }
        let selected: BoundAction | undefined;
        run.latestDecision = { inputRevision: run.inputRevision, configVersion: run.configVersion,
          stage: plan.stage, eligibleIds: plan.eligible.map(a => a.id), source: 'code' };
        if (plan.eligible.length === 1) selected = plan.eligible[0];
        else {
          const request = choiceRequest(snapshot, run.goal, plan, run.latestResult);
          run.latestDecision.model = JEV_MODEL;
          try {
            const envelope = await bounded(active.controller.signal, this.timeout,
              signal => this.options.choice.choose(request, signal));
            guard();
            const choice = validateChoice(envelope, request);
            selected = plan.eligible.find(a => a.id === choice.id);
            run.latestDecision.source = 'jev';
            run.latestDecision.confidence = choice.confidence;
          } catch (error) {
            guard(); // Cancellation / input edits are never converted into a question fallback.
            const reason = error instanceof ChoiceFailure || error instanceof ExecutionStop ? error.message : 'choice_service_failure';
            selected = fallbackQuestion(plan.eligible);
            run.latestDecision.source = 'fallback'; run.latestDecision.fallback = reason;
            run.latestFallback = reason;
            if (!selected) { finish('blocked', `${reason}; ${plan.blocker ?? 'No eligible input question is available.'}`); return undefined; }
          }
        }
        guard();
        if (!selected) throw new Error('No bound action');
        run.latestDecision.selectedId = selected.id;
        run.latestAction = selected.id;
        pending = selected;
        save();
        return selected;
      } catch (error) { fail(error); throw error; }
    });
    const parameters = Type.Object({ runId: Type.String(), actionId: Type.String() }, { additionalProperties: false });
    const tools: AgentTool<typeof parameters>[] = operations.map(operation => ({
      name: operation, label: operation, description: 'Execute the current server-bound business operation.',
      parameters, executionMode: 'sequential', replay: 'never',
      execute: async (_callId, args) => {
        try {
          const before = guard();
          const action = pending;
          if (run.status !== 'running' || !action || args.runId !== run.id || args.actionId !== action.id || action.operation !== operation) throw new Error('Invalid action binding');
          pending = undefined; // One-shot binding; no replay of this tool call.
          run.steps += 1;
          if (operation === 'request_input') {
            if (!action.question) throw new Error('Missing question');
            run.question = action.question;
            run.latestResult = action.question.text;
            finish('waiting_input', 'Answer through the domain API, then start a fresh run.');
            return { content: [{ type: 'text', text: action.question.text }], details: { question: action.question }, terminate: true };
          }
          save();
          const context = { packageId: run.packageId, runId: run.id, actionId: action.id,
            inputRevision: run.inputRevision, configVersion: run.configVersion, signal: active.controller.signal };
          const result = await bounded(active.controller.signal, this.timeout,
            signal => domain.execute(action, { ...context, signal }));
          guard();
          if (!domain.commit(action, result, context)) throw new ExecutionStop('input_or_config_changed');
          const after = guard();
          run.latestResult = result.summary;
          if (JSON.stringify(before) === JSON.stringify(after)) finish('blocked', 'no_progress');
          else save();
          return { content: [{ type: 'text', text: result.summary }], details: { actionId: action.id }, terminate: run.status !== 'running' };
        } catch (error) {
          fail(error);
          // Pi catches tool errors. The persisted status prevents another domain operation.
          throw new Error('Business operation stopped; inspect the saved run status.');
        }
      },
    }));
    try {
      const agent = new Agent({ initialState: { model: WORKFLOW_MODEL, tools, thinkingLevel: 'off',
        systemPrompt: 'Execute only the current server-bound business operation.' }, streamFn, toolExecution: 'sequential',
        finishTurn: () => run.status === 'running' ? undefined : { action: 'end' } });
      active.agent = agent;
      if (this.options.onEvent) agent.subscribe(event => this.options.onEvent!(run.id, event));
      if (active.controller.signal.aborted) throw new ExecutionStop('cancelled');
      await agent.prompt(`Execute ${run.goal} for the saved work package.`);
      if (run.status === 'running') {
        guard();
        finish('failed', 'Pi ended without a policy stop; business completion was not inferred.');
      }
    } catch (error) { fail(error); }
    return structuredClone(run);
  }
}
