import { describe, expect, it } from 'vitest';
import { referenceDrawing, referenceChanges, referenceProvenance, referenceSource, referenceCounts } from '../src/reference.js';
import { validateDrawing, pipeLength, renderDrawingSvg, drawingBody, defaultDrawingLayers } from '../src/plan.js';
import { connectAt, newDrawingId } from '../src/plan-edit.js';
describe('FS-01 mezzanine source reproduction',()=>{
  it('never reuses a deleted source ID for a newly drawn element',()=>{
    const d=referenceDrawing();d.heads=d.heads.filter(h=>h.id!=='H2');d.pipes=d.pipes.filter(p=>p.id!=='P8');
    expect(newDrawingId(d,'H')).toBe('H20');expect(newDrawingId(d,'P')).toBe('P42');
    expect(referenceProvenance(newDrawingId(d,'H'))).toBeNull();
  });
  it('rejects contradictory DN/inch imports and limits labels to changed or selected pipes',()=>{
    const d=referenceDrawing(),p=d.pipes.find(p=>p.id==='P8')!;
    p.diameter=100;expect(()=>validateDrawing(d)).toThrow();delete p.nominalInches;
    const svg=renderDrawingSvg(validateDrawing(d),2);
    expect(svg).toContain('P8 · DN100');expect(svg).not.toContain('P34 · 2″');
  });
  it('retains the complete scoped network with its scale and source instead of a synthetic layout',()=>{
    const d=validateDrawing(referenceDrawing());
    expect(d.heads).toHaveLength(19);expect(d.pipes).toHaveLength(41);
    expect(referenceCounts.sourcePipePaths).toBe(32);expect(d.source?.mmPerPdfPoint).toBeCloseTo(33.8666666667);
    expect(d.heads.every(h=>h.model==='UNSPECIFIED'&&h.orientation==='upright')).toBe(true);
    expect(referenceChanges(d)).toEqual({pipes:[],heads:[],removed:[]});
    expect(renderDrawingSvg(d,1)).toContain(referenceSource.sha256);
  });
  it('reproduces each original head center within the declared 0.02 PDF point tolerance',()=>{
    const d=referenceDrawing();
    for(const h of d.heads){
      const n=d.nodes.find(n=>n.id===h.nodeId)!;
      const source=referenceProvenance(h.id) as {pdfCenter:number[]};
      const error=Math.hypot(n.x/referenceSource.mmPerPdfPoint+1460-source.pdfCenter[0]!,n.y/referenceSource.mmPerPdfPoint+1500-source.pdfCenter[1]!);
      expect(error).toBeLessThan(.02);
    }
  });
  it('splits a real pipe for a tee and preserves geometry, nominal size and shared connectivity',()=>{
    const d=referenceDrawing(),p=d.pipes.find(p=>pipeLength(d,p)>1000)!,a=d.nodes.find(n=>n.id===p.from)!,b=d.nodes.find(n=>n.id===p.to)!;
    const before=d.pipes.reduce((s,p)=>s+pipeLength(d,p),0),point={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const id=connectAt(d,point,.1);
    expect(d.pipes).toHaveLength(42);expect(d.pipes.filter(p=>p.from===id||p.to===id)).toHaveLength(2);
    expect(d.pipes.reduce((s,p)=>s+pipeLength(d,p),0)).toBeCloseTo(before,6);
    expect(d.pipes.at(-1)?.nominalInches).toBe(p.nominalInches);
    expect(connectAt(d,point,.1)).toBe(id);expect(d.pipes).toHaveLength(42);
    validateDrawing(d);
    expect(referenceChanges(d).pipes).toContain(p.id);
  });
  it('hides obsolete source size glyphs after edits and renders accepted room/door additions',()=>{
    const d=referenceDrawing();d.pipes[0]!.diameter=100;delete d.pipes[0]!.nominalInches;
    d.rooms.push({id:'R1',x:5000,y:5000,name:'Updated room'});
    d.doors.push({id:'D1',at:{x:6000,y:6000},width:900,rotation:0});
    const svg=renderDrawingSvg(validateDrawing(d),2);
    expect(svg).toContain('Updated room');expect(svg).toContain('DN100');expect(svg).toContain('旧径・標高文字は原図のみ表示');
    expect(drawingBody(d,2,{...defaultDrawingLayers,referenceMode:'original'})).not.toContain('Updated room');
    expect(svg).not.toContain('型式は未指定');
  });

});
