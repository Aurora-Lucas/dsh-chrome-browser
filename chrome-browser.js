/**
 * `chrome-browser` — a model-facing Chrome tool for the DeepSeek Harness.
 *
 * Registers one `chrome` tool that drives the Google Chrome installed on this
 * machine through the DevTools protocol. Because the tool runs inside the Host
 * process, it needs no per-call shell approval and is unaffected by the bash
 * file sandbox. Screenshots are returned as real images beside a saved path.
 *
 * The bundle intentionally imports nothing but `./browser.js`: a workspace
 * bundle is linked into the profile, so a bare `@deepseek-ai/*` import would
 * resolve against the workspace instead of the dsh installation and fail. The
 * tool definition below therefore satisfies the registry contract directly
 * (name/description/parameters/output/execute) and validates its own arguments.
 *
 * @module dsh-chrome-browser
 */

import path from 'node:path';

import { ChromeBrowser, boundText } from './browser.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-browser';

/** Services required by the Chrome tool. */
export const inject = ['tools'];

/**
 * Default configuration; a row may override any field through `config`.
 * `noSandbox` is a POSIX convention (Chrome refuses to run as root otherwise) and
 * is off on Windows, where the flag is unnecessary and only weakens the sandbox.
 */
const FALLBACK_SETTINGS = {
  chromePath: '',
  headless: true,
  noSandbox: process.platform !== 'win32',
  userDataDir: '',
  defaultWidth: 1280,
  defaultHeight: 800,
  maxOutputChars: 100000,
  navigationTimeoutMs: 30000,
  artifactDir: '',
};

/** Settings that must be positive integers when supplied. */
const INTEGER_SETTINGS = ['defaultWidth', 'defaultHeight', 'maxOutputChars', 'navigationTimeoutMs'];

/** Every action the `chrome` tool accepts. */
const ACTIONS = [
  'open',
  'goto',
  'screenshot',
  'viewport',
  'dom',
  'text',
  'eval',
  'click',
  'type',
  'press',
  'wait_for',
  'console',
  'network',
  'pdf',
  'tabs',
  'close',
  'stop',
];

const ACTION_HELP = [
  'open: start Chrome if needed, open a new page (optional url, width, height, deviceScaleFactor, mobile)',
  'goto: navigate an open page to url',
  'screenshot: capture a PNG of the viewport, of the full page (fullPage), or of one element (selector)',
  'viewport: resize the emulated viewport (width, height, deviceScaleFactor, mobile)',
  'dom: outerHTML of the document or of selector',
  'text: innerText of the body or of selector',
  'eval: evaluate a JavaScript expression in the page and return its JSON value',
  'click: click an element (selector) or viewport coordinates (x, y)',
  'type: focus selector, optionally clear, insert text, optionally submit with Enter',
  'press: synthesize one key (Enter, Tab, Escape, arrows, ...)',
  'wait_for: wait until selector matches or the page text contains text',
  'console: read collected console messages and uncaught page errors',
  'network: read collected failed requests and HTTP 4xx/5xx responses',
  'pdf: print the page to a PDF file',
  'tabs: list open pages',
  'close: close one page',
  'stop: shut Chrome down and release its temporary profile',
].join('; ');

