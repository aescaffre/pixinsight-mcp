import { measureCoreContrast } from '../agents/ops/subject-metrics.mjs';
import assert from 'node:assert';
const mk = (o) => ({ pjsr: async () => ({ status: 'ok', outputs: { consoleOutput: JSON.stringify(Object.assign({
  coreRelContrast: 0.15, shellRelContrast: 0.3, ratio: 0.5, coreLum: 0.7, coreSat: 0.3,
  coreWhiteFraction: 0.02, coreStructFrac: 0.95, haloFrac: 0.012, coreFraction: 0.02, peak: 0.9, bg: 0.1 }, o)) } }) });
let r = await measureCoreContrast(mk({}), 'x', 'galaxy_spiral', {});
assert.ok(r.pass && r.relAdvisory && /relC advisory/.test(r.details));
r = await measureCoreContrast(mk({ coreStructFrac: 0.45 }), 'x', 'galaxy_spiral', {});
assert.ok(!r.pass);
r = await measureCoreContrast(mk({ coreWhiteFraction: 0.3 }), 'x', 'galaxy_spiral', {});
assert.ok(!r.pass);
r = await measureCoreContrast(mk({ coreRelContrast: 0.5 }), 'x', 'galaxy_spiral', {});
assert.ok(r.pass && !r.relAdvisory);
r = await measureCoreContrast(mk({ haloFrac: 0.06 }), 'x', 'galaxy_spiral', {});
assert.ok(!r.pass);
console.log('ok');
