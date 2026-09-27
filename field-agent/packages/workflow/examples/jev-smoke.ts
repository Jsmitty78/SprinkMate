import { bounded } from '../src/bounded.js';
import { ChoiceFailure, choiceRequest, JevHttpClient, JEV_MODEL, validateChoice } from '../src/choice.js';
import { planNext } from '../src/policy.js';
import { FixtureDomain } from '../test/fixtures/domain.js';

// Only a synthetic, non-sensitive request is sent. No domain tool runs and no retries occur.
const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.log('SKIPPED: TYPESAFE_API_KEY is not configured. Live JEV connection is unverified.');
  process.exitCode = 2;
} else {
  const domain = new FixtureDomain();
  const snapshot = domain.read('fixture-package');
  snapshot.outputs = [
    { id: 'm', kind: 'model', subjectId: snapshot.drawingId, inputRevision: 1, configVersion: 'fixture-v1' },
    { id: 'p', kind: 'package', subjectId: snapshot.baselinePlanId, inputRevision: 1, configVersion: 'fixture-v1' },
    { id: 'e', kind: 'evaluation', subjectId: snapshot.baselinePlanId, inputRevision: 1, configVersion: 'fixture-v1' },
  ];
  const request = choiceRequest(snapshot, snapshot.intent, planNext(snapshot, snapshot.intent));
  try {
    const response = await bounded(new AbortController().signal, 15_000, signal => new JevHttpClient(key).choose(request, signal));
    let decision: { id: string; confidence: number } | { fallback: string };
    try { decision = validateChoice(response, request); }
    catch (error) {
      // These reasons occur only after shape/model/distribution/version validation succeeds.
      if (!(error instanceof ChoiceFailure) || !['needs_clarification', 'ambiguous_distribution'].includes(error.message)) throw error;
      decision = { fallback: error.message };
    }
    console.log(JSON.stringify({ connection: 'verified', model: JEV_MODEL, ...decision, scope: 'One synthetic Choice request only; no product accuracy claim.' }, null, 2));
  } catch {
    console.error('Live smoke did not pass transport/Choice validation. No credentials or raw service response were logged.');
    process.exitCode = 1;
  }
}
