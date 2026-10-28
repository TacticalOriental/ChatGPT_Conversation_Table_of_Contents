const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const source = fs.readFileSync(path.join(__dirname, '..', 'ChatGPT_Conversation_Table_of_Contents.user.js'), 'utf8');
let sliceStart = 0;
let slices = [];
let yields = 0;
const context = vm.createContext({
  document: {body:true}, performance, AbortController, DOMException,
  window: {
    setTimeout(fn, ms) {
      slices.push(performance.now() - sliceStart); yields++;
      return setTimeout(() => {sliceStart = performance.now(); fn();},ms);
    },
    clearTimeout,
  },
});
vm.runInContext(source.replace('if (document.body) bootstrap();', 'globalThis.Search = PromptSearch;'),context);
async function run(label, data, query, reuse) {
  const engine = reuse || new context.Search();
  engine.setItems(data);
  yields = 0; slices = [];
  const start = performance.now(); sliceStart = start;
  const result = await engine.find(query);
  slices.push(performance.now()-sliceStart);
  console.log(JSON.stringify({label,prompts:data.length,chars:data.reduce((s,p)=>s+p.text.length,0),matches:result.length,elapsedMs:+(performance.now()-start).toFixed(1),longestSliceMs:+Math.max(...slices).toFixed(1),yields}));
  return engine;
}
(async () => {
  const texts = ['What happens to battery voltage in winter?', 'Explain the difference between inflation and interest rates.', 'Why does tire pressure change with temperature?', 'How can I organize a long conversation?', 'Can you recommend reading material about chemistry?'];
  const data = Array.from({length:5000},(_,i)=>({id:String(i),text:('Question '+i+'. '+texts[i%texts.length]+' ').repeat(5)}));
  const engine = await run('5000 prompts, cold index',data,'battrey voltge');
  await run('5000 prompts, warm index',data,'tire pressur',engine);
  await run('one very large prompt',[{id:'long',text:'ordinary material '.repeat(30000)+'battery voltage at the very end'}],'battrey voltge');
})().catch(error => {console.error(error);process.exitCode=1;});
