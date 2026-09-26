import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  createAgentSession, ModelRuntime, SessionManager,
  type AgentSessionEvent, type CreateAgentSessionOptions, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Check } from 'typebox/value';
import { createPiDriver, type PiDriverOptions } from '../src/pi.js';
import { FieldService } from '../src/service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function setup(onPrompt?: (options: CreateAgentSessionOptions, emit: (event: AgentSessionEvent) => void) => Promise<void>, overrides: PiDriverOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'field-pi-'));
  const service = new FieldService(dir);
  service.createTask({ id: 'task-one' });
  cleanups.push(async () => { service.store.close(); await rm(dir, { recursive: true, force: true }); });
  const captured: CreateAgentSessionOptions[] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
  const unsubscribe = vi.fn();
  const prompt = vi.fn(async (_text: string, _options?: unknown) => {
    await onPrompt?.(captured.at(-1)!, emit);
    emit({ type: 'agent_settled' });
  });
  const abort = vi.fn(async () => {});
  const dispose = vi.fn();
  const createRuntime = vi.fn(async () => ({ getModel: () => ({ id: 'test-model', provider: 'test' }) } as unknown as ModelRuntime));
  const createSession: NonNullable<PiDriverOptions['createSession']> = async options => {
    captured.push(options);
    return { session: {
      sessionFile: options.sessionManager!.getSessionFile(), prompt, abort, dispose,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); unsubscribe(); };
      },
    } };
  };
  const driver = createPiDriver(service, { createRuntime, createSession, ...overrides });
  return { service, driver, captured, prompt, abort, dispose, unsubscribe, createRuntime, emit, dir };
}

const tools = (options: CreateAgentSessionOptions) => new Map(options.customTools!.map(tool => [tool.name, tool]));
async function execute(tool: ToolDefinition, params: unknown = {}, callId = 'call-one') {
  return tool.execute(callId, params as never, undefined, undefined, {} as ExtensionContext);
}
async function addImage(service: FieldService, id = 'photo-one') {
  const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#2875c1' } }).jpeg().toBuffer();
  return service.addObservation('task-one', {
    id, targetId: 'H1', source: 'file', synthetic: false, capturedAt: '2026-09-26T00:00:00Z',
  }, bytes);
}

