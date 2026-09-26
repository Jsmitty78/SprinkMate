import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPiDriver } from '../apps/server/src/pi.js';
import { FieldService } from '../apps/server/src/service.js';

// Opt-in live check: uses the existing server-side Pi credentials and one model run.
// The code exists only inside the image, so readback checks actual image input.
const imageCode = randomBytes(3).toString('hex').toUpperCase();
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
  <rect width="800" height="500" fill="white"/>
  <circle cx="180" cy="175" r="80" fill="#dd2222"/>
  <rect x="350" y="95" width="160" height="160" fill="#2255dd"/>
  <text x="75" y="365" font-family="Arial" font-size="60" fill="black">CHECK-CODE: ${imageCode}</text>
</svg>`;
const directory = await mkdtemp(join(tmpdir(), 'field-pi-live-'));
const service = new FieldService(directory);
try {
  service.createTask({ id: 'image-smoke', title: 'Pi画像接続テスト（合成）' });
  await service.addObservation('image-smoke', {
    id: 'smoke-image', targetId: 'H1', source: 'fixture', synthetic: true, capturedAt: new Date().toISOString(),
  }, Buffer.from(svg));
  await createPiDriver(service, { maxRunMs: 120_000, maxToolCalls: 8 }).run('image-smoke',
    'これは合成画像を使った接続テストです。get_task_contextを読み、validate_taskを1回実行してください。' +
    'fact提案・追加要求・成果物は作らず、最後に画像の形と色、およびCHECK-CODEの文字列を答えてください。' +
    '合成画像なので現場や規格の適合は主張しないでください。', new AbortController().signal);
  const task = service.getTask('image-smoke');
  const events = service.store.events('image-smoke', 0).filter(event => event.type === 'agent');
  const imageReadback = events.some(event => event.data.kind === 'message' && String(event.data.text).includes(imageCode));
  const validatorTool = events.some(event => event.data.kind === 'tool_finished' && event.data.tool === 'validate_task' && !event.data.failed);
  const noAuthorityEscalation = Object.values(task.facts).every(fact => !fact.confirmed) && task.validation?.rule.status === 'unknown';
  console.log(JSON.stringify({
    provider: 'openai-codex', model: 'gpt-6-astra', imageReadback, validatorTool, noAuthorityEscalation,
  }));
  if (!imageReadback || !validatorTool || !noAuthorityEscalation) process.exitCode = 1;
} catch (error) {
  // Provider errors may contain request details. Never print credentials or raw errors.
  const message = error instanceof Error ? error.message : '';
  const category = /EACCES|EPERM|permission|denied|not permitted|approval/i.test(message) ? 'credential_access_denied'
    : /Invalid auth\.json|Failed to read auth\.json/i.test(message) ? 'credential_storage_invalid'
    : /storage lock/i.test(message) ? 'credential_storage_locked'
    : /not configured|No API key|No credentials/i.test(message) ? 'credential_missing'
    : /モデルが見つかりません|Unknown model/i.test(message) ? 'model_unavailable'
    : /auth|OAuth|API key|credential|認証/i.test(message) ? 'authentication_or_provider'
    : /network|fetch|connect|ENOTFOUND/i.test(message) ? 'connection'
    : /time|時間上限/i.test(message) ? 'timeout'
    : /schema|tool.*invalid|invalid.*tool/i.test(message) ? 'tool_schema'
    : 'runtime';
  const locations = error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 4)
    .map(line => line.match(/([A-Za-z0-9_./@+-]+\.(?:ts|js|mjs|cjs):\d+:\d+)/)?.[1]).filter(Boolean) : [];
  const agentEvents = service.store.events('image-smoke', 0).filter(event => event.type === 'agent');
  console.error(JSON.stringify({ liveSmoke: false, category, locations,
    errorName: error instanceof Error ? error.name : typeof error,
    events: agentEvents.map(event => ({ kind: event.data.kind, tool: event.data.tool, code: event.data.code })),
  }));
  process.exitCode = 1;
} finally {
  service.store.close();
  await rm(directory, { recursive: true, force: true });
}
