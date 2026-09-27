import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentOutputs, JsonRunStore, WorkflowRunner } from '../src/index.js';
import { FixtureDomain, RecordedChoices } from '../test/fixtures/domain.js';

const directory = mkdtempSync(join(tmpdir(), 'pi-jev-fixture-'));
console.log('TEST FIXTURES ONLY — no materials engine, route generation, rule compliance or actual PDF/CSV export.');
console.log(`Saved example input/output/run files: ${directory}`);
for (const intent of ['prepare_from_drawing', 'adapt_to_site'] as const) {
  const domain = new FixtureDomain(intent, join(directory, `${intent}-inputs-and-outputs.json`));
  const choices = new RecordedChoices();
  const runner = new WorkflowRunner({ domain, store: new JsonRunStore(join(directory, `${intent}-runs.json`)),
    choice: choices, configVersion: 'fixture-v1', onEvent(runId, event) {
      if (event.type === 'tool_execution_start') console.log(`${runId.slice(0, 8)} Pi tool: ${event.toolName}`);
    } });
  const start = () => runner.start('fixture-package', 'export_selected_package', domain.read('fixture-package')).done;
  let run = await start();
  if (run.question?.kind === 'candidate_selection') {
    console.log('USER selects fixture candidate-a after reviewing comparison.');
    domain.answer([], 'candidate-a');
    run = await start();
  }
  console.log(`${intent}: ${run.status}; ${run.question?.text}`);
  if (run.status !== 'waiting_input') throw new Error('Expected a domain input question');
  const waitingId = run.id;
  console.log('USER supplies fixture answers; semantic revision increments.');
  domain.answer(['joint_datum', 'assembly_access']);
  run = await start();
  if (run.status !== 'completed' || run.id === waitingId) throw new Error('Fresh run did not complete');
  console.log(`${intent}: ${run.status}; fresh Agent/run; ${choices.requests.length} recorded Choice responses consumed.`);
  console.log('Current fixture outputs:', currentOutputs(domain.read('fixture-package')).map(o => o.kind));
}
