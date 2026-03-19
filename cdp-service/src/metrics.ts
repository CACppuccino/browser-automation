/**
 * Prometheus Metrics Collection
 * Provides comprehensive metrics for CDP service monitoring
 */
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { IsolationLevel } from './types.js';

// Create separate registry for CDP service metrics
const registry = new Registry();

// Evaluate request counter
const evaluateCounter = new Counter({
  name: 'cdp_evaluate_total',
  help: 'Total number of evaluate requests',
  labelNames: ['agent_id', 'isolation_level', 'status'] as const,
  registers: [registry],
});

// Evaluate duration histogram
const evaluateDuration = new Histogram({
  name: 'cdp_evaluate_duration_ms',
  help: 'Evaluate request duration in milliseconds',
  labelNames: ['agent_id', 'isolation_level'] as const,
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

// Timeout counter
const timeoutCounter = new Counter({
  name: 'cdp_timeouts_total',
  help: 'Total number of timeout events',
  labelNames: ['agent_id', 'isolation_level'] as const,
  registers: [registry],
});

// Active connections gauge
const activeConnections = new Gauge({
  name: 'cdp_active_connections',
  help: 'Current number of active WebSocket connections',
  registers: [registry],
});

// Active sessions gauge
const activeSessions = new Gauge({
  name: 'cdp_active_sessions',
  help: 'Current number of active CDP sessions by isolation level',
  labelNames: ['isolation_level'] as const,
  registers: [registry],
});

// Active engines gauge
const activeEngines = new Gauge({
  name: 'cdp_active_engines',
  help: 'Current number of active CDP engines by isolation level',
  labelNames: ['isolation_level'] as const,
  registers: [registry],
});

// Error counter
const errorCounter = new Counter({
  name: 'cdp_errors_total',
  help: 'Total number of errors by type',
  labelNames: ['error_type', 'agent_id'] as const,
  registers: [registry],
});

// Queue size gauge
const queueSize = new Gauge({
  name: 'cdp_queue_size',
  help: 'Current queue size by target ID',
  labelNames: ['target_id'] as const,
  registers: [registry],
});

// Queue wait duration histogram
const queueWaitDuration = new Histogram({
  name: 'cdp_queue_wait_duration_ms',
  help: 'Time spent waiting in queue in milliseconds',
  labelNames: ['target_id'] as const,
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
  registers: [registry],
});

/**
 * Metrics collector interface
 */
export class MetricsCollector {
  /**
   * Record evaluate request start
   */
  recordEvaluateStart(agentId: string, isolationLevel: IsolationLevel): () => void {
    const endTimer = evaluateDuration.startTimer({
      agent_id: agentId,
      isolation_level: isolationLevel,
    });

    return endTimer;
  }

  /**
   * Record evaluate request completion
   */
  recordEvaluateComplete(
    agentId: string,
    isolationLevel: IsolationLevel,
    status: 'success' | 'error' | 'timeout'
  ): void {
    evaluateCounter.inc({
      agent_id: agentId,
      isolation_level: isolationLevel,
      status,
    });

    if (status === 'timeout') {
      timeoutCounter.inc({
        agent_id: agentId,
        isolation_level: isolationLevel,
      });
    }
  }

  /**
   * Record error
   */
  recordError(errorType: string, agentId?: string): void {
    errorCounter.inc({
      error_type: errorType,
      agent_id: agentId || 'unknown',
    });
  }

  /**
   * Update active connections count
   */
  setActiveConnections(count: number): void {
    activeConnections.set(count);
  }

  /**
   * Update active sessions count
   */
  setActiveSessions(isolationLevel: IsolationLevel, count: number): void {
    activeSessions.set({ isolation_level: isolationLevel }, count);
  }

  /**
   * Update active engines count
   */
  setActiveEngines(isolationLevel: IsolationLevel, count: number): void {
    activeEngines.set({ isolation_level: isolationLevel }, count);
  }

  /**
   * Update queue size
   */
  setQueueSize(targetId: string, size: number): void {
    queueSize.set({ target_id: targetId }, size);
  }

  /**
   * Record queue wait time
   */
  recordQueueWait(targetId: string): () => void {
    const endTimer = queueWaitDuration.startTimer({ target_id: targetId });
    return endTimer;
  }

  /**
   * Get registry for /metrics endpoint
   */
  getRegistry(): Registry {
    return registry;
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return registry.metrics();
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    registry.resetMetrics();
  }
}

// Singleton instance
let metricsCollector: MetricsCollector | null = null;

/**
 * Initialize metrics collector
 */
export function initMetrics(): MetricsCollector {
  if (!metricsCollector) {
    metricsCollector = new MetricsCollector();
  }
  return metricsCollector;
}

/**
 * Get metrics collector instance
 */
export function getMetrics(): MetricsCollector {
  if (!metricsCollector) {
    throw new Error('Metrics collector not initialized. Call initMetrics() first.');
  }
  return metricsCollector;
}
