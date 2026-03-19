/**
 * Budget Manager - Handles timeout budgets and deadline propagation
 */
import type { Budget, BudgetRequest } from './types.js';

export class BudgetManager {
  /**
   * Create a budget from a request with optional parent signal
   */
  createBudget(request: BudgetRequest, parentSignal?: AbortSignal): Budget {
    const startMs = Date.now();
    const deadlineAtMs = request.deadlineAtMs || (startMs + request.timeoutMs);

    // Create linked abort controller
    const controller = new AbortController();

    // Link to parent signal if provided
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    // Auto-abort on deadline
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, Math.max(0, deadlineAtMs - startMs));

    const budget: Budget = {
      timeoutMs: request.timeoutMs,
      deadlineAtMs,
      signal: controller.signal,
      startMs,
      remainingMs(): number {
        return Math.max(0, deadlineAtMs - Date.now());
      },
      cleanup() {
        clearTimeout(timeoutHandle);
      },
    };

    return budget;
  }

  /**
   * Create a child budget with remaining time minus overhead
   */
  propagateBudget(budget: Budget, overheadMs: number = 100): Budget {
    const remaining = budget.remainingMs() - overheadMs;

    if (remaining <= 0) {
      throw new Error('Insufficient budget for propagation');
    }

    return this.createBudget(
      {
        timeoutMs: remaining,
        deadlineAtMs: budget.deadlineAtMs,
      },
      budget.signal
    );
  }

  /**
   * Execute a function with timeout budget
   */
  async withBudget<T>(
    budget: Budget,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    try {
      return await fn(budget.signal);
    } finally {
      budget.cleanup();
    }
  }

  /**
   * Race a promise against budget timeout
   */
  async raceWithBudget<T>(
    budget: Budget,
    promise: Promise<T>,
    timeoutError: string = 'Operation timed out'
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let completed = false;

      // Listen for abort signal
      const abortHandler = () => {
        if (!completed) {
          completed = true;
          reject(new Error(timeoutError));
        }
      };

      budget.signal.addEventListener('abort', abortHandler, { once: true });

      // Execute promise
      promise
        .then(result => {
          if (!completed) {
            completed = true;
            budget.signal.removeEventListener('abort', abortHandler);
            resolve(result);
          }
        })
        .catch(error => {
          if (!completed) {
            completed = true;
            budget.signal.removeEventListener('abort', abortHandler);
            reject(error);
          }
        });
    });
  }
}

// Singleton instance
let budgetManagerInstance: BudgetManager | null = null;

export function getBudgetManager(): BudgetManager {
  if (!budgetManagerInstance) {
    budgetManagerInstance = new BudgetManager();
  }
  return budgetManagerInstance;
}
