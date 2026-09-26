import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Offline evaluation only. Labels are never loaded by the server. */
interface ImageCase {id:string;synthetic:false;expected:'pendent'|'upright'|'sideways';predicted:'pendent'|'upright'|'sideways'|null}
interface DistanceCase {id:string;synthetic:false;referenceMeters:number;measuredMeters:number|null;wrongHit:boolean}
export function evaluateReal(input:{orientationCases:ImageCase[];measurementCases:DistanceCase[]}) {
  if(!Array.isArray(input.orientationCases)||!Array.isArray(input.measurementCases))throw new Error('Both case arrays are required');
  const all=[...input.orientationCases,...input.measurementCases];
  if(all.some(c=>!c.id||c.synthetic!==false))throw new Error('This evaluator requires explicitly non-synthetic, labeled records');
  if(new Set(all.map(c=>c.id)).size!==all.length)throw new Error('Evaluation case IDs must be unique');
  const orientations=['pendent','upright','sideways'];
  if(input.orientationCases.some(c=>!orientations.includes(c.expected)||(c.predicted!==null&&!orientations.includes(c.predicted))))throw new Error('Invalid orientation label');
  if(input.measurementCases.some(c=>!Number.isFinite(c.referenceMeters)||c.referenceMeters<=0||(c.measuredMeters!==null&&(!Number.isFinite(c.measuredMeters)||c.measuredMeters<0))||typeof c.wrongHit!=='boolean'))throw new Error('Invalid reference measurement');
  const classified=input.orientationCases.filter(c=>c.predicted!==null),correct=classified.filter(c=>c.predicted===c.expected);
  const distances=input.measurementCases.filter(c=>c.measuredMeters!==null&&!c.wrongHit);
  const errors=distances.map(c=>({id:c.id,signedErrorMeters:c.measuredMeters!-c.referenceMeters,absoluteErrorMeters:Math.abs(c.measuredMeters!-c.referenceMeters),relativeError:Math.abs(c.measuredMeters!-c.referenceMeters)/c.referenceMeters}));
  const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return {
    evaluatedAt:new Date().toISOString(),synthetic:false,
    orientation:{total:input.orientationCases.length,classified:classified.length,unknown:input.orientationCases.length-classified.length,correct:correct.length,incorrect:classified.length-correct.length,accuracyAmongClassified:classified.length?correct.length/classified.length:null,perCase:input.orientationCases},
    measurement:{total:input.measurementCases.length,unmeasurable:input.measurementCases.filter(c=>c.measuredMeters===null).length,wrongHit:input.measurementCases.filter(c=>c.wrongHit).length,correctHitMeasured:distances.length,meanAbsoluteErrorMeters:mean(errors.map(e=>e.absoluteErrorMeters)),meanSignedErrorMeters:mean(errors.map(e=>e.signedErrorMeters)),maximumAbsoluteErrorMeters:errors.length?Math.max(...errors.map(e=>e.absoluteErrorMeters)):null,perCase:input.measurementCases,errors},
    limitation:'Measured on the supplied labeled dataset only. No physical accuracy or whole-system compliance guarantee.',
  };
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)) {
  const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: pnpm evaluate:real <labeled-input.json> <report.json>');
  const report=evaluateReal(JSON.parse(readFileSync(input,'utf8')));writeFileSync(output,JSON.stringify(report,null,2));
  console.log(`Evaluation report saved: ${resolve(output)}`);
}
