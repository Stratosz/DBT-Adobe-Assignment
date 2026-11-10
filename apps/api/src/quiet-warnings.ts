// node:sqlite prints an ExperimentalWarning on load. It is expected; keep the logs clean.
// Must be imported before anything that loads node:sqlite.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
