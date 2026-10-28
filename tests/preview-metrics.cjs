// Optional development check. Requires @napi-rs/canvas 0.1.100; not a userscript
// dependency. Pass TOC_CANVAS_MODULE if it is installed outside this directory.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createCanvas, GlobalFonts } = require(process.env.TOC_CANVAS_MODULE || '@napi-rs/canvas');
const fontDir=process.env.TOC_FONT_DIR || '/usr/share/fonts/truetype/dejavu';
for(const [file,family] of [['DejaVuSans.ttf','TOC Sans'],['DejaVuSans-Bold.ttf','TOC Sans'],['DejaVuSerif.ttf','TOC Serif'],['DejaVuSerif-Bold.ttf','TOC Serif']]) {
  assert.ok(GlobalFonts.registerFromPath(path.join(fontDir,file),family),`Could not load ${file}`);
}
const root = path.resolve(__dirname,'..');
const source = fs.readFileSync(path.join(root,'ChatGPT_Conversation_Table_of_Contents.user.js'),'utf8');
const context = vm.createContext({document:{body:true},performance,DOMException,
  window:{setTimeout,clearTimeout}});
vm.runInContext(source.replace('if (document.body) bootstrap();',
  'globalThis.previewApi = {searchPreview, PromptSearch, cachedPreviewMeasure};'),context);
const metricContext = createCanvas(10,10).getContext('2d');
const graphemes = new Intl.Segmenter(undefined,{granularity:'grapheme'});
const cases = [
  {name:'Near the beginning',text:'ok 1. let’s do a full robustness/standards check with the now standardized md, and make sure to retain all intended functionality.',query:'robustness'},
  {name:'First word',text:'Robustness comes from the way the system behaves when its environment changes.',query:'robustness'},
  {name:'Short prompt',text:'Please check robustness.',query:'robustness'},
  {name:'Distant hit',text:'We are going to build a polished userscript. '+('Earlier requirements and unrelated details. '.repeat(100))+'Selector robustness: Prefer stable semantic attributes and durable message IDs.',query:'robustness'},
  {name:'Partial word',text:'so, text within the panel needs some work, slightly bigger font, less empty space to the sides as starters',query:'te'},
  {name:'Several related hits',text:'Robustness is mentioned at the start. '+('Other matters. '.repeat(100))+'Battery voltage and charging behavior are explained together.',query:'robustness voltage charging'},
  {name:'Unbroken word',text:'The identifier is '+('robustness'.repeat(100))+' in the source code.',query:'robustness'},
  {name:'Quote and spacing',text:'Could you explain the comparison with a size 32” DDD and how those measurements are defined?',query:'32dd'},
];

// Independent drawing/layout pass: word wrapping plus glyph advances. This is
// a font/preview check, not a DOM/CSS renderer or live-browser substitute.
// Static test faces use 400 for the UI's normal 440 weight: CSS selects their
// regular face at that weight. napi-canvas misparses non-hundred weights as a
// font size; production browser typography and its computed weight are unchanged.
function layout(selected,ranges,fontFamily,width) {
  const font = highlighted => `${highlighted?600:400} 14px "${fontFamily}"`;
  const glyphs = [];
  for(const part of graphemes.segment(selected.text)) {
    const sourceAt = selected.start + part.index;
    glyphs.push({value:part.segment,start:sourceAt,end:sourceAt+part.segment.length,
      marked:ranges.some(r=>sourceAt>=r.start&&sourceAt<r.end)});
  }
  if(selected.start) glyphs.unshift({value:'… ',marked:false});
  if(selected.omittedTail) glyphs.push({value:' …',marked:false});
  for(const g of glyphs){metricContext.font=font(g.marked);g.width=metricContext.measureText(g.value).width;}
  const units=[];
  for(const g of glyphs){
    const space=/^\s+$/u.test(g.value);
    const last=units.at(-1);
    if(last&&last.space===space)last.glyphs.push(g);
    else units.push({space,glyphs:[g]});
  }
  const placed=[];let x=0;let line=0;
  for(const unit of units){
    const advance=unit.glyphs.reduce((n,g)=>n+g.width,0);
    if(unit.space&&x===0)continue;
    if(!unit.space&&advance<=width&&x&&x+advance>width){line++;x=0;}
    for(const g of unit.glyphs){
      if(x&&x+g.width>width){line++;x=0;}
      placed.push({...g,x,line});x+=g.width;
    }
  }
  let visible=placed.filter(g=>g.line<2);
  if(placed.some(g=>g.line>=2)){
    metricContext.font=font(false);const ew=metricContext.measureText('…').width;
    visible=visible.filter(g=>g.line===0||g.x+g.width<=width-ew);
    const tail=visible.filter(g=>g.line===1).at(-1);
    visible.push({value:'…',marked:false,x:tail?tail.x+tail.width:0,line:1,width:ew});
  }
  return {visible,font};
}

