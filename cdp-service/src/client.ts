/**
 * CDP Service Client
 * HTTP client for the standalone CDP Service
 * To be used by host applications for browser operations
 */

export type CdpBrowserMode = 'shared' | 'dedicated';

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
  browserMode?: CdpBrowserMode;
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
    browserMode?: CdpBrowserMode;
    browserInstanceId?: string;
    targetId?: string;
    terminatedViaSignal?: boolean;
  };
}

export interface CdpSessionRequest {
  agentId: string;
  browserMode?: CdpBrowserMode;
  targetId?: string;
}

export interface CdpSessionResponse {
  agentId: string;
  browserMode: CdpBrowserMode;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface CdpServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  activeEngines: number;
  activeSessions: number;
  activeBrowserInstances?: number;
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
  browser?: {
    activeSessions: number;
    activeBrowserInstances: number;
    sessions: Array<{
      agentId: string;
      browserMode: CdpBrowserMode;
      browserInstanceId: string;
      targetId: string;
      lastUsedAt: number;
    }>;
  };
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
 *   browserMode: 'shared',
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
    if (!request.budget) {
      request.budget = { timeoutMs: this.config.defaultTimeout };
    } else if (!request.budget.timeoutMs) {
      request.budget.timeoutMs = this.config.defaultTimeout;
    }

    return this.request<CdpEvaluateResponse>(
      'POST',
      '/api/v1/evaluate',
      request,
      request.budget.timeoutMs + 1000
    );
  }

  /**
   * Create or resolve a browser session for an agent.
   */
  async createSession(request: CdpSessionRequest): Promise<CdpSessionResponse> {
    return this.request<CdpSessionResponse>('POST', '/api/v1/sessions', request, 10000);
  }

  /**
   * Get an existing browser session.
   */
  async getSession(agentId: string, browserMode?: CdpBrowserMode): Promise<CdpSessionResponse> {
    const query = browserMode ? `?browserMode=${encodeURIComponent(browserMode)}` : '';
    return this.request<CdpSessionResponse>('GET', `/api/v1/sessions/${encodeURIComponent(agentId)}${query}`);
  }

  /**
   * Delete a browser session.
   */
  async deleteSession(agentId: string, browserMode?: CdpBrowserMode): Promise<void> {
    const query = browserMode ? `?browserMode=${encodeURIComponent(browserMode)}` : '';
    await this.request<void>('DELETE', `/api/v1/sessions/${encodeURIComponent(agentId)}${query}`);
  }

  /**
   * Get service health status
   */
  async getHealth(): Promise<CdpServiceHealth> {
    const response = await this.request<CdpServiceHealth>('GET', '/health', undefined, 5000, false);
    this.healthStatus = response;
    return response;
  }

  /**
   * Get service statistics
   */
  async getStats(): Promise<CdpServiceStats> {
    return this.request<CdpServiceStats>('GET', '/api/v1/stats', undefined, 5000);
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
        const errorPayload = (await response.json().catch(() => ({
          error: 'Unknown error',
          message: response.statusText,
        }))) as { error?: string; message?: string };

        throw new CdpServiceError(
          errorPayload.message || errorPayload.error || 'Request failed',
          response.status,
          errorPayload
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof CdpServiceError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new CdpServiceError(`Request timeout after ${timeoutMs}ms`, 408, {
          timeout: timeoutMs,
        });
      }

      throw new CdpServiceError(error instanceof Error ? error.message : 'Unknown error', 0, {
        originalError: error,
      });
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    this.getHealth().catch(() => {
      // Ignore initial errors
    });

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
export function createCdpServiceClient(config: CdpServiceConfig): CdpServiceClient {
  return new CdpServiceClient(config);
}
