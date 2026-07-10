import pino from "pino";
import { config } from "./config";

/**
 * Build the pino logger.
 *
 * `pino-pretty` is a *dev* dependency (colorized human-readable logs) and is
 * intentionally absent from the production Docker image. If `LOG_PRETTY=true`
 * is set but the transport is missing, we silently fall back to plain JSON
 * logs instead of crashing — production must never depend on a dev-only tool.
 */
function buildLogger(): pino.Logger {
  const opts: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    base: undefined, // omit pid/hostname to reduce noise
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.LOG_PRETTY) {
    try {
      // Resolves to the transport only if the package is installed.
      require.resolve("pino-pretty");
      opts.transport = {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      };
    } catch {
      // pino-pretty not installed (production image) — fall back to JSON.
      opts.transport = undefined;
    }
  }

  return pino(opts);
}

export const logger = buildLogger();

export type Logger = typeof logger;
