/**
 * CDP Service Client
 * HTTP client for OpenClaw CDP Service
 * To be used by openclaw gateway for browser operations
 */

export interface CdpServiceConfig {
  serviceUrl: string;
  authToken: string;
  defaultTimeout?: number;
  maxRetries?: number;
  healthCheckInterval?: number;
}

export interface CdpEvaluateRequest {
  sessionId?: string;
  agentId?: string;
  targetId?: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  ref?: string;
  backendDOMNodeId?: number;
  budget?: {
    timeoutMs: number;
    deadlineAtMs?: number;
  };
}

export interface CdpEvaluateResponse {
  result: unknown;
  exceptionDetails?: {
    text: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: unknown;
  };
  metadata: {
    durationMs: number;
    isolationLevel: 'process' | 'context' | 'session';
    engineId: string;
    terminatedViaSignal?: boolean;
  };
}

export interface CdpServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  activeEngines: number;
  activeSessions: number;
  cdpConnections: Array<{
    url: string;
    status: 'connected' | 'disconnected';
    latencyMs?: number;
  }>;
  errors: string[];
  timestamp: string;
}

export interface CdpServiceStats {
  uptime: number;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  timeoutRequests: number;
  activeEngines: number;
  activeAgents: number;
  avgDurationMs: number;
  requestsPerSecond: number;
}

/**
 * CDP Service Client
 *
 * @example
 * ```typescript
 * const client = new CdpServiceClient({
 *   serviceUrl: 'http://localhost:3100',
 *   authToken: process.env.CDP_SERVICE_TOKEN,
 *   defaultTimeout: 30000
 * });
 *
 * const result = await client.evaluate({
 *   agentId: 'my-agent',
 *   expression: 'document.title',
 *   budget: { timeoutMs: 5000 }
 * });
 * ```
 */
export class CdpServiceClient {
  private config: Required<CdpServiceConfig>;
  private healthStatus: CdpServiceHealth | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(config: CdpServiceConfig) {
    this.config = {
      serviceUrl: config.serviceUrl,
      authToken: config.authToken,
      defaultTimeout: config.defaultTimeout || 30000,
      maxRetries: config.maxRetries || 2,
      healthCheckInterval: config.healthCheckInterval || 30000,
    };

    // Start periodic health checks
    this.startHealthCheck();
  }

  /**
   * Execute JavaScript evaluation
   */
  async evaluate(request: CdpEvaluateRequest): Promise<CdpEvaluateResponse> {
    // Apply default timeout if not specified
    if (!request.budget) {
      request.budget = { timeoutMs: this.config.defaultTimeout };
    } else if (!request.budget.timeoutMs) {
      request.budget.timeoutMs = this.config.defaultTimeout;
    }

    const response = await this.request<CdpEvaluateResponse>(
      'POST',
      '/api/v1/evaluate',
      request,
      request.budget.timeoutMs + 1000 // Add 1s buffer
    );

    return response;
  }

  /**
   * Get service health status
   */
  async getHealth(): Promise<CdpServiceHealth> {
    const response = await this.request<CdpServiceHealth>(
      'GET',
      '/health',
      undefined,
      5000,
      false // No auth required for health
    );

    this.healthStatus = response;
    return response;
  }

  /**
   * Get service statistics
   */
  async getStats(): Promise<CdpServiceStats> {
    return this.request<CdpServiceStats>(
      'GET',
      '/api/v1/stats',
      undefined,
      5000
    );
  }

  /**
   * Check if service is healthy
   */
  isHealthy(): boolean {
    return this.healthStatus?.status === 'healthy';
  }

  /**
   * Get cached health status
   */
  getCachedHealth(): CdpServiceHealth | null {
    return this.healthStatus;
  }

  /**
   * Stop health checks and cleanup
   */
  dispose(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Make HTTP request to CDP service
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs: number = 10000,
    requireAuth: boolean = true
  ): Promise<T> {
    const url = `${this.config.serviceUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requireAuth) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const error: any = await response.json().catch(() => ({
          error: 'Unknown error',
          message: response.statusText,
        }));

        throw new CdpServiceError(
          (error.message || error.error || 'Request failed') as string,
          response.status,
          error
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof CdpServiceError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new CdpServiceError(
          `Request timeout after ${timeoutMs}ms`,
          408,
          { timeout: timeoutMs }
        );
      }

      throw new CdpServiceError(
        error instanceof Error ? error.message : 'Unknown error',
        0,
        { originalError: error }
      );
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    // Immediate health check
    this.getHealth().catch(() => {
      // Ignore initial errors
    });

    // Periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.getHealth().catch(() => {
        // Ignore errors during periodic checks
      });
    }, this.config.healthCheckInterval);
  }
}

/**
 * CDP Service Error
 */
export class CdpServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'CdpServiceError';
  }
}

/**
 * Create CDP Service client with configuration
 */
export function createCdpServiceClient(
  config: CdpServiceConfig
): CdpServiceClient {
  return new CdpServiceClient(config);
}
