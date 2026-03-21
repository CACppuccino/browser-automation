/**
 * HTTP/WebSocket Server with authentication
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import type {
  ServiceConfig,
  HealthStatus,
  EvaluateRequest,
  EvaluateResponse,
  BrowserMode,
  BrowserSessionRequest,
  EngineEvaluateRequest,
} from './types.js';
import { getLogger } from './logger.js';
import { IsolationRouter } from './isolation-router.js';
import { BrowserSessionRegistry } from './browser-session-registry.js';
import { getQueueManager } from './queue-manager.js';
import { getBudgetManager } from './budget-manager.js';
import { getMetrics } from './metrics.js';
import { getStats } from './stats.js';

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: ServiceConfig;
  private isolationRouter: IsolationRouter;
  private browserSessionRegistry: BrowserSessionRegistry;
  private healthCheckFn: (() => Promise<HealthStatus>) | null = null;

  constructor(
    config: ServiceConfig,
    isolationRouter: IsolationRouter,
    browserSessionRegistry: BrowserSessionRegistry
  ) {
    this.config = config;
    this.isolationRouter = isolationRouter;
    this.browserSessionRegistry = browserSessionRegistry;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Parse JSON bodies
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      const logger = getLogger();
      logger.debug('Incoming request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });

    // Authentication middleware (except for /health and /metrics)
    this.app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/metrics') {
        return next();
      }

      const authHeader = req.headers.authorization;
      const expectedToken = `Bearer ${this.config.service.authToken}`;

      if (!authHeader || authHeader !== expectedToken) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token',
        });
      }

      next();
    });
  }

  private setupRoutes(): void {
    const logger = getLogger();

    // Health check endpoint (no auth required)
    this.app.get('/health', async (_req, res) => {
      try {
        if (!this.healthCheckFn) {
          res.status(503).json({
            status: 'unhealthy',
            error: 'Health check function not registered',
          });
          return;
        }

        const health = await this.healthCheckFn();
        const statusCode =
          health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

        res.status(statusCode).json(health);
      } catch (error) {
        logger.error('Health check failed', error);
        res.status(500).json({
          status: 'unhealthy',
          error: 'Health check error',
        });
      }
    });

    // Prometheus metrics endpoint (no auth required)
    this.app.get('/metrics', async (_req, res) => {
      try {
        const metrics = getMetrics();
        const data = await metrics.getMetrics();
        res.setHeader('Content-Type', 'text/plain');
        res.send(data);
      } catch (error) {
        logger.error('Failed to get metrics', error);
        res.status(500).send('# Error generating metrics\n');
      }
    });

    // API info endpoint
    this.app.get('/api/v1/info', (_req, res) => {
      res.json({
        name: 'cdp-service',
        version: '1.0.0',
        capabilities: ['evaluate', 'snapshot', 'screenshot', 'sessions'],
        isolationLevels: ['process', 'context', 'session'],
        browserModes: ['shared', 'dedicated'],
      });
    });

    // Stats API endpoints
    this.app.get('/api/v1/stats', (_req, res) => {
      try {
        const stats = getStats();
        const data = stats.getServiceStats();
        res.json({
          ...data,
          browser: this.browserSessionRegistry.getStats(),
        });
      } catch (error) {
        logger.error('Failed to get stats', error);
        res.status(500).json({ error: 'Failed to get statistics' });
      }
    });

    this.app.get('/api/v1/stats/engines', (_req, res) => {
      try {
        const stats = getStats();
        const data = stats.getAllEngineStats();
        res.json(data);
      } catch (error) {
        logger.error('Failed to get engine stats', error);
        res.status(500).json({ error: 'Failed to get engine statistics' });
      }
    });

    this.app.get('/api/v1/stats/agents/:id', (req, res) => {
      try {
        const stats = getStats();
        const agentId = req.params.id;
        const data = stats.getAgentStats(agentId);

        if (!data) {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }

        res.json(data);
      } catch (error) {
        logger.error('Failed to get agent stats', error);
        res.status(500).json({ error: 'Failed to get agent statistics' });
      }
    });

    this.app.post('/api/v1/sessions', async (req, res) => {
      const request = req.body as BrowserSessionRequest;
      const agentId = request.agentId?.trim();

      if (!agentId) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'agentId is required',
        });
        return;
      }

      const browserMode = this.normalizeBrowserMode(request.browserMode) || this.config.browser.defaultMode;
      if (request.browserMode && !this.normalizeBrowserMode(request.browserMode)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'browserMode must be shared or dedicated',
        });
        return;
      }

      const budget = getBudgetManager().createBudget({
        timeoutMs: this.config.timeouts.defaultBudgetMs,
      });

      try {
        const session = await this.browserSessionRegistry.resolveSession(
          {
            agentId,
            browserMode,
            targetId: request.targetId,
          },
          budget
        );
        res.status(201).json(this.browserSessionRegistry.toResponse(session));
      } catch (error) {
        logger.error('Failed to create browser session', error, { agentId, browserMode });
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({
          error: 'Session Creation Failed',
          message,
        });
      } finally {
        budget.cleanup();
      }
    });

    this.app.get('/api/v1/sessions/:id', async (req, res) => {
      const agentId = req.params.id;
      const browserMode = this.normalizeBrowserMode(req.query.browserMode);

      if (req.query.browserMode !== undefined && !browserMode) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'browserMode must be shared or dedicated',
        });
        return;
      }

      const session = await this.browserSessionRegistry.getSession(agentId, browserMode || undefined);
      if (!session) {
        res.status(404).json({
          error: 'Not Found',
          message: `No browser session found for agent ${agentId}`,
        });
        return;
      }

      res.json(this.browserSessionRegistry.toResponse(session));
    });

    this.app.delete('/api/v1/sessions/:id', async (req, res) => {
      const agentId = req.params.id;
      const browserMode = this.normalizeBrowserMode(req.query.browserMode);

      if (req.query.browserMode !== undefined && !browserMode) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'browserMode must be shared or dedicated',
        });
        return;
      }

      try {
        const released = await this.browserSessionRegistry.releaseSession(
          agentId,
          browserMode || undefined
        );

        if (!released) {
          res.status(404).json({
            error: 'Not Found',
            message: `No browser session found for agent ${agentId}`,
          });
          return;
        }

        res.status(204).send();
      } catch (error) {
        logger.error('Failed to release browser session', error, { agentId, browserMode });
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'Session Release Failed',
          message,
        });
      }
    });

    // Evaluate API
    this.app.post('/api/v1/evaluate', async (req, res) => {
      const budgetManager = getBudgetManager();
      const queueManager = getQueueManager();

      try {
        const request = req.body as EvaluateRequest;

        if (!request.expression) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'expression is required',
          });
          return;
        }

        const agentId = request.agentId?.trim() || 'default';
        const browserMode = this.normalizeBrowserMode(request.browserMode) || this.config.browser.defaultMode;

        if (request.browserMode && !this.normalizeBrowserMode(request.browserMode)) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'browserMode must be shared or dedicated',
          });
          return;
        }

        // Apply default timeout if not specified
        const timeoutMs = request.budget?.timeoutMs || this.config.timeouts.defaultBudgetMs;

        if (timeoutMs > this.config.timeouts.maxBudgetMs) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Timeout exceeds maximum (${this.config.timeouts.maxBudgetMs}ms)`,
          });
          return;
        }

        const budgetRequest = {
          timeoutMs,
        };
        const requestBudget = budgetManager.createBudget(budgetRequest);

        try {
          const session = await this.browserSessionRegistry.resolveSession(
            {
              agentId,
              browserMode,
              targetId: request.targetId,
            },
            requestBudget
          );

          const level = this.isolationRouter.selectLevel({
            agentId,
            requestType: 'evaluate',
          });

          logger.info('Evaluate request', {
            agentId,
            targetId: session.targetId,
            browserMode,
            browserInstanceId: session.browserInstanceId,
            isolationLevel: level,
            timeoutMs,
          });

          const strategy = this.isolationRouter.getStrategy(level);
          const engine = await strategy.getEngine(agentId);

          const engineRequest: EngineEvaluateRequest = {
            ...request,
            agentId,
            browserMode,
            browserInstanceId: session.browserInstanceId,
            cdpUrl: session.cdpUrl,
            targetId: session.targetId,
            budget: budgetRequest,
          };

          const queueBudget = budgetManager.propagateBudget(requestBudget, 50);
          let result: EvaluateResponse;

          try {
            result = await queueManager.enqueue(
              session.targetId,
              () => engine.evaluate(engineRequest),
              queueBudget
            );
          } finally {
            queueBudget.cleanup();
          }

          res.json(result);
        } finally {
          requestBudget.cleanup();
        }
      } catch (error) {
        logger.error('Evaluate failed', error);

        const message = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = this.isClientError(message) ? 400 : 500;

        res.status(statusCode).json({
          error: 'Evaluation Failed',
          message,
        });
      }
    });

    // Error handling
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error', err);
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
      });
    });

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({
        error: 'Not Found',
      });
    });
  }

  registerHealthCheck(fn: () => Promise<HealthStatus>): void {
    this.healthCheckFn = fn;
  }

  async start(): Promise<void> {
    const logger = getLogger();

    return new Promise((resolve, reject) => {
      try {
        this.server = createServer(this.app);

        this.server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.config.service.port} is already in use`));
          } else {
            reject(error);
          }
        });

        this.server.listen(this.config.service.port, this.config.service.host, () => {
          logger.info('HTTP server started', {
            host: this.config.service.host,
            port: this.config.service.port,
          });
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    const logger = getLogger();

    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          logger.error('Error stopping HTTP server', err);
          reject(err);
        } else {
          logger.info('HTTP server stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  getApp(): Express {
    return this.app;
  }

  private normalizeBrowserMode(value: unknown): BrowserMode | null {
    if (value === 'shared' || value === 'dedicated') {
      return value;
    }
    return null;
  }

  private isClientError(message: string): boolean {
    return [
      'targetId',
      'browserMode',
      'Dedicated browser mode is not enabled',
      'Dedicated browser instance limit reached',
      'not owned by agent',
      'not found',
    ].some((fragment) => message.includes(fragment));
  }
}
