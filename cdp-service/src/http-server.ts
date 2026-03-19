/**
 * HTTP/WebSocket Server with authentication
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import type { ServiceConfig, HealthStatus, EvaluateRequest, EvaluateResponse } from './types.js';
import { getLogger } from './logger.js';
import { IsolationRouter } from './isolation-router.js';
import { getQueueManager } from './queue-manager.js';
import { getBudgetManager } from './budget-manager.js';
import { getMetrics } from './metrics.js';
import { getStats } from './stats.js';

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: ServiceConfig;
  private isolationRouter: IsolationRouter;
  private healthCheckFn: (() => Promise<HealthStatus>) | null = null;

  constructor(config: ServiceConfig, isolationRouter: IsolationRouter) {
    this.config = config;
    this.isolationRouter = isolationRouter;
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
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

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
        capabilities: ['evaluate', 'snapshot', 'screenshot'],
        isolationLevels: ['process', 'context', 'session'],
      });
    });

    // Stats API endpoints
    this.app.get('/api/v1/stats', (_req, res) => {
      try {
        const stats = getStats();
        const data = stats.getServiceStats();
        res.json(data);
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

    // Sessions API (placeholder for Phase 2)
    this.app.post('/api/v1/sessions', (_req, res) => {
      res.status(501).json({
        error: 'Not Implemented',
        message: 'Session management will be implemented in Phase 2',
      });
    });

    this.app.delete('/api/v1/sessions/:id', (_req, res) => {
      res.status(501).json({
        error: 'Not Implemented',
        message: 'Session management will be implemented in Phase 2',
      });
    });

    // Evaluate API
    this.app.post('/api/v1/evaluate', async (req, res) => {
      const logger = getLogger();
      const budgetManager = getBudgetManager();
      const queueManager = getQueueManager();

      try {
        // Validate request
        const request = req.body as EvaluateRequest;

        if (!request.expression) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'expression is required',
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

        request.budget = {
          timeoutMs,
        };

        // Select isolation level
        const level = this.isolationRouter.selectLevel({
          agentId: request.agentId,
          requestType: 'evaluate',
        });

        logger.info('Evaluate request', {
          agentId: request.agentId,
          targetId: request.targetId,
          isolationLevel: level,
          timeoutMs,
        });

        // Get engine for this isolation level
        const strategy = this.isolationRouter.getStrategy(level);
        const engine = await strategy.getEngine(request.agentId || 'default');

        // Execute with queue management (if targetId specified)
        let result: EvaluateResponse;

        if (request.targetId) {
          const budget = budgetManager.createBudget(request.budget);
          result = await queueManager.enqueue(
            request.targetId,
            () => engine.evaluate(request),
            budget
          );
        } else {
          result = await engine.evaluate(request);
        }

        res.json(result);
      } catch (error) {
        logger.error('Evaluate failed', error);

        const message = error instanceof Error ? error.message : 'Unknown error';

        res.status(500).json({
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

        this.server.listen(
          this.config.service.port,
          this.config.service.host,
          () => {
            logger.info('HTTP server started', {
              host: this.config.service.host,
              port: this.config.service.port,
            });
            resolve();
          }
        );
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
}
