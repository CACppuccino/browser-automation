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
  NavigateRequest,
  NavigateResponse,
  BrowserMode,
  BrowserSessionRequest,
  EngineEvaluateRequest,
  BrowserStateMode,
  ProfileStorageScope,
  ProfileCreateRequest,
  ProfileMigrationRequest,
  NavigationSafetySite,
} from './types.js';
import { getLogger } from './logger.js';
import { IsolationRouter } from './isolation-router.js';
import { BrowserSessionRegistry } from './browser-session-registry.js';
import { getQueueManager } from './queue-manager.js';
import { getBudgetManager } from './budget-manager.js';
import { getMetrics } from './metrics.js';
import { getStats } from './stats.js';
import { ProfileManager } from './profile-manager.js';

export class HttpServer {
  private app: Express;
  private server: Server | null = null;
  private config: ServiceConfig;
  private isolationRouter: IsolationRouter;
  private browserSessionRegistry: BrowserSessionRegistry;
  private profileManager: ProfileManager;
  private healthCheckFn: (() => Promise<HealthStatus>) | null = null;

  constructor(
    config: ServiceConfig,
    isolationRouter: IsolationRouter,
    browserSessionRegistry: BrowserSessionRegistry
  ) {
    this.config = config;
    this.isolationRouter = isolationRouter;
    this.browserSessionRegistry = browserSessionRegistry;
    this.profileManager = new ProfileManager(config.browser);
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
        capabilities: ['evaluate', 'navigate', 'snapshot', 'screenshot', 'sessions', 'profiles'],
        isolationLevels: ['process', 'context', 'session'],
        browserModes: ['shared', 'dedicated'],
        stateModes: ['profile', 'fresh'],
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

    this.app.post('/api/v1/profiles', (req, res) => {
      try {
        const request = req.body as ProfileCreateRequest;
        const response = this.browserSessionRegistry.createProfile(request);
        res.status(201).json(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ error: 'Profile Creation Failed', message });
      }
    });

