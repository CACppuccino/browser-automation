/**
 * Isolation Strategy Interface and Implementations
 */
import { CdpEvaluateEngine } from '../cdp-engine.js';

export interface IsolationStrategy {
  getEngine(agentId: string): Promise<CdpEvaluateEngine>;
  destroy(agentId: string): Promise<void>;
  destroyAll(): Promise<void>;
  getActiveCount(): number;
}

/**
 * Session-Level Isolation
 * Lightweight, shared browser state acceptable
 */
export class SessionIsolation implements IsolationStrategy {
  private engines = new Map<string, CdpEvaluateEngine>();
  private cdpUrl: string;

  constructor(cdpUrl: string) {
    this.cdpUrl = cdpUrl;
  }

  async getEngine(agentId: string): Promise<CdpEvaluateEngine> {
    let engine = this.engines.get(agentId);

    if (!engine) {
      const engineId = `session-${agentId}-${Date.now()}`;
      engine = new CdpEvaluateEngine(this.cdpUrl, 'session', engineId);
      this.engines.set(agentId, engine);
    }

    return engine;
  }

  async destroy(agentId: string): Promise<void> {
    this.engines.delete(agentId);
  }

  async destroyAll(): Promise<void> {
    this.engines.clear();
  }

  getActiveCount(): number {
    return this.engines.size;
  }
}
