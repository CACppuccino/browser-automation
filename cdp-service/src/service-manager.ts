/**
 * Service Manager - Handles CDP Service lifecycle
 */
import type { ServiceConfig, ServiceInfo, HealthStatus } from './types.js';
import { getLogger } from './logger.js';
import { HttpServer } from './http-server.js';
import { IsolationRouter } from './isolation-router.js';
import { initMetrics } from './metrics.js';
import { initStats, getStats } from './stats.js';
import { initTracing, shutdownTracing } from './tracing.js';

export class ServiceManager {
  private config: ServiceConfig;
  private httpServer: HttpServer | null = null;
  private isolationRouter: IsolationRouter | null = null;
  private startTime: number = 0;
  private shutdownHandlers: Array<() => Promise<void>> = [];
  private isShuttingDown = false;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.setupSignalHandlers();
  }

  async start(): Promise<ServiceInfo> {
    const logger = getLogger();
    logger.info('Starting CDP Service', {
      host: this.config.service.host,
      port: this.config.service.port,
      isolation: this.config.isolation.default,
    });

    this.startTime = Date.now();

    // Initialize monitoring components
    initMetrics();
    initStats();
    if (this.config.monitoring.enableTracing) {
      initTracing(this.config);
      logger.info('OpenTelemetry tracing enabled');
    }

    // Initialize isolation router
    this.isolationRouter = new IsolationRouter(this.config);

    // Start HTTP server
    this.httpServer = new HttpServer(this.config, this.isolationRouter);
    this.httpServer.registerHealthCheck(() => this.healthCheck());
    await this.httpServer.start();

    logger.info('CDP Service started successfully', {
      port: this.config.service.port,
      metricsPort: this.config.monitoring.metricsPort,
      tracingEnabled: this.config.monitoring.enableTracing,
    });

    return {
      version: '1.0.0',
      started: new Date(this.startTime).toISOString(),
      config: {
        host: this.config.service.host,
        port: this.config.service.port,
        metricsPort: this.config.monitoring.metricsPort,
      },
    };
  }

  async stop(gracefulShutdownMs?: number): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    const logger = getLogger();
    const timeout = gracefulShutdownMs || this.config.timeouts.gracefulTerminationMs;

    logger.info('Shutting down CDP Service', { gracefulTimeoutMs: timeout });

    // Execute shutdown handlers with timeout
    const shutdownPromise = Promise.all(
      this.shutdownHandlers.map(handler => handler().catch(err => {
        logger.error('Shutdown handler failed', err);
      }))
    );

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn('Graceful shutdown timeout exceeded');
        resolve();
      }, timeout);
    });

    await Promise.race([shutdownPromise, timeoutPromise]);

    // Stop HTTP server
    if (this.httpServer) {
      await this.httpServer.stop();
      this.httpServer = null;
    }

    // Cleanup isolation strategies
    if (this.isolationRouter) {
      await this.isolationRouter.destroyAll();
      this.isolationRouter = null;
    }

    // Shutdown tracing
    if (this.config.monitoring.enableTracing) {
      await shutdownTracing();
    }

    logger.info('CDP Service stopped');
  }

  async restart(partialConfig?: Partial<ServiceConfig>): Promise<ServiceInfo> {
    const logger = getLogger();
    logger.info('Restarting CDP Service');

    await this.stop();

    if (partialConfig) {
      this.config = { ...this.config, ...partialConfig };
    }

    return await this.start();
  }

  async healthCheck(): Promise<HealthStatus> {
    const errors: string[] = [];
    const stats = getStats();

    // Check HTTP server
    if (!this.httpServer) {
      errors.push('HTTP server not running');
    }

    // Check CDP connections
    const cdpConnections = await this.checkCdpEndpoints();

    // Get service stats
    const serviceStats = stats.getServiceStats();

    const status = errors.length > 0 ? 'unhealthy' :
                   cdpConnections.some(c => c.status === 'disconnected') ? 'degraded' :
                   'healthy';

    return {
      status,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      activeEngines: serviceStats.activeEngines,
      activeSessions: serviceStats.activeAgents,
      cdpConnections,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkCdpEndpoints(): Promise<HealthStatus['cdpConnections']> {
    const results = await Promise.all(
      this.config.cdp.endpoints.map(async endpoint => {
        try {
          const start = Date.now();
          const response = await fetch(`${endpoint.url}/json/version`, {
            signal: AbortSignal.timeout(2000),
          });

          if (!response.ok) {
            return {
              url: endpoint.url,
              status: 'disconnected' as const,
            };
          }

          const latencyMs = Date.now() - start;
          return {
            url: endpoint.url,
            status: 'connected' as const,
            latencyMs,
          };
        } catch {
          return {
            url: endpoint.url,
            status: 'disconnected' as const,
          };
        }
      })
    );

    return results;
  }

  registerShutdownHandler(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  private setupSignalHandlers(): void {
    const handleShutdown = async () => {
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', handleShutdown);
    process.on('SIGINT', handleShutdown);
  }
}
