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

export class QueueManager {
  private queues = new Map<string, Array<QueuedCommand<unknown>>>();
  private executing = new Set<string>();

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

  /**
   * Get statistics
   */
  getStats() {
    const queueSizes: Record<string, number> = {};
    for (const [targetId, queue] of this.queues.entries()) {
      queueSizes[targetId] = queue.length;
    }

    return {
      totalQueued: this.getTotalQueued(),
      totalExecuting: this.executing.size,
      queueSizes,
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
