export type Logger = {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

const logWith = (level: "debug" | "info" | "warn" | "error") =>
  (message: string, meta?: unknown) => {
    if (meta !== undefined) {
      // eslint-disable-next-line no-console
      console[level](message, meta);
      return;
    }
    // eslint-disable-next-line no-console
    console[level](message);
  };

export const consoleLogger: Logger = {
  debug: logWith("debug"),
  info: logWith("info"),
  warn: logWith("warn"),
  error: logWith("error"),
};
