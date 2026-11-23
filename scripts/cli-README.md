# documd

The official CLI of [docu.md Markdown Viewer](https://docu.md).

Render Markdown, diagrams and GitBook books to **HTML, EPUB, DOCX, PDF, SVG, PNG
and DrawIO** with headless Chromium — powered by the docu.md Markdown Viewer
engine (the same renderers and exporters as the browser extension).

- Website: <https://docu.md>
- Source: <https://github.com/markdown-viewer/markdown-viewer-extension>
- Issues: <https://github.com/markdown-viewer/markdown-viewer-extension/issues>

## Install

```bash
npm install -g @markdown-viewer/documd
```

## Version

```bash
documd --version
```

## Usage

```bash
documd <input> [<output>] [--format <f>] [options]
```

The output file is the second positional argument (pandoc style). Its
extension selects the format — when the input extension is a known input
format and the output extension is a known output format, documd infers
everything; otherwise it reports the unknown format and asks you to set
`--format` instead of guessing.

`--format` is inferred from the **output extension** when omitted:

- `notes.md out.epub` → epub, `notes.md out.pdf` → pdf, `flow.puml out.png` → png, …
- no output: markdown → html, diagram sources → svg, `--book` → epub

## Markdown documents

```bash
documd notes.md                      # notes.html
documd notes.md --format epub        # notes.epub
documd notes.md report.pdf           # PDF (inferred from the extension)
documd notes.md --format docx        # notes.docx
```

## Diagrams

```bash
documd flow.puml                     # flow.svg (PlantUML inferred)
documd chart.mmd chart.png           # Mermaid → PNG
documd flow.puml --format drawio     # PlantUML → DrawIO XML
```

Supported diagram sources:

| Extension | Renderer |
|---|---|
| .puml / .plantuml / .wsd | PlantUML (also produces DrawIO XML) |
| .mmd / .mermaid | Mermaid |
| .dot / .gv | Graphviz |
| .vega / .vl | Vega / Vega-Lite |
| .drawio | DrawIO |
| .echarts | ECharts |
| .svg | static SVG (passed through) |
| .infographic | Infographic |
| .canvas | Canvas |

## Whole books (GitBook SUMMARY.md)

```bash
documd SUMMARY.md --book                 # book.epub (default)
documd SUMMARY.md --book --format docx   # merged DOCX
documd SUMMARY.md --book --format pdf    # one page per chapter
```

## Loopback server (`documd serve`)

`serve` does not render anything. It is a long-running local file server that
backs the browser extension's in-place Markdown editing: the extension opens a
token-namespaced `http://127.0.0.1` URL, renders the text itself, and saves with
a same-origin `PUT`.

```bash
documd serve ./notes                     # http://127.0.0.1:4317, random token
documd serve ./notes --port 8080
documd serve ./notes --port 0            # pick any free port
documd serve ./notes --token "$MY_TOKEN" --max-body-mb 32
```

Startup prints the root, the loopback origin, and the full clickable URL of
each top-level text file. The token is printed once at startup and never again.

### URL and MIME model

Every route is namespaced under `/__documd/<token>/`, followed by the disk path
relative to the served root, so document URLs map one-to-one to files.
`.md`, `.markdown`, `.mdown`, `.mkd` and `.txt` are served as
`text/plain; charset=utf-8` (the extension's content detector requires it);
other extensions keep their normal MIME type, so relative images still render.
No HTML is generated and directory listings are not offered — a directory path
is a 404.

### Security model

| Layer | Rule |
|---|---|
| Bind address | Listens on `127.0.0.1` only; the port is never reachable from the LAN |
| Token namespace | A wrong or missing token is an indistinguishable 404; the default token is 36 random hex characters (144 bits) |
| Host check | Every request's `Host` must name a loopback interface with the actual listening port, checked before any filesystem access — this blocks DNS-rebinding |
| Root confinement | Percent-encoded separators are decoded, then the resolved target must stay inside the root; traversal is refused |
| Save channel | `PUT` only overwrites an **existing regular file**; it never creates files |
| Concurrency | `GET` carries a strong `sha256` `ETag`; `PUT` honours `If-Match` and answers `412` when the disk revision moved |
| Atomic writes | The body lands in a same-directory temp file and is renamed into place, so a crash cannot leave a half-written document |
| Referrer leakage | Every response carries `referrer-policy: no-referrer` and `cache-control: no-store` |

Status codes form a frozen contract: `204` (saved), `304` (ETag current),
`403` (bad host / outside root), `404` (no such file, directory, or token),
`405` (method other than GET/HEAD/PUT/OPTIONS), `412` (stale `If-Match`),
`413` (body over the limit), `415` (non-text `Content-Type`), `500`.

**Token URLs are bearer credentials.** Anyone who obtains the full URL can read
and overwrite the served files for the lifetime of the process. Browser history,
shared shell scrollback and synced tabs retain it: stop the server (Ctrl-C) when
done, and rely on the random token rather than passing a guessable `--token`.

### Exit behaviour

`0` on Ctrl-C / SIGTERM after the listening socket closes; `1` when the root is
not a directory, the port is already in use (the message suggests `--port 0`),
or another startup error occurs. Per-request errors are answered with the status
codes above and do not stop the process.

## Exporting figures and images

`--assets <dir>` writes the figures and images a Markdown document shows into
`<dir>` — the rendered result, not a re-parse of the source: each figure keeps
the engine that drew it, images are copied byte for byte.

```bash
documd report.md --assets ./figures                  # every figure and image
documd report.md --assets ./figures --kind diagrams  # figures only
documd report.md --assets ./figures --only 1,3       # select by number
documd report.md --assets ./figures --format svg     # figures as SVG, not PNG
```

The report lists every asset with the number `--only` takes back, its markdown
line and its outcome:

```
report.md: 2 diagrams, 1 image (3 assets)
  1  image    icon48.png  line 6   -> report-01-icon48.png
  2  diagram  mermaid     line 8   -> report-02-mermaid.png
  3  diagram  mermaid     line 15  skipped
```

Files are named `<document>-<number>-<label>.<ext>`, so a row and a file always
name the same asset. Numbering is document order, so `--only 2` selects the same
figure with or without other filters.

## Render errors and exit codes

A document whose figures or images fail to render is not the document it looks
like, so documd reports every failure with its markdown line, its type and the
engine's reason — and exits non-zero:

```
$ documd report.md report.docx
Render errors (2):
  line 11  mermaid  No diagram type detected matching given configuration for text: invalid syntax here
  line 15  image    Failed to fetch image: assets/missing.png - Unable to read resource (404): ...
Exported /path/report.docx
documd: 2 render errors; pass --no-fail-on-error to export anyway
```

The document is still written (a failed figure stays visible as an error block
in it), so the output always lets you see what went wrong. Pass
`--no-fail-on-error` when a pipeline only wants the report and not the failure,
e.g. when a missing optional image should not stop a batch conversion.

## Options

| Option | Description |
|---|---|
| `--format <f>` | html, epub, docx, pdf, svg, png, drawio (with `--assets`: png or svg figures) |
| `-b, --book` | Whole-book export (input: GitBook SUMMARY.md) |
| `--assets <dir>` | Export the document's figures and images into `<dir>` |
| `--kind <k>` | With `--assets`: all (default), diagrams, or images |
| `--only <list>` | With `--assets`: 1-based asset numbers, e.g. `1,3` |
| `--fail-on-error` | Exit non-zero when a figure or image fails (default) |
| `--no-fail-on-error` | Report render failures but still exit 0 |
| `--diagram-type <t>` | Diagram renderer override |
| `-t, --theme <id>` | Viewer theme id |
| `--title <text>` | Document title |
| `--language <code>` | Document language |
| `--frontmatter <mode>` | hide, table, raw |
| `--table-layout <mode>` | left, center, center-full-width |
| `--image-layout <mode>` | left, center |
| `--diagram-layout <mode>` | left, center |
| `--merge-empty-cells` | Merge empty table cells (on by default) |
| `--first-line-indent <n>` | First-line indent in characters, 0-4 (default 2) |
| `--merge-empty-cells` | Merge empty Markdown table cells |
| `--chrome <path>` | Explicit Chrome/Chromium binary (or `DOCUMD_CHROME_PATH`) |
| `--browser-arg <flag>` | Extra Chromium flag, repeatable (or `DOCUMD_CHROME_ARGS`) |
| `--timeout <seconds>` | Render timeout (default 120) |
| `--port <n>` | `serve`: TCP port, `0` = random free port (default 4317) |
| `--token <t>` | `serve`: URL namespace token (default: 36 random hex chars) |
| `--max-body-mb <n>` | `serve`: PUT body ceiling in MiB (default 64) |
| `-h, --help` | Show help |

## Browser

Every export runs in a headless Chromium. Which one, in order:

1. the binary given by `--chrome <path>` or `DOCUMD_CHROME_PATH`;
2. Playwright's bundled Chromium (`npx playwright install chromium`) — a
   headless build that needs no GUI session and no system install, so it is the
   one that starts in containers and sandboxes;
3. the installed Chrome (`channel: "chrome"`), for CLI installs that never
   fetched a Playwright browser.

The browser is started headless and **sandboxless** (`--no-sandbox`) — Chromium's
own sandbox cannot nest inside the environments documd runs in (see *Sandboxed
runs* below), so the isolation is whatever the surrounding environment provides.
PDFs are printed through the inline CDP transfer, so no host temp directory
write is needed either. Before an export starts, documd checks that the browser
it picked can actually draw a page; a browser that cannot is reported and the
next candidate is tried.

Extra Chromium flags: `--browser-arg <flag>` (repeatable) and
`DOCUMD_CHROME_ARGS` (whitespace separated), e.g.
`--browser-arg --font-render-hinting=none`.

## Sandboxed runs (CI, containers, macOS Seatbelt)

Running inside another sandbox changes two things:

- **Chromium's sandbox cannot nest.** In a macOS Seatbelt sandbox (e.g. boxsh),
  a container without the sandbox privileges, or as root on Linux, the kernel
  refuses to install Chromium's sandbox a second time
  (`deny forbidden-sandbox-reinit`). Two symptoms: the browser aborts while
  starting (`GPU process isn't usable. Goodbye`, `bootstrap_check_in …
  Permission denied`), or it starts and then cannot draw a page
  (`browser.newPage: Target crashed`), because the renderer is the process that
  re-enters the sandbox. documd therefore starts Chromium sandboxless from the
  start — no flag and no retry needed in these environments. A browser that
  still cannot render is reported on stderr and the next candidate (the
  installed Chrome) is tried.
- **The OS temp directory may be read-only.** The print stream Chromium writes
  for `page.pdf()` lands in the OS user temp directory (`/private/var/folders/…`
  on macOS — Chromium ignores `$TMPDIR`), which sandboxes refuse. documd
  transfers the PDF inline over CDP instead, so rendering, HTML export,
  screenshots *and* PDF all work without write access there (a document large
  enough to hit the protocol message size limit falls back to the stream path).

A GUI Chrome cannot start in a sandbox without a window server at all (it aborts
in `TransformProcessType`) — that is what the bundled headless Chromium above is
for.

## Notes

- Needs a browser: Playwright's bundled Chromium, or an installed Chrome. Pass
  `--chrome` to use a specific binary.
- **Documents are treated as untrusted input.** Markup written in a document is
  sanitized before it reaches the DOM (in an inert `<template>`, so nothing loads
  or runs while it is cleaned), and the page every export renders in carries a
  CSP without `'unsafe-inline'` scripts — so even a sanitizer gap cannot turn
  document markup into code. Inline styles and the diagram engines' remote fonts
  stay allowed, which is why styled HTML blocks and figures still render.
- Themes, fonts, code highlighting, math and layout settings mirror the
  docu.md Markdown Viewer extension.
- Report file paths go to stdout; warnings and render-error reports go to
  stderr, so a script can read the paths and let the failures print.