    this.app.get('/api/v1/profiles', (req, res) => {
      try {
        const scope = this.normalizeProfileScope(req.query.scope);
        const workspacePath = this.normalizeOptionalString(req.query.workspacePath);
        if (req.query.scope !== undefined && !scope) {
          res.status(400).json({ error: 'Bad Request', message: 'scope must be workspace or global' });
          return;
        }
        const response = this.browserSessionRegistry.listProfiles(scope || undefined, workspacePath);
        res.json(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ error: 'Profile List Failed', message });
      }
    });

    this.app.get('/api/v1/profiles/:id', (req, res) => {
      try {
        const scope = this.normalizeProfileScope(req.query.scope) || this.config.browser.profiles.defaultScope;
        const workspacePath = this.normalizeOptionalString(req.query.workspacePath);
        const response = this.browserSessionRegistry.getProfile(req.params.id, scope, workspacePath);
        res.json(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = message.includes('not found') ? 404 : 400;
        res.status(statusCode).json({ error: 'Profile Lookup Failed', message });
      }
    });

    this.app.delete('/api/v1/profiles/:id', (req, res) => {
      try {
        const scope = this.normalizeProfileScope(req.query.scope) || this.config.browser.profiles.defaultScope;
        const workspacePath = this.normalizeOptionalString(req.query.workspacePath);
        this.browserSessionRegistry.deleteProfile(req.params.id, scope, workspacePath);
        res.status(204).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = message.includes('not found') ? 404 : 400;
        res.status(statusCode).json({ error: 'Profile Delete Failed', message });
      }
    });

    this.app.post('/api/v1/profiles/:id/migrate', (req, res) => {
      try {
        const sourceScope = this.normalizeProfileScope(req.query.scope) || this.config.browser.profiles.defaultScope;
        const sourceWorkspacePath = this.normalizeOptionalString(req.query.workspacePath);
        const request = req.body as ProfileMigrationRequest;
        const response = this.browserSessionRegistry.migrateProfile(
          req.params.id,
          sourceScope,
          sourceWorkspacePath,
          request
        );
        res.status(201).json(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ error: 'Profile Migration Failed', message });
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

      const validationError = this.validateAccessRequest({
        ...request,
        agentId,
        browserMode,
      });
      if (validationError) {
        res.status(400).json({ error: 'Bad Request', message: validationError });
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
            stateMode: this.normalizeStateMode(request.stateMode) || undefined,
            profileId: this.normalizeOptionalString(request.profileId),
            profileScope: this.normalizeProfileScope(request.profileScope) || undefined,
            workspacePath: this.normalizeOptionalString(request.workspacePath),
            freshInstanceId: this.normalizeOptionalString(request.freshInstanceId),
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
      const stateMode = this.normalizeStateMode(req.query.stateMode);
      const profileScope = this.normalizeProfileScope(req.query.profileScope);
      const workspacePath = this.normalizeOptionalString(req.query.workspacePath);
      const profileId = this.normalizeOptionalString(req.query.profileId);
      const freshInstanceId = this.normalizeOptionalString(req.query.freshInstanceId);

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
          browserMode || undefined,
          {
            stateMode: stateMode || undefined,
            profileId: profileId || undefined,
            profileScope: profileScope || undefined,
            workspacePath: workspacePath || undefined,
            freshInstanceId: freshInstanceId || undefined,
          }
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
        const stateMode = this.normalizeStateMode(request.stateMode) || undefined;
        const profileScope = this.normalizeProfileScope(request.profileScope) || undefined;
        const workspacePath = this.normalizeOptionalString(request.workspacePath);
        const profileId = this.normalizeOptionalString(request.profileId);
        const freshInstanceId = this.normalizeOptionalString(request.freshInstanceId);

        if (request.browserMode && !this.normalizeBrowserMode(request.browserMode)) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'browserMode must be shared or dedicated',
          });
          return;
        }

        const validationError = this.validateAccessRequest({
          agentId,
          browserMode,
          stateMode,
          profileId,
          profileScope,
          workspacePath,
          freshInstanceId,
          targetId: request.targetId,
        });
        if (validationError) {
          res.status(400).json({ error: 'Bad Request', message: validationError });
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
              stateMode,
              profileId,
              profileScope,
              workspacePath,
              freshInstanceId,
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
            stateMode: session.stateMode,
            profileId: session.profileId,
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
            stateMode: session.stateMode,
            profileId: session.profileId,
            profileScope: session.profileScope,
            workspacePath: session.workspacePath,
            freshInstanceId,
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

    this.app.post('/api/v1/navigate', async (req, res) => {
      const budgetManager = getBudgetManager();
      const queueManager = getQueueManager();

      try {
        const request = req.body as NavigateRequest;

        if (!request.url) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'url is required',
          });
          return;
        }

        let requestedUrl: URL;
        try {
          requestedUrl = new URL(request.url);
        } catch {
          res.status(400).json({
            error: 'Bad Request',
            message: 'url must be a valid absolute URL',
          });
          return;
        }

        const agentId = request.agentId?.trim() || 'default';
        const browserMode = this.normalizeBrowserMode(request.browserMode) || this.config.browser.defaultMode;
        const stateMode = this.normalizeStateMode(request.stateMode) || undefined;
        const profileScope = this.normalizeProfileScope(request.profileScope) || undefined;
        const workspacePath = this.normalizeOptionalString(request.workspacePath);
        const profileId = this.normalizeOptionalString(request.profileId);
        const freshInstanceId = this.normalizeOptionalString(request.freshInstanceId);

        if (request.browserMode && !this.normalizeBrowserMode(request.browserMode)) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'browserMode must be shared or dedicated',
          });
          return;
        }

        const validationError = this.validateAccessRequest({
          agentId,
          browserMode,
          stateMode,
          profileId,
          profileScope,
          workspacePath,
          freshInstanceId,
        });
        if (validationError) {
          res.status(400).json({ error: 'Bad Request', message: validationError });
          return;
        }

        const timeoutMs = request.timeoutMs || this.config.timeouts.defaultBudgetMs;
        if (timeoutMs > this.config.timeouts.maxBudgetMs) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Timeout exceeds maximum (${this.config.timeouts.maxBudgetMs}ms)`,
          });
          return;
        }

        const requestBudget = budgetManager.createBudget({ timeoutMs });

        try {
          const session = await this.browserSessionRegistry.resolveSession(
            {
              agentId,
              browserMode,
              stateMode,
              profileId,
              profileScope,
              workspacePath,
              freshInstanceId,
            },
            requestBudget
          );

          const siteBucket = this.getNavigationSafetySite(requestedUrl.hostname);
          let rateLimitApplied = false;
          let queueWaitMs = 0;
          let startupDelayMs = 0;
          let startedAt = Date.now();

          if (siteBucket && this.isNavigationSafetyEnabledForHost(requestedUrl.hostname)) {
            const permitBudget = budgetManager.propagateBudget(requestBudget, 100);
            try {
              const permit = await queueManager.acquireNavigationPermit(siteBucket, permitBudget, {
                minStartIntervalMs: this.config.browser.navigationSafety.minStartIntervalMs,
                maxRandomStartupDelayMs: this.config.browser.navigationSafety.maxRandomStartupDelayMs,
              });
              rateLimitApplied = true;
              queueWaitMs = permit.queueWaitMs;
              startupDelayMs = permit.startupDelayMs;
              startedAt = permit.startedAt;
            } finally {
              permitBudget.cleanup();
            }
          }

          const navigateBudget = budgetManager.propagateBudget(requestBudget, 50);
          try {
            const response = await queueManager.enqueue(
              session.targetId,
              () => this.navigateSessionToUrl(session.cdpUrl, session.targetId, request.url, navigateBudget),
              navigateBudget
            );

            const payload: NavigateResponse = {
              url: response.url,
              title: response.title,
              readyState: response.readyState,
              metadata: {
                browserMode: session.browserMode,
                stateMode: session.stateMode,
                browserInstanceId: session.browserInstanceId,
                targetId: session.targetId,
                rateLimitApplied,
                siteBucket: siteBucket || undefined,
                queueWaitMs,
                startupDelayMs,
                startedAt,
              },
            };

            logger.info('Navigate request completed', {
              agentId,
              requestedUrl: request.url,
              finalUrl: payload.url,
              browserMode: session.browserMode,
              stateMode: session.stateMode,
              profileId: session.profileId,
              browserInstanceId: session.browserInstanceId,
              targetId: session.targetId,
              rateLimitApplied,
              siteBucket,
              queueWaitMs,
              startupDelayMs,
            });

            res.json(payload);
          } finally {
            navigateBudget.cleanup();
          }
        } finally {
          requestBudget.cleanup();
        }
      } catch (error) {
        logger.error('Navigate failed', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = this.isClientError(message) ? 400 : 500;

        res.status(statusCode).json({
          error: 'Navigation Failed',
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

  private normalizeStateMode(value: unknown): BrowserStateMode | null {
    if (value === 'profile' || value === 'fresh') {
      return value;
    }
    return null;
  }

  private normalizeProfileScope(value: unknown): ProfileStorageScope | null {
    if (value === 'workspace' || value === 'global') {
      return value;
    }
    return null;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private validateAccessRequest(request: {
    agentId: string;
    browserMode?: BrowserMode;
    stateMode?: BrowserStateMode;
    profileId?: string;
    profileScope?: ProfileStorageScope;
    workspacePath?: string;
    freshInstanceId?: string;
    targetId?: string;
  }): string | null {
    try {
      this.profileManager.validateAccessRequest(request);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid browser access request';
    }
  }

  private getNavigationSafetySite(hostname: string): NavigationSafetySite | null {
    const normalizedHost = hostname.toLowerCase();

    if (normalizedHost === 'linkedin.com' || normalizedHost.endsWith('.linkedin.com')) {
      return 'linkedin';
    }
    if (normalizedHost === 'instagram.com' || normalizedHost.endsWith('.instagram.com')) {
      return 'instagram';
    }
    if (
      normalizedHost === 'x.com' ||
      normalizedHost.endsWith('.x.com') ||
      normalizedHost === 'twitter.com' ||
      normalizedHost.endsWith('.twitter.com')
    ) {
      return 'x';
    }
    if (normalizedHost === 'facebook.com' || normalizedHost.endsWith('.facebook.com')) {
      return 'facebook';
    }

    return null;
  }

  private isNavigationSafetyEnabledForHost(hostname: string): boolean {
    const navigationSafety = this.config.browser.navigationSafety;
    if (!navigationSafety.enabled) {
      return false;
    }

    const normalizedHost = hostname.toLowerCase();
    return navigationSafety.protectedSites.some((site) => {
      const normalizedSite = site.toLowerCase();
      return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
    });
  }

  private async navigateSessionToUrl(
    cdpUrl: string,
    targetId: string,
    url: string,
    budget: { remainingMs(): number; signal: AbortSignal }
  ): Promise<{ url: string; title?: string; readyState?: string }> {
    const response = await fetch(`${cdpUrl}/json/list`, {
      signal: budget.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const targets = (await response.json()) as Array<{
      id: string;
      webSocketDebuggerUrl?: string;
    }>;
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`Target ${targetId} has no webSocketDebuggerUrl`);
    }

    const { createCdpSender, openCdpWebSocket, sendWithBudget } = await import('./cdp-helpers.js');
    const { getBudgetManager } = await import('./budget-manager.js');
    const budgetManager = getBudgetManager();
    const connectBudget = budgetManager.createBudget({ timeoutMs: Math.max(1000, budget.remainingMs()) }, budget.signal);
    const ws = await openCdpWebSocket(target.webSocketDebuggerUrl, connectBudget);
    connectBudget.cleanup();

    try {
      const sender = createCdpSender(ws);
      const runtimeBudget = budgetManager.createBudget({ timeoutMs: Math.max(1000, budget.remainingMs()) }, budget.signal);
      try {
        await sendWithBudget(sender, 'Page.enable', undefined, undefined, runtimeBudget);
        await sendWithBudget(sender, 'Runtime.enable', undefined, undefined, runtimeBudget);
        await sendWithBudget(sender, 'Page.navigate', { url }, undefined, runtimeBudget);
        await sendWithBudget(
          sender,
          'Runtime.evaluate',
          {
            expression: '({ url: window.location.href, title: document.title, readyState: document.readyState })',
            returnByValue: true,
            awaitPromise: false,
          },
          undefined,
          runtimeBudget
        );
      } finally {
        runtimeBudget.cleanup();
      }

      const settleBudget = budgetManager.createBudget({ timeoutMs: Math.max(1000, budget.remainingMs()) }, budget.signal);
      try {
        const settled = await sendWithBudget<{ result?: { value?: { url?: string; title?: string; readyState?: string } } }>(
          sender,
          'Runtime.evaluate',
          {
            expression: `new Promise((resolve) => {
              const startedAt = Date.now();
              const sample = () => {
                const body = document.body;
                const textLength = (body?.innerText || '').trim().length;
                const nodeCount = body ? body.querySelectorAll('*').length : 0;
                const mainLike = !!document.querySelector('main, #main, [role="main"], [data-testid="main"]');
                const state = {
                  url: window.location.href,
                  title: document.title,
                  readyState: document.readyState,
                  textLength,
                  nodeCount,
                  mainLike,
                };
                if (
                  state.readyState === 'complete' ||
                  (state.readyState === 'interactive' && state.title && (state.textLength >= 200 || state.mainLike || state.nodeCount >= 25)) ||
                  Date.now() - startedAt >= ${Math.max(1000, budget.remainingMs())}
                ) {
                  resolve(state);
                  return;
                }
                setTimeout(sample, 150);
              };
              sample();
            })`,
            returnByValue: true,
            awaitPromise: true,
          },
          undefined,
          settleBudget
        );

        return {
          url: settled.result?.value?.url || url,
          title: settled.result?.value?.title,
          readyState: settled.result?.value?.readyState,
        };
      } finally {
        settleBudget.cleanup();
      }
    } finally {
      ws.close();
    }
  }

  private isClientError(message: string): boolean {
    return [
      'targetId',
      'browserMode',
      'stateMode',
      'profileId',
      'workspacePath',
      'scope',
      'Dedicated browser mode is not enabled',
      'Dedicated browser instance limit reached',
      'not owned by agent',
      'not found',
      'locked',
    ].some((fragment) => message.includes(fragment));
  }
}
