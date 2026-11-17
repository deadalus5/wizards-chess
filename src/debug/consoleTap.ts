// Keep the devtools overlay panel out of screenshots; the bridge still works.
(window as unknown as { __THREEJS_DEVTOOLS_NO_OVERLAY__: boolean }).__THREEJS_DEVTOOLS_NO_OVERLAY__ = true;

// Records warnings and errors so the test-browser helper (scripts/browser.mjs console) can read them.
const log: string[] = [];
(window as unknown as { __consoleLog: string[] }).__consoleLog = log;

const fmt = (args: unknown[]): string =>
  args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'object' ? safeJson(a) : String(a)))
    .join(' ')
    .slice(0, 1500);

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    log.push(`[${level}] ${fmt(args)}`);
    if (log.length > 200) log.shift();
    original(...args);
  };
}
addEventListener('error', (e) => log.push(`[uncaught] ${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => log.push(`[unhandled] ${fmt([e.reason])}`));

export {};
