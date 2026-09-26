import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgentSession, createExtensionRuntime, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent,
  type CreateAgentSessionOptions, type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { AppError } from './models.js';
import type { FieldService } from './service.js';
import { createFieldReviewPlugin } from './plugins/field-review.js';

export interface PiDriver {
  run(taskId: string, message: string, signal: AbortSignal): Promise<void>;
}

type Session = Pick<AgentSession, 'prompt' | 'subscribe' | 'abort' | 'dispose' | 'sessionFile'>;
export interface PiDriverOptions {
  provider?: string;
  modelId?: string;
  authDirectory?: string;
  maxRunMs?: number;
  maxToolCalls?: number;
  createRuntime?: typeof ModelRuntime.create;
  createSession?: (options: CreateAgentSessionOptions) => Promise<{ session: Session }>;
}

function appResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function publicEvent(event: AgentSessionEvent): unknown | undefined {
  if (event.type === 'tool_execution_start') return { kind: 'tool_started', tool: event.toolName };
  if (event.type === 'tool_execution_end') return { kind: 'tool_finished', tool: event.toolName, failed: event.isError };
  if (event.type === 'agent_settled') return { kind: 'settled' };
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') return undefined;
    const text = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    return text ? { kind: 'message', text } : undefined;
  }
  return undefined;
}

export function createPiDriver(service: FieldService, options: PiDriverOptions = {}): PiDriver {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const authDirectory = options.authDirectory ?? getAgentDir();
  const createRuntime = options.createRuntime ?? ModelRuntime.create;
  const createSession = options.createSession ?? createAgentSession;
  const maxToolCalls = options.maxToolCalls ?? 24;
  const maxRunMs = options.maxRunMs ?? 120_000;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || !Number.isFinite(maxRunMs) || maxRunMs < 1) {
    throw new Error('Piの実行上限が不正です');
  }

  return {
    async run(taskId, message, callerSignal) {
      const controller = new AbortController();
      const signal = AbortSignal.any([callerSignal, controller.signal]);
      const guard = () => {
        signal.throwIfAborted();
        if (service.getTask(taskId).state === 'cancelled') throw new AppError(409, 'この仕事はキャンセル済みです');
      };
      guard();
      const timeout = setTimeout(() => controller.abort(new Error('Piの実行時間上限に達しました')), maxRunMs);
      let session: Session | undefined;
      let unsubscribe: (() => void) | undefined;
      let aborting: Promise<void> | undefined;
      let modelFailed = false;
      let modelFailureCode = 'provider_error';
      const abort = () => { aborting ??= session?.abort().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      let toolCalls = 0;

      const plugin = createFieldReviewPlugin(service, taskId, {
        guard,
        onToolCall() {
          if (++toolCalls > maxToolCalls) {
            controller.abort(new Error('Piのツール回数上限に達しました'));
            signal.throwIfAborted();
          }
        },
      });

      try {
        // Authentication is loaded only when an explicitly requested run starts.
        runtimePromise ??= createRuntime({
          authPath: join(authDirectory, 'auth.json'), modelsPath: join(authDirectory, 'models.json'), allowModelNetwork: false,
        }).catch(error => { runtimePromise = undefined; throw error; });
        const runtime = await runtimePromise;
        guard();
        const model = runtime.getModel(options.provider ?? 'openai-codex', options.modelId ?? 'gpt-6-astra');
        if (!model) throw new Error('指定されたPiモデルが見つかりません');
        const cwd = join(service.dataDir, 'pi', taskId);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        guard();
        const savedPath = service.getSessionPath(taskId);
        const manager = savedPath ? SessionManager.open(savedPath, cwd, cwd) : SessionManager.create(cwd, cwd);
        ({ session } = await createSession({
          cwd, agentDir: join(service.dataDir, 'pi-config'), modelRuntime: runtime, model,
          resourceLoader: appResources(plugin.systemPrompt), sessionManager: manager,
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' }),
          customTools: plugin.tools, tools: plugin.tools.map(t => t.name),
        }));
        guard();
        if (session.sessionFile) service.setSessionPath(taskId, session.sessionFile);
        unsubscribe = session.subscribe(event => {
          if (signal.aborted || service.getTask(taskId).state === 'cancelled') return;
          if (event.type === 'message_end' && event.message.role === 'assistant' &&
              (event.message.stopReason === 'error' || event.message.stopReason === 'aborted')) {
            modelFailed = true;
            const error = event.message.errorMessage ?? '';
            modelFailureCode = /auth|oauth|API key|401|403|credential|expired/i.test(error) ? 'authentication'
              : /not found|unknown model|does not exist/i.test(error) ? 'model_unavailable'
              : /schema|parameter|tool|unsupported/i.test(error) ? 'request_rejected'
              : /fetch|network|connect|ENOTFOUND/i.test(error) ? 'connection' : 'provider_error';
            service.recordAgentEvent(taskId, { kind: 'model_error', code: modelFailureCode });
          }
          const output = publicEvent(event);
          if (output) service.recordAgentEvent(taskId, output);
        });
        const latest = service.getTask(taskId).observations.filter(o => !o.superseded).at(-1);
        const image = latest ? await service.getObservationImage(taskId, latest.id) : undefined;
        guard();
        const imageNote = latest ? `\nAttached observation: ${latest.id}; normalized ${latest.width}x${latest.height} pixels; synthetic=${latest.synthetic}.` : '';
        await session.prompt(`${message}${imageNote}`, {
          expandPromptTemplates: false,
          images: image ? [{ type: 'image', ...image }] : undefined,
        });
        guard();
        if (modelFailed) throw new Error(`Piのモデル呼出しが完了しませんでした (${modelFailureCode})`);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        await aborting;
        unsubscribe?.();
        session?.dispose();
      }
    },
  };
}
