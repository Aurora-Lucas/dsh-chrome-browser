/**
 * Standalone smoke test for the Chrome engine (no DSH imports).
 * Run from the repository root: node test/engine.test.mjs
 */
import { ChromeBrowser, chromeCandidates, resolveChromePath } from '../browser.js';

const html = `<!doctype html><html><head><title>Engine Test</title></head><body>
<h1 id="heading">Hello Chrome</h1>
<button id="btn" onclick="document.getElementById('out').textContent='clicked'; console.log('btn clicked')">Press</button>
<div id="out"></div>
<input id="field" />
<script>
  console.log('page ready');
  console.warn('a warning');
  fetch('http://127.0.0.1:59999/missing').catch(() => {});
</script>
</body></html>`;

const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const browser = new ChromeBrowser({ width: 1024, height: 768 });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// Executable resolution is pure, so the Windows branch is verifiable from Linux.
const windowsEnv = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
};
const winCandidates = chromeCandidates('win32', windowsEnv);
check('win: Program Files chrome.exe probed', winCandidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
check('win: x86 chrome.exe probed', winCandidates.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
check('win: LOCALAPPDATA chrome.exe probed', winCandidates.includes('C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
check('win: Edge is the last resort', winCandidates.some((candidate) => candidate.endsWith('\\msedge.exe')));
check('win: no POSIX paths in the Windows list', !winCandidates.some((candidate) => candidate.startsWith('/')));
const posixCandidates = chromeCandidates('linux', {});
check('linux: /usr/bin/google-chrome probed', posixCandidates.includes('/usr/bin/google-chrome'));
check('linux: no .exe in the Linux list', !posixCandidates.some((candidate) => candidate.endsWith('.exe')));
check('darwin: app bundle probed', chromeCandidates('darwin', {}).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
const missingConfigured = (() => {
  try {
    resolveChromePath('/definitely/missing/chrome', 'linux', {});
    return 'no error was raised';
  } catch (error) {
    return error.message;
  }
})();
check('configured-but-missing path is reported', /not found at the configured path/u.test(missingConfigured), missingConfigured.split('\n')[0]);
check('DSH_CHROME_PATH override resolves', resolveChromePath('', 'linux', { DSH_CHROME_PATH: process.execPath }) === process.execPath);
check('auto-detection finds this host browser', resolveChromePath('', process.platform, process.env).length > 0);

try {
  const page = await browser.openPage(url);
  check('open page', page.id === 'p1', `id=${page.id}`);
  check('title', (await page.title()) === 'Engine Test');
  check('text', (await page.evaluate('document.getElementById("heading").textContent')) === 'Hello Chrome');
  check('eval returns objects', (await page.evaluate('({ a: 1, b: [2, 3] })')).b[1] === 3);
  check('eval rejects page exceptions', await page.evaluate('1 + 1').then(() => false).catch(() => false) === false);

  const dom = await page.evaluate('document.documentElement.outerHTML');
  check('dom', typeof dom === 'string' && dom.includes('Hello Chrome'));

  await page.click({ selector: '#btn' });
  check('click', (await page.evaluate('document.getElementById("out").textContent')) === 'clicked');

  await page.type({ selector: '#field', text: 'typed text' });
  check('type', (await page.evaluate('document.getElementById("field").value')) === 'typed text');
  await page.type({ selector: '#field', text: 'replaced', clear: true });
  check('type clear', (await page.evaluate('document.getElementById("field").value')) === 'replaced');
  await page.press('Enter');

  await page.waitFor({ selector: '#out', timeoutMs: 3000 });
  const waitText = await page.waitFor({ text: 'clicked', timeoutMs: 3000 });
  check('wait_for', typeof waitText.elapsedMs === 'number');
  check('wait_for times out', await page.waitFor({ selector: '#nope', timeoutMs: 600 }).then(() => false).catch((e) => /timed out/u.test(e.message)));

  const png = await page.screenshot({});
  check('viewport screenshot', png.length > 1000 && png[0] === 0x89, `${png.length} bytes`);
  const full = await page.screenshot({ fullPage: true });
  check('fullpage screenshot', full.length > 1000, `${full.length} bytes`);
  const clipped = await page.screenshot({ selector: '#heading' });
  check('selector screenshot', clipped.length > 200, `${clipped.length} bytes`);

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const mobile = await page.screenshot({});
  check('mobile screenshot', mobile.length > 1000, `${mobile.length} bytes`);

  const pdf = await page.printPdf();
  check('pdf', pdf.length > 500 && pdf.subarray(0, 4).toString() === '%PDF', `${pdf.length} bytes`);

  await new Promise((r) => setTimeout(r, 400));
  const consoleEntries = page.takeConsole({});
  check('console capture', consoleEntries.some((e) => e.text.includes('page ready')), JSON.stringify(consoleEntries.map((e) => e.text)));
  check('console captures click handler', consoleEntries.some((e) => e.text.includes('btn clicked')));
  check('console captures warn level', consoleEntries.some((e) => e.level === 'warning' || e.level === 'warn'));

  const network = page.takeNetwork({});
  check('network failure capture', network.some((e) => e.kind === 'failed'), JSON.stringify(network.slice(0, 2)));

  const second = await browser.openPage('about:blank');
  check('second page id', second.id === 'p2');
  check('listPages', (await browser.listPages()).length === 2);
  await second.goto(url);
  check('goto second page', (await second.title()) === 'Engine Test');
  await browser.closePage('p2');
  check('close page', (await browser.listPages()).length === 1);

  const failing = await browser.openPage('about:blank');
  await failing.goto('http://127.0.0.1:59999/').then(
    () => check('navigation to closed port reports failure', false, 'no error raised'),
    (error) => check('navigation to closed port reports failure', /ERR_CONNECTION_REFUSED|navigation to/u.test(error.message), error.message.split('\n')[0]),
  );

  // data: URL navigation and page text extraction on a fresh page.
  const third = await browser.openPage('data:text/html,<p>alpha beta</p>');
  check('text extraction', (await third.evaluate('document.body.innerText')).includes('alpha beta'));
} catch (error) {
  check('unexpected failure', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
} finally {
  const running = browser.running;
  await browser.dispose();
  check('chrome was running', running === true);
  check('dispose stops chrome', browser.running === false);
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`);
