/**
 * Node-only contract entry.
 *
 * The suites imported here either install browser global shims (XMLHttpRequest,
 * Window, FileSystemFileHandle, DOMException) and rely on extensionless module
 * resolution, or require native Node HTTP behavior for a full 64 MiB request.
 * The fibjs compatibility runner cannot provide those conditions. They therefore
 * do NOT hang off test/suites/browser-contracts/index.js (the fibjs entry) and
 * run exclusively through `npm run test:contracts:node` on native Node.js + tsx.
 */
import '../source-file-writer.test.ts';
import '../loopback-file-watch.test.ts';
import './cli-serve-oversized.test.ts';
