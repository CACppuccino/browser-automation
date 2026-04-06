/**
 * Browser session registry for shared and dedicated browser ownership.
 */
import type { ChildProcess } from 'node:child_process';
import type {
  BrowserAccessRequest,
  BrowserInstanceRecord,
  BrowserMode,
  BrowserSessionRecord,
  BrowserSessionRequest,
  BrowserSessionResponse,
  Budget,
  ProfileRecord,
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
import { ProfileManager } from './profile-manager.js';

interface DedicatedRuntime {
  instance: BrowserInstanceRecord;
  process: ChildProcess;
}

export class BrowserSessionRegistry {
  private config: ServiceConfig['browser'];
  private launcher: ChromeLauncher | null;
  private profileManager: ProfileManager;
  private sharedInstance: BrowserInstanceRecord;
  private sessions = new Map<string, BrowserSessionRecord>();
  private dedicatedInstances = new Map<string, DedicatedRuntime>();
  private targetOwners = new Map<string, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private nextPort = 0;

  constructor(config: ServiceConfig['browser']) {
    this.config = config;
    this.launcher = config.dedicated.enabled ? new ChromeLauncher(config.dedicated) : null;
    this.profileManager = new ProfileManager(config);
    this.sharedInstance = {
      instanceId: 'shared-default',
      instanceKey: 'shared:default',
      mode: 'shared',
      stateMode: 'profile',
      cdpUrl: config.shared.cdpUrl,
      deleteUserDataDirOnShutdown: false,
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
    const normalized = this.profileManager.normalizeAccessRequest(request);
    this.profileManager.validateAccessRequest(normalized);

    const sessionKey = this.makeSessionKey(normalized);
    const instanceKey = this.makeInstanceKey(normalized);

    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) {
      if (normalized.targetId && normalized.targetId !== existingSession.targetId && this.config.target.enforceOwnership) {
        throw new Error(
          `targetId ${normalized.targetId} is not owned by agent ${normalized.agentId} in ${normalized.browserMode} mode`
        );
      }

      if (!(await this.validateSession(existingSession, budget))) {
        await this.releaseSession(normalized.agentId, normalized.browserMode, {
          stateMode: normalized.stateMode,
          profileId: normalized.profileId,
          profileScope: normalized.profileScope,
          workspacePath: normalized.workspacePath,
          freshInstanceId: normalized.freshInstanceId,
        });
      } else {
        existingSession.lastUsedAt = Date.now();
        this.touchInstance(existingSession.instanceKey);
        return existingSession;
      }
    }

    const instance = await this.resolveBrowserInstance(normalized, budget);
    const pageTarget = await createPageTarget(instance.cdpUrl, this.config.target.createUrl, budget);
    const now = Date.now();

    const session: BrowserSessionRecord = {
      sessionKey,
      instanceKey,
      agentId: normalized.agentId,
      browserMode: normalized.browserMode!,
      stateMode: normalized.stateMode!,
      profileId: normalized.profileId,
      profileScope: normalized.profileScope,
      workspacePath: normalized.workspacePath,
      browserInstanceId: instance.instanceId,
      cdpUrl: instance.cdpUrl,
      targetId: pageTarget.id,
      createdAt: now,
      lastUsedAt: now,
    };

    this.sessions.set(sessionKey, session);
    this.targetOwners.set(pageTarget.id, sessionKey);
    this.touchInstance(instance.instanceKey);

    getLogger().info('Created browser session', {
      agentId: normalized.agentId,
      browserMode: normalized.browserMode,
      stateMode: normalized.stateMode,
      profileId: normalized.profileId,
      browserInstanceId: session.browserInstanceId,
      targetId: session.targetId,
    });

    return session;
  }

  async getSession(agentId: string, browserMode?: BrowserMode): Promise<BrowserSessionRecord | null> {
    const matches = Array.from(this.sessions.values()).filter(
      (session) => session.agentId === agentId && (!browserMode || session.browserMode === browserMode)
    );

    if (matches.length === 0) {
      return null;
    }

    matches.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return matches[0];
  }

  async releaseSession(
    agentId: string,
    browserMode?: BrowserMode,
    options?: Partial<BrowserAccessRequest>
  ): Promise<boolean> {
    const matches = Array.from(this.sessions.values()).filter((session) => {
      if (session.agentId !== agentId) {
        return false;
      }
      if (browserMode && session.browserMode !== browserMode) {
        return false;
      }
      if (options?.stateMode && session.stateMode !== options.stateMode) {
        return false;
      }
      if (options?.profileId && session.profileId !== options.profileId) {
        return false;
      }
      if (options?.profileScope && session.profileScope !== options.profileScope) {
        return false;
      }
      if (options?.workspacePath && session.workspacePath !== options.workspacePath) {
        return false;
      }
      if (options?.freshInstanceId && !session.instanceKey.endsWith(`:${options.freshInstanceId}`)) {
        return false;
      }
      return true;
    });

    let released = false;

    for (const session of matches) {
      this.sessions.delete(session.sessionKey);
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
          browserMode: session.browserMode,
          targetId: session.targetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (session.browserMode === 'dedicated') {
        const runtime = this.dedicatedInstances.get(session.instanceKey);
        if (runtime) {
          this.dedicatedInstances.delete(session.instanceKey);
          await this.launcher?.shutdown(runtime.instance, runtime.process);
          if (session.profileId && session.profileScope) {
            try {
              const profile = this.profileManager.readProfileRecord(
                session.profileId,
                session.profileScope,
                session.workspacePath
              );
              this.profileManager.releaseProfileLock(profile, session.instanceKey);
            } catch {
              // ignore lock cleanup failures
            }
          }
        }
      }
    }

    return released;
  }

  async cleanupAll(): Promise<void> {
    this.stopCleanupLoop();

    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      await this.releaseSession(session.agentId, session.browserMode, {
        stateMode: session.stateMode,
        profileId: session.profileId,
        profileScope: session.profileScope,
        workspacePath: session.workspacePath,
      });
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
        stateMode: session.stateMode,
        profileId: session.profileId,
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
      stateMode: session.stateMode,
      profileId: session.profileId,
      profileScope: session.profileScope,
      workspacePath: session.workspacePath,
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

  createProfile(record: { profileId: string; scope?: 'workspace' | 'global'; workspacePath?: string; displayName?: string }) {
    return this.profileManager.createProfile(record);
  }

  listProfiles(scope?: 'workspace' | 'global', workspacePath?: string) {
    return this.profileManager.listProfiles(scope, workspacePath);
  }

  getProfile(profileId: string, scope: 'workspace' | 'global', workspacePath?: string) {
    return this.profileManager.getProfile(profileId, scope, workspacePath);
  }

  deleteProfile(profileId: string, scope: 'workspace' | 'global', workspacePath?: string) {
    return this.profileManager.deleteProfile(profileId, scope, workspacePath);
  }

  migrateProfile(profileId: string, scope: 'workspace' | 'global', workspacePath: string | undefined, request: any) {
    return this.profileManager.migrateProfile(profileId, scope, workspacePath, request);
  }

  private async resolveBrowserInstance(
    request: BrowserAccessRequest,
    budget: Budget
  ): Promise<BrowserInstanceRecord> {
    if (request.browserMode === 'shared') {
      this.sharedInstance.lastUsedAt = Date.now();
      await getBrowserWebSocketUrl(this.sharedInstance.cdpUrl, budget);
      return this.sharedInstance;
    }

    if (!this.launcher || !this.config.dedicated.enabled) {
      throw new Error('Dedicated browser mode is not enabled');
    }

    const instanceKey = this.makeInstanceKey(request);
    const existing = this.dedicatedInstances.get(instanceKey);
    if (existing) {
      existing.instance.lastUsedAt = Date.now();
      return existing.instance;
    }

    if (this.dedicatedInstances.size >= this.config.dedicated.maxInstances) {
      throw new Error('Dedicated browser instance limit reached');
    }

    const accessContext = this.profileManager.resolveAccessContext(request);
    let lockedProfile: ProfileRecord | null = null;
    if (accessContext.stateMode === 'profile' && accessContext.profileId && accessContext.profileScope) {
      lockedProfile = this.profileManager.readProfileRecord(
        accessContext.profileId,
        accessContext.profileScope,
        accessContext.workspacePath
      );
      this.profileManager.acquireProfileLock(lockedProfile, {
        instanceKey,
        agentId: request.agentId,
        timestamp: Date.now(),
      });
    }

    try {
      const runtime = await this.launcher.launch(
        {
          instanceKey,
          agentId: request.agentId,
          stateMode: accessContext.stateMode,
          profileId: accessContext.profileId,
          profileScope: accessContext.profileScope,
          workspacePath: accessContext.workspacePath,
          userDataDir: accessContext.paths.userDataDir,
          deleteUserDataDirOnShutdown: accessContext.deleteUserDataDirOnShutdown,
        },
        this.allocatePort()
      );
      this.dedicatedInstances.set(instanceKey, runtime);
      return runtime.instance;
    } catch (error) {
      if (lockedProfile) {
        this.profileManager.releaseProfileLock(lockedProfile, instanceKey);
      }
      throw error;
    }
  }

  private async validateSession(session: BrowserSessionRecord, budget: Budget): Promise<boolean> {
    try {
      await getBrowserWebSocketUrl(session.cdpUrl, budget);
      return await targetExists(session.cdpUrl, session.targetId, budget);
    } catch {
      return false;
    }
  }

  private touchInstance(instanceKey: string): void {
    if (instanceKey === this.sharedInstance.instanceKey) {
      this.sharedInstance.lastUsedAt = Date.now();
      return;
    }

    const runtime = this.dedicatedInstances.get(instanceKey);
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
      if (session.lastUsedAt >= idleBefore) {
        continue;
      }
      if (session.stateMode === 'profile' && !this.config.profiles.retention.cleanupFreshOnIdle) {
        continue;
      }
      await this.releaseSession(session.agentId, session.browserMode, {
        stateMode: session.stateMode,
        profileId: session.profileId,
        profileScope: session.profileScope,
        workspacePath: session.workspacePath,
      });
    }
  }

  private makeSessionKey(request: BrowserAccessRequest): string {
    const normalized = this.profileManager.normalizeAccessRequest(request);
    return `${this.makeInstanceKey(normalized)}:agent:${normalized.agentId}`;
  }

  private makeInstanceKey(request: BrowserAccessRequest): string {
    const normalized = this.profileManager.normalizeAccessRequest(request);
    if (normalized.browserMode === 'shared') {
      return 'shared:default';
    }
    if (normalized.stateMode === 'profile') {
      const workspaceSegment = normalized.profileScope === 'workspace' ? `:${sanitizeSegment(normalized.workspacePath || '')}` : '';
      return `dedicated:profile:${normalized.profileScope}:${normalized.profileId}${workspaceSegment}`;
    }
    return `dedicated:fresh:${normalized.agentId}:${normalized.freshInstanceId || 'auto'}`;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
