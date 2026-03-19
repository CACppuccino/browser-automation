/**
 * Context-Level Isolation Strategy
 * Separate BrowserContext per agent (recommended)
 */
import type { IsolationStrategy } from './session.js';
import { CdpEvaluateEngine } from '../cdp-engine.js';

export class ContextIsolation implements IsolationStrategy {
  private engines = new Map<string, CdpEvaluateEngine>();
  private cdpUrl: string;

  constructor(cdpUrl: string) {
    this.cdpUrl = cdpUrl;
  }

  async getEngine(agentId: string): Promise<CdpEvaluateEngine> {
    let engine = this.engines.get(agentId);

    if (!engine) {
      const engineId = `context-${agentId}-${Date.now()}`;
      // Note: In Phase 2, we use same CDP URL but will manage contexts
      // via Playwright in future phases. For now, create engine per agent.
      engine = new CdpEvaluateEngine(this.cdpUrl, 'context', engineId);
      this.engines.set(agentId, engine);
    }

    return engine;
  }

  async destroy(agentId: string): Promise<void> {
    const engine = this.engines.get(agentId);
    if (engine) {
      // Future: await engine.closeContext();
      this.engines.delete(agentId);
    }
  }

  async destroyAll(): Promise<void> {
    // Future: close all contexts
    this.engines.clear();
  }

  getActiveCount(): number {
    return this.engines.size;
  }
}
