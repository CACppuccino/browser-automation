/**
 * Stats API - Runtime statistics collection and query
 */
import type { IsolationLevel } from './types.js';

/**
 * Engine statistics
 */
export interface EngineStats {
  engineId: string;
  agentId: string;
  isolationLevel: IsolationLevel;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  totalDurationMs: number;
  errorCount: number;
  timeoutCount: number;
}

/**
 * Agent statistics
 */
export interface AgentStats {
  agentId: string;
  engineCount: number;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  timeoutRequests: number;
  avgDurationMs: number;
  lastRequestAt?: number;
}

/**
 * Isolation level statistics
 */
export interface IsolationLevelStats {
  level: IsolationLevel;
  activeEngines: number;
  totalRequests: number;
  avgDurationMs: number;
  errorRate: number;
}

/**
 * Overall service statistics
 */
export interface ServiceStats {
  uptime: number;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  timeoutRequests: number;
  activeEngines: number;
  activeAgents: number;
  avgDurationMs: number;
  requestsPerSecond: number;
  isolationLevels: IsolationLevelStats[];
}

/**
 * Stats collector
 */
export class StatsCollector {
  private startTime: number = Date.now();
  private engines = new Map<string, EngineStats>();
  private requests: Array<{
    timestamp: number;
    agentId: string;
    isolationLevel: IsolationLevel;
    durationMs: number;
    status: 'success' | 'error' | 'timeout';
  }> = [];

  /**
   * Register a new engine
   */
  registerEngine(engineId: string, agentId: string, isolationLevel: IsolationLevel): void {
    this.engines.set(engineId, {
      engineId,
      agentId,
      isolationLevel,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      requestCount: 0,
      totalDurationMs: 0,
      errorCount: 0,
      timeoutCount: 0,
    });
  }

  /**
   * Unregister an engine
   */
  unregisterEngine(engineId: string): void {
    this.engines.delete(engineId);
  }

  /**
   * Record a request completion
   */
  recordRequest(
    engineId: string,
    agentId: string,
    isolationLevel: IsolationLevel,
    durationMs: number,
    status: 'success' | 'error' | 'timeout'
  ): void {
    // Update engine stats
    const engine = this.engines.get(engineId);
    if (engine) {
      engine.lastUsedAt = Date.now();
      engine.requestCount++;
      engine.totalDurationMs += durationMs;
      if (status === 'error') engine.errorCount++;
      if (status === 'timeout') engine.timeoutCount++;
    }

    // Add to request history
    this.requests.push({
      timestamp: Date.now(),
      agentId,
      isolationLevel,
      durationMs,
      status,
    });

    // Keep only last 10000 requests
    if (this.requests.length > 10000) {
      this.requests.shift();
    }
  }

  /**
   * Get statistics for a specific engine
   */
  getEngineStats(engineId: string): EngineStats | null {
    return this.engines.get(engineId) || null;
  }

  /**
   * Get all engine statistics
   */
  getAllEngineStats(): EngineStats[] {
    return Array.from(this.engines.values());
  }

  /**
   * Get statistics for a specific agent
   */
  getAgentStats(agentId: string): AgentStats | null {
    const engineStats = Array.from(this.engines.values()).filter((e) => e.agentId === agentId);
    const agentRequests = this.requests.filter((r) => r.agentId === agentId);

    if (engineStats.length === 0 && agentRequests.length === 0) {
      return null;
    }

    const totalRequests = agentRequests.length;
    const successRequests = agentRequests.filter((r) => r.status === 'success').length;
    const errorRequests = agentRequests.filter((r) => r.status === 'error').length;
    const timeoutRequests = agentRequests.filter((r) => r.status === 'timeout').length;
    const avgDurationMs =
      agentRequests.length > 0
        ? agentRequests.reduce((sum, r) => sum + r.durationMs, 0) / agentRequests.length
        : 0;
    const lastRequestAt =
      agentRequests.length > 0 ? Math.max(...agentRequests.map((r) => r.timestamp)) : undefined;

    return {
      agentId,
      engineCount: engineStats.length,
      totalRequests,
      successRequests,
      errorRequests,
      timeoutRequests,
      avgDurationMs,
      lastRequestAt,
    };
  }

  /**
   * Get statistics by isolation level
   */
  getIsolationLevelStats(): IsolationLevelStats[] {
    const levels: IsolationLevel[] = ['session', 'context', 'process'];

    return levels.map((level) => {
      const levelEngines = Array.from(this.engines.values()).filter(
        (e) => e.isolationLevel === level
      );
      const levelRequests = this.requests.filter((r) => r.isolationLevel === level);

      const totalRequests = levelRequests.length;
      const errorRequests = levelRequests.filter((r) => r.status !== 'success').length;
      const avgDurationMs =
        totalRequests > 0
          ? levelRequests.reduce((sum, r) => sum + r.durationMs, 0) / totalRequests
          : 0;
      const errorRate = totalRequests > 0 ? errorRequests / totalRequests : 0;

      return {
        level,
        activeEngines: levelEngines.length,
        totalRequests,
        avgDurationMs,
        errorRate,
      };
    });
  }

  /**
   * Get overall service statistics
   */
  getServiceStats(): ServiceStats {
    const now = Date.now();
    const uptime = now - this.startTime;

    const totalRequests = this.requests.length;
    const successRequests = this.requests.filter((r) => r.status === 'success').length;
    const errorRequests = this.requests.filter((r) => r.status === 'error').length;
    const timeoutRequests = this.requests.filter((r) => r.status === 'timeout').length;

    const avgDurationMs =
      totalRequests > 0
        ? this.requests.reduce((sum, r) => sum + r.durationMs, 0) / totalRequests
        : 0;

    // Calculate requests per second (last minute)
    const oneMinuteAgo = now - 60000;
    const recentRequests = this.requests.filter((r) => r.timestamp >= oneMinuteAgo);
    const requestsPerSecond = recentRequests.length / 60;

    // Count unique agents
    const uniqueAgents = new Set(this.requests.map((r) => r.agentId)).size;

    return {
      uptime,
      totalRequests,
      successRequests,
      errorRequests,
      timeoutRequests,
      activeEngines: this.engines.size,
      activeAgents: uniqueAgents,
      avgDurationMs,
      requestsPerSecond,
      isolationLevels: this.getIsolationLevelStats(),
    };
  }

  /**
   * Reset all statistics (for testing)
   */
  reset(): void {
    this.startTime = Date.now();
    this.engines.clear();
    this.requests = [];
  }
}

// Singleton instance
let statsCollector: StatsCollector | null = null;

/**
 * Initialize stats collector
 */
export function initStats(): StatsCollector {
  if (!statsCollector) {
    statsCollector = new StatsCollector();
  }
  return statsCollector;
}

/**
 * Get stats collector instance
 */
export function getStats(): StatsCollector {
  if (!statsCollector) {
    throw new Error('Stats collector not initialized. Call initStats() first.');
  }
  return statsCollector;
}
