import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { BoundAction } from './contracts.js';

// Metadata only. No provider registry, model discovery, API key lookup or default LLM stream.
export const WORKFLOW_MODEL: Model<'workflow-choice'> = {
  id: 'bound-business-actions', name: 'Bound business actions', api: 'workflow-choice',
  provider: 'workflow', baseUrl: '', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 256,
};
export function decisionStream(runId: string, decide: (signal?: AbortSignal) => Promise<BoundAction | undefined>): StreamFn {
  return (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [], api: WORKFLOW_MODEL.api, provider: WORKFLOW_MODEL.provider,
      model: WORKFLOW_MODEL.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      try {
        const selected = await decide(options?.signal);
        options?.signal?.throwIfAborted();
        stream.push({ type: 'start', partial: message });
        if (selected) {
          const call: ToolCall = { type: 'toolCall', id: `${runId}:${crypto.randomUUID()}`,
            name: selected.operation, arguments: {} };
          message.content.push(call);
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          call.arguments = { runId, actionId: selected.id };
          stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = 'toolUse';
        }
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      } catch {
        message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = 'Workflow decision failed; inspect the saved run status.';
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { stream.end(message); }
    })();
    return stream;
  };
}
