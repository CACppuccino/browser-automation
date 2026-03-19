/**
 * CDP Service Integration Example
 *
 * This file demonstrates how to integrate the CDP service client
 * into OpenClaw's browser-tool.ts implementation
 */

import { CdpServiceClient, createCdpServiceClient, CdpServiceError } from './client.js';
import type { CdpEvaluateRequest, CdpEvaluateResponse } from './client.js';

/**
 * Configuration for CDP Service integration
 */
export interface CdpServiceIntegrationConfig {
  enabled: boolean;
  serviceUrl: string;
  authToken: string;
  fallbackToLegacy: boolean;
  rolloutPercentage: number;
  rolloutAgentPattern?: string;
}

/**
 * Browser Tool Adapter
 * Wraps CDP service client and provides fallback to legacy implementation
 */
export class BrowserToolAdapter {
  private cdpClient: CdpServiceClient | null = null;
  private config: CdpServiceIntegrationConfig;
  private legacyEvaluate: (req: unknown) => Promise<unknown>;

  constructor(
    config: CdpServiceIntegrationConfig,
    legacyEvaluate: (req: unknown) => Promise<unknown>
  ) {
    this.config = config;
    this.legacyEvaluate = legacyEvaluate;

    if (this.config.enabled) {
      this.cdpClient = createCdpServiceClient({
        serviceUrl: this.config.serviceUrl,
        authToken: this.config.authToken,
        defaultTimeout: 30000,
        healthCheckInterval: 30000,
      });
    }
  }

  /**
   * Execute JavaScript evaluation with automatic fallback
   */
  async evaluate(request: CdpEvaluateRequest): Promise<CdpEvaluateResponse> {
    // Check if CDP service should be used for this request
    if (!this.shouldUseCdpService(request.agentId)) {
      return this.executeLegacy(request);
    }

    try {
      // Attempt to use CDP service
      const result = await this.cdpClient!.evaluate(request);

      // Log success
      this.logSuccess(request, result.metadata.durationMs);

      return result;
    } catch (error) {
      // Log failure
      this.logError(request, error);

      // Fallback to legacy if enabled
      if (this.config.fallbackToLegacy) {
        console.warn('CDP service failed, falling back to legacy implementation', {
          agentId: request.agentId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        return this.executeLegacy(request);
      }

      throw error;
    }
  }

  /**
   * Check service health
   */
  async checkHealth(): Promise<boolean> {
    if (!this.cdpClient) {
      return false;
    }

    try {
      const health = await this.cdpClient.getHealth();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }

  /**
   * Get service statistics
   */
  async getStats() {
    if (!this.cdpClient) {
      throw new Error('CDP service not enabled');
    }

    return this.cdpClient.getStats();
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.cdpClient) {
      this.cdpClient.dispose();
    }
  }

  /**
   * Determine if CDP service should be used for this request
   */
  private shouldUseCdpService(agentId?: string): boolean {
    // CDP service not enabled
    if (!this.config.enabled || !this.cdpClient) {
      return false;
    }

    // Check if service is healthy
    if (!this.cdpClient.isHealthy()) {
      return false;
    }

    // Check agent pattern if specified
    if (this.config.rolloutAgentPattern && agentId) {
      const pattern = new RegExp(this.config.rolloutAgentPattern);
      if (!pattern.test(agentId)) {
        return false;
      }
    }

    // Check rollout percentage
    if (this.config.rolloutPercentage < 100) {
      const random = Math.random() * 100;
      if (random >= this.config.rolloutPercentage) {
        return false;
      }
    }

    return true;
  }

  /**
   * Execute using legacy implementation
   */
  private async executeLegacy(request: CdpEvaluateRequest): Promise<CdpEvaluateResponse> {
    const startMs = Date.now();

    try {
      const result = await this.legacyEvaluate(request);
      const durationMs = Date.now() - startMs;

      return {
        result,
        metadata: {
          durationMs,
          isolationLevel: 'session', // Legacy uses session-level
          engineId: 'legacy',
        },
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Log successful evaluation
   */
  private logSuccess(request: CdpEvaluateRequest, durationMs: number): void {
    console.log('CDP service evaluation succeeded', {
      agentId: request.agentId,
      durationMs,
      expressionLength: request.expression.length,
    });
  }

  /**
   * Log evaluation error
   */
  private logError(request: CdpEvaluateRequest, error: unknown): void {
    console.error('CDP service evaluation failed', {
      agentId: request.agentId,
      error: error instanceof Error ? error.message : 'Unknown error',
      statusCode: error instanceof CdpServiceError ? error.statusCode : undefined,
    });
  }
}

/**
 * Example integration in browser-tool.ts
 *
 * @example
 * ```typescript
 * // In browser-tool.ts or similar file:
 *
 * import { BrowserToolAdapter } from './cdp-service-integration.js';
 *
 * class BrowserTool {
 *   private adapter: BrowserToolAdapter;
 *
 *   constructor(config: ToolConfig) {
 *     // Legacy evaluate function
 *     const legacyEvaluate = async (req) => {
 *       // Your existing evaluate implementation
 *       return await this.legacyEvaluateImplementation(req);
 *     };
 *
 *     // Create adapter
 *     this.adapter = new BrowserToolAdapter(
 *       {
 *         enabled: process.env.CDP_SERVICE_ENABLED === 'true',
 *         serviceUrl: process.env.CDP_SERVICE_URL || 'http://localhost:3100',
 *         authToken: process.env.CDP_SERVICE_TOKEN || '',
 *         fallbackToLegacy: true,
 *         rolloutPercentage: parseInt(process.env.CDP_SERVICE_ROLLOUT || '0'),
 *         rolloutAgentPattern: process.env.CDP_SERVICE_AGENT_PATTERN,
 *       },
 *       legacyEvaluate
 *     );
 *   }
 *
 *   async evaluate(options: EvaluateOptions) {
 *     return this.adapter.evaluate({
 *       agentId: this.agentId,
 *       targetId: this.targetId,
 *       expression: options.expression,
 *       awaitPromise: options.awaitPromise,
 *       returnByValue: options.returnByValue,
 *       budget: {
 *         timeoutMs: options.timeout || 30000,
 *       },
 *     });
 *   }
 *
 *   async dispose() {
 *     this.adapter.dispose();
 *   }
 * }
 * ```
 */

/**
 * Feature flags configuration example
 *
 * @example
 * ```yaml
 * # config.yaml
 * cdpService:
 *   enabled: false              # Master switch
 *   serviceUrl: http://localhost:3100
 *   authToken: ${CDP_SERVICE_TOKEN}
 *   fallback: true              # Enable fallback to legacy
 *   rolloutPercentage: 0        # Gradual rollout: 0-100%
 *   rolloutAgentPattern: null   # Optional: test specific agents first
 * ```
 *
 * @example
 * ```bash
 * # Environment variables
 * export CDP_SERVICE_ENABLED=true
 * export CDP_SERVICE_URL=http://localhost:3100
 * export CDP_SERVICE_TOKEN=your-secret-token
 * export CDP_SERVICE_ROLLOUT=10  # 10% rollout
 * export CDP_SERVICE_AGENT_PATTERN="test-.*"  # Test agents only
 * ```
 */
