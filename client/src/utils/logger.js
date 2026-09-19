// Tiny console facade so screens never call console.* directly (lint rule).
export const logger = {
  info: (...a) => { if (import.meta.env.DEV) console.warn('[info]', ...a); },
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
export default logger;
