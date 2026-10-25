type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Minimal structured JSON logger (one line per event, stdout). */
export function createLogger(service: string, level: Level = (process.env.LOG_LEVEL as Level) ?? 'info', base: Record<string, unknown> = {}): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min || process.env.NODE_ENV === 'test') return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, service, msg, ...base, ...fields });
    (lvl === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(service, level, { ...base, ...f }),
  };
}
