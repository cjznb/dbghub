/**
 * Minimal daemon fixture for DaemonClient auto-start tests.
 * Usage: node fake-daemon.mjs <socketPath>
 */
import { runDaemon } from '../../../src/daemon/daemon.mjs';

const socketPath = process.argv[2] || process.env.DBGHUB_SOCKET;
if (!socketPath) {
  process.stderr.write('fake-daemon: socket path required\n');
  process.exit(2);
}

const handlers = {
  echo: async (params) => ({ ok: true, echo: params }),
  whoami: async (_params, ctx) => ({ ok: true, clientId: ctx.clientId }),
};

const daemon = await runDaemon({ socketPath, handlers, idleExitMin: 0.05, idleCheckMs: 25 });
await daemon.whenClosed;
process.exit(0);
