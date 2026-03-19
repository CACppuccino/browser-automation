/**
 * Core types for CDP Service
 */

export type IsolationLevel = 'process' | 'context' | 'session';

export interface ServiceConfig {
  service: {
    host: string;
    port: number;
    authToken: string;
  };
  isolation: {
    strategy: 'static' | 'dynamic';
    default: IsolationLevel;
    rules: Array<{
      pattern: string;
      level: IsolationLevel;
    }>;
  };
  cdp: {
    endpoints: Array<{
      url: string;
      weight: number;
    }>;
    connectionPool: {
      maxPerEndpoint: number;
      idleTimeoutMs: number;
    };
  };
  timeouts: {
    defaultBudgetMs: number;
    maxBudgetMs: number;
    gracefulTerminationMs: number;
  };
  monitoring: {
    metricsPort: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    enableTracing: boolean;
    zipkinEndpoint?: string;
    jaegerEndpoint?: string;
  };
}

export interface HealthStatus {
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

export interface ServiceInfo {
  version: string;
  started: string;
  config: {
    host: string;
    port: number;
    metricsPort: number;
  };
}

export interface BudgetRequest {
  timeoutMs: number;
  deadlineAtMs?: number;
}

export interface Budget {
  timeoutMs: number;
  deadlineAtMs: number;
  signal: AbortSignal;
  startMs: number;
  remainingMs(): number;
  cleanup(): void;
}

export interface EvaluateRequest {
  sessionId?: string;
  agentId?: string;
  targetId?: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  ref?: string;
  backendDOMNodeId?: number;
  budget: BudgetRequest;
}

export interface EvaluateResponse {
  result: unknown;
  exceptionDetails?: {
    text: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: unknown;
  };
  metadata: {
    durationMs: number;
    isolationLevel: IsolationLevel;
    engineId: string;
    terminatedViaSignal?: boolean;
  };
}

export interface LoadMetrics {
  activeSessions: number;
  cpuUsage: number;
  memoryUsage: number;
}
