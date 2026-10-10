/**
 * Headless Chrome driver over the Chrome DevTools Protocol.
 *
 * Pure Node.js (no third-party dependencies): spawns the installed Google
 * Chrome with a random DevTools port, speaks CDP over the global WebSocket,
 * and exposes one page session per browser tab. This module is deliberately
 * free of `@deepseek-ai/*` imports so it can be exercised directly with node.
 *
 * @module dsh-chrome-browser/browser
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Executables probed when no explicit Chrome path is configured. */
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome-beta',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** Keys `press` can synthesize, with their CDP key metadata. */
const KEY_SPECS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** Resolve the Chrome executable from config, env, or well-known locations. */
export function resolveChromePath(configured) {
  const explicit = (configured && configured.trim()) || process.env.DSH_CHROME_PATH || '';
  if (explicit.trim().length > 0) {
    if (!existsSync(explicit)) throw new Error(`Chrome executable not found at the configured path: ${explicit}`);
    return explicit;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Google Chrome or Chromium executable found. Install Chrome or set the plugin config `chromePath` '
    + '(or the DSH_CHROME_PATH environment variable) to the browser executable.',
  );
}

/** Resolve a caller-supplied artifact path, defaulting under the artifact directory. */
export function resolveArtifactPath(requested, { artifactDir, cwd, extension }) {
  if (requested !== undefined && requested.trim().length > 0) {
    return path.resolve(cwd, requested);
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return path.join(artifactDir, `chrome-${stamp}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
}

/** Sleep for a bounded interval. */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Resolve true once the child process has exited, or false after `timeoutMs`. */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/** Render one CDP RemoteObject as human-readable console text. */
function describeRemoteObject(object) {
  if (object === undefined || object === null) return '';
  if (object.type === 'string') return String(object.value ?? '');
  if (object.unserializableValue !== undefined) return String(object.unserializableValue);
  if ('value' in object) {
    const { value } = object;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(object.description ?? object.type ?? '');
}

/** Render a Runtime.exceptionThrown payload as a bounded multi-line message. */
function describeException(details) {
  if (details === undefined || details === null) return 'unknown page error';
  const exception = details.exception;
  const text = exception?.description ?? exception?.value ?? details.text ?? 'unknown page error';
  return String(text).split('\n').slice(0, 8).join('\n');
}

/** Bound a string to `max` characters, appending an explicit truncation marker. */
export function boundText(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated: ${value.length - max} more characters]`;
}

/**
 * One CDP WebSocket connection: request/response correlation plus raw event fan-out.
 * `sessionId` routes a command to one attached page target when flattened.
 */
class CdpConnection {
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.failAll(new Error(`${label}: DevTools connection closed`)));
    socket.addEventListener('error', () => this.failAll(new Error(`${label}: DevTools connection error`)));
  }

  static async connect(url, label, timeoutMs) {
    if (typeof WebSocket !== 'function') {
      throw new Error(`${label}: this Node.js runtime has no global WebSocket, so the DevTools protocol cannot be reached`);
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${label}: timed out connecting to ${url}`)); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${label}: could not connect to ${url}`)); }, { once: true });
    });
    return new CdpConnection(socket, label);
  }

  onMessage(data) {
    let message;
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        const detail = message.error.data === undefined ? '' : ` (${message.error.data})`;
        pending.reject(new Error(`${pending.method}: ${message.error.message}${detail}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === undefined) return;
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A listener must never break the protocol loop.
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`${this.label}: DevTools connection is closed`));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no DevTools reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  failAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.failAll(new Error(`${this.label}: DevTools connection closed by this client`));
    try {
      this.socket.close();
    } catch {
      // Closing an already-closed socket is not an error worth surfacing.
    }
  }
}

/** One attached page target: evaluation, navigation, input, and capture helpers. */
class ChromePage {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.id = undefined;
    this.consoleEntries = [];
    this.networkEntries = [];
    this.loadFired = false;
    this.unsubscribe = undefined;
  }

  send(method, params, timeoutMs) {
    return this.browser.connection.send(method, params, this.sessionId, timeoutMs ?? this.browser.options.actionTimeoutMs);
  }

  async init() {
    this.unsubscribe = this.browser.connection.on((message) => this.onEvent(message));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.setViewport(this.browser.options.viewport);
  }

  onEvent(message) {
    if (message.sessionId !== this.sessionId) return;
    const params = message.params ?? {};
    switch (message.method) {
      case 'Runtime.consoleAPICalled': {
        this.recordConsole({
          kind: 'console',
          level: String(params.type ?? 'log'),
          text: (params.args ?? []).map(describeRemoteObject).join(' '),
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        this.recordConsole({ kind: 'exception', level: 'error', text: describeException(params.exceptionDetails) });
        break;
      }
      case 'Log.entryAdded': {
        const entry = params.entry ?? {};
        this.recordConsole({
          kind: 'log',
          level: String(entry.level ?? 'info'),
          text: `${entry.source === undefined ? '' : `[${entry.source}] `}${entry.text ?? ''}`,
        });
        break;
      }
      case 'Network.loadingFailed': {
        this.recordNetwork({
          kind: 'failed',
          url: this.browser.requestUrls.get(params.requestId) ?? '(unknown url)',
          errorText: String(params.errorText ?? 'unknown failure'),
          type: params.type,
          canceled: params.canceled === true,
        });
        break;
      }
      case 'Network.requestWillBeSent': {
        this.browser.requestUrls.set(params.requestId, params.request?.url);
        break;
      }
      case 'Network.responseReceived': {
        const response = params.response ?? {};
        if (typeof response.status === 'number' && response.status >= 400) {
          this.recordNetwork({
            kind: 'http-error',
            url: String(response.url ?? ''),
            status: response.status,
            mimeType: response.mimeType,
            type: params.type,
          });
        }
        break;
      }
      case 'Page.loadEventFired': {
        this.loadFired = true;
        break;
      }
      case 'Page.frameNavigated': {
        if (params.frame?.parentId === undefined) this.loadFired = false;
        break;
      }
      default:
        break;
    }
  }

  recordConsole(entry) {
    this.consoleEntries.push({ ...entry, at: new Date().toISOString() });
    const cap = this.browser.options.maxConsoleEntries;
    if (this.consoleEntries.length > cap) this.consoleEntries.splice(0, this.consoleEntries.length - cap);
  }

  recordNetwork(entry) {
    this.networkEntries.push({ ...entry, at: new Date().toISOString() });
    const cap = this.browser.options.maxNetworkEntries;
    if (this.networkEntries.length > cap) this.networkEntries.splice(0, this.networkEntries.length - cap);
  }

  /** Evaluate one expression in the page and return its value by value. */
  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page evaluation failed: ${describeException(result.exceptionDetails)}`);
    }
    const remote = result.result ?? {};
    if (remote.unserializableValue !== undefined) return remote.unserializableValue;
    if (remote.type === 'undefined') return undefined;
    if (remote.value === undefined && remote.description !== undefined) return remote.description;
    return remote.value;
  }

  /** Evaluate an expression, tolerating the transient failures of a navigating frame. */
  async evaluateQuietly(expression) {
    try {
      return await this.evaluate(expression, { timeoutMs: Math.min(this.browser.options.actionTimeoutMs, 10000) });
    } catch {
      return undefined;
    }
  }

  async currentUrl() {
    const value = await this.evaluate('document.location.href');
    return typeof value === 'string' ? value : undefined;
  }

  async title() {
    const value = await this.evaluate('document.title');
    return typeof value === 'string' ? value : undefined;
  }

  /** Navigate this page and wait until the document reports itself loaded. */
  async goto(url, { timeoutMs, waitForLoad = true } = {}) {
    const timeout = timeoutMs ?? this.browser.options.navigationTimeoutMs;
    this.loadFired = false;
    const result = await this.send('Page.navigate', { url }, timeout);
    if (result.errorText !== undefined && result.errorText !== null) {
      throw new Error(`navigation to ${url} failed: ${result.errorText}`);
    }
    if (waitForLoad) await this.waitForLoad(timeout);
    return { url: (await this.currentUrl()) ?? url, title: (await this.title()) ?? '' };
  }

  /** Wait for the load event, falling back to a readyState poll, then let the page settle. */
  async waitForLoad(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.loadFired) {
      if (this.browser.signalAborted()) return;
      const ready = await this.evaluateQuietly('document.readyState');
      if (ready === 'complete') break;
      await delay(100);
    }
    await delay(this.browser.options.settleMs);
  }

  /** Resolve a selector to both document and viewport coordinates. */
  async measure(selector) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        viewportX: rect.x,
        viewportY: rect.y,
        width: rect.width,
        height: rect.height,
      };
    })()`;
    const box = await this.evaluate(expression);
    if (box === null || box === undefined) throw new Error(`no element matches selector ${JSON.stringify(selector)}`);
    if (!(box.width >= 1) || !(box.height >= 1)) {
      throw new Error(`element ${JSON.stringify(selector)} has no visible box (${box.width}x${box.height} CSS px)`);
    }
    return box;
  }

  /** Set the emulated viewport; affects layout and screenshot pixel density. */
  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor,
      mobile,
      screenWidth: Math.round(width),
      screenHeight: Math.round(height),
    });
  }

  /** Capture a PNG and return its bytes. */
  async screenshot({ fullPage = false, selector, scale = 1, maxFullPageHeightPx = 12000 }) {
    // `captureBeyondViewport` belongs only to clip captures: without a clip it
    // would silently capture the whole content box instead of the viewport.
    const params = { format: 'png', fromSurface: true };
    if (selector !== undefined) {
      const box = await this.measure(selector);
      params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale };
      params.captureBeyondViewport = true;
    } else if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const height = Math.min(Math.ceil(size.height), maxFullPageHeightPx);
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height, scale };
      params.captureBeyondViewport = true;
    }
    const result = await this.send('Page.captureScreenshot', params, this.browser.options.captureTimeoutMs);
    return Buffer.from(String(result.data), 'base64');
  }

  async printPdf({ landscape = false, printBackground = true } = {}) {
    const result = await this.send('Page.printToPDF', {
      printBackground,
      landscape,
      preferCSSPageSize: true,
    }, this.browser.options.captureTimeoutMs);
    return Buffer.from(String(result.data), 'base64');
  }

  /** Click at a selector's center or at explicit viewport coordinates. */
  async click({ selector, x, y, button = 'left', clickCount = 1 }) {
    let pointX;
    let pointY;
    if (selector !== undefined) {
      const box = await this.measure(selector);
      pointX = box.viewportX + box.width / 2;
      pointY = box.viewportY + box.height / 2;
    } else {
      pointX = x;
      pointY = y;
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointX, y: pointY, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pointX, y: pointY, button, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointX, y: pointY, button, clickCount });
    await delay(50);
    return { x: pointX, y: pointY };
  }

  /** Focus a field, optionally clear it, and insert text as real input events. */
  async type({ selector, text, clear = false, submit = false, delayMs = 0 }) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.focus();
      ${clear ? "if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.value = ''; } else { el.textContent = ''; } el.dispatchEvent(new Event('input', { bubbles: true }));" : ''}
      return true;
    })()`;
    const focused = await this.evaluate(expression);
    if (focused !== true) throw new Error(`no element matches selector ${JSON.stringify(selector)}`);
    if (text.length > 0) {
      if (delayMs > 0) {
        for (const character of text) {
          await this.send('Input.insertText', { text: character });
          await delay(delayMs);
        }
      } else {
        await this.send('Input.insertText', { text });
      }
    }
    if (submit) await this.press('Enter');
  }

  /** Synthesize a key press with keyDown/keyUp (plus char when it produces text). */
  async press(key) {
    const spec = KEY_SPECS[key] ?? { key, code: key, keyCode: 0 };
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    };
    if (spec.text === undefined) await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (spec.text !== undefined) await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: spec.text });
    if (spec.text !== undefined) await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: spec.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(30);
  }

  /** Wait until a selector matches or the page text contains a needle. */
  async waitFor({ selector, text, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    const predicate = selector !== undefined
      ? `document.querySelector(${JSON.stringify(selector)}) !== null`
      : `document.body !== null && document.body.innerText.includes(${JSON.stringify(text ?? '')})`;
    let lastError;
    while (Date.now() < deadline) {
      if (this.browser.signalAborted()) throw new Error('the tool call was cancelled while waiting');
      try {
        if (await this.evaluate(predicate, { timeoutMs: Math.min(5000, this.browser.options.actionTimeoutMs) })) {
          return { elapsedMs: timeoutMs - (deadline - Date.now()) };
        }
      } catch (error) {
        lastError = error;
      }
      await delay(150);
    }
    const target = selector !== undefined ? `selector ${JSON.stringify(selector)}` : `text ${JSON.stringify(text ?? '')}`;
    const suffix = lastError === undefined ? '' : ` (last evaluation error: ${lastError.message})`;
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${target}${suffix}`);
  }

  /** Snapshot and optionally clear the collected console and page-error entries. */
  takeConsole({ clear = false }) {
    const entries = this.consoleEntries.slice();
    if (clear) this.consoleEntries = [];
    return entries;
  }

  /** Snapshot and optionally clear the collected failed / HTTP-error network entries. */
  takeNetwork({ clear = false }) {
    const entries = this.networkEntries.slice();
    if (clear) this.networkEntries = [];
    return entries;
  }

  dispose() {
    if (this.unsubscribe !== undefined) this.unsubscribe();
    this.unsubscribe = undefined;
  }
}

/**
 * Owns one Chrome process, its DevTools connection, and every open page.
 * Chrome starts lazily on first use and is torn down by `dispose`.
 */
export class ChromeBrowser {
  constructor(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.options = {
      chromePath: options.chromePath ?? '',
      headless: options.headless !== false,
      noSandbox: options.noSandbox !== false,
      settleMs: options.settleMs ?? 150,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 30000,
      actionTimeoutMs: options.actionTimeoutMs ?? 20000,
      captureTimeoutMs: options.captureTimeoutMs ?? 60000,
      maxConsoleEntries: options.maxConsoleEntries ?? 200,
      maxNetworkEntries: options.maxNetworkEntries ?? 200,
      artifactDir: options.artifactDir ?? path.join(tmpdir(), 'dsh-chrome-artifacts'),
      cwd,
      viewport: {
        width: options.width ?? 1280,
        height: options.height ?? 800,
        deviceScaleFactor: 1,
        mobile: false,
      },
    };
    this.process = undefined;
    this.connection = undefined;
    this.userDataDir = undefined;
    this.stderrTail = [];
    this.requestUrls = new Map();
    this.pages = new Map();
    this.pageSequence = 0;
    this.lastPageId = undefined;
    this.starting = undefined;
    this.aborted = false;
  }

  signalAborted() {
    return this.aborted;
  }

  setAborted(value) {
    this.aborted = value === true;
  }

  /** Start Chrome if it is not already running; concurrent callers share one start. */
  async ensureStarted() {
    if (this.connection !== undefined && this.process !== undefined && this.process.exitCode === null) return;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async start() {
    const chromePath = resolveChromePath(this.options.chromePath);
    this.userDataDir = await mkdtemp(path.join(tmpdir(), 'dsh-chrome-profile-'));
    const args = [];
    if (this.options.headless) args.push('--headless');
    if (this.options.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
    args.push(
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-popup-blocking',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--remote-allow-origins=*',
      `--window-size=${this.options.viewport.width},${this.options.viewport.height}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      'about:blank',
    );
    const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout.on('data', () => {});
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Google Chrome exposed no DevTools endpoint within ${this.options.actionTimeoutMs * 3}ms.\n${this.diagnostics()}`));
      }, this.options.actionTimeoutMs * 3);
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.pushStderr(text);
        const match = /DevTools listening on (ws:\/\/\S+)/u.exec(text);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`could not launch Chrome (${chromePath}): ${error.message}`));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited before DevTools became available (code ${code}${signal === null ? '' : `, signal ${signal}`}).\n${this.diagnostics()}`));
      });
    });
    this.connection = await CdpConnection.connect(endpoint, 'chrome', this.options.actionTimeoutMs);
    child.once('exit', () => {
      if (this.connection !== undefined) this.connection.failAll(new Error('Chrome exited'));
      this.connection = undefined;
      this.process = undefined;
    });
  }

  pushStderr(text) {
    this.stderrTail.push(text);
    if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40);
  }

  diagnostics() {
    const notable = this.stderrTail
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0 && !/^\[?\d+:\d+/u.test(line.trim()))
      .slice(-8)
      .join('\n');
    return notable.length > 0 ? `Chrome stderr:\n${notable}` : 'Chrome produced no stderr output.';
  }

  /** Open a new tab (page) and optionally navigate it. */
  async openPage(url) {
    await this.ensureStarted();
    const created = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.connection.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const page = new ChromePage(this, created.targetId, attached.sessionId);
    await page.init();
    this.pageSequence += 1;
    page.id = `p${this.pageSequence}`;
    this.pages.set(page.id, page);
    this.lastPageId = page.id;
    if (typeof url === 'string' && url.trim().length > 0) {
      await page.goto(url);
    }
    return page;
  }

  /** Resolve the page a call targets: an explicit id, else the most recent page. */
  page(id) {
    if (id !== undefined && String(id).trim().length > 0) {
      const page = this.pages.get(String(id).trim());
      if (page === undefined) {
        const known = [...this.pages.keys()].join(', ') || 'none';
        throw new Error(`unknown page ${JSON.stringify(id)}; open pages: ${known}`);
      }
      this.lastPageId = page.id;
      return page;
    }
    const page = this.lastPageId === undefined ? undefined : this.pages.get(this.lastPageId);
    if (page === undefined) throw new Error("no page is open; call this tool with action 'open' first");
    return page;
  }

  /** Close one page and forget it. */
  async closePage(id) {
    const page = this.page(id);
    page.dispose();
    this.pages.delete(page.id);
    if (this.lastPageId === page.id) this.lastPageId = [...this.pages.keys()].pop();
    try {
      await this.connection.send('Target.closeTarget', { targetId: page.targetId });
    } catch {
      // The target may already be gone; forgetting it locally is enough.
    }
    return page.id;
  }

  /** Describe every open page. */
  async listPages() {
    const listing = [];
    for (const page of this.pages.values()) {
      listing.push({
        page: page.id,
        url: await page.currentUrl(),
        title: await page.title(),
      });
    }
    return listing;
  }

  /** Write bytes to disk, creating parent directories. */
  async writeArtifact(filePath, data) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return filePath;
  }

  resolvePath(requested, extension, cwd) {
    return resolveArtifactPath(requested, {
      artifactDir: this.options.artifactDir,
      cwd: cwd ?? this.options.cwd,
      extension,
    });
  }

  /**
   * Terminate Chrome and remove its temporary profile.
   * @returns Whether the temporary profile directory is gone afterwards.
   */
  async dispose() {
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    this.lastPageId = undefined;
    this.requestUrls.clear();
    if (this.connection !== undefined) {
      this.connection.close();
      this.connection = undefined;
    }
    const child = this.process;
    this.process = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      // Wait for the exit before touching the profile: a dying Chrome (including
      // its crashpad handler) can recreate files while the removal runs.
      if (!(await waitForExit(child, 2000))) {
        child.kill('SIGKILL');
        await waitForExit(child, 2000);
      }
    }
    const dir = this.userDataDir;
    this.userDataDir = undefined;
    if (dir === undefined) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return true;
      } catch {
        await delay(150);
      }
    }
    return false;
  }

  /** Whether Chrome is currently running under this manager. */
  get running() {
    return this.connection !== undefined && this.process !== undefined && this.process.exitCode === null;
  }
}
