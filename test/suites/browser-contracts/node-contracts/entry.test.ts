/**
 * Node-only contract entry.
 *
 * The suites imported here install browser global shims (XMLHttpRequest,
 * Window, FileSystemFileHandle, DOMException) and rely on extensionless
 * module resolution, neither of which the fibjs compatibility runner
 * provides. They therefore do NOT hang off test/suites/browser-contracts/
 * index.js (the fibjs entry) and run exclusively through
 * `npm run test:contracts:node` on a native Node.js + tsx process.
 *
 * The loopback file-watch contracts join this same entry in a later phase.
 */
import '../source-file-writer.test.ts';