/** Canonical image value schema; mirrors the attachment reference an image block carries. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

/** Model-facing argument schema; the registry forwards it to the provider verbatim. */
const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ACTIONS, description: ACTION_HELP },
    url: { type: 'string', description: 'Page URL for open/goto.' },
    page: { type: 'string', description: 'Page id returned by open or tabs; defaults to the most recent page.' },
    selector: { type: 'string', description: 'CSS selector for screenshot/dom/text/click/type/wait_for.' },
    expression: { type: 'string', description: 'JavaScript expression for eval; its resolved value is returned as JSON.' },
    text: { type: 'string', description: 'Text to insert for type, or text to wait for with wait_for.' },
    key: { type: 'string', description: 'Key name for press, such as Enter, Tab, Escape, ArrowDown.' },
    path: { type: 'string', description: 'Output file for screenshot/pdf, relative to the session working directory.' },
    x: { type: 'number', description: 'Viewport x coordinate for click when no selector is given.' },
    y: { type: 'number', description: 'Viewport y coordinate for click when no selector is given.' },
    width: { type: 'integer', description: 'Viewport width in CSS pixels for open/screenshot/viewport.' },
    height: { type: 'integer', description: 'Viewport height in CSS pixels for open/screenshot/viewport.' },
    deviceScaleFactor: { type: 'number', description: 'Device pixel ratio for open/screenshot/viewport; 1 is CSS pixels.' },
    mobile: { type: 'boolean', description: 'Emulate a mobile viewport for open/screenshot/viewport.' },
    fullPage: { type: 'boolean', description: 'screenshot only: capture the full scrollable page, capped at 12000 CSS px.' },
    scale: { type: 'number', description: 'screenshot only: clip scale for fullPage/selector captures.' },
    clear: { type: 'boolean', description: 'type clears the field first; console/network drop collected entries.' },
    submit: { type: 'boolean', description: 'type presses Enter after inserting the text.' },
    delayMs: { type: 'integer', description: 'type only: delay in milliseconds between inserted characters.' },
    timeoutMs: { type: 'integer', description: 'Override the budget in milliseconds for goto and wait_for.' },
    maxChars: { type: 'integer', description: 'Character cap for dom/text/eval output.' },
    limit: { type: 'integer', description: 'console/network: maximum entries to report, newest last.' },
  },
};

const STRING_PARAMETERS = ['url', 'page', 'selector', 'expression', 'text', 'key', 'path'];
const NUMBER_PARAMETERS = ['x', 'y', 'deviceScaleFactor', 'scale'];
const INTEGER_PARAMETERS = ['width', 'height', 'delayMs', 'timeoutMs', 'maxChars', 'limit'];
const BOOLEAN_PARAMETERS = ['mobile', 'fullPage', 'clear', 'submit'];

/** Validate model arguments against {@link PARAMETERS_SCHEMA}; returns every violation. */
function argumentViolations(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const violations = [];
  if (typeof args.action !== 'string') violations.push('"action" is required and must be a string');
  else if (!ACTIONS.includes(args.action)) violations.push(`"action" must be one of ${JSON.stringify(ACTIONS)}`);
  for (const key of STRING_PARAMETERS) {
    if (args[key] !== undefined && typeof args[key] !== 'string') violations.push(`"${key}" must be a string`);
  }
  for (const key of NUMBER_PARAMETERS) {
    if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) {
      violations.push(`"${key}" must be a finite number`);
    }
  }
  for (const key of INTEGER_PARAMETERS) {
    if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 1)) {
      violations.push(`"${key}" must be a positive integer`);
    }
  }
  for (const key of BOOLEAN_PARAMETERS) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') violations.push(`"${key}" must be a boolean`);
  }
  return violations;
}

