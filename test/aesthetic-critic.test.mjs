import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCritiqueRubric, RUBRIC_VERSION, critiqueContextFromBrief } from '../agents/llm/aesthetic-critic.mjs';
import { spearman, buildReport } from '../agents/llm/rate-critique.mjs';
import crypto from 'crypto';

test('starless narrowband rubric', () => {
  const r = buildCritiqueRubric({ starless: true, narrowband: true, palette: 'SHO' });
  assert.match(r, /Do NOT score axis 4/);
  assert.match(r, /False-colour SHO/);
  assert.match(r, /most images score 5-7/);
  assert.equal(RUBRIC_VERSION, 2);
});
test('galaxy rubric', () => {
  const r = buildCritiqueRubric({ classification: 'galaxy_spiral', referenceNotes: 'keep it calm' });
  assert.match(r, /muted saturation is CORRECT/);
  assert.match(r, /Owner intent: keep it calm/);
  assert.doesNotMatch(r, /Do NOT score axis 4/);
});
test('context from brief', () => {
  const c = critiqueContextFromBrief({ target: { classification: 'x' }, dataDescription: { starless: true, narrowband: true }, processingProfile: { palette: { goal: 'HOO' } } });
  assert.equal(c.palette, 'HOO'); assert.equal(c.starless, true);
});
test('cache key differs when rubric differs', () => {
  const key = (b, rub) => crypto.createHash('sha256').update(b).update(rub).update('opus').digest('hex').slice(0, 16) + `-v${RUBRIC_VERSION}.json`;
  const jpg = Buffer.from('abc');
  assert.notEqual(key(jpg, buildCritiqueRubric({})), key(jpg, buildCritiqueRubric({ starless: true })));
});
test('spearman', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  const rep = buildReport([
    { hash: 'a', score: 5, classification: 'g' }, { hash: 'b', score: 6, classification: 'g' }, { hash: 'c', score: 7, classification: 'g' },
    { hash: 'a', user_rating: 3 }, { hash: 'b', user_rating: 5 }, { hash: 'c', user_rating: 8 }]);
  assert.equal(rep.g.n, 3); assert.equal(rep.g.rho, 1);
});
