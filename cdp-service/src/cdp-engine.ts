/**
 * CDP Evaluate Engine - Independent CDP evaluation engine
 * Bypasses Playwright's per-page command queue
 */
import type { EvaluateRequest, EvaluateResponse, Budget, IsolationLevel } from './types.js';
import { getBudgetManager } from './budget-manager.js';
import { openCdpWebSocket, getCdpWebSocketUrl, createCdpSender, sendWithBudget } from './cdp-helpers.js';
import { getLogger } from './logger.js';
import type { CdpSendFn } from './cdp-helpers.js';
import { getMetrics } from './metrics.js';
import { getStats } from './stats.js';
import { startEvaluateSpan, addIsolationAttributes, addConnectionAttributes, addResultAttributes } from './tracing.js';

export class CdpEvaluateEngine {
  private cdpUrl: string;
  private isolationLevel: IsolationLevel;
  private engineId: string;

  constructor(cdpUrl: string, isolationLevel: IsolationLevel, engineId: string) {
    this.cdpUrl = cdpUrl;
    this.isolationLevel = isolationLevel;
    this.engineId = engineId;
  }

  /**
   * Execute JavaScript evaluation
   */
  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    const logger = getLogger();
    const budgetManager = getBudgetManager();
    const metrics = getMetrics();
    const stats = getStats();
    const startMs = Date.now();

    // Start tracing span
    const { span, endSpan } = startEvaluateSpan(request);
    addIsolationAttributes(span, this.isolationLevel, this.engineId);

    // Start metrics timer
    const endTimer = metrics.recordEvaluateStart(
      request.agentId || 'default',
      this.isolationLevel
    );

    // Create budget
    const budget = budgetManager.createBudget(request.budget);