/** Build a registry-ready tool definition that validates arguments before execution. */
function defineChromeTool(options) {
  const { execute, presentCall } = options;
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(typeof presentCall !== 'function' ? {} : {
      presentCall: (args) => (argumentViolations(args).length > 0 ? undefined : presentCall(args)),
    }),
    async execute(args, exec) {
      const violations = argumentViolations(args);
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`);
      return execute(args, exec);
    },
  };
}

/** Read PNG pixel dimensions from the IHDR chunk without decoding the image. */
function pngDimensions(buffer) {
  if (buffer.length < 24) return undefined;
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Format console entries as a bounded model-facing listing. */
function formatConsole(entries, limit) {
  const shown = entries.slice(-limit);
  const omitted = entries.length - shown.length;
  const lines = shown.map((entry) => `${entry.level.toUpperCase()} [${entry.kind}] ${entry.text}`);
  return `${omitted > 0 ? `(${omitted} earlier entries omitted)\n` : ''}${lines.join('\n')}`;
}

/** Format network entries as a bounded model-facing listing. */
function formatNetwork(entries, limit) {
  const shown = entries.slice(-limit);
  const omitted = entries.length - shown.length;
  const lines = shown.map((entry) => (entry.kind === 'failed'
    ? `FAILED ${entry.type ?? ''} ${entry.url} — ${entry.errorText}${entry.canceled === true ? ' (canceled)' : ''}`
    : `HTTP ${entry.status} ${entry.type ?? ''} ${entry.url}${entry.mimeType === undefined ? '' : ` (${entry.mimeType})`}`));
  return `${omitted > 0 ? `(${omitted} earlier entries omitted)\n` : ''}${lines.join('\n')}`;
}

/** Pick a viewport override from tool arguments, or undefined when none was given. */
function viewportFrom(args, fallback) {
  const width = typeof args.width === 'number' ? args.width : undefined;
  const height = typeof args.height === 'number' ? args.height : undefined;
  const deviceScaleFactor = typeof args.deviceScaleFactor === 'number' ? args.deviceScaleFactor : undefined;
  const mobile = typeof args.mobile === 'boolean' ? args.mobile : undefined;
  if (width === undefined && height === undefined && deviceScaleFactor === undefined && mobile === undefined) {
    return undefined;
  }
  return {
    width: width ?? fallback.width,
    height: height ?? fallback.height,
    deviceScaleFactor: deviceScaleFactor ?? 1,
    mobile: mobile ?? false,
  };
}

/** Register the `chrome` tool on the given context. */
export function apply(ctx, config) {
  registerChromeTool(ctx, config);
}

/** Build and register the `chrome` tool definition. */
function registerChromeTool(ctx, config) {
  const settings = { ...FALLBACK_SETTINGS, ...(config ?? {}) };
  for (const key of INTEGER_SETTINGS) {
    const value = settings[key];
    if (!Number.isInteger(value) || value < 1) throw new Error(`chrome-browser: config ${key} must be a positive integer`);
  }
  if (typeof settings.chromePath !== 'string' || typeof settings.artifactDir !== 'string'
    || typeof settings.userDataDir !== 'string') {
    throw new Error('chrome-browser: config chromePath, userDataDir, and artifactDir must be strings');
  }
  const browser = new ChromeBrowser({
    chromePath: settings.chromePath,
    headless: settings.headless !== false,
    noSandbox: settings.noSandbox !== false,
    width: settings.defaultWidth,
    height: settings.defaultHeight,
    navigationTimeoutMs: settings.navigationTimeoutMs,
    ...(settings.artifactDir.trim().length > 0 ? { artifactDir: settings.artifactDir } : {}),
    ...(settings.userDataDir.trim().length > 0 ? { userDataDir: settings.userDataDir } : {}),
  });

  // Keep a scoped context for the optional attachment service so screenshots can
  // be attached as images, without making the tool itself depend on that service.
  let attachmentsScope;
  ctx.inject(['attachments'], (scoped) => {
    attachmentsScope = scoped;
  });

  const attachmentsService = () => attachmentsScope?.get?.('attachments') ?? ctx.get?.('attachments');

  /** Resolve the working directory a relative artifact path is anchored to. */
  const callCwd = (exec) => exec?.agent?.cwd
    ?? exec?.agent?.session?.cwd
    ?? exec?.agent?.session?.header?.cwd
    ?? exec?.agent?.meta?.cwd
    ?? browser.options.cwd;

  /** Whether the calling model route accepts image input; failures mean "no image". */
  async function routeAcceptsImages(exec) {
    try {
      const routed = exec?.agent?.session?.requestHeader?.()?.config;
      const provider = routed?.provider ?? exec?.agent?.options?.provider;
      const model = routed?.model ?? exec?.agent?.options?.model;
      const llm = ctx.get?.('llm') ?? attachmentsScope?.get?.('llm');
      if (llm === undefined || provider === undefined || model === undefined) return false;
      const info = await llm.resolveModelInfo(provider, model, exec?.signal);
      return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
    } catch {
      return false;
    }
  }

  /**
   * Try to store PNG bytes as a durable attachment so the result can carry the
   * image itself. Returns undefined when no store is mounted, the route cannot
   * take images, or the deployment rejects the bytes; the file on disk remains.
   */
  async function attachPng(exec, data, fileName) {
    const service = attachmentsService();
    if (service === undefined) return undefined;
    const limits = service.imageLimits;
    if (limits !== undefined && !limits.mediaTypes.includes('image/png')) return undefined;
    if (limits !== undefined && data.length > Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)) return undefined;
    if (!(await routeAcceptsImages(exec))) return undefined;
    try {
      const ref = await service.saveImage({ data, mediaType: 'image/png', name: fileName });
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      };
    } catch {
      return undefined;
    }
  }

  ctx.effect(() => () => {
    void browser.dispose();
  });

  ctx.tools.register(defineChromeTool({
    name: 'chrome',
    description:
      'Drive the Google Chrome browser installed on this machine (headless; runs inside the Host, so no approval is needed). '
      + `Start with action 'open'; later actions take an optional page id and otherwise use the most recent page. Actions: ${ACTION_HELP}. `
      + 'screenshot returns the image itself, so use it to see rendered UI; console and network report what the page did while the tool was attached.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
        required: ['text'],
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: value.text }];
        if (value.image !== undefined && value.image !== null) {
          blocks.push({ type: 'image', attachment: { ...value.image } });
        }
        return blocks;
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const action = args.action;
      const maxChars = Number.isInteger(args.maxChars) && args.maxChars > 0 ? args.maxChars : settings.maxOutputChars;
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50;
      if (exec.signal?.aborted === true) throw new Error('the Chrome tool call was cancelled before it started');

      const abortListener = () => browser.setAborted(true);
      exec.signal?.addEventListener?.('abort', abortListener);
      try {
        browser.setAborted(false);
        switch (action) {
          case 'open': {
            const page = await browser.openPage(undefined);
            const override = viewportFrom(args, browser.options.viewport);
            if (override !== undefined) await page.setViewport(override);
            let shown = `opened a new page as ${page.id}`;
            if (typeof args.url === 'string' && args.url.trim().length > 0) {
              const navigated = await page.goto(args.url, { timeoutMs: args.timeoutMs });
              shown += ` at ${navigated.url}${navigated.title ? ` — "${navigated.title}"` : ''}`;
            }
            return { text: shown };
          }
          case 'goto': {
            if (typeof args.url !== 'string' || args.url.trim().length === 0) throw new Error("action 'goto' requires url");
            const page = browser.page(args.page);
            const navigated = await page.goto(args.url, { timeoutMs: args.timeoutMs });
            return { text: `${page.id} navigated to ${navigated.url}${navigated.title ? ` — "${navigated.title}"` : ''}` };
          }
          case 'screenshot': {
            const page = browser.page(args.page);
            const override = viewportFrom(args, browser.options.viewport);
            if (override !== undefined) await page.setViewport(override);
            const clipBased = args.fullPage === true || (typeof args.selector === 'string' && args.selector.length > 0);
            const scale = typeof args.scale === 'number' && args.scale > 0 ? args.scale : 1;
            const capture = (clipScale) => page.screenshot({
              fullPage: args.fullPage === true,
              selector: typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : undefined,
              scale: clipScale,
            });
            let data = await capture(scale);
            // Keep the attachment within deployment limits by halving a clip capture once.
            const limits = attachmentsService()?.imageLimits;
            const byteCap = limits === undefined
              ? undefined
              : Math.min(limits.maxImageBytes, limits.maxMessageImageBytes);
            if (byteCap !== undefined && data.length > byteCap && clipBased && scale > 0.3) {
              data = await capture(scale / 2);
            }
            const filePath = browser.resolvePath(args.path, 'png', callCwd(exec));
            await browser.writeArtifact(filePath, data);
            const dimensions = pngDimensions(data);
            const target = typeof args.selector === 'string' && args.selector.length > 0
              ? `element ${args.selector}`
              : args.fullPage === true ? 'full page' : 'viewport';
            const size = dimensions === undefined ? '' : `, ${dimensions.width}x${dimensions.height} px`;
            const image = await attachPng(exec, data, path.basename(filePath));
            const note = image === undefined
              ? ' The image could not be attached to this result, so inspect the saved file instead.'
              : '';
            return {
              text: `screenshot of the ${target} on ${page.id}: PNG, ${data.length} bytes${size}, saved to ${filePath}.${note}`,
              ...(image === undefined ? {} : { image }),
            };
          }
          case 'viewport': {
            if (typeof args.width !== 'number' || typeof args.height !== 'number') {
              throw new Error("action 'viewport' requires numeric width and height");
            }
            const page = browser.page(args.page);
            const override = {
              width: args.width,
              height: args.height,
              deviceScaleFactor: typeof args.deviceScaleFactor === 'number' ? args.deviceScaleFactor : 1,
              mobile: args.mobile === true,
            };
            await page.setViewport(override);
            return { text: `${page.id} viewport is now ${override.width}x${override.height} CSS px at device scale ${override.deviceScaleFactor}${override.mobile ? ' (mobile)' : ''}` };
          }
          case 'dom': {
            const page = browser.page(args.page);
            const expression = typeof args.selector === 'string' && args.selector.length > 0
              ? `document.querySelector(${JSON.stringify(args.selector)})?.outerHTML ?? null`
              : 'document.documentElement.outerHTML';
            const html = await page.evaluate(expression);
            if (html === null || html === undefined) throw new Error(`no element matches selector ${JSON.stringify(args.selector)}`);
            const bounded = boundText(html, maxChars);
            return { text: `${page.id} DOM (${String(html).length} chars${bounded.length < String(html).length ? ', truncated' : ''}):\n${bounded}` };
          }
          case 'text': {
            const page = browser.page(args.page);
            const expression = typeof args.selector === 'string' && args.selector.length > 0
              ? `document.querySelector(${JSON.stringify(args.selector)})?.innerText ?? null`
              : 'document.body?.innerText ?? ""';
            const content = await page.evaluate(expression);
            if (content === null || content === undefined) throw new Error(`no element matches selector ${JSON.stringify(args.selector)}`);
            const bounded = boundText(content, maxChars);
            return { text: `${page.id} text (${String(content).length} chars${bounded.length < String(content).length ? ', truncated' : ''}):\n${bounded}` };
          }
          case 'eval': {
            if (typeof args.expression !== 'string' || args.expression.trim().length === 0) throw new Error("action 'eval' requires expression");
            const page = browser.page(args.page);
            const value = await page.evaluate(args.expression);
            const serialized = value === undefined
              ? 'undefined'
              : typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
            return { text: `${page.id} eval result:\n${boundText(serialized, maxChars)}` };
          }
          case 'click': {
            const page = browser.page(args.page);
            const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
            if (!hasSelector && (typeof args.x !== 'number' || typeof args.y !== 'number')) {
              throw new Error("action 'click' requires selector or both x and y");
            }
            const point = await page.click({
              selector: hasSelector ? args.selector : undefined,
              x: args.x,
              y: args.y,
            });
            await page.waitForLoad(1500).catch(() => {});
            return {
              text: hasSelector
                ? `clicked ${args.selector} on ${page.id} at viewport (${Math.round(point.x)}, ${Math.round(point.y)})`
                : `clicked ${page.id} at viewport (${Math.round(point.x)}, ${Math.round(point.y)})`,
            };
          }
          case 'type': {
            const page = browser.page(args.page);
            if (typeof args.selector !== 'string' || args.selector.length === 0) throw new Error("action 'type' requires selector");
            if (typeof args.text !== 'string') throw new Error("action 'type' requires text");
            await page.type({
              selector: args.selector,
              text: args.text,
              clear: args.clear === true,
              submit: args.submit === true,
              delayMs: Number.isInteger(args.delayMs) && args.delayMs > 0 ? args.delayMs : 0,
            });
            await page.waitForLoad(1000).catch(() => {});
            return {
              text: `typed ${args.text.length} characters into ${args.selector} on ${page.id}${args.clear === true ? ' after clearing it' : ''}${args.submit === true ? ' and pressed Enter' : ''}`,
            };
          }
          case 'press': {
            const page = browser.page(args.page);
            if (typeof args.key !== 'string' || args.key.length === 0) throw new Error("action 'press' requires key");
            await page.press(args.key);
            await page.waitForLoad(1000).catch(() => {});
            return { text: `pressed ${args.key} on ${page.id}` };
          }
          case 'wait_for': {
            const page = browser.page(args.page);
            const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
            const hasText = typeof args.text === 'string' && args.text.length > 0;
            if (!hasSelector && !hasText) throw new Error("action 'wait_for' requires selector or text");
            const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs
              : Math.max(1000, settings.navigationTimeoutMs);
            const outcome = await page.waitFor({
              selector: hasSelector ? args.selector : undefined,
              text: hasText ? args.text : undefined,
              timeoutMs,
            });
            const target = hasSelector ? `selector ${args.selector}` : `text ${JSON.stringify(args.text)}`;
            return { text: `wait_for ${target} on ${page.id} succeeded after ${outcome.elapsedMs}ms` };
          }
          case 'console': {
            const page = browser.page(args.page);
            const entries = page.takeConsole({ clear: args.clear === true });
            if (entries.length === 0) return { text: `${page.id} collected no console messages or page errors` };
            const errors = entries.filter((entry) => entry.level === 'error').length;
            return { text: `${page.id} console (${entries.length} entries, ${errors} at error level):\n${formatConsole(entries, limit)}` };
          }
          case 'network': {
            const page = browser.page(args.page);
            const entries = page.takeNetwork({ clear: args.clear === true });
            if (entries.length === 0) return { text: `${page.id} collected no failed requests or HTTP errors` };
            return { text: `${page.id} network problems (${entries.length} entries):\n${formatNetwork(entries, limit)}` };
          }
          case 'pdf': {
            const page = browser.page(args.page);
            const data = await page.printPdf();
            const filePath = browser.resolvePath(args.path, 'pdf', callCwd(exec));
            await browser.writeArtifact(filePath, data);
            return { text: `printed ${page.id} to PDF, ${data.length} bytes, saved to ${filePath}` };
          }
          case 'tabs': {
            const pages = await browser.listPages();
            if (pages.length === 0) return { text: "no pages are open; call this tool with action 'open' to start Chrome" };
            const lines = pages.map((entry) => `${entry.page}: ${entry.url ?? '(unknown)'}${entry.title ? ` — "${entry.title}"` : ''}`);
            return { text: `${pages.length} open page(s):\n${lines.join('\n')}` };
          }
          case 'close': {
            const closed = await browser.closePage(args.page);
            return { text: `closed page ${closed}` };
          }
          case 'stop': {
            if (!browser.running) return { text: 'Chrome was not running' };
            const outcome = await browser.dispose();
            const detail = outcome === 'removed'
              ? 'its temporary profile was removed'
              : outcome === 'kept'
                ? 'the configured profile directory was left in place'
                : 'a temporary profile directory remains under the system temp directory';
            return { text: `Chrome stopped; ${detail}` };
          }
          default:
            throw new Error(`unknown action ${JSON.stringify(action)}; expected one of: ${ACTIONS.join(', ')}`);
        }
      } finally {
        exec.signal?.removeEventListener?.('abort', abortListener);
        browser.setAborted(false);
      }
    },
    presentCall(args) {
      const detail = args.url ?? args.selector ?? args.expression ?? args.key ?? '';
      const shown = typeof detail === 'string' ? detail.slice(0, 80) : String(detail);
      return {
        card: 'generic',
        title: `Chrome ${args.action}${shown ? ` ${shown}` : ''}`,
        kind: 'search',
        rawInput: shown === '' ? args.action : shown,
      };
    },
  }));
}
