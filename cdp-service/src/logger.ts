/**
 * Structured logging system for CDP Service
 * Enhanced with OpenTelemetry trace ID correlation
 */
import { Logger as TsLogger, ILogObj } from 'tslog';
import type { ServiceConfig } from './types.js';
import { getCurrentTraceId } from './tracing.js';

class LoggerInstance {
  private logger: TsLogger<ILogObj>;

  constructor(config?: ServiceConfig) {
    const logLevel = config?.monitoring?.logLevel || 'info';

    this.logger = new TsLogger({
      name: 'cdp-service',
      minLevel: this.mapLogLevel(logLevel),
      type: 'pretty',
      prettyLogTimeZone: 'local',
      prettyLogTemplate: '{{yyyy}}-{{mm}}-{{dd}} {{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{name}}] ',
    });
  }

  private mapLogLevel(level: string): number {
    const levels: Record<string, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return levels[level] ?? 1;
  }

  /**
   * Add trace ID to metadata if available
   */
  private enrichMeta(meta?: Record<string, unknown>): Record<string, unknown> {
    const traceId = getCurrentTraceId();
    if (traceId) {
      return { traceId, ...meta };
    }
    return meta || {};
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(message, this.enrichMeta(meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(message, this.enrichMeta(meta));
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    const enrichedMeta = this.enrichMeta(meta);

    if (error instanceof Error) {
      this.logger.error(message, {
        error: error.message,
        stack: error.stack,
        ...enrichedMeta,
      });
    } else {
      this.logger.error(message, { error, ...enrichedMeta });
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, this.enrichMeta(meta));
  }

  /**
   * Log with explicit trace ID (for correlation)
   */
  withTraceId(traceId: string) {
    return {
      info: (message: string, meta?: Record<string, unknown>) =>
        this.info(message, { traceId, ...meta }),
      warn: (message: string, meta?: Record<string, unknown>) =>
        this.warn(message, { traceId, ...meta }),
      error: (message: string, error?: Error | unknown, meta?: Record<string, unknown>) =>
        this.error(message, error, { traceId, ...meta }),
      debug: (message: string, meta?: Record<string, unknown>) =>
        this.debug(message, { traceId, ...meta }),
    };
  }
}

let loggerInstance: LoggerInstance | null = null;

export function initLogger(config?: ServiceConfig): LoggerInstance {
  loggerInstance = new LoggerInstance(config);
  return loggerInstance;
}

export function getLogger(): LoggerInstance {
  if (!loggerInstance) {
    loggerInstance = new LoggerInstance();
  }
  return loggerInstance;
}
