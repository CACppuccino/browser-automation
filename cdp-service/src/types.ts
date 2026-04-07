/**
 * Core types for CDP Service
 */

export type IsolationLevel = 'process' | 'context' | 'session';
export type BrowserMode = 'shared' | 'dedicated';
export type BrowserStateMode = 'profile' | 'fresh';
export type ProfileStorageScope = 'workspace' | 'global';
export type ProfileMigrationMode = 'copy' | 'move';
export type NavigationSafetySite = 'linkedin' | 'instagram' | 'x' | 'facebook';

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
    profiles: {
      workspaceRootName: string;
      globalRootDir: string;
      defaultScope: ProfileStorageScope;
      metadataFileName: string;
      lockFileName: string;
      lockTimeoutMs: number;
      retention: {
        keepWorkspaceProfiles: boolean;
        keepGlobalProfiles: boolean;
        cleanupFreshOnShutdown: boolean;
        cleanupFreshOnIdle: boolean;
      };
      migration: {
        tempDir: string;
      };
    };
    target: {
      createUrl: string;
      enforceOwnership: boolean;
      allowClientTargetOverride: boolean;
    };
    navigationSafety: {
      enabled: boolean;
      protectedSites: string[];
      minStartIntervalMs: number;
      maxRandomStartupDelayMs: number;
      queueDiscipline: 'fifo';
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

export interface BrowserAccessRequest {
  agentId: string;
  browserMode?: BrowserMode;
  targetId?: string;
  stateMode?: BrowserStateMode;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  freshInstanceId?: string;
}

export interface EvaluateRequest {
  sessionId?: string;
  agentId?: string;
  targetId?: string;
  browserMode?: BrowserMode;
  stateMode?: BrowserStateMode;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  freshInstanceId?: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  ref?: string;
  backendDOMNodeId?: number;
  budget: BudgetRequest;
}

export interface NavigateRequest extends BrowserAccessRequest {
  url: string;
  waitForLoad?: boolean;
  timeoutMs?: number;
}

export interface EngineEvaluateRequest extends EvaluateRequest {
  agentId: string;
  browserMode: BrowserMode;
  stateMode: BrowserStateMode;
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
    stateMode?: BrowserStateMode;
    browserInstanceId?: string;
    targetId?: string;
    terminatedViaSignal?: boolean;
  };
}

export interface NavigateResponse {
  url: string;
  title?: string;
  readyState?: string;
  metadata: {
    browserMode?: BrowserMode;
    stateMode?: BrowserStateMode;
    browserInstanceId?: string;
    targetId?: string;
    rateLimitApplied: boolean;
    siteBucket?: NavigationSafetySite;
    queueWaitMs: number;
    startupDelayMs: number;
    startedAt: number;
  };
}

export interface LoadMetrics {
  activeSessions: number;
  cpuUsage: number;
  memoryUsage: number;
}

export interface ProfileStoragePaths {
  rootDir: string;
  userDataDir: string;
  metadataPath: string;
  lockPath: string;
}

export interface ProfileRecord {
  profileId: string;
  scope: ProfileStorageScope;
  workspacePath?: string;
  displayName?: string;
  rootDir: string;
  userDataDir: string;
  metadataPath: string;
  lockPath: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  state: 'ready' | 'migrating' | 'locked' | 'error';
  version: number;
  sourceProfileId?: string;
  sourceScope?: ProfileStorageScope;
  migratedFrom?: {
    profileId: string;
    scope: ProfileStorageScope;
    workspacePath?: string;
    migratedAt: number;
    mode: ProfileMigrationMode;
  };
}

export interface BrowserInstanceRecord {
  instanceId: string;
  instanceKey: string;
  mode: BrowserMode;
  stateMode: BrowserStateMode;
  cdpUrl: string;
  ownerAgentId?: string;
  port?: number;
  pid?: number;
  userDataDir?: string;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  profileRootDir?: string;
  deleteUserDataDirOnShutdown: boolean;
  createdAt: number;
  lastUsedAt: number;
  status: 'starting' | 'ready' | 'stopping' | 'error';
}

export interface BrowserSessionRecord {
  sessionKey: string;
  instanceKey: string;
  agentId: string;
  browserMode: BrowserMode;
  stateMode: BrowserStateMode;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface BrowserSessionRequest extends BrowserAccessRequest {}

export interface BrowserSessionResponse {
  agentId: string;
  browserMode: BrowserMode;
  stateMode: BrowserStateMode;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  browserInstanceId: string;
  cdpUrl: string;
  targetId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ProfileCreateRequest {
  profileId: string;
  scope?: ProfileStorageScope;
  workspacePath?: string;
  displayName?: string;
}

export interface ProfileMigrationRequest {
  targetProfileId?: string;
  targetScope: ProfileStorageScope;
  targetWorkspacePath?: string;
  mode?: ProfileMigrationMode;
  force?: boolean;
}

export interface ProfileResponse {
  profile: ProfileRecord;
}

export interface ProfileListResponse {
  profiles: ProfileRecord[];
}
