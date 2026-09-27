import { describe, expect, it } from 'vitest';
import { drawingBody, drawingTransform, exampleDrawing, pipeLength, renderDrawingSvg, validateDrawing } from '../src/plan.js';

describe('dimensioned drawing model',()=>{
  it('keeps mm coordinates and connected centerline lengths authoritative',()=>{
    const d=validateDrawing(exampleDrawing());
    expect(pipeLength(d,d.pipes[0]!)).toBe(2000);
    d.nodes.find(n=>n.id==='N2')!.x=3500;
    expect(pipeLength(d,d.pipes[0]!)).toBe(2500);
    expect(pipeLength(d,d.pipes.find(p=>p.id==='P7')!)).toBe(2500);
    expect(drawingBody(d,2)).toContain('2,500');
    expect(drawingTransform(d).scale*12000).toBe(630);
  });
  it.each(['NaN','Infinity','missing endpoint','duplicate ID','zero length','orphan head','missing target','invalid orientation'])('rejects %s',kind=>{
    const d=exampleDrawing();
    if(kind==='NaN')d.nodes[0]!.x=NaN;
    if(kind==='Infinity')d.width=Infinity;
    if(kind==='missing endpoint')d.pipes[0]!.to='absent';
    if(kind==='duplicate ID')d.heads[1]!.id='H1';
    if(kind==='zero length'){d.nodes[0]!.x=d.nodes[1]!.x;d.nodes[0]!.y=d.nodes[1]!.y;}
    if(kind==='orphan head')d.heads[0]!.nodeId='absent';
    if(kind==='missing target')d.heads.shift();
    if(kind==='invalid orientation')d.heads[0]!.orientation='invalid' as never;
    expect(()=>validateDrawing(d)).toThrow('図面データ');
  });
  it('escapes all free text and renders three distinct head symbols',()=>{
    const d=exampleDrawing();d.rooms[0]!.name='<script>alert("x")</script>';
    const svg=renderDrawingSvg(validateDrawing(d),1);
    expect(svg).not.toContain('<script>');expect(svg).toContain('&lt;script&gt;');
    const symbols=['pendent','upright','sideways'].map(o=>renderDrawingSvg(exampleDrawing(o),1));
    expect(new Set(symbols).size).toBe(3);
  });
  it('hides drawing layers independently without removing pipe geometry',()=>{
    const body=drawingBody(exampleDrawing(),1,{architecture:false,dimensions:false,labels:false,grid:false});
    expect(body).not.toContain('data-wall');expect(body).toContain('data-pipe="P1"');expect(body).not.toContain('12,000 mm');
  });
});
