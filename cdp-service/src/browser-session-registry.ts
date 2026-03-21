/**
 * Browser session registry for shared and dedicated browser ownership.
 */
import type { ChildProcess } from 'node:child_process';
import type {
  BrowserInstanceRecord,
  BrowserMode,
  BrowserSessionRecord,
  BrowserSessionRequest,
  BrowserSessionResponse,
  Budget,
  ServiceConfig,
} from './types.js';
import { ChromeLauncher } from './chrome-launcher.js';
import { getLogger } from './logger.js';
import {
  createPageTarget,
  deleteTarget,
  getBrowserWebSocketUrl,
  getTargetWebSocketUrl,
  targetExists,
} from './cdp-helpers.js';

interface DedicatedRuntime {
  instance: BrowserInstanceRecord;
  process: ChildProcess;
}

export class BrowserSessionRegistry {
  private config: ServiceConfig['browser'];
  private launcher: ChromeLauncher | null;
  private sharedInstance: BrowserInstanceRecord;
  private sessions = new Map<string, BrowserSessionRecord>();
  private dedicatedInstances = new Map<string, DedicatedRuntime>();
  private targetOwners = new Map<string, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private nextPort = 0;

  constructor(config: ServiceConfig['browser']) {
    this.config = config;
    this.launcher = config.dedicated.enabled ? new ChromeLauncher(config.dedicated) : null;
    this.sharedInstance = {
      instanceId: 'shared-default',
      mode: 'shared',
      cdpUrl: config.shared.cdpUrl,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: 'ready',
    };
    this.nextPort = config.dedicated.startingPort;
  }

