// Development-only fixture. It loads the actual userscript UI/search classes,
// replaces only bootstrap, and never talks to ChatGPT or accesses account data.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ChatGPT_Conversation_Table_of_Contents.user.js'), 'utf8');
const version = source.match(/^\/\/ @version\s+(\S+)/m)?.[1];
if (!version) throw new Error('Userscript version is missing');
const setup = `
  const prompts = [
    'Why exactly do I wait for the Supra starting RPM to settle before driving?',
    'And why does tire pressure drop over time, especially when the weather gets colder?',
    'Okay then for the car battery is it better to drive regularly or use a trickle charger?',
    'Explain the difference between inflation and interest rates in plain language.',
    'Can you compare my favorite websites for reading long articles?',
    'I want to understand this more carefully before making any decisions. What happens to battery voltage when the temperature drops during winter?',
    'What is a good way to organize a very long conversation without losing earlier questions?',
    'How does regenerative braking work in a hybrid vehicle?',
    'What affects a bicycle battery when charging overnight?',
    'Can you explain how a lithium battery ages under everyday use?',
    'How can I improve readability and spacing in the contents panel?',
    'Café recommendations and résumé formatting tips for Montréal.',
    '轮胎压力为什么会随温度变化？',
    'Compare C++ and C# for a small desktop utility.',
    'Short prompt.',
    'ok 1. let’s do a full robustness/standards check with the now standardized md, and retain all intended functionality.',
    'Robustness comes from the behavior of the complete system.',
    'Please check robustness.',
    'An unrelated introduction. '+('Earlier specifications. '.repeat(100))+'Selector robustness: prefer semantic attributes and durable message IDs.',
    'A sample sizing question: roughly a size 32” DDD, and how those measurements compare.',
  ].map((text, i) => ({id:'example-' + i, text}));
  let view;
  const status = document.querySelector('#navigation');
  const create = () => {
    view?.destroy();
    view = new TocView(id => { status.textContent = 'Selected: ' + id; });
    view.render(prompts);
    view.setActive('example-5');
    view.setStatus('complete');
  };
  create();
  document.querySelector('#dark').onclick = () => document.documentElement.dataset.theme = 'dark';
  document.querySelector('#light').onclick = () => document.documentElement.dataset.theme = 'light';
  document.querySelector('#long').onclick = () => {
    view.clear();
    view.render([...Array.from({length:800}, (_,i) => ({id:'history-'+i,
      text: 'Earlier question ' + i + ' about ' + (i % 9 === 0 ? 'battery maintenance and charging' : 'daily reading and organization')})), ...prompts]);
    view.setActive('example-5'); view.setStatus('complete');
  };
  document.querySelector('#reset').onclick = create;
  document.querySelector('#empty').onclick = () => view.clear();
  document.querySelector('#append').onclick = () => view.render([...view.items,
    { id:'appended', text:'A newly appended battery question about voltage and charging'}]);
  document.querySelector('#edit').onclick = () => view.render(view.items.map(item => item.id === 'example-5'
    ? {...item, text:'An edited prompt discussing a battery warranty instead of voltage.'} : item));
  window.addEventListener('resize', () => view.resize());
`;
const executable = source.replace('if (document.body) bootstrap();', setup);
const html = `<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TOC ${version} local UI test</title><style>
:root {font:16px/1.6 system-ui,sans-serif; color-scheme:light;
 --color-text-primary:#0d0d0d;--color-text-secondary:#5d5d5d;--color-text-tertiary:#8f8f8f;
 --color-surface-elevated-secondary:#fff;--color-token-main-surface-primary:#fff; background:#fff;color:#0d0d0d}
:root[data-theme=dark] {color-scheme:dark;--color-text-primary:#ececec;--color-text-secondary:#b4b4b4;--color-text-tertiary:#8f8f8f;
 --color-surface-elevated-secondary:#303030;--color-token-main-surface-primary:#212121;background:#212121;color:#ececec}
body {margin:0;min-height:100vh} header {padding:20px 28px;font-size:13px;opacity:.8} header button {font:inherit;padding:5px 8px;margin:3px;border-radius:7px;border:1px solid #7775;background:transparent;color:inherit;cursor:pointer}
main {max-width:650px;margin:7vh auto;padding:0 34px} .bubble {margin-left:auto;width:72%;padding:12px 18px;border-radius:22px;background:color-mix(in srgb,currentColor 6%,transparent)} p {margin:24px 0} footer {margin-top:32px;font-size:13px;opacity:.6}
</style><header>Local test fixture — sample prompts only. No account access.<br><button id="dark">Dark</button><button id="light">Light</button><button id="long">Long conversation</button><button id="reset">Reset</button><button id="empty">Empty</button><button id="append">Append</button><button id="edit">Edit fixture prompt</button><output id="navigation"></output></header><main>
<div class="bubble">I want to understand this more carefully before making any decisions. What happens to battery voltage when the temperature drops during winter?</div>
<p>Temperature changes affect the chemical reactions inside a battery. In cold weather, those reactions slow down, reducing the power available for starting a vehicle.</p><p>A resting voltage reading can help you assess the state of charge, but temperature and the type of battery also matter.</p><footer>The actual ${version} contents/search UI is mounted at the right edge. Hover or Tab to open.</footer></main><script>${executable}</script></html>`;
fs.writeFileSync(path.join(root, 'tests', 'browser-fixture.html'), html);
console.log('Generated tests/browser-fixture.html from current userscript.');
