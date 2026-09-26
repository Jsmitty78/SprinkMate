import { expect,it } from 'vitest';
import { evaluateReal } from '../../../scripts/evaluate-real.js';

it('keeps unknown, wrong hit, and unmeasurable results in the evaluation denominator',()=>{
  const report=evaluateReal({orientationCases:[{id:'o1',synthetic:false,expected:'pendent',predicted:'pendent'},{id:'o2',synthetic:false,expected:'upright',predicted:null}],measurementCases:[{id:'m1',synthetic:false,referenceMeters:2,measuredMeters:2.1,wrongHit:false},{id:'m2',synthetic:false,referenceMeters:2,measuredMeters:4,wrongHit:true},{id:'m3',synthetic:false,referenceMeters:2,measuredMeters:null,wrongHit:false}]});
  expect(report.orientation).toMatchObject({total:2,classified:1,unknown:1,correct:1});
  expect(report.measurement).toMatchObject({total:3,unmeasurable:1,wrongHit:1,correctHitMeasured:1});
  expect(report.measurement.meanAbsoluteErrorMeters).toBeCloseTo(.1);
});
it('rejects synthetic records from real evaluation',()=>{
  expect(()=>evaluateReal({orientationCases:[{id:'synthetic',synthetic:true,expected:'pendent',predicted:'pendent'} as never],measurementCases:[]})).toThrow('non-synthetic');
});
