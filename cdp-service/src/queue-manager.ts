/**
 * Queue Manager - Prevents concurrent commands on same target from blocking
 */
import type { Budget } from './types.js';
import { getLogger } from './logger.js';

interface QueuedCommand<T> {
  command: () => Promise<T>;
  budget: Budget;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface SiteNavigationTicket {
  requestedAt: number;
  budget: Budget;
  resolve: (value: NavigationPermit) => void;
  reject: (error: Error) => void;
}

export interface NavigationPermit {
  queueWaitMs: number;
  startupDelayMs: number;
  startedAt: number;
}

export class QueueManager {
  private queues = new Map<string, Array<QueuedCommand<unknown>>>();
  private executing = new Set<string>();
  private siteQueues = new Map<string, SiteNavigationTicket[]>();
  private processingSites = new Set<string>();
  private siteLastStartedAt = new Map<string, number>();

  /**
   * Enqueue a command for a specific target
   * Ensures serialized execution per target
   */
  async enqueue<T>(
    targetId: string,
    command: () => Promise<T>,
    budget: Budget
  ): Promise<T> {
    const logger = getLogger();

    // Check if another command is executing for this target
    if (this.executing.has(targetId)) {
      logger.debug('Queueing command', { targetId, queueSize: this.getQueueSize(targetId) });

      // Queue the command
      return new Promise<T>((resolve, reject) => {
        const queued: QueuedCommand<T> = {
          command,
          budget,
          resolve: resolve as (value: unknown) => void,
          reject,
        };

        const queue = this.queues.get(targetId) || [];
        queue.push(queued as QueuedCommand<unknown>);
        this.queues.set(targetId, queue);

        // Check budget while waiting
        const abortHandler = () => {
          const idx = queue.indexOf(queued as QueuedCommand<unknown>);
          if (idx >= 0) {
            queue.splice(idx, 1);
            reject(new Error('Command aborted while queued'));
          }
        };

        budget.signal.addEventListener('abort', abortHandler, { once: true });
      });
    }

    // Execute immediately
    logger.debug('Executing command immediately', { targetId });
    return this.execute(targetId, command, budget);
  }

  async acquireNavigationPermit(
    siteKey: string,
    budget: Budget,
    options: {
      minStartIntervalMs: number;
      maxRandomStartupDelayMs: number;
      random?: () => number;
    }
  ): Promise<NavigationPermit> {
    const logger = getLogger();
    const queue = this.siteQueues.get(siteKey) || [];

    return new Promise<NavigationPermit>((resolve, reject) => {
      const ticket: SiteNavigationTicket = {
        requestedAt: Date.now(),
        budget,
        resolve,
        reject,
      };

      queue.push(ticket);
      this.siteQueues.set(siteKey, queue);
      logger.debug('Queued site navigation request', { siteKey, queueSize: queue.length });

      const abortHandler = () => {
        const currentQueue = this.siteQueues.get(siteKey);
        if (!currentQueue) {
          return;
        }
        const idx = currentQueue.indexOf(ticket);
        if (idx >= 0) {
          currentQueue.splice(idx, 1);
          if (currentQueue.length === 0) {
            this.siteQueues.delete(siteKey);
          }
          reject(new Error('Navigation aborted while queued'));
        }
      };

      budget.signal.addEventListener('abort', abortHandler, { once: true });
      void this.processSiteQueue(siteKey, options);
    });
  }

