#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { DEFAULT_RENDER_SETTINGS } from '../src/config/defaults.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// When installed/published from dist/cli, the renderer assets live next to
// this file; in development the script runs from scripts/ and the built
// assets live in ../dist/cli.
const cliAssetDir = existsSync(path.join(scriptDir, 'browser-renderer.js'))
  ? scriptDir
  : path.resolve(scriptDir, '..', 'dist', 'cli');

// Version comes from the package.json that ships next to this file (dist/cli)
// or the repository root in development.
const CLI_PKG_PATH = existsSync(path.join(scriptDir, 'package.json'))
  ? path.join(scriptDir, 'package.json')
  : path.resolve(scriptDir, '..', 'package.json');
const CLI_PKG = JSON.parse(readFileSync(CLI_PKG_PATH, 'utf8'));
const CLI_VERSION = CLI_PKG.version;
const CLI_HOMEPAGE = 'https://docu.md';

// `documd serve` defaults. Declared before HELP because its template
// interpolates them at module evaluation time. The server is loopback-only;
// the token path prefix is the sole request credential, so no other auth
// state is kept.
const SERVE_DEFAULT_PORT = 4317;
const SERVE_DEFAULT_MAX_BODY_MB = 64;
const SERVE_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);
const SERVE_ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SERVE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'OPTIONS']);

function parseServePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return port;
}

function parseServeMaxBodyMb(value) {
  const mb = Number(value);
  if (!Number.isInteger(mb) || mb <= 0) {
    throw new Error('--max-body-mb must be a positive integer');
  }
  return mb;
}

// Defaults in the help text are derived from the shared settings schema so
// the CLI help can never drift from settings-schema.json.
const HELP = `documd v${CLI_VERSION} — ${CLI_HOMEPAGE}
Render Markdown / diagrams / books with headless Chromium

Usage:
  documd <input> [<output>] [--format <f>] [options]
  documd <input> --assets <dir> [--kind <k>] [--only <list>]
  documd serve [<root-dir>] [--port <n>] [--token <hex>] [--max-body-mb <n>]

The second positional is treated as the output file (pandoc style) when its
extension is a known output format; the input extension must be a known input
format (.md/.markdown/.mdown/.mkd/.txt or a diagram source like .puml/.mmd/...).

Output formats (--format; inferred from the output extension when omitted):
  html, epub, docx, pdf, png   markdown / SUMMARY.md (--book) documents
                               (png = full-page screenshot of the rendered page)
  svg, png, drawio             diagram sources (PlantUML/Mermaid/DOT/Vega/...)

Exporting figures and images (--assets, Markdown input):
  documd report.md --assets ./figures           every figure and image
  documd report.md --assets ./figures --only 1,3
  documd report.md --assets ./figures --kind diagrams --format svg
  Assets are numbered in document order; --kind picks the kinds and --only the
  numbers to write. Figures come from the engines that render them (png, or the
  engine's svg with --format svg); images are copied in their original format.

Diagram render errors are reported with their engine and markdown line. The
command exits with status 1 when a figure or image failed (--no-fail-on-error
exports anyway).

Options:
      --format <f>          html, epub, docx, pdf, svg, png or drawio
                            (with --assets: png or svg, the figure format)
  -b, --book                Whole-book export: input is a GitBook SUMMARY.md
      --assets <dir>        Export the document's figures and images into <dir>
      --kind <k>            With --assets: all (default), diagrams or images
      --only <list>         With --assets: 1-based asset numbers, e.g. 1,3
      --fail-on-error       Exit 1 when a figure or image fails (default)
      --no-fail-on-error    Report failures but still exit 0
      --diagram-type <t>    Diagram renderer (default: inferred from the extension)
  -t, --theme <id>          Viewer theme (default: ${DEFAULT_RENDER_SETTINGS.theme})
      --title <text>        Override the document title
      --language <code>     Document language code (default: ${DEFAULT_RENDER_SETTINGS.language})
      --frontmatter <mode>  hide, table, or raw (default: ${DEFAULT_RENDER_SETTINGS.frontmatterDisplay})
      --table-layout <mode> left, center, or center-full-width (default: ${DEFAULT_RENDER_SETTINGS.tableLayout})
      --image-layout <mode> left or center (default: ${DEFAULT_RENDER_SETTINGS.imageLayout})
      --diagram-layout <mode> left or center (default: ${DEFAULT_RENDER_SETTINGS.diagramLayout})
      --merge-empty-cells   Merge empty Markdown table cells (default: on)
      --first-line-indent <n>  First-line indent in characters, 0-4 (default: ${DEFAULT_RENDER_SETTINGS.firstLineIndent})
      --png-width <px>      Viewport width for --format png on a document (default: 1180)
      --png-scale <n>       Device pixel ratio for --format png, 1-4 (default: 2)
      --chrome <path>       Explicit Chrome/Chromium binary (DOCUMD_CHROME_PATH)
      --browser-arg <flag>  Extra Chromium flag, repeatable (DOCUMD_CHROME_ARGS)
      --timeout <seconds>   Overall render timeout (default: 120)
      --port <n>            serve: loopback port (default ${SERVE_DEFAULT_PORT}, 0 = random)
      --token <hex>         serve: token path prefix credential (default: random 36 hex chars)
      --max-body-mb <n>     serve: maximum PUT body size in MiB (default ${SERVE_DEFAULT_MAX_BODY_MB})
  -v, --version             Print the version and exit
  -h, --help                Show this help

Local editing server (documd serve):
  Serves a directory on http://127.0.0.1 only, behind a random token path
  prefix. Markdown files are served as text/plain so the Markdown Viewer
  browser extension injects on them, and same-origin PUT writes the editor
  content back to the original file atomically. Host header checks, root
  confinement and a body limit are always on; no browser is launched.

Website: ${CLI_HOMEPAGE}
`;

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return value;
}

/**
 * Like takeValue, but for options whose value is itself a flag
 * (`--browser-arg --disable-gpu`): here a leading dash is the value, not the
 * start of the next option.
 */
function takeFlagValue(args, index, option) {
  const value = args[index + 1];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

const OUTPUT_FORMATS = ['html', 'epub', 'docx', 'pdf', 'svg', 'png', 'drawio'];
const DIAGRAM_FORMATS = ['svg', 'png', 'drawio'];
/** Kinds of asset `--assets` can export, in document order. */
const ASSET_KINDS = ['all', 'diagrams', 'images'];
/** Payload formats for an exported figure (--assets --format). */
const ASSET_DIAGRAM_FORMATS = ['png', 'svg'];
const OUTPUT_EXT_FORMATS = {
  '.html': 'html',
  '.epub': 'epub',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.svg': 'svg',
  '.png': 'png',
  '.drawio': 'drawio',
};
const DIAGRAM_EXT_TYPES = {
  '.puml': 'plantuml',
  '.plantuml': 'plantuml',
  '.wsd': 'plantuml',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.dot': 'dot',
  '.gv': 'dot',
  '.vega': 'vega',
  '.vl': 'vega-lite',
  '.drawio': 'drawio',
  '.echarts': 'echarts',
  '.svg': 'svg',
  '.infographic': 'infographic',
  '.canvas': 'canvas',
};

// Recognised input extensions: Markdown documents plus every diagram source
// type. Used to decide whether a second positional argument can be treated as
// the output file (pandoc style) instead of guessing.
const INPUT_EXT_FORMATS = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.txt': 'markdown',
  ...DIAGRAM_EXT_TYPES,
};