    try {
      logger.debug('Starting evaluation', {
        agentId: request.agentId,
        targetId: request.targetId,
        engineId: this.engineId,
      });

      // Get WebSocket URL
      const wsUrl = await getCdpWebSocketUrl(this.cdpUrl, budget);
      addConnectionAttributes(span, wsUrl);

      // Open WebSocket connection
      const ws = await openCdpWebSocket(wsUrl, budget);
      const sender = createCdpSender(ws);

      try {
        let result: unknown;
        let sessionId: string | undefined;

        // If targetId specified, attach to target
        if (request.targetId) {
          sessionId = await this.attachToTarget(sender, request.targetId, budget);
        }

        // Execute evaluation
        if (request.backendDOMNodeId !== undefined) {
          // Element-level evaluation
          result = await this.evaluateOnNode(
            sender,
            sessionId,
            request.backendDOMNodeId,
            request.expression,
            request.awaitPromise,
            budget
          );
        } else {
          // Page-level evaluation
          result = await this.evaluateOnPage(
            sender,
            sessionId,
            request.expression,
            request.awaitPromise,
            request.returnByValue,
            budget
          );
        }

        // Detach from target
        if (sessionId) {
          await this.detachFromTarget(sender, sessionId, budget).catch(() => {
            // Best effort
          });
        }

        // Close WebSocket
        ws.close();

        const durationMs = Date.now() - startMs;
        const resultSize = JSON.stringify(result).length;

        // Record success metrics
        endTimer();
        metrics.recordEvaluateComplete(
          request.agentId || 'default',
          this.isolationLevel,
          'success'
        );

        // Record stats
        stats.recordRequest(
          this.engineId,
          request.agentId || 'default',
          this.isolationLevel,
          durationMs,
          'success'
        );

        // Add tracing attributes
        addResultAttributes(span, durationMs, resultSize);
        endSpan();

        logger.debug('Evaluation completed', {
          agentId: request.agentId,
          durationMs,
          engineId: this.engineId,
        });

        return {
          result,
          metadata: {
            durationMs,
            isolationLevel: this.isolationLevel,
            engineId: this.engineId,
          },
        };
      } catch (error) {
        // On timeout/abort, try to terminate execution
        if (budget.signal.aborted && request.targetId) {
          await this.terminateExecution(sender, request.targetId, budget).catch(() => {
            // Best effort
          });
        }

        ws.close();
        throw error;
      }
    } catch (error) {
      const durationMs = Date.now() - startMs;
      const isTimeout = budget.signal.aborted;

      // Record error metrics
      endTimer();
      metrics.recordEvaluateComplete(
        request.agentId || 'default',
        this.isolationLevel,
        isTimeout ? 'timeout' : 'error'
      );

      if (!isTimeout) {
        metrics.recordError(
          error instanceof Error ? error.constructor.name : 'Unknown',
          request.agentId
        );
      }

      // Record stats
      stats.recordRequest(
        this.engineId,
        request.agentId || 'default',
        this.isolationLevel,
        durationMs,
        isTimeout ? 'timeout' : 'error'
      );

      // End tracing span with error
      endSpan(error instanceof Error ? error : new Error(String(error)));

      logger.error('Evaluation failed', error, {
        agentId: request.agentId,
        durationMs,
        engineId: this.engineId,
        isTimeout,
      });

      throw error;
    } finally {
      budget.cleanup();
    }
  }

  private async attachToTarget(
    sender: CdpSendFn,
    targetId: string,
    budget: Budget
  ): Promise<string> {
    const result = await sendWithBudget<{ sessionId: string }>(
      sender,
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      budget
    );

    return result.sessionId;
  }

  private async detachFromTarget(
    sender: CdpSendFn,
    sessionId: string,
    budget: Budget
  ): Promise<void> {
    await sendWithBudget(
      sender,
      'Target.detachFromTarget',
      { sessionId },
      undefined,
      budget
    );
  }

  private async evaluateOnPage(
    sender: CdpSendFn,
    sessionId: string | undefined,
    expression: string,
    awaitPromise: boolean = true,
    returnByValue: boolean = true,
    budget: Budget
  ): Promise<unknown> {
    // Enable Runtime domain
    await sendWithBudget(
      sender,
      'Runtime.enable',
      {},
      sessionId,
      budget
    );

    // Execute evaluation
    const result = await sendWithBudget<{
      result?: { value?: unknown };
      exceptionDetails?: {
        text: string;
        lineNumber?: number;
        columnNumber?: number;
        stackTrace?: unknown;
      };
    }>(
      sender,
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue,
        userGesture: true,
        includeCommandLineAPI: true,
      },
      sessionId,
      budget
    );

    if (result.exceptionDetails) {
      const error: EvaluateResponse['exceptionDetails'] = {
        text: result.exceptionDetails.text || 'Evaluation exception',
        lineNumber: result.exceptionDetails.lineNumber,
        columnNumber: result.exceptionDetails.columnNumber,
        stackTrace: result.exceptionDetails.stackTrace,
      };
      throw new Error(error.text);
    }

    return result.result?.value;
  }

  private async evaluateOnNode(
    sender: CdpSendFn,
    sessionId: string | undefined,
    backendDOMNodeId: number,
    expression: string,
    awaitPromise: boolean = true,
    budget: Budget
  ): Promise<unknown> {
    // Resolve DOM node to CDP object
    const resolveResult = await sendWithBudget<{
      object: { objectId: string };
    }>(
      sender,
      'DOM.resolveNode',
      { backendNodeId: backendDOMNodeId },
      sessionId,
      budget
    );

    // Call function on the object
    const callResult = await sendWithBudget<{
      result?: { value?: unknown };
      exceptionDetails?: {
        text: string;
        lineNumber?: number;
        columnNumber?: number;
      };
    }>(
      sender,
      'Runtime.callFunctionOn',
      {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function() { return (${expression}).call(this); }`,
        returnByValue: true,
        awaitPromise,
      },
      sessionId,
      budget
    );

    if (callResult.exceptionDetails) {
      throw new Error(callResult.exceptionDetails.text || 'Evaluation exception');
    }

    return callResult.result?.value;
  }

  private async terminateExecution(
    sender: CdpSendFn,
    _targetId: string,
    _budget: Budget
  ): Promise<void> {
    const logger = getLogger();

    try {
      // Short timeout for termination itself
      const terminateBudget = getBudgetManager().createBudget({
        timeoutMs: 1500,
      });

      await sendWithBudget(
        sender,
        'Runtime.terminateExecution',
        {},
        undefined,
        terminateBudget
      );

      logger.warn('Execution terminated');
    } catch (error) {
      logger.error('Failed to terminate execution', error);
    }
  }

  getId(): string {
    return this.engineId;
  }

  getIsolationLevel(): IsolationLevel {
    return this.isolationLevel;
  }
}