  startCleanupLoop(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions().catch((error) => {
        getLogger().error('Idle browser session cleanup failed', error);
      });
    }, this.config.cleanupIntervalMs);
  }

  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async resolveSession(
    request: BrowserSessionRequest,
    budget: Budget
  ): Promise<BrowserSessionRecord> {
    const agentId = request.agentId;
    const browserMode = request.browserMode ?? this.config.defaultMode;
    const sessionKey = this.makeSessionKey(agentId, browserMode);

    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) {
      if (request.targetId && request.targetId !== existingSession.targetId && this.config.target.enforceOwnership) {
        throw new Error(
          `targetId ${request.targetId} is not owned by agent ${agentId} in ${browserMode} mode`
        );
      }

      if (!(await this.validateSession(existingSession, budget))) {
        await this.releaseSession(agentId, browserMode);
      } else {
        existingSession.lastUsedAt = Date.now();
        this.touchInstance(existingSession.browserInstanceId);
        return existingSession;
      }
    }

    const instance = await this.resolveBrowserInstance(agentId, browserMode, budget);
    const pageTarget = await createPageTarget(instance.cdpUrl, this.config.target.createUrl, budget);
    const now = Date.now();

    const session: BrowserSessionRecord = {
      sessionKey,
      agentId,
      browserMode,
      browserInstanceId: instance.instanceId,
      cdpUrl: instance.cdpUrl,
      targetId: pageTarget.id,
      createdAt: now,
      lastUsedAt: now,
    };

    this.sessions.set(sessionKey, session);
    this.targetOwners.set(pageTarget.id, sessionKey);
    this.touchInstance(instance.instanceId);

    getLogger().info('Created browser session', {
      agentId,
      browserMode,
      browserInstanceId: session.browserInstanceId,
      targetId: session.targetId,
    });

    return session;
  }

  async getSession(agentId: string, browserMode?: BrowserMode): Promise<BrowserSessionRecord | null> {
    if (browserMode) {
      return this.sessions.get(this.makeSessionKey(agentId, browserMode)) || null;
    }

    return (
      this.sessions.get(this.makeSessionKey(agentId, 'dedicated')) ||
      this.sessions.get(this.makeSessionKey(agentId, 'shared')) ||
      null
    );
  }

  async releaseSession(agentId: string, browserMode?: BrowserMode): Promise<boolean> {
    const candidates: BrowserMode[] = browserMode ? [browserMode] : ['shared', 'dedicated'];
    let released = false;

    for (const mode of candidates) {
      const sessionKey = this.makeSessionKey(agentId, mode);
      const session = this.sessions.get(sessionKey);
      if (!session) {
        continue;
      }

      this.sessions.delete(sessionKey);
      this.targetOwners.delete(session.targetId);
      released = true;

      try {
        const startMs = Date.now();
        const deadlineAtMs = startMs + this.config.cleanupIntervalMs;
        const cleanupBudget: Budget = {
          timeoutMs: this.config.cleanupIntervalMs,
          deadlineAtMs,
          signal: AbortSignal.timeout(this.config.cleanupIntervalMs),
          startMs,
          remainingMs() {
            return Math.max(0, deadlineAtMs - Date.now());
          },
          cleanup() {
            // native timeout signal cleans itself up
          },
        };
        await deleteTarget(session.cdpUrl, session.targetId, cleanupBudget);
      } catch (error) {
        getLogger().warn('Failed to delete page target during session cleanup', {
          agentId,
          browserMode: mode,
          targetId: session.targetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (mode === 'dedicated') {
        const runtime = this.dedicatedInstances.get(agentId);
        if (runtime) {
          this.dedicatedInstances.delete(agentId);
          await this.launcher?.shutdown(runtime.instance, runtime.process);
        }
      }
    }

    return released;
  }

  async cleanupAll(): Promise<void> {
    this.stopCleanupLoop();

    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      await this.releaseSession(session.agentId, session.browserMode);
    }
  }

  getHealthConnections(): Array<{ url: string; status: 'connected' | 'disconnected'; latencyMs?: number }> {
    const connections: Array<{ url: string; status: 'connected' | 'disconnected'; latencyMs?: number }> = [
      {
        url: this.sharedInstance.cdpUrl,
        status: 'connected',
      },
    ];

    for (const runtime of this.dedicatedInstances.values()) {
      connections.push({
        url: runtime.instance.cdpUrl,
        status: runtime.instance.status === 'ready' ? 'connected' : 'disconnected',
      });
    }

    return connections;
  }

  getStats() {
    return {
      activeSessions: this.sessions.size,
      activeBrowserInstances: 1 + this.dedicatedInstances.size,
      sessions: Array.from(this.sessions.values()).map((session) => ({
        agentId: session.agentId,
        browserMode: session.browserMode,
        browserInstanceId: session.browserInstanceId,
        targetId: session.targetId,
        lastUsedAt: session.lastUsedAt,
      })),
    };
  }

  toResponse(session: BrowserSessionRecord): BrowserSessionResponse {
    return {
      agentId: session.agentId,
      browserMode: session.browserMode,
      browserInstanceId: session.browserInstanceId,
      cdpUrl: session.cdpUrl,
      targetId: session.targetId,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    };
  }

  async getBrowserWebSocketUrlForSession(session: BrowserSessionRecord, budget: Budget): Promise<string> {
    return getBrowserWebSocketUrl(session.cdpUrl, budget);
  }

  async getTargetWebSocketUrlForSession(session: BrowserSessionRecord, budget: Budget): Promise<string> {
    return getTargetWebSocketUrl(session.cdpUrl, session.targetId, budget);
  }

  private async resolveBrowserInstance(
    agentId: string,
    browserMode: BrowserMode,
    budget: Budget
  ): Promise<BrowserInstanceRecord> {
    if (browserMode === 'shared') {
      this.sharedInstance.lastUsedAt = Date.now();
      await getBrowserWebSocketUrl(this.sharedInstance.cdpUrl, budget);
      return this.sharedInstance;
    }

    if (!this.launcher || !this.config.dedicated.enabled) {
      throw new Error('Dedicated browser mode is not enabled');
    }

    const existing = this.dedicatedInstances.get(agentId);
    if (existing) {
      existing.instance.lastUsedAt = Date.now();
      return existing.instance;
    }

    if (this.dedicatedInstances.size >= this.config.dedicated.maxInstances) {
      throw new Error('Dedicated browser instance limit reached');
    }

    const runtime = await this.launcher.launch(agentId, this.allocatePort());
    this.dedicatedInstances.set(agentId, runtime);
    return runtime.instance;
  }

  private async validateSession(session: BrowserSessionRecord, budget: Budget): Promise<boolean> {
    try {
      await getBrowserWebSocketUrl(session.cdpUrl, budget);
      return await targetExists(session.cdpUrl, session.targetId, budget);
    } catch {
      return false;
    }
  }

  private touchInstance(instanceId: string): void {
    if (instanceId === this.sharedInstance.instanceId) {
      this.sharedInstance.lastUsedAt = Date.now();
      return;
    }

    const runtime = Array.from(this.dedicatedInstances.values()).find(
      ({ instance }) => instance.instanceId === instanceId
    );
    if (runtime) {
      runtime.instance.lastUsedAt = Date.now();
    }
  }

  private allocatePort(): number {
    const port = this.nextPort;
    this.nextPort += 1;
    return port;
  }

  private async cleanupIdleSessions(): Promise<void> {
    const idleBefore = Date.now() - this.config.dedicated.idleTimeoutMs;

    for (const session of Array.from(this.sessions.values())) {
      if (session.browserMode !== 'dedicated') {
        continue;
      }
      if (session.lastUsedAt < idleBefore) {
        await this.releaseSession(session.agentId, session.browserMode);
      }
    }

    const sharedSessionKeys = Array.from(this.sessions.entries())
      .filter(([, session]) => session.browserMode === 'shared' && session.lastUsedAt < idleBefore)
      .map(([key]) => key);

    for (const sessionKey of sharedSessionKeys) {
      const session = this.sessions.get(sessionKey);
      if (session) {
        await this.releaseSession(session.agentId, 'shared');
      }
    }
  }

  private makeSessionKey(agentId: string, browserMode: BrowserMode): string {
    return `${browserMode}:${agentId}`;
  }
}
