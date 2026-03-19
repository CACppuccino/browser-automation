/**
 * Isolation Router - Dynamic strategy selection
 */
import type { IsolationLevel, ServiceConfig, LoadMetrics } from './types.js';
import type { IsolationStrategy } from './isolation/session.js';
import { SessionIsolation } from './isolation/session.js';
import { ContextIsolation } from './isolation/context.js';
import { ProcessIsolation } from './isolation/process.js';
import { getLogger } from './logger.js';
import os from 'node:os';

export class IsolationRouter {
  private strategies = new Map<IsolationLevel, IsolationStrategy>();
  private config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;

    // Initialize strategies for all CDP endpoints (use first one for Phase 2)
    const cdpUrl = config.cdp.endpoints[0]?.url || 'http://localhost:9222';

    this.strategies.set('session', new SessionIsolation(cdpUrl));
    this.strategies.set('context', new ContextIsolation(cdpUrl));
    this.strategies.set('process', new ProcessIsolation(cdpUrl));
  }

  /**
   * Select isolation level based on request and load metrics
   */
  selectLevel(request: {
    agentId?: string;
    requestType?: 'evaluate' | 'snapshot' | 'screenshot';
  }): IsolationLevel {
    const logger = getLogger();

    // Static strategy mode
    if (this.config.isolation.strategy === 'static') {
      return this.config.isolation.default;
    }

    // Check custom rules first
    if (request.agentId) {
      for (const rule of this.config.isolation.rules) {
        if (new RegExp(rule.pattern).test(request.agentId)) {
          logger.debug('Isolation rule matched', {
            agentId: request.agentId,
            pattern: rule.pattern,
            level: rule.level,
          });
          return rule.level;
        }
      }
    }

    // Dynamic selection based on system load
    const load = this.getLoadMetrics();

    // Get thresholds from config (with defaults for backward compatibility)
    const sessionThreshold = (this.config.isolation as any).thresholds?.highLoadSessionCount || 10;
    const cpuThreshold = ((this.config.isolation as any).thresholds?.highLoadCpuPercent || 70) / 100;
    const memoryThreshold = ((this.config.isolation as any).thresholds?.highLoadMemoryPercent || 80) / 100;

    // High load → use lighter isolation
    if (load.activeSessions > sessionThreshold ||
        load.cpuUsage > cpuThreshold ||
        load.memoryUsage > memoryThreshold) {
      logger.debug('High load detected, using session isolation', load as unknown as Record<string, unknown>);
      return 'session';
    }

    // Heavy operations → use process isolation (only under normal load)
    if (request.requestType === 'evaluate') {
      return 'process';
    }

    // Default: context isolation (good balance)
    return this.config.isolation.default;
  }

  /**
   * Get strategy for a specific isolation level
   */
  getStrategy(level: IsolationLevel): IsolationStrategy {
    const strategy = this.strategies.get(level);
    if (!strategy) {
      throw new Error(`Unknown isolation level: ${level}`);
    }
    return strategy;
  }

  /**
   * Get current load metrics
   */
  private getLoadMetrics(): LoadMetrics {
    // Count active sessions across all strategies
    let activeSessions = 0;
    for (const strategy of this.strategies.values()) {
      activeSessions += strategy.getActiveCount();
    }

    // Get system metrics
    const cpus = os.cpus();
    const totalLoad = os.loadavg()[0]; // 1-minute load average
    const cpuUsage = totalLoad / cpus.length; // Normalized to 0-1

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = 1 - (freeMem / totalMem);

    return {
      activeSessions,
      cpuUsage,
      memoryUsage,
    };
  }

  /**
   * Cleanup all strategies
   */
  async destroyAll(): Promise<void> {
    const logger = getLogger();
    logger.info('Destroying all isolation strategies');

    await Promise.all(
      Array.from(this.strategies.values()).map(strategy => strategy.destroyAll())
    );
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats: Record<string, number> = {};

    for (const [level, strategy] of this.strategies.entries()) {
      stats[level] = strategy.getActiveCount();
    }

    return {
      byLevel: stats,
      total: Object.values(stats).reduce((sum, count) => sum + count, 0),
      loadMetrics: this.getLoadMetrics(),
    };
  }
}
