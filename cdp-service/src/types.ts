/**
 * Core types for CDP Service
 */

export type IsolationLevel = 'process' | 'context' | 'session';
export type BrowserMode = 'shared' | 'dedicated';

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
  browser: {
    defaultMode: BrowserMode;
    shared: {
      cdpUrl: string;
    };
    dedicated: {
      enabled: boolean;
      executablePath?: string;
      host: string;
      startingPort: number;
      maxInstances: number;
      idleTimeoutMs: number;
      startupTimeoutMs: number;
      headless: boolean;
      userDataDirBase: string;
      extraArgs?: string[];
    };
    target: {
      createUrl: string;
      enforceOwnership: boolean;
      allowClientTargetOverride: boolean;
    };
    cleanupIntervalMs: number;
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
  activeBrowserInstances?: number;
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
    defaultBrowserMode?: BrowserMode;
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
  browserMode?: BrowserMode;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  ref?: string;
  backendDOMNodeId?: number;
  budget: BudgetRequest;
}

export interface EngineEvaluateRequest extends EvaluateRequest {
  agentId: string;
  browserMode: BrowserMode;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
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
    browserMode?: BrowserMode;
    browserInstanceId?: string;
    targetId?: string;
    terminatedViaSignal?: boolean;
  };
}

export interface LoadMetrics {
  activeSessions: number;
  cpuUsage: number;
  memoryUsage: number;
}

export interface BrowserInstanceRecord {
  instanceId: string;
  mode: BrowserMode;
  cdpUrl: string;
  ownerAgentId?: string;
  port?: number;
  pid?: number;
  userDataDir?: string;
  createdAt: number;
  lastUsedAt: number;
  status: 'starting' | 'ready' | 'stopping' | 'error';
}

export interface BrowserSessionRecord {
  sessionKey: string;
  agentId: string;
  browserMode: BrowserMode;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface BrowserSessionRequest {
  agentId: string;
  browserMode?: BrowserMode;
  targetId?: string;
}

export interface BrowserSessionResponse {
  agentId: string;
  browserMode: BrowserMode;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
  createdAt: number;
  lastUsedAt: number;
}
