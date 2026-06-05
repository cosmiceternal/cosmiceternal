// Tiny timestamped logger with a per-station tag.
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function makeLog(tag) {
  const prefix = tag ? `[${tag}]` : '';
  return {
    info: (...a) => console.log(ts(), prefix, ...a),
    warn: (...a) => console.warn(ts(), prefix, 'WARN', ...a),
    error: (...a) => console.error(ts(), prefix, 'ERROR', ...a),
  };
}

export const log = makeLog('');