(async()=>{
  const reports=[];
  for(const sample of cases){
    const engine=new context.previewApi.PromptSearch();
    engine.setItems([{id:'sample',text:sample.text}]);
    const [found]=await engine.find(sample.query);
    assert.ok(found,sample.name);
    sample.ranges=found.ranges;
    for(const family of ['TOC Sans','TOC Serif'])for(const width of [150,208,288]){
      const measure=(text,highlighted=false)=>{
        metricContext.font=`${highlighted?600:400} 14px "${family}"`;
        return metricContext.measureText(text).width;
      };
      const plan=context.previewApi.searchPreview(sample.text,sample.ranges,{width,measure});
      const selected={text:sample.text.slice(plan.start,plan.end),start:plan.start,omittedTail:plan.end<sample.text.length};
      const result=layout(selected,sample.ranges,family,width);
      const completeHits=sample.ranges.filter(r=>r.start>=plan.start&&r.end<=plan.end
        && Array.from(graphemes.segment(sample.text.slice(r.start,r.end))).every(p=>result.visible.some(g=>g.marked&&g.start<=r.start+p.index&&g.end>=r.start+p.index+p.segment.length)));
      assert.ok(completeHits.length,`${sample.name}/${family}/${width}: no complete keyword remains visible; ${JSON.stringify({plan,shown:result.visible.map(g=>g.value).join('')})}`);
      if(sample.name==='Near the beginning'||sample.name==='First word'||sample.name==='Short prompt') assert.equal(plan.start,0,`${sample.name}/${family}/${width}`);
      reports.push({case:sample.name,family,width,start:plan.start,end:plan.end,completeHits:completeHits.length});
      if(family==='TOC Sans'&&(width===288||width===208))sample[width]={result,plan};
    }
  }
  const benchmarks=[];
  for(const late of [false,true]){
    const data=Array.from({length:1000},(_,i)=>{
      const text=`Question ${i}. `+(late?'Unrelated specifications. '.repeat(100):'')+'Could you explain the robustness and behavior of this component?';
      const start=text.indexOf('robustness');return {text,ranges:[{start,end:start+10}]};
    });
    let reference;
    for(const cached of [false,true]){
      let calls=0;
      const raw=(text,highlighted=false)=>{calls++;metricContext.font=`${highlighted?600:400} 14px "TOC Sans"`;return metricContext.measureText(text).width;};
      const measure=cached?context.previewApi.cachedPreviewMeasure(raw):raw;
      const begin=performance.now();
      const plans=data.map(row=>context.previewApi.searchPreview(row.text,row.ranges,{width:288,measure}));
      benchmarks.push({rows:data.length,late,cached,elapsedMs:+(performance.now()-begin).toFixed(1),measurements:calls});
      if(reference)assert.equal(JSON.stringify(plans),reference,'caching changed excerpt selection');
      else reference=JSON.stringify(plans);
    }
  }
  fs.writeFileSync(path.join(__dirname,'preview-metrics-results.json'),JSON.stringify({engine:'@napi-rs/canvas 0.1.100',checks:reports.length,cases:reports,benchmarks},null,2)+'\n');
  const scale=2;const canvas=createCanvas(720*scale,760*scale);const c=canvas.getContext('2d');c.scale(scale,scale);
  c.fillStyle='#eeeeee';c.fillRect(0,0,720,760);
  c.fillStyle='#343434';c.font='600 15px "TOC Sans"';c.fillText('Typography check · native canvas with the actual preview planner',18,27);
  c.font='11px "TOC Sans"';c.fillText('Sample prompts. This checks text layout; it is not a browser screenshot or an animation test.',18,48);
  for(const [column,width,background,foreground] of [[0,288,'#303030','#c9c9c9'],[1,208,'#ffffff','#5d5d5d']]){
    const px=column?398:18;const pw=width+28;
    c.fillStyle='#505050';c.font='600 12px "TOC Sans"';c.fillText(column?'Light · narrower text area':'Dark · normal text area',px,75);
    c.fillStyle=background;c.beginPath();c.roundRect(px,87,pw,646,12);c.fill();
    cases.forEach((sample,index)=>{
      const y=108+index*77;
      c.fillStyle=column?'#888888':'#939393';c.font='10px "TOC Sans"';c.fillText(sample.name,px+14,y);
      const highlights=[];
      for(const g of sample[width].result.visible){
        if(!g.marked)continue;
        const last=highlights.at(-1);
        if(last&&last.line===g.line&&Math.abs(last.end-g.x)<0.01)last.end=g.x+g.width;
        else highlights.push({start:g.x,end:g.x+g.width,line:g.line});
      }
      for(const h of highlights){
        c.fillStyle=column?'#e6e6e6':'#484848';c.beginPath();c.roundRect(px+14+h.start,y+10+h.line*18,h.end-h.start,17,2);c.fill();
      }
      for(const g of sample[width].result.visible){
        const baseline=y+23+g.line*18;
        c.font=sample[width].result.font(g.marked);c.fillStyle=g.marked?(column?'#0d0d0d':'#ececec'):foreground;
        c.fillText(g.value,px+14+g.x,baseline);
      }
    });
  }
  fs.writeFileSync(path.join(__dirname,'preview-typography.png'),canvas.toBuffer('image/png'));
  console.log(JSON.stringify({nativeFontChecks:reports.length,passed:true,benchmarks,image:'tests/preview-typography.png'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
