/**
 * Pre-install test of the plugin's real tool definition: builds a stub Cordis
 * context, activates the plugin, and drives every action through the
 * `defineTool` wrapper (so argument validation is exercised too).
 */
import { readFile } from 'node:fs/promises';
import * as plugin from '../chrome-browser.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const registrations = [];
let cleanup;
const ctx = {
  tools: { register: (definition) => { registrations.push(definition); return () => {}; } },
  inject: () => () => {},
  get: () => undefined,
  on: () => () => {},
  effect: (callback) => { cleanup = callback(); return () => {}; },
};

plugin.apply(ctx, {});
check('plugin exports name/inject', plugin.name === 'chrome-browser' && Array.isArray(plugin.inject));
check('registers exactly one tool', registrations.length === 1, `got ${registrations.length}`);
const tool = registrations[0];
check('tool name', tool.name === 'chrome');
check('tool exposes expected parameters', tool.parameters.properties.action.enum.includes('screenshot'));
check('presentCall is safe for empty args', tool.presentCall({ action: 'open' }) !== undefined);

const exec = { signal: undefined, agent: undefined };
const call = (args) => tool.execute(args, exec);

const tallHtml = `<!doctype html><html><head><title>Plugin Test</title></head><body style="margin:0">
<div style="height:2500px;background:linear-gradient(#fff,#036)"></div>
<h1 id="end">Bottom of page</h1>
<button id="btn" onclick="document.getElementById('out').textContent='clicked'">Go</button>
<div id="out">idle</div>
<input id="field" />
<script>
  console.log('hello from page');
  window.addEventListener('error', () => {});
  setTimeout(() => { throw new Error('deliberate page error'); }, 0);
  fetch('http://127.0.0.1:59998/nope').catch(() => {});
</script>
</body></html>`;
const url = `data:text/html;charset=utf-8,${encodeURIComponent(tallHtml)}`;