  private async processSiteQueue(
    siteKey: string,
    options: {
      minStartIntervalMs: number;
      maxRandomStartupDelayMs: number;
      random?: () => number;
    }
  ): Promise<void> {
    if (this.processingSites.has(siteKey)) {
      return;
    }

    const logger = getLogger();
    this.processingSites.add(siteKey);

    try {
      while (true) {
        const queue = this.siteQueues.get(siteKey);
        const ticket = queue?.[0];
        if (!queue || !ticket) {
          this.siteQueues.delete(siteKey);
          return;
        }

        if (ticket.budget.signal.aborted) {
          queue.shift();
          ticket.reject(new Error('Navigation aborted while queued'));
          continue;
        }

        const lastStartedAt = this.siteLastStartedAt.get(siteKey) || 0;
        const earliestStartAt = Math.max(Date.now(), lastStartedAt + options.minStartIntervalMs);
        const preStartWaitMs = Math.max(0, earliestStartAt - Date.now());

        if (preStartWaitMs > 0) {
          try {
            await this.waitForDelay(preStartWaitMs, ticket.budget.signal);
          } catch {
            queue.shift();
            ticket.reject(new Error('Navigation aborted while waiting for site interval'));
            continue;
          }
        }

        const startupDelayMs = this.sampleStartupDelay(options.maxRandomStartupDelayMs, options.random);
        if (startupDelayMs > 0) {
          try {
            await this.waitForDelay(startupDelayMs, ticket.budget.signal);
          } catch {
            queue.shift();
            ticket.reject(new Error('Navigation aborted during randomized startup delay'));
            continue;
          }
        }

        const startedAt = Date.now();
        this.siteLastStartedAt.set(siteKey, startedAt);
        queue.shift();
        if (queue.length === 0) {
          this.siteQueues.delete(siteKey);
        }

        logger.debug('Granted site navigation permit', {
          siteKey,
          startedAt,
          startupDelayMs,
          queueWaitMs: Math.max(0, startedAt - ticket.requestedAt - startupDelayMs),
          remainingQueue: queue.length,
        });

        ticket.resolve({
          queueWaitMs: Math.max(0, startedAt - ticket.requestedAt - startupDelayMs),
          startupDelayMs,
          startedAt,
        });
      }
    } finally {
      this.processingSites.delete(siteKey);
      if ((this.siteQueues.get(siteKey)?.length || 0) > 0) {
        void this.processSiteQueue(siteKey, options);
      }
    }
  }

  private sampleStartupDelay(maxRandomStartupDelayMs: number, random: (() => number) | undefined): number {
    if (maxRandomStartupDelayMs <= 0) {
      return 0;
    }

    const randomValue = Math.min(1, Math.max(0, (random || Math.random)()));
    return Math.floor(randomValue * (maxRandomStartupDelayMs + 1));
  }

  private waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', abortHandler);
        resolve();
      }, delayMs);

      const abortHandler = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortHandler);
        reject(new Error('Aborted'));
      };

      signal.addEventListener('abort', abortHandler, { once: true });
    });
  }

  private async execute<T>(
    targetId: string,
    command: () => Promise<T>,
    _budget: Budget
  ): Promise<T> {
    const logger = getLogger();

    this.executing.add(targetId);

    try {
      const result = await command();
      return result;
    } catch (error) {
      throw error;
    } finally {
      this.executing.delete(targetId);

      // Process next command in queue
      const queue = this.queues.get(targetId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;

        logger.debug('Processing next queued command', {
          targetId,
          remainingQueue: queue.length,
        });

        // Execute next command asynchronously
        this.execute(targetId, next.command, next.budget)
          .then(next.resolve)
          .catch(next.reject);
      } else {
        // Clean up empty queue
        this.queues.delete(targetId);
      }
    }
  }

  /**
   * Get queue size for a target
   */
  getQueueSize(targetId: string): number {
    return this.queues.get(targetId)?.length || 0;
  }

  getSiteQueueSize(siteKey: string): number {
    return this.siteQueues.get(siteKey)?.length || 0;
  }

  /**
   * Get total queued commands across all targets
   */
  getTotalQueued(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  getTotalQueuedSiteNavigations(): number {
    let total = 0;
    for (const queue of this.siteQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get statistics
   */
  getStats() {
    const queueSizes: Record<string, number> = {};
    for (const [targetId, queue] of this.queues.entries()) {
      queueSizes[targetId] = queue.length;
    }

    const siteQueueSizes: Record<string, number> = {};
    for (const [siteKey, queue] of this.siteQueues.entries()) {
      siteQueueSizes[siteKey] = queue.length;
    }

    return {
      totalQueued: this.getTotalQueued(),
      totalExecuting: this.executing.size,
      queueSizes,
      siteQueueSizes,
      totalQueuedSiteNavigations: this.getTotalQueuedSiteNavigations(),
    };
  }
}

// Singleton instance
let queueManagerInstance: QueueManager | null = null;

export function getQueueManager(): QueueManager {
  if (!queueManagerInstance) {
    queueManagerInstance = new QueueManager();
  }
  return queueManagerInstance;
}