function isDiagramInput(inputPath) {
  return Boolean(DIAGRAM_EXT_TYPES[path.extname(inputPath).toLowerCase()]);
}

function inferDiagramType(inputPath) {
  return DIAGRAM_EXT_TYPES[path.extname(inputPath).toLowerCase()] || null;
}

export function parseArgs(args) {
  const options = {
    theme: DEFAULT_RENDER_SETTINGS.theme,
    language: DEFAULT_RENDER_SETTINGS.language,
    frontmatterDisplay: DEFAULT_RENDER_SETTINGS.frontmatterDisplay,
    tableLayout: DEFAULT_RENDER_SETTINGS.tableLayout,
    imageLayout: DEFAULT_RENDER_SETTINGS.imageLayout,
    diagramLayout: DEFAULT_RENDER_SETTINGS.diagramLayout,
    tableMergeEmpty: DEFAULT_RENDER_SETTINGS.tableMergeEmpty,
    firstLineIndent: DEFAULT_RENDER_SETTINGS.firstLineIndent,
    browserArgs: [],
    assetKind: 'all',
    failOnError: true,
    timeoutMs: 120_000,
    // `documd serve` defaults; ignored by every export command.
    servePort: SERVE_DEFAULT_PORT,
    serveMaxBodyMb: SERVE_DEFAULT_MAX_BODY_MB,
  };
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '-b' || arg === '--book') {
      options.bookMode = true;
    } else if (arg === '--assets') {
      options.assetsDir = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--kind') {
      options.assetKind = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--only') {
      options.only = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--fail-on-error') {
      options.failOnError = true;
    } else if (arg === '--no-fail-on-error') {
      options.failOnError = false;
    } else if (arg === '--diagram-type') {
      options.diagramType = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--format') {
      options.format = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '-t' || arg === '--theme') {
      options.theme = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--title') {
      options.title = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--language') {
      options.language = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--frontmatter') {
      options.frontmatterDisplay = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--table-layout') {
      options.tableLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--image-layout') {
      options.imageLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--diagram-layout') {
      options.diagramLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--merge-empty-cells') {
      options.tableMergeEmpty = true;
    } else if (arg === '--first-line-indent') {
      const chars = Number(takeValue(args, i, arg));
      if (!Number.isInteger(chars) || chars < 0 || chars > 4) {
        throw new Error('--first-line-indent must be an integer between 0 and 4 (characters)');
      }
      options.firstLineIndent = chars;
      i += 1;
    } else if (arg === '--png-width') {
      const width = Number(takeValue(args, i, arg));
      if (!Number.isFinite(width) || width < 200 || width > 4000) {
        throw new Error('--png-width must be a number between 200 and 4000 (pixels)');
      }
      options.pngWidth = width;
      i += 1;
    } else if (arg === '--png-scale') {
      const scale = Number(takeValue(args, i, arg));
      if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
        throw new Error('--png-scale must be a number between 1 and 4');
      }
      options.pngScale = scale;
      i += 1;
    } else if (arg === '--chrome') {
      options.chromePath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--browser-arg') {
      options.browserArgs.push(takeFlagValue(args, i, arg));
      i += 1;
    } else if (arg === '--timeout') {
      const seconds = Number(takeValue(args, i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = seconds * 1000;
      i += 1;
    } else if (arg === '--port') {
      options.servePort = parseServePort(takeValue(args, i, arg));
      i += 1;
    } else if (arg === '--token') {
      options.serveToken = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--max-body-mb') {
      options.serveMaxBodyMb = parseServeMaxBodyMb(takeValue(args, i, arg));
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  // `documd serve` is a long-running local server, not an export: it has no
  // input/output files, so it bypasses the pandoc-style positional rules below.
  if (!options.help && !options.version && positional[0] === 'serve') {
    if (positional.length > 2) {
      throw new Error('serve accepts at most one root directory: documd serve [<root-dir>] [options]');
    }
    options.serve = true;
    options.serveRoot = positional[1] || '.';
    return options;
  }

  if (!options.help && !options.version) {
    if (positional.length === 1) {
      options.input = positional[0];
    } else if (positional.length === 2) {
      // Pandoc-style second positional: treat it as the output file. Only
      // when both extensions are recognisable — otherwise fail loudly with
      // the unknown format named, instead of guessing.
      const [candidateInput, candidateOutput] = positional;
      const inputExt = path.extname(candidateInput).toLowerCase();
      const outputExt = path.extname(candidateOutput).toLowerCase();
      const inputKnown = INPUT_EXT_FORMATS[inputExt] !== undefined;
      // An explicit --format makes the output extension irrelevant (same as -o).
      const outputKnown = OUTPUT_EXT_FORMATS[outputExt] !== undefined || Boolean(options.format);
      if (inputKnown && outputKnown) {
        options.input = candidateInput;
        options.output = candidateOutput;
      } else {
        const problems = [];
        if (!inputKnown) {
          problems.push(`unknown input format "${inputExt || path.basename(candidateInput)}"`);
        }
        if (!OUTPUT_EXT_FORMATS[outputExt]) {
          problems.push(`unknown output format "${outputExt || path.basename(candidateOutput)}"`);
        }
        throw new Error(
          `Cannot treat "${candidateOutput}" as the output file: ${problems.join(' and ')}; use --format html|epub|docx|pdf|svg|png|drawio`,
        );
      }
    } else {
      throw new Error('Exactly one input file is required (usage: documd <input> [<output>] [options])');
    }
  }
  if (!['hide', 'table', 'raw'].includes(options.frontmatterDisplay)) {
    throw new Error('--frontmatter must be hide, table, or raw');
  }
  if (!['left', 'center', 'center-full-width'].includes(options.tableLayout)) {
    throw new Error('--table-layout must be left, center, or center-full-width');
  }
  if (!['left', 'center'].includes(options.imageLayout)) {
    throw new Error('--image-layout must be left or center');
  }
  if (!['left', 'center'].includes(options.diagramLayout)) {
    throw new Error('--diagram-layout must be left or center');
  }
  if (options.format && !OUTPUT_FORMATS.includes(options.format)) {
    throw new Error('--format must be html, epub, docx, pdf, svg, png or drawio');
  }
  if (!ASSET_KINDS.includes(options.assetKind)) {
    throw new Error('--kind must be all, diagrams, or images');
  }
  if (options.only !== undefined) {
    options.onlyIndexes = parseOnlyIndexes(options.only);
  }
  if (!options.assetsDir) {
    if (options.onlyIndexes) {
      throw new Error('--only requires --assets <dir>');
    }
    if (options.assetKind !== 'all') {
      throw new Error('--kind requires --assets <dir>');
    }
  }

  // help/version need no input or format inference.
  if (options.help || options.version) {
    return options;
  }

  // --assets is a mode of its own: the figures and images of one Markdown
  // document are written into a directory, so there is no document format to
  // infer — --format picks the figure payload (png or svg) instead.
  if (options.assetsDir) {
    if (isDiagramInput(options.input)) {
      throw new Error(`--assets exports what a Markdown document references; "${options.input}" is a diagram source`);
    }
    if (options.bookMode) {
      throw new Error('--assets exports the figures of a single document; --book is not supported yet');
    }
    if (options.output) {
      throw new Error('--assets writes into its own directory; drop the output file argument');
    }
    options.format = options.format || 'png';
    if (!ASSET_DIAGRAM_FORMATS.includes(options.format)) {
      throw new Error('--assets exports figures as png or svg; use --format png|svg');
    }
    return options;
  }

  // Infer the output format when --format is omitted.
  if (!options.format) {
    if (options.output) {
      const ext = path.extname(options.output).toLowerCase();
      options.format = OUTPUT_EXT_FORMATS[ext];
      if (!options.format) {
        throw new Error(`Cannot infer --format from output "${options.output}"; use --format html|epub|docx|pdf|svg|png|drawio`);
      }
    } else if (options.bookMode) {
      options.format = 'epub';
    } else if (isDiagramInput(options.input)) {
      options.format = 'svg';
    } else {
      options.format = 'html';
    }
  }

  const diagramInput = isDiagramInput(options.input);
  if (options.format === 'png') {
    // png serves both inputs: a diagram source exports its single figure, a
    // document exports a full-page screenshot of the rendered viewer page.
    options.diagramMode = diagramInput;
  } else if (DIAGRAM_FORMATS.includes(options.format)) {
    if (!diagramInput) {
      throw new Error(`Format "${options.format}" requires a diagram input (PlantUML/Mermaid/DOT/Vega/...); "${options.input}" is not one`);
    }
    options.diagramMode = true;
  } else if (diagramInput) {
    throw new Error(`Diagram input "${options.input}" cannot be exported as ${options.format}; use --format svg, png or drawio`);
  }

  if (options.bookMode) {
    if (!['epub', 'docx', 'pdf'].includes(options.format)) {
      throw new Error('--book requires --format epub, docx or pdf');
    }
  }

  return options;
}

/**
 * Parse a GitBook SUMMARY.md into book pages (same format as the viewer's
 * GitBook panel): `- [Title](relative-link)` with indentation depth.
 */
export function parseSummaryPages(summaryContent, summaryDir) {
  const pages = [];
  for (const line of summaryContent.split(/\r?\n/)) {
    const match = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+\[([^\]]+)\]\(([^)]+)\)\s*$/);
    if (!match) continue;
    const indent = match[1] || '';
    const title = match[2].trim();
    const target = match[3].trim();
    if (!target || /^(?:mailto:|javascript:|#)/i.test(target)) continue;
    let href = target;
    if (!href.startsWith('http')) {
      href = href.replace(/^\.?\//, '');
      if (summaryDir) {
        href = path.posix.join(summaryDir.replace(/\\/g, '/'), href);
      }
    }
    const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
    pages.push({ href, title, depth });
  }
  return pages;
}

function outputPathFor(inputPath, requestedOutput, format) {
  if (requestedOutput) return path.resolve(requestedOutput);
  const parsed = path.parse(inputPath);
  const extension = format === 'epub' ? '.epub' : format === 'docx' ? '.docx' : format === 'pdf' ? '.pdf' : DIAGRAM_FORMATS.includes(format) ? `.${format}` : '.html';
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

export async function ensureOutputDirectory(outputPath) {
  const outputDirectory = path.dirname(outputPath);
  try {
    const stats = await fs.stat(outputDirectory);
    if (!stats.isDirectory()) {
      throw new Error(`Output parent is not a directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(outputDirectory, { recursive: true });
  }
}

/**
 * Parse the `--only` asset list: 1-based numbers in document order, comma
 * separated (`1,3`). Anything else is rejected instead of silently exporting
 * the wrong figure.
 */
export function parseOnlyIndexes(value) {
  const indexes = new Set();
  for (const part of String(value).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (!/^\d+$/.test(entry) || Number(entry) < 1) {
      throw new Error(`--only takes asset numbers like 1,3 (got "${entry}")`);
    }
    indexes.add(Number(entry));
  }
  if (indexes.size === 0) {
    throw new Error('--only needs at least one asset number, e.g. --only 1,3');
  }
  return indexes;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function sendFile(response, filePath) {
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeType(filePath),
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
    response.end(error?.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
  }
}

/**
 * The page every export renders in.
 *
 * The CSP is the second layer behind the HTML sanitizer, and the reason a gap in
 * it cannot become code execution: `script-src 'self'` (with `'unsafe-eval'`,
 * which diagram engines need) deliberately omits `'unsafe-inline'`, so an inline
 * event handler or an inline `<script>` that reached the DOM anyway is refused
 * by the browser — the document can inject markup, but never behaviour. Styles
 * stay inline (`'unsafe-inline'`) because KaTeX/mermaid inject stylesheets at
 * runtime, and remote stylesheets are allowed because the diagram engines fetch
 * their fonts from a CDN (the sanitizer strips `@import` from document styles,
 * so that allowance does not hand the document a remote-CSS channel).
 */
const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob: http: https:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function rendererHtml(basePath) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}">
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="${basePath}/styles.css">
</head>
<body>
  <div id="markdown-page"><div id="markdown-content"></div></div>
  <script src="${basePath}/browser-renderer.js"></script>
</body>
</html>`;
}

function virtualDocumentDirectory(documentDir) {
  const normalized = documentDir.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `__root__${normalized}`;
  return normalized;
}

function localPathFromVirtual(value) {
  if (value.startsWith('__root__/')) return `/${value.slice('__root__/'.length)}`;
  return value.replace(/\//g, path.sep);
}

async function startAssetServer(documentDir) {
  const token = crypto.randomBytes(18).toString('hex');
  const basePath = `/__documd/${token}`;
  const virtualDirectory = virtualDocumentDirectory(documentDir);
  const rendererPath = `${basePath}/fs/${virtualDirectory}/__documd_renderer__.html`;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const decodedPathname = decodeURIComponent(url.pathname);
      if (decodedPathname === rendererPath) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(rendererHtml(basePath));
        return;
      }

      if (url.pathname === `${basePath}/file`) {
        const requestedPath = url.searchParams.get('path');
        if (!requestedPath) {
          response.writeHead(400).end('Missing path');
          return;
        }
        let localPath = requestedPath;
        if (localPath.toLowerCase().startsWith('file:')) {
          localPath = fileURLToPath(localPath);
        } else if (!path.isAbsolute(localPath)) {
          localPath = path.resolve(documentDir, localPath);
        }
        await sendFile(response, localPath);
        return;
      }

      if (url.pathname.startsWith(`${basePath}/document/`)) {
        const relativePath = decodeURIComponent(url.pathname.slice(`${basePath}/document/`.length));
        const localPath = path.resolve(documentDir, relativePath);
        if (!isWithin(documentDir, localPath)) {
          response.writeHead(403).end('Outside document directory');
          return;
        }
        await sendFile(response, localPath);
        return;
      }

      if (decodedPathname.startsWith(`${basePath}/fs/`)) {
        const virtualPath = decodedPathname.slice(`${basePath}/fs/`.length);
        await sendFile(response, localPathFromVirtual(virtualPath));
        return;
      }

      const assetPrefix = `${basePath}/`;
      if (url.pathname.startsWith(assetPrefix)) {
        const relativePath = decodeURIComponent(url.pathname.slice(assetPrefix.length));
        const localPath = path.resolve(cliAssetDir, relativePath);
        if (!isWithin(cliAssetDir, localPath)) {
          response.writeHead(403).end('Outside asset directory');
          return;
        }
        await sendFile(response, localPath);
        return;
      }

      response.writeHead(404).end('Not found');
    } catch {
      response.writeHead(500).end('Internal server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to determine renderer server address');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    pageUrl: `${origin}${rendererPath}`,
    documentBaseUrl: `${origin}${basePath}/fs/${virtualDirectory}`,
    fileReadUrl: `${origin}${basePath}/file`,
    resourceBaseUrl: `${origin}${basePath}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── `documd serve`: loopback editing server ─────────────────────────────────

function serveMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  // The extension only injects on text/plain responses whose URL ends in a
  // Markdown extension; the generic table maps .md to octet-stream, so the
  // editable text types are overridden here.
  if (SERVE_TEXT_EXTENSIONS.has(extension)) return 'text/plain; charset=utf-8';
  return mimeType(filePath);
}

function validateServeToken(token) {
  if (typeof token !== 'string' || token.length < 8 || /[/?#\s]/.test(token)) {
    throw new Error('--token must be at least 8 characters and contain no "/", "?", "#" or whitespace');
  }
  return token;
}

// DNS rebinding wall: a browser pointed at a rebinding name still sends that
// name in the Host header, so every fs-touching request must present a loopback
// host naming the real listening port.
function isAllowedServeHost(hostHeader, actualPort) {
  if (!hostHeader) return false;
  let parsed;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  // WHATWG URL already strips IPv6 brackets from hostname; the replace is
  // belt-and-braces for runtimes that keep them.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!SERVE_ALLOWED_HOSTS.has(hostname)) return false;
  // An empty port means the scheme default; an explicit port must match.
  if (parsed.port !== '' && Number(parsed.port) !== actualPort) return false;
  return true;
}

function sha256Etag(buffer) {
  return `"${crypto.createHash('sha256').update(buffer).digest('hex')}"`;
}

// Event-style body collection (no async iteration) to stay within the fibjs
// node:http compatibility surface. Oversized bodies reject; the caller sends
// 413 before destroying the socket, so a chunked upload past the limit is never
// fully buffered and the client still receives the status line.
function collectRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error('Request body exceeds the size limit');
        error.code = 'MV_BODY_TOO_LARGE';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * `documd serve` server: loopback-only static hosting with same-origin PUT
 * write-back for the browser extension's source editor.
 *
 * Defence in depth, in request order:
 *   1. bind 127.0.0.1 only — the socket is unreachable off the machine;
 *   2. Host header allow-list — DNS rebinding replies carry a foreign Host;
 *   3. random token path prefix — the sole request credential;
 *   4. isWithin() root confinement — traversal attempts never reach fs writes;
 *   5. PUT targets must already be regular files — the route cannot create files.
 * Writes are same-directory tmp+rename, so a failed save never leaves a partial
 * target file. Exported for tests and never imports playwright.
 */
export async function createServeServer(rootDir, options = {}) {
  const absoluteRoot = path.resolve(rootDir);
  const token = options.token
    ? validateServeToken(options.token)
    : crypto.randomBytes(18).toString('hex');
  const maxBodyMb = options.maxBodyMb ?? SERVE_DEFAULT_MAX_BODY_MB;
  const maxBodyBytes = maxBodyMb * 1024 * 1024;
  const requestedPort = options.port ?? SERVE_DEFAULT_PORT;
  const basePath = `/__documd/${token}`;
  const securityHeaders = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  let listeningPort = requestedPort;

  async function handleGetOrHead(request, response, method, localPath, stats) {
    const data = await fs.readFile(localPath);
    const etag = sha256Etag(data);
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch) {
      const candidates = ifNoneMatch.split(',').map((value) => value.trim());
      if (candidates.includes(etag) || candidates.includes('*')) {
        response.writeHead(304, {
          ...securityHeaders,
          etag,
          'last-modified': stats.mtime.toUTCString(),
        });
        response.end();
        return;
      }
    }
    response.writeHead(200, {
      ...securityHeaders,
      'content-type': serveMimeType(localPath),
      etag,
      'last-modified': stats.mtime.toUTCString(),
      'content-length': String(data.length),
    });
    // HEAD keeps the full headers but never sends the body.
    response.end(method === 'HEAD' ? undefined : data);
  }

  // Refuse a request whose body must not be consumed (wrong type, too large).
  // The response is flushed before the socket is torn down with destroySoon():
  // an immediate destroy() on Windows sends RST while the response is still in
  // the socket receive buffer, so the client would see a reset instead of the
  // status line.
  function refuseAndClose(response, request, status, message) {
    response.writeHead(status, { ...securityHeaders, connection: 'close' });
    response.end(message, () => {
      request.socket?.destroySoon();
    });
  }

  async function handlePut(request, response, localPath) {
    // Missing Content-Type is accepted (curl-style clients); any present type
    // must be text/*. Binary overwrites are refused before the body is buffered.
    const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('text/')) {
      refuseAndClose(response, request, 415, 'Unsupported media type');
      return;
    }

    // Content-Length lets a declared-oversized upload fail without reading a byte.
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        refuseAndClose(response, request, 413, 'Payload too large');
        return;
      }
    }

    let body;
    try {
      body = await collectRequestBody(request, maxBodyBytes);
    } catch (error) {
      if (error?.code === 'MV_BODY_TOO_LARGE') {
        if (!response.headersSent) {
          refuseAndClose(response, request, 413, 'Payload too large');
        }
        return;
      }
      throw error;
    }

    // Optimistic concurrency: If-Match carries the ETag the editor last read.
    // A mismatch fails with 412 and the disk is not touched. No If-Match means
    // an unconditional overwrite (the user-confirmed conflict path).
    const currentData = await fs.readFile(localPath);
    const currentEtag = sha256Etag(currentData);
    const ifMatch = request.headers['if-match'];
    if (ifMatch !== undefined) {
      const candidates = ifMatch.split(',').map((value) => value.trim());
      if (!candidates.includes('*') && !candidates.includes(currentEtag)) {
        response.writeHead(412, { ...securityHeaders, etag: currentEtag });
        response.end('Precondition failed');
        return;
      }
    }

    // Same-directory temp file: a cross-volume rename is not atomic on Windows,
    // and the editor's abort invariant maps to "target file never half-written".
    const tmpName = `.${path.basename(localPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tmpPath = path.join(path.dirname(localPath), tmpName);
    try {
      await fs.writeFile(tmpPath, body);
      await fs.rename(tmpPath, localPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }

    response.writeHead(204, { ...securityHeaders, etag: sha256Etag(body) });
    response.end();
  }

  async function handleServeRequest(request, response) {
    const method = (request.method || 'GET').toUpperCase();

    // Same-origin PUT never triggers a CORS preflight, but answer OPTIONS so a
    // manual probe gets a clean 204 instead of a 405.
    if (method === 'OPTIONS') {
      response.writeHead(204, securityHeaders);
      response.end();
      return;
    }
    if (!SERVE_METHODS.has(method)) {
      response.writeHead(405, { ...securityHeaders, allow: 'GET, HEAD, PUT, OPTIONS' });
      response.end('Method not allowed');
      return;
    }

    // Host check precedes the token check: a forged Host learns nothing.
    if (!isAllowedServeHost(request.headers.host, listeningPort)) {
      response.writeHead(403, securityHeaders);
      response.end('Forbidden host');
      return;
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404, securityHeaders);
      response.end('Not found');
      return;
    }

    // WHATWG URL normalisation already collapses plain "/../" segments (they
    // lose the token prefix and 404 above); encoded traversal survives to here
    // and is caught by the lexical root-confinement check.
    const relativePath = decodeURIComponent(url.pathname.slice(basePath.length + 1));
    const localPath = path.resolve(absoluteRoot, relativePath);
    if (!isWithin(absoluteRoot, localPath)) {
      response.writeHead(403, securityHeaders);
      response.end('Outside served root');
      return;
    }

    let stats;
    try {
      stats = await fs.stat(localPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        response.writeHead(404, securityHeaders);
        response.end('Not found');
        return;
      }
      throw error;
    }
    // No directory listings: directories and special files read as 404, and
    // PUT cannot create a missing file.
    if (!stats.isFile()) {
      response.writeHead(404, securityHeaders);
      response.end('Not found');
      return;
    }

    if (method === 'PUT') {
      await handlePut(request, response, localPath);
      return;
    }
    await handleGetOrHead(request, response, method, localPath, stats);
  }

  const server = http.createServer((request, response) => {
    handleServeRequest(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, securityHeaders);
      response.end('Internal server error');
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `Port ${requestedPort} is already in use; choose another with --port (or --port 0 for a random port)`,
      );
    }
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to determine serve server address');
  }
  listeningPort = address.port;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    basePath,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * `documd serve` process entry: validate the root, start the loopback server
 * and hold the process open until SIGINT/SIGTERM. No browser is launched.
 */
export async function runServe(options) {
  const root = path.resolve(options.serveRoot || '.');
  let stats;
  try {
    stats = await fs.stat(root);
  } catch {
    throw new Error(`serve root does not exist: ${root}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`serve root is not a directory: ${root}`);
  }

  const server = await createServeServer(root, {
    port: options.servePort,
    token: options.serveToken,
    maxBodyMb: options.serveMaxBodyMb,
  });

  // The token is a credential: it appears in this one local startup banner so
  // the URLs are clickable, but it is never written into error messages.
  process.stdout.write(`Serving Markdown directory: ${root}\n`);
  process.stdout.write('Loopback URL (contains the access token, keep it local):\n');
  process.stdout.write(`  ${server.origin}${server.basePath}/\n`);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const documents = entries
    .filter((entry) => entry.isFile() && SERVE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
  if (documents.length > 0) {
    process.stdout.write('Documents:\n');
    for (const entry of documents) {
      process.stdout.write(`  ${server.origin}${server.basePath}/${encodeURI(entry.name)}\n`);
    }
  }
  process.stdout.write('Press Ctrl+C to stop.\n');

  let closing = false;
  const onSignal = () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    server
      .close()
      .then(() => process.stdout.write('\nServer stopped.\n'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Render timed out after ${timeoutMs / 1000} seconds`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ── Browser launch ──────────────────────────────────────────────────────────
 *
 * Every export drives the same headless Chromium, so the launch lives here
 * once and the export functions only ask for a browser.
 *
 * Which browser, in order: the Playwright-bundled Chromium (a headless build
 * that needs no GUI session and no system install — the one that starts in
 * containers and sandboxes), then the installed Chrome. `--chrome <path>`
 * (or DOCUMD_CHROME_PATH) replaces both with one explicit binary.
 *
 * Sandbox: none. Chromium starts sandboxless (`--no-sandbox`), because its own
 * sandbox cannot nest inside the environments documd runs in — macOS Seatbelt
 * (boxsh), containers, root on Linux — where the kernel refuses to install it a
 * second time (`deny forbidden-sandbox-reinit`) and the browser either aborts
 * while starting ("GPU process isn't usable. Goodbye", "bootstrap_check_in ...
 * Permission denied") or starts and then cannot draw a page
 * ("browser.newPage: Target crashed"). Paying for a doomed attempt first would
 * only delay every export there, so the browser starts sandboxless and the
 * isolation is whatever the surrounding environment provides.
 *
 * Flags: DOCUMD_CHROME_ARGS (whitespace separated) first, then every
 * --browser-arg.
 */
const CHROME_PATH_ENV = 'DOCUMD_CHROME_PATH';
const CHROME_ARGS_ENV = 'DOCUMD_CHROME_ARGS';
const NO_SANDBOX_FLAG = '--no-sandbox';
/**
 * Per-attempt budget for starting the browser. A browser that cannot start
 * aborts at once; this only bounds one that hangs before it answers.
 */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

/** `--chrome` wins over DOCUMD_CHROME_PATH; both replace the default browsers. */
export function resolveChromePath(options, env = process.env) {
  const requested = options.chromePath || env[CHROME_PATH_ENV];
  return requested ? path.resolve(requested) : '';
}

/** Extra Chromium flags: DOCUMD_CHROME_ARGS first, then every --browser-arg. */
export function extraBrowserArgs(options, env = process.env) {
  const fromEnv = String(env[CHROME_ARGS_ENV] || '').trim();
  return [
    ...(fromEnv ? fromEnv.split(/\s+/) : []),
    ...(options.browserArgs || []),
  ];
}

/**
 * Launch attempts for this run, in order, as `{ label, options }` pairs that go
 * straight into `chromium.launch()`: one per candidate browser, each started
 * headless and sandboxless. `chromiumSandbox` is deliberately never set —
 * Playwright's default leaves Chromium's sandbox off, and documd passes
 * `--no-sandbox` itself so the behaviour cannot drift with a Playwright update.
 */
export function browserLaunchPlan(options, env = process.env) {
  const executablePath = resolveChromePath(options, env);
  const args = extraBrowserArgs(options, env);
  if (!args.includes(NO_SANDBOX_FLAG)) {
    args.push(NO_SANDBOX_FLAG);
  }
  const browsers = executablePath
    ? [{ label: executablePath, options: { executablePath } }]
    : [
      { label: 'bundled Chromium', options: {} },
      { label: 'installed Chrome', options: { channel: 'chrome' } },
    ];

  return browsers.map((browser) => ({
    label: browser.label,
    options: { headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS, args, ...browser.options },
  }));
}

/** A browser that simply is not installed here — a normal fallback, not news. */
const BROWSER_MISSING = /Executable doesn't exist|is not installed|playwright install|ENOENT/i;

function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').map((line) => line.trim()).find(Boolean) || 'unknown error';
}

/**
 * A browser can start and still be unusable. Chromium's sandbox re-entering the
 * kernel's (`deny forbidden-sandbox-reinit`) kills the renderer and helper
 * processes: `chromium.launch()` succeeds and the browser keeps answering CDP,
 * but the first page fails with "browser.newPage: Target crashed". Documd starts
 * sandboxless so that does not happen, and this check turns any other broken
 * browser into a clear error here instead of a crash three steps into an
 * export — and is what makes the fallback to the next browser reachable.
 */
async function assertBrowserCanRender(browser) {
  const page = await withTimeout(browser.newPage(), BROWSER_LAUNCH_TIMEOUT_MS);
  try {
    await withTimeout(
      page.setContent('<!doctype html><title>documd browser check</title>'),
      BROWSER_LAUNCH_TIMEOUT_MS,
    );
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Launch the first browser of the plan that starts *and renders*. A browser
 * that cannot run here is explained on stderr before the next one is tried; one
 * that is merely absent stays quiet, because falling back to the installed
 * Chrome is the normal path for a CLI install.
 *
 * `launch` is injectable so the ladder can be tested without a browser.
 */
export async function launchBrowser(options, { launch = (launchOptions) => chromium.launch(launchOptions) } = {}) {
  const attempts = browserLaunchPlan(options);
  let lastError;
  for (const [index, attempt] of attempts.entries()) {
    const next = attempts[index + 1];
    let browser;
    let started = false;
    try {
      browser = await launch(attempt.options);
      started = true;
      await assertBrowserCanRender(browser);
      return browser;
    } catch (error) {
      lastError = error;
      // A browser that cannot render can also fail to close; the next attempt
      // must not be held up by it.
      await browser?.close().catch(() => {});
      if (next && !BROWSER_MISSING.test(firstLine(error))) {
        const stage = started ? 'started but cannot render' : 'failed to start';
        console.warn(`documd: ${attempt.label} ${stage} (${firstLine(error)}); falling back to ${next.label}`);
      }
    }
  }
  throw new Error([
    `Could not run a browser (tried ${attempts.map((attempt) => attempt.label).join(', ')}).`,
    firstLine(lastError),
    'Install the bundled browser ("npx playwright install chromium"), install Chrome, or pass --chrome <path>.',
  ].join('\n'));
}

/**
 * ── Printing ────────────────────────────────────────────────────────────────
 *
 * Playwright prints through the CDP *stream* transfer: Chromium writes the PDF
 * into a temporary file in the OS user temp directory (NSTemporaryDirectory(),
 * i.e. /private/var/folders/... on macOS — $TMPDIR is ignored there) and
 * Playwright reads those bytes back with IO.read. That file is the only part
 * of an export that needs write access to the *host* temp directory, which is
 * exactly what a macOS Seatbelt sandbox (or a locked-down container) denies:
 * rendering, HTML export and screenshots keep working while page.pdf() fails
 * with "Protocol error (IO.read): Read failed".
 *
 * The same command can hand the document back inline over CDP instead
 * (`transferMode: 'ReturnAsBase64'`), with the parameters Playwright itself
 * sends so the printed document is identical; page.pdf() stays the fallback
 * for a document large enough to hit the protocol's message size limit.
 */
const PLAYWRIGHT_PDF_OPTIONS = { printBackground: true, preferCSSPageSize: true };
const PDF_PRINT_PARAMS = {
  transferMode: 'ReturnAsBase64',
  landscape: false,
  displayHeaderFooter: false,
  headerTemplate: '',
  footerTemplate: '',
  printBackground: true,
  scale: 1,
  paperWidth: 8.5,
  paperHeight: 11,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
  pageRanges: '',
  preferCSSPageSize: true,
  generateTaggedPDF: false,
  generateDocumentOutline: false,
};

/** Print the current page to PDF bytes (inline CDP transfer, page.pdf() fallback). */
export async function printPageToPdf(page, timeoutMs) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const result = await withTimeout(session.send('Page.printToPDF', PDF_PRINT_PARAMS), timeoutMs);
      if (typeof result?.data === 'string' && result.data.length > 0) {
        return Buffer.from(result.data, 'base64');
      }
      console.warn('documd: the browser returned no inline PDF data; printing through Playwright instead');
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (error) {
    console.warn(`documd: inline PDF transfer failed (${firstLine(error)}); printing through Playwright instead`);
  }
  return withTimeout(page.pdf(PLAYWRIGHT_PDF_OPTIONS), timeoutMs);
}

/**
 * Structured render diagnostics of the last render in this page (which engine
 * failed, on which markdown line, and why). The page records them next to the
 * console warnings it already prints, so a batch export can report failures
 * instead of only logging them.
 */
async function readPageDiagnostics(page) {
  try {
    return await page.evaluate(() =>
      typeof window.markdownCli?.diagnostics === 'function' ? window.markdownCli.diagnostics() : [],
    );
  } catch {
    return [];
  }
}

export async function renderMarkdownFile(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, options.format);
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.render === 'function');

    const html = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.render(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, html, 'utf8');
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Full-page PNG screenshot of the rendered document — the viewer card with its
 * page / code / blockquote / table backgrounds captured as they look on screen,
 * so a theme or visual audit needs no separate browser screenshot step.
 */
export async function exportMarkdownPng(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'png');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({
      viewport: { width: options.pngWidth || 1180, height: 1200 },
      deviceScaleFactor: options.pngScale || 2,
    });
    const browserErrors = [];
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.snapshotDom === 'function');

    await withTimeout(page.evaluate((request) => {
      return window.markdownCli.snapshotDom(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    // The renderer page shell pins body to the viewport (height:100vh,
    // overflow:hidden) for the live app; relax it so a full-page screenshot
    // captures the whole card, with a vertical gutter so the page background
    // reads distinctly from the frame surface.
    await page.evaluate(() => {
      const body = document.body;
      body.style.height = 'auto';
      body.style.minHeight = '100vh';
      body.style.overflow = 'visible';
      body.style.padding = '32px 0';
    });

    const png = await withTimeout(page.screenshot({ fullPage: true, type: 'png' }), options.timeoutMs);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, png);
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function snapshotMarkdownFile(options) {
  const inputPath = path.resolve(options.input);
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.snapshotDom === 'function');

    return await withTimeout(page.evaluate((request) => {
      return window.markdownCli.snapshotDom(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);
  } finally {
    await browser?.close();
    await server.close();
  }
}

function base64ToBuffer(base64) {
  // The page serializes bytes with String.fromCharCode, so the base64 payload
  // must be decoded as latin1 to recover the original binary bytes.
  return Buffer.from(Buffer.from(base64, 'base64').toString('latin1'), 'binary');
}

/**
 * Run the REAL single-document EPUB export pipeline (same code path as the
 * extension: HTML staticizing -> collectEpubCss -> JSZip packaging) and write
 * the generated .epub to disk.
 */
export async function exportMarkdownEpub(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'epub');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderEpub === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderEpub(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, filename: result.filename, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Render a diagram source file (PlantUML / Mermaid / DOT / Vega / ...) to
 * SVG, PNG or DrawIO XML through the shared renderer registry.
 */
export async function exportMarkdownDiagram(options) {
  const inputPath = path.resolve(options.input);
  const diagramType = options.diagramType || inferDiagramType(inputPath);
  if (!diagramType) {
    throw new Error(`Cannot infer a diagram renderer from ${inputPath}; use --diagram-type`);
  }
  const format = options.format || 'svg';
  const content = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderDiagram === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderDiagram(request);
    }, {
      diagramType,
      content,
      theme: options.theme || 'default',
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const ext = format === 'png' ? '.png' : format === 'drawio' ? '.drawio' : '.svg';
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + ext);

    await ensureOutputDirectory(outputPath);
    if (format === 'png') {
      if (!result.pngBase64) {
        throw new Error(`Diagram type "${diagramType}" produced no PNG`);
      }
      await fs.writeFile(outputPath, Buffer.from(result.pngBase64, 'base64'));
    } else if (format === 'drawio') {
      if (!result.drawioXml) {
        throw new Error(`Diagram type "${diagramType}" does not produce DrawIO XML (PlantUML only)`);
      }
      await fs.writeFile(outputPath, result.drawioXml, 'utf8');
    } else {
      if (!result.svg) {
        if (result.pngBase64) {
          throw new Error(`Diagram type "${diagramType}" produces PNG only; use --format png (or an output ending in .png)`);
        }
        throw new Error(`Diagram type "${diagramType}" produced no SVG`);
      }
      await fs.writeFile(outputPath, result.svg, 'utf8');
    }
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * ── Asset export (--assets) ─────────────────────────────────────────────────
 *
 * The figures and images of a Markdown document, written as files. The page
 * walks its own rendered DOM (see collectAssets in src/cli/browser-renderer.ts)
 * so each figure keeps the engine that drew it, the markdown line it came from
 * and the payload the reader actually sees; images are copied from their source
 * resource, never re-encoded. Nothing is re-parsed from the markdown here — the
 * export copies what the real pipeline produced.
 */

const ASSET_CONTENT_TYPE_EXTENSIONS = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
};

const ASSET_IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
]);

function sanitizeFileStem(value, fallback = 'asset') {
  const stem = String(value || '')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || fallback;
}

/** Original file name of an image asset, derived from the URL it was read from. */
function assetSourceName(asset) {
  const src = asset.src || '';
  try {
    const base = path.basename(new URL(src).pathname);
    if (base) return decodeURIComponent(base);
  } catch {
    const base = path.basename(src.split(/[?#]/)[0] || '');
    if (base) return base;
  }
  return 'image';
}

function assetImageExtension(asset) {
  const fromContentType = ASSET_CONTENT_TYPE_EXTENSIONS[String(asset.contentType || '').toLowerCase()];
  if (fromContentType) return fromContentType;
  const fromUrl = path.extname(assetSourceName(asset)).toLowerCase();
  return ASSET_IMAGE_EXTENSIONS.has(fromUrl) ? fromUrl : '.bin';
}

/**
 * File name for an exported asset: `<document>-<number>-<label>.<ext>`.
 *
 * The number is the document-order index the report prints, so a file name and
 * a report row always name the same asset, with or without --only.
 */
export function assetFileName(asset, options) {
  const documentStem = sanitizeFileStem(options.documentBase, 'document');
  const number = String(asset.index).padStart(2, '0');
  if (asset.kind === 'diagram') {
    const label = sanitizeFileStem(asset.type, 'diagram');
    const extension = options.diagramFormat === 'svg' ? 'svg' : 'png';
    return `${documentStem}-${number}-${label}.${extension}`;
  }
  return `${documentStem}-${number}-${sanitizeFileStem(assetSourceName(asset), 'image')}${assetImageExtension(asset)}`;
}

function assetBytes(asset) {
  if (asset.svg !== undefined) return Buffer.from(asset.svg, 'utf8');
  if (asset.pngBase64 !== undefined) return Buffer.from(asset.pngBase64, 'base64');
  if (asset.imageBase64 !== undefined) return Buffer.from(asset.imageBase64, 'base64');
  return null;
}

function selectedAssets(assets, options) {
  if (!options.onlyIndexes) return assets;
  return assets.filter((asset) => options.onlyIndexes.has(asset.index));
}

function assetKindLabel(asset) {
  return asset.kind === 'diagram' ? 'diagram' : 'image';
}

function assetLabel(asset) {
  return asset.kind === 'diagram' ? asset.type || 'diagram' : assetSourceName(asset);
}

/**
 * Console report of one asset export: every asset in document order, marked as
 * written, failed or skipped (`--only`), so the numbers the report shows can be
 * fed straight back into `--only`.
 */
export function formatAssetReport(assets, written, options) {
  const documentName = path.basename(options.input || 'document');
  const diagramCount = assets.filter((asset) => asset.kind === 'diagram').length;
  const imageCount = assets.length - diagramCount;
  const lines = [
    `${documentName}: ${diagramCount} diagram${diagramCount === 1 ? '' : 's'}, ${imageCount} image${imageCount === 1 ? '' : 's'} (${assets.length} asset${assets.length === 1 ? '' : 's'})`,
  ];

  const writtenNames = new Map(written.map((entry) => [entry.assetIndex, entry.fileName]));
  const numberWidth = Math.max(String(assets.length).length, 1);
  const kindWidth = Math.max(...assets.map((asset) => assetKindLabel(asset).length), 5);
  const labelWidth = Math.max(...assets.map((asset) => assetLabel(asset).length), 5);
  const lineTexts = assets.map((asset) =>
    typeof asset.line === 'number' ? `line ${asset.line}` : '',
  );
  const lineWidth = Math.max(...lineTexts.map((text) => text.length), 0);
  for (const [position, asset] of assets.entries()) {
    const cells = [String(asset.index).padStart(numberWidth), assetKindLabel(asset).padEnd(kindWidth), assetLabel(asset).padEnd(labelWidth)];
    if (lineWidth > 0) {
      cells.push(lineTexts[position].padEnd(lineWidth));
    }
    let outcome;
    if (asset.error) {
      outcome = `failed: ${asset.error.replace(/\s+/g, ' ').slice(0, 120)}`;
    } else if (writtenNames.has(asset.index)) {
      outcome = `-> ${writtenNames.get(asset.index)}`;
    } else {
      outcome = 'skipped';
    }
    lines.push(`  ${cells.join('  ')}  ${outcome}`);
  }
  return lines.join('\n');
}

/**
 * Render a Markdown document and export its figures and images into
 * `--assets <dir>`. Returns the collected assets, the files written and the
 * render diagnostics, so the caller can report and decide on the exit code.
 */
export async function exportMarkdownAssets(options) {
  const inputPath = path.resolve(options.input);
  const markdown = await fs.readFile(inputPath, 'utf8');
  const assetDirectory = path.resolve(options.assetsDir);
  const diagramFormat = ASSET_DIAGRAM_FORMATS.includes(options.format) ? options.format : 'png';

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Same console collection as the document exports: page-side render
    // problems are concise warnings, never stack-trace dumps.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.collectAssets === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.collectAssets(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
      kinds: options.assetKind === 'diagrams' ? ['diagram'] : options.assetKind === 'images' ? ['image'] : ['diagram', 'image'],
      diagramFormat,
    }), options.timeoutMs);

    const written = [];
    for (const asset of selectedAssets(result.assets, options)) {
      if (asset.error) continue;
      const bytes = assetBytes(asset);
      if (!bytes) {
        asset.error = 'no payload was produced for this asset';
        continue;
      }
      await fs.mkdir(assetDirectory, { recursive: true });
      const fileName = assetFileName(asset, {
        documentBase: path.parse(inputPath).name,
        diagramFormat,
      });
      await fs.writeFile(path.join(assetDirectory, fileName), bytes);
      written.push({ assetIndex: asset.index, fileName, filePath: path.join(assetDirectory, fileName) });
    }

    return {
      inputPath,
      assetDirectory,
      assets: result.assets,
      written,
      diagnostics: result.diagnostics || [],
      browserErrors,
    };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Run the REAL DOCX export pipeline (DocxExporter on the raw markdown) and
 * write the generated .docx to disk.
 */
export async function exportMarkdownDocx(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'docx');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderDocx === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderDocx(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Whole-book export: parse the SUMMARY.md pages and run the real book
 * pipeline (book-renderer + exportToEpub / exportBookToDocx).
 */
export async function exportMarkdownBook(options) {
  const inputPath = path.resolve(options.input);
  const summaryDir = path.dirname(inputPath);
  const summaryContent = await fs.readFile(inputPath, 'utf8');
  const pages = parseSummaryPages(summaryContent, '');
  if (pages.length === 0) {
    throw new Error(`No book pages found in ${inputPath}`);
  }
  const bookTitle = options.title || path.basename(summaryDir) || 'Book';

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(summaryDir);
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    const apiName = options.format === 'epub' ? 'renderBookEpub' : 'renderBookDocx';
    await page.waitForFunction((name) => typeof window.markdownCli?.[name] === 'function', apiName);

    const result = await withTimeout(page.evaluate((request) => {
      const api = request.format === 'epub' ? window.markdownCli.renderBookEpub : window.markdownCli.renderBookDocx;
      return api(request);
    }, {
      markdown: '',
      filename: `${bookTitle}${options.format === 'epub' ? '.epub' : '.docx'}`,
      title: bookTitle,
      bookTitle,
      format: options.format,
      pages,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: summaryDir,
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const ext = options.format === 'epub' ? '.epub' : '.docx';
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(summaryDir, `${bookTitle}${ext}`);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

function doneMessage(action, outputPath) {
  return `${action} ${outputPath}`;
}

/**
 * Export a single markdown file to PDF through the headless Chromium print
 * pipeline (shared print styles from print-utils).
 */
export async function exportMarkdownPdf(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'pdf');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderPdf === 'function');

    await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderPdf(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const pdf = await printPageToPdf(page, options.timeoutMs);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, pdf);
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Whole-book PDF export: parse the SUMMARY.md pages, render the book into
 * #book-print-root and print it through headless Chromium.
 */
export async function exportMarkdownBookPdf(options) {
  const inputPath = path.resolve(options.input);
  const summaryDir = path.dirname(inputPath);
  const summaryContent = await fs.readFile(inputPath, 'utf8');
  const pages = parseSummaryPages(summaryContent, '');
  if (pages.length === 0) {
    throw new Error(`No book pages found in ${inputPath}`);
  }
  const bookTitle = options.title || path.basename(summaryDir) || 'Book';

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(summaryDir);
  let browser;
  try {
    browser = await launchBrowser(options);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderBookPdf === 'function');

    await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderBookPdf(request);
    }, {
      markdown: '',
      filename: `${bookTitle}.pdf`,
      title: bookTitle,
      pages,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: summaryDir,
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const pdf = await printPageToPdf(page, options.timeoutMs);
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(summaryDir, `${bookTitle}.pdf`);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, pdf);
    return { outputPath, browserErrors, diagnostics: await readPageDiagnostics(page) };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Console lines that the structured diagnostics already report. Printing them
 * twice would make one failed diagram look like two.
 */
const MIRRORED_CONSOLE_WARNING = /^\[(?:PluginTask|TaskManager)\]\s/;

function printBrowserMessages(browserErrors) {
  for (const warning of browserErrors || []) {
    if (MIRRORED_CONSOLE_WARNING.test(warning)) continue;
    console.warn(`[browser] ${warning}`);
  }
}

/**
 * Report the render errors of a conversion (stdout stays the machine-readable
 * channel — file paths, asset tables — while problems go to stderr).
 *
 * @param diagnostics - Structured diagnostics of the render
 * @param skipBlockIds - Blocks already reported by another section of the run
 * @returns Number of errors reported
 */
function printRenderErrors(diagnostics, skipBlockIds) {
  const errors = (diagnostics || []).filter(
    (diagnostic) => diagnostic.level === 'error' && !(skipBlockIds && skipBlockIds.has(diagnostic.blockId || '')),
  );
  if (errors.length === 0) {
    return 0;
  }
  console.warn(`Render errors (${errors.length}):`);
  for (const diagnostic of errors) {
    const where = typeof diagnostic.line === 'number'
      ? `line ${diagnostic.line}`
      : diagnostic.blockId || 'unknown location';
    console.warn(`  ${where}  ${diagnostic.type || 'diagram'}  ${diagnostic.message}`);
  }
  return errors.length;
}

/**
 * Diagram render failures are a failure of the run: the export is written (the
 * document keeps an error block where the figure should be), but the exit code
 * says the document is not what it looks like. `--no-fail-on-error` relaxes it
 * for pipelines that only want the report.
 */
function applyFailOnError(failureCount, options) {
  if (failureCount === 0 || !options.failOnError) {
    return;
  }
  console.error(`documd: ${failureCount} render error${failureCount === 1 ? '' : 's'}; pass --no-fail-on-error to export anyway`);
  process.exitCode = 1;
}

/** Shared tail of every document export: warnings, error report, then the path. */
function finishExport(action, result, options) {
  printBrowserMessages(result.browserErrors);
  const failures = printRenderErrors(result.diagnostics);
  console.log(doneMessage(action, result.outputPath));
  applyFailOnError(failures, options);
}

/** Shared tail of `--assets`: the asset table is the report of that mode. */
function finishAssetExport(result, options) {
  printBrowserMessages(result.browserErrors);
  console.log(formatAssetReport(result.assets, result.written, options));

  const selected = selectedAssets(result.assets, options);
  const failed = selected.filter((asset) => asset.error);
  // Failures already visible in the table stay out of the diagnostic report;
  // problems that left no asset behind (e.g. a block that vanished entirely)
  // still get reported, so nothing fails silently.
  const reportedBlockIds = new Set(failed.map((asset) => asset.blockId).filter(Boolean));
  const extraFailures = printRenderErrors(result.diagnostics, reportedBlockIds);

  if (failed.length > 0) {
    console.error(`${failed.length} of ${selected.length} selected asset${selected.length === 1 ? '' : 's'} could not be exported`);
  }
  console.log(
    `Exported ${result.written.length} asset${result.written.length === 1 ? '' : 's'} to ${result.assetDirectory}`,
  );
  applyFailOnError(failed.length + extraFailures, options);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.version) {
      process.stdout.write(`documd v${CLI_VERSION} — ${CLI_HOMEPAGE}\n`);
      return;
    }
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    // `documd serve` is a long-running loopback server with its own banner and
    // no browser launch; it bypasses the export pipeline entirely.
    if (options.serve) {
      await runServe(options);
      return;
    }
    // Startup banner: the version and homepage are shown when the CLI starts
    // (--version/--help print their own header); the completion message below
    // stays a clean "Rendered/Exported <path>".
    process.stdout.write(`documd v${CLI_VERSION} — ${CLI_HOMEPAGE}\n`);
    if (options.assetsDir) {
      finishAssetExport(await exportMarkdownAssets(options), options);
      return;
    }
    if (options.bookMode) {
      if (options.format === 'pdf') {
        finishExport('Exported', await exportMarkdownBookPdf(options), options);
        return;
      }
      finishExport('Exported', await exportMarkdownBook(options), options);
      return;
    }
    if (options.format === 'pdf') {
      finishExport('Exported', await exportMarkdownPdf(options), options);
      return;
    }
    if (options.format === 'png' && !options.diagramMode) {
      finishExport('Rendered', await exportMarkdownPng(options), options);
      return;
    }
    if (options.diagramMode) {
      finishExport('Exported', await exportMarkdownDiagram(options), options);
      return;
    }
    if (options.format === 'docx') {
      finishExport('Exported', await exportMarkdownDocx(options), options);
      return;
    }
    if (options.format === 'epub') {
      finishExport('Exported', await exportMarkdownEpub(options), options);
      return;
    }
    finishExport('Rendered', await renderMarkdownFile(options), options);
  } catch (error) {
    console.error(`documd: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Only run as a CLI entry point when this file is the invoked script.
// Compare REAL paths: process.argv[1] keeps symlinks (e.g. macOS /tmp ->
// /private/tmp, pnpm/yarn stores, npm link), while import.meta.url is the
// resolved module path. A plain path.resolve() comparison silently skipped
// main() in those layouts and the CLI exited 0 without doing anything.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isEntry = false;
try {
  isEntry = realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  // Fall back to the plain comparison if realpath fails (e.g. missing file).
  isEntry = invokedPath === fileURLToPath(import.meta.url);
}
if (isEntry) await main();