try {
  const open = await call({ action: 'open', url, width: 800, height: 600 });
  check('open', /opened a new page as p1/u.test(open.text) && open.text.includes('Plugin Test'), open.text);
  const page = 'p1';

  const text = await call({ action: 'text', page });
  check('text', text.text.includes('Bottom of page'));

  const dom = await call({ action: 'dom', page, selector: '#out' });
  check('dom with selector', dom.text.includes('id="out"'));

  const evalResult = await call({ action: 'eval', page, expression: '({ w: innerWidth, h: innerHeight, items: [1,2,3] })' });
  check('eval', evalResult.text.includes('"w": 800') && evalResult.text.includes('"h": 600'), evalResult.text.split('\n')[1]);

  const viewportShot = await call({ action: 'screenshot', page, path: '.tmp/shots/viewport.png' });
  check('screenshot viewport', viewportShot.text.includes('saved to'), viewportShot.text);
  check('screenshot has no image without attachments service', viewportShot.image === undefined);

  const fullShot = await call({ action: 'screenshot', page, fullPage: true, path: '.tmp/shots/full.png' });
  const fullPng = await readFile('.tmp/shots/full.png');
  const fullHeight = fullPng.readUInt32BE(20);
  check('fullpage screenshot exceeds viewport height', fullHeight > 2400, `${fullHeight}px tall`);
  const viewportPng = await readFile('.tmp/shots/viewport.png');
  check('viewport screenshot is 800x600', viewportPng.readUInt32BE(16) === 800 && viewportPng.readUInt32BE(20) === 600,
    `${viewportPng.readUInt32BE(16)}x${viewportPng.readUInt32BE(20)}`);
  check('fullpage text reports dimensions', fullShot.text.includes('800x'), fullShot.text);

  const elementShot = await call({ action: 'screenshot', page, selector: '#btn', path: '.tmp/shots/element.png' });
  check('element screenshot', elementShot.text.includes('element #btn'));

  const resized = await call({ action: 'viewport', page, width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  check('viewport action', resized.text.includes('390x844'));

  const mobileShot = await call({ action: 'screenshot', page, path: '.tmp/shots/mobile.png' });
  const mobilePng = await readFile('.tmp/shots/mobile.png');
  check('mobile screenshot at 2x scale', mobilePng.readUInt32BE(16) === 780, `${mobilePng.readUInt32BE(16)}x${mobilePng.readUInt32BE(20)}`);

  const click = await call({ action: 'click', page, selector: '#btn' });
  check('click', click.text.includes('clicked #btn'));
  check('click effect', (await call({ action: 'text', page, selector: '#out' })).text.includes('clicked'));

  await call({ action: 'type', page, selector: '#field', text: 'hello' });
  check('type', (await call({ action: 'eval', page, expression: 'document.getElementById("field").value' })).text.includes('hello'));
  await call({ action: 'type', page, selector: '#field', text: 'bye', clear: true });
  check('type clear', (await call({ action: 'eval', page, expression: 'document.getElementById("field").value' })).text.includes('bye'));
  await call({ action: 'press', page, key: 'Enter' });

  const waited = await call({ action: 'wait_for', page, selector: '#end', timeoutMs: 3000 });
  check('wait_for selector', waited.text.includes('succeeded'));
  await call({ action: 'wait_for', page, text: 'Bottom of page', timeoutMs: 3000 }).then(
    () => check('wait_for text', true),
    (error) => check('wait_for text', false, error.message),
  );
  await call({ action: 'wait_for', page, selector: '#absent', timeoutMs: 700 }).then(
    () => check('wait_for timeout raises', false, 'no error'),
    (error) => check('wait_for timeout raises', /timed out/u.test(error.message), error.message.split('\n')[0]),
  );

  await new Promise((r) => setTimeout(r, 500));
  const consoleResult = await call({ action: 'console', page });
  check('console', consoleResult.text.includes('hello from page'), consoleResult.text.split('\n')[1]);
  check('console captures uncaught error', /deliberate page error/u.test(consoleResult.text), consoleResult.text.split('\n')[2]);
  const consoleAfterClear = await call({ action: 'console', page, clear: true });
  check('console clear', consoleAfterClear.text.length > 0 && consoleAfterClear.text.includes('hello from page'));
  const consoleCleared = await call({ action: 'console', page });
  check('console cleared buffer', consoleCleared.text.includes('no console messages'), consoleCleared.text);

  const networkResult = await call({ action: 'network', page });
  check('network failed request', /FAILED/u.test(networkResult.text) && networkResult.text.includes('59998'), networkResult.text.split('\n')[1]);

  const pdf = await call({ action: 'pdf', page, path: '.tmp/shots/page.pdf' });
  const pdfBytes = await readFile('.tmp/shots/page.pdf');
  check('pdf', pdf.text.includes('saved to') && pdfBytes.subarray(0, 4).toString() === '%PDF', `${pdfBytes.length} bytes`);

  const tabs = await call({ action: 'tabs' });
  check('tabs', tabs.text.includes('p1') && tabs.text.includes('Plugin Test'), tabs.text.split('\n')[0]);

  const second = await call({ action: 'open', url: 'data:text/html,<p>second</p>' });
  check('second page', second.text.includes('p2'), second.text);
  const tabsTwo = await call({ action: 'tabs' });
  check('tabs lists both', tabsTwo.text.includes('p1') && tabsTwo.text.includes('p2'));
  const closed = await call({ action: 'close', page: 'p2' });
  check('close page', closed.text.includes('p2'));
  check('closing an unknown page fails', await call({ action: 'close', page: 'p9' }).then(() => false, (e) => /unknown page/u.test(e.message)));

  check('goto requires url', await call({ action: 'goto' }).then(() => false, (e) => /requires url/u.test(e.message)));
  check('unknown action rejected by schema', await call({ action: 'nope' }).then(() => false, (e) => /invalid arguments|enum|expected/u.test(e.message)),
    await call({ action: 'nope' }).then(() => 'no error', (e) => e.message.split('\n')[0]));
  check('bad parameter type rejected', await call({ action: 'open', width: 'wide' }).then(() => false, (e) => /invalid arguments/u.test(e.message)),
    await call({ action: 'open', width: 'wide' }).then(() => 'no error', (e) => e.message.split('\n')[0]));

  const stopped = await call({ action: 'stop' });
  check('stop', /stopped/u.test(stopped.text), stopped.text);
  check('stop when already stopped', (await call({ action: 'stop' })).text.includes('not running'));

  // A cancelled signal must surface, not hang.
  const abortController = new AbortController();
  abortController.abort();
  await tool.execute({ action: 'open' }, { signal: abortController.signal, agent: undefined }).then(
    () => check('aborted call is refused', false, 'no error'),
    (error) => check('aborted call is refused', /cancelled/u.test(error.message), error.message),
  );
} catch (error) {
  check('unexpected failure', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
} finally {
  if (typeof cleanup === 'function') await cleanup();
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`);
