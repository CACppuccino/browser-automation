/**
 * Process-Level Isolation Strategy
 * Separate Worker process per agent (heavy isolation)
 */
import type { IsolationStrategy } from './session.js';
import { CdpEvaluateEngine } from '../cdp-engine.js';

export class ProcessIsolation implements IsolationStrategy {
  private engines = new Map<string, CdpEvaluateEngine>();
  private cdpUrl: string;

  constructor(cdpUrl: string) {
    this.cdpUrl = cdpUrl;
  }

  async getEngine(agentId: string): Promise<CdpEvaluateEngine> {
    let engine = this.engines.get(agentId);

    if (!engine) {
      const engineId = `process-${agentId}-${Date.now()}`;
      // Note: In Phase 2, we create engine per agent.
      // In future, this would spawn actual Worker process.
      engine = new CdpEvaluateEngine(this.cdpUrl, 'process', engineId);
      this.engines.set(agentId, engine);
    }

    return engine;
  }

  async destroy(agentId: string): Promise<void> {
    const engine = this.engines.get(agentId);
    if (engine) {
      // Future: await worker.terminate();
      this.engines.delete(agentId);
    }
  }

  async destroyAll(): Promise<void> {
    // Future: terminate all workers
    this.engines.clear();
  }

  getActiveCount(): number {
    return this.engines.size;
  }
}