describe('Pi task adapter', () => {
  it('loads authentication only on an explicit run and publishes only task tools', async () => {
    const t = await setup();
    expect(t.createRuntime).not.toHaveBeenCalled();
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
    expect(t.createRuntime).toHaveBeenCalledOnce();
    const options = t.captured[0];
    expect(options.tools).toEqual([
      'get_task_context', 'get_observation', 'image_crop', 'get_reference', 'propose_facts', 'record_finding',
      'request_capture', 'request_measurement', 'request_confirmation', 'validate_measurement', 'validate_task', 'prepare_artifact',
    ]);
    expect(options.customTools!.every(tool => tool.executionMode === 'sequential')).toBe(true);
    expect(options.tools).not.toContain('review_facts');
    expect(options.tools).not.toContain('answer');
    expect(options.tools).not.toContain('bash');
    const loader = options.resourceLoader!;
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(t.prompt.mock.calls[0][1]).toMatchObject({ expandPromptTemplates: false });
    expect(t.unsubscribe).toHaveBeenCalledOnce();
    expect(t.dispose).toHaveBeenCalledOnce();
  });

  it('passes real JPEG bytes and the corresponding observation ID to the model', async () => {
    const t = await setup();
    await addImage(t.service);
    await t.driver.run('task-one', '写真を確認', new AbortController().signal);
    const [message, options] = t.prompt.mock.calls[0];
    expect(message).toContain('Attached observation: photo-one; normalized 48x32');
    const image = (options as { images: { type: string; mimeType: string; data: string }[] }).images[0];
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/jpeg');
    expect((await sharp(Buffer.from(image.data, 'base64')).metadata()).width).toBe(48);
  });

  it('returns crops as image content and keeps observation access scoped to the task', async () => {
    const t = await setup(async options => {
      const api = tools(options);
      const result = await execute(api.get('image_crop')!, { observationId: 'photo-one', x: 4, y: 5, width: 8, height: 7 });
      const image = result.content[0];
      expect(image.type).toBe('image');
      if (image.type === 'image') expect((await sharp(Buffer.from(image.data, 'base64')).metadata()).width).toBe(8);
      await expect(execute(api.get('get_observation')!, { observationId: 'foreign-photo' })).rejects.toThrow('観測');
      await expect(execute(api.get('get_task_context')!, { taskId: 'foreign' })).rejects.toThrow('引数');
    });
    await addImage(t.service);
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
  });

  it('cannot submit confirmed facts, answer a human request, or choose a validator result', async () => {
    const t = await setup(async options => {
      const api = tools(options);
      const propose = api.get('propose_facts')!;
      const valid = { reason: 'visible marking', facts: { model: { value: 'TY3231', evidenceIds: ['photo-one'] } } };
      expect(Check(propose.parameters, valid)).toBe(true);
      const forged = { ...valid, facts: { model: { ...valid.facts.model, confirmed: true, source: 'manual' } } };
      expect(Check(propose.parameters, forged)).toBe(false);
      await expect(execute(propose, forged)).rejects.toThrow('引数');
      await execute(propose, valid, 'candidate-call');
      expect(t.service.getTask('task-one').facts.model).toMatchObject({ confirmed: false, source: 'model' });
      const result = await execute(api.get('validate_task')!);
      expect(JSON.parse((result.content[0] as { text: string }).text).rule.status).toBe('unknown');
      await expect(execute(api.get('validate_task')!, { status: 'pass' })).rejects.toThrow('引数');
      expect([...api.keys()]).not.toContain('reviewFacts');
      expect([...api.keys()]).not.toContain('answer');
    });
    await addImage(t.service);
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
  });

  it('persists deduplicated requests and unverified findings while blocking premature artifacts', async () => {
    const t = await setup(async options => {
      const api = tools(options);
      await execute(api.get('request_capture')!, { reason: '刻印が読めません', fields: ['model'] }, 'request-1');
      await execute(api.get('request_capture')!, { reason: '別の言い方', fields: ['model'] }, 'request-2');
      await execute(api.get('record_finding')!, { description: '配管の近くに物体が見えます', evidenceIds: ['photo-one'] }, 'finding-1');
      expect(t.service.getTask('task-one').requests).toHaveLength(1);
      expect(t.service.getTask('task-one').findings[0].status).toBe('unverified');
      await expect(execute(api.get('prepare_artifact')!)).rejects.toThrow();
    });
    await addImage(t.service);
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
  });

  it('blocks all tool mutations after cancellation and aborts the Pi run', async () => {
    const controller = new AbortController();
    const t = await setup(async options => {
      controller.abort(new Error('cancelled by test'));
      await expect(execute(tools(options).get('request_capture')!, { reason: 'test', fields: ['model'] })).rejects.toThrow('cancelled');
    });
    await expect(t.driver.run('task-one', 'inspect', controller.signal)).rejects.toThrow('cancelled');
    expect(t.service.getTask('task-one').requests).toHaveLength(0);
    expect(t.abort).toHaveBeenCalledOnce();
    expect(t.dispose).toHaveBeenCalledOnce();
  });

  it('does not even initialize Pi for an already cancelled task', async () => {
    const t = await setup();
    t.service.cancel('task-one');
    await expect(t.driver.run('task-one', 'inspect', new AbortController().signal)).rejects.toThrow('キャンセル');
    expect(t.createRuntime).not.toHaveBeenCalled();
  });

  it('stops repeated tool calls at the budget boundary', async () => {
    const t = await setup(async options => {
      const read = tools(options).get('get_task_context')!;
      await execute(read);
      await expect(execute(read)).rejects.toThrow('回数上限');
    }, { maxToolCalls: 1 });
    await expect(t.driver.run('task-one', 'inspect', new AbortController().signal)).rejects.toThrow('回数上限');
    expect(t.abort).toHaveBeenCalledOnce();
  });

  it('blocks a delayed mutation after the run time budget expires', async () => {
    const t = await setup(async options => {
      await new Promise(resolve => setTimeout(resolve, 45));
      await expect(execute(tools(options).get('request_capture')!, { reason: 'late', fields: ['model'] })).rejects.toThrow('時間上限');
    }, { maxRunMs: 20 });
    await expect(t.driver.run('task-one', 'inspect', new AbortController().signal)).rejects.toThrow('時間上限');
    expect(t.service.getTask('task-one').requests).toHaveLength(0);
  });

  it('treats a resolved prompt with an assistant error as a failed run without exposing error text', async () => {
    const t = await setup(async (_options, emit) => {
      emit({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'failed-response-do-not-publish' }],
        stopReason: 'error', errorMessage: 'OAuth secret-do-not-publish',
      } } as unknown as AgentSessionEvent);
    });
    await expect(t.driver.run('task-one', 'inspect', new AbortController().signal)).rejects.toThrow('authentication');
    const events = JSON.stringify(t.service.store.events('task-one', 0));
    expect(events).toContain('model_error');
    expect(events).not.toContain('secret-do-not-publish');
    expect(events).not.toContain('failed-response-do-not-publish');
    expect(t.dispose).toHaveBeenCalledOnce();
  });

  it('reopens the exact saved session and retains its history on the next run', async () => {
    let runs = 0;
    const t = await setup(async options => {
      const manager = options.sessionManager!;
      if (runs++ > 0) expect(manager.getBranch().some(entry => entry.type === 'message')).toBe(true);
      manager.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: 'preserved history' }],
        api: 'openai-responses', provider: 'openai-codex', model: 'gpt-6-astra', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    });
    await t.driver.run('task-one', 'first', new AbortController().signal);
    const path = t.service.getSessionPath('task-one');
    await t.driver.run('task-one', 'second', new AbortController().signal);
    expect(t.service.getSessionPath('task-one')).toBe(path);
    expect(t.captured[1].sessionManager!.getSessionFile()).toBe(path);
    expect(t.createRuntime).toHaveBeenCalledOnce();
  });

  it('emits selected public messages and progress without raw tool results or model internals', async () => {
    const t = await setup(async (_options, emit) => {
      emit({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'get_observation', args: { internal: 'hide-me' } });
      emit({ type: 'tool_execution_end', toolCallId: 'one', toolName: 'get_observation', result: { imageData: 'hide-image' }, isError: false });
    });
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
    const events = JSON.stringify(t.service.store.events('task-one', 0));
    expect(events).toContain('tool_started');
    expect(events).toContain('settled');
    expect(events).not.toContain('hide-me');
    expect(events).not.toContain('hide-image');
  });

  it('registers the allowlist with the real installed SDK without discovering local resources', async () => {
    const t = await setup();
    const capturedDir = join(t.dir, 'would-be-local-resources');
    await mkdir(join(capturedDir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(capturedDir, '.pi', 'extensions', 'forbidden.ts'), 'throw new Error("Should never load");');
    await writeFile(join(capturedDir, 'AGENTS.md'), 'FORBIDDEN_LOCAL_CONTEXT');
    await t.driver.run('task-one', 'inspect', new AbortController().signal);
    // This new runtime has an isolated, absent credential file, not the user's auth store.
    const runtime = await ModelRuntime.create({ authPath: join(t.dir, 'empty-auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModels()[0];
    expect(model).toBeDefined();
    const { session } = await createAgentSession({
      ...t.captured[0], cwd: capturedDir, modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(capturedDir),
    });
    try {
      expect(session.getActiveToolNames().sort()).toEqual([...t.captured[0].tools!].sort());
      expect(session.systemPrompt).not.toContain('FORBIDDEN_LOCAL_CONTEXT');
      expect(session.systemPrompt).toContain('You cannot confirm facts');
    } finally { session.dispose(); }
  });
});
