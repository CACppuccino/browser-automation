/**
 * CDP Evaluate Engine - Independent CDP evaluation engine
 * Bypasses Playwright's per-page command queue
 */
import type { EngineEvaluateRequest, EvaluateResponse, Budget, IsolationLevel } from './types.js';
import { getBudgetManager } from './budget-manager.js';
import {
  openCdpWebSocket,
  getBrowserWebSocketUrl,
  createCdpSender,
  sendWithBudget,
} from './cdp-helpers.js';
import { getLogger } from './logger.js';
import type { CdpSendFn } from './cdp-helpers.js';
import { getMetrics } from './metrics.js';
import { getStats } from './stats.js';
import {
  startEvaluateSpan,
  addIsolationAttributes,
  addConnectionAttributes,
  addResultAttributes,
} from './tracing.js';

export class CdpEvaluateEngine {
  private fallbackCdpUrl: string;
  private isolationLevel: IsolationLevel;
  private engineId: string;

  constructor(cdpUrl: string, isolationLevel: IsolationLevel, engineId: string) {
    this.fallbackCdpUrl = cdpUrl;
    this.isolationLevel = isolationLevel;
    this.engineId = engineId;
  }

  /**
   * Execute JavaScript evaluation
   */
  async evaluate(request: EngineEvaluateRequest): Promise<EvaluateResponse> {
    const logger = getLogger();
    const budgetManager = getBudgetManager();
    const metrics = getMetrics();
    const stats = getStats();
    const startMs = Date.now();
    const cdpUrl = request.cdpUrl || this.fallbackCdpUrl;

    // Start tracing span
    const { span, endSpan } = startEvaluateSpan(request);
    addIsolationAttributes(span, this.isolationLevel, this.engineId);

    // Start metrics timer
    const endTimer = metrics.recordEvaluateStart(request.agentId, this.isolationLevel);

    // Create budget
    const budget = budgetManager.createBudget(request.budget);

    try {
      logger.debug('Starting evaluation', {
        agentId: request.agentId,
        targetId: request.targetId,
        browserMode: request.browserMode,
        browserInstanceId: request.browserInstanceId,
        engineId: this.engineId,
      });

      // Get browser WebSocket URL
      const wsUrl = await getBrowserWebSocketUrl(cdpUrl, budget);
      addConnectionAttributes(span, wsUrl);

      // Open WebSocket connection
      const ws = await openCdpWebSocket(wsUrl, budget);
      const sender = createCdpSender(ws);
      let sessionId: string | undefined;

      try {
        let result: unknown;

        sessionId = await this.attachToTarget(sender, request.targetId, budget);

        // Execute evaluation
        if (request.backendDOMNodeId !== undefined) {
          result = await this.evaluateOnNode(
            sender,
            sessionId,
            request.backendDOMNodeId,
            request.expression,
            request.awaitPromise,
            budget
          );
        } else {
          result = await this.evaluateOnPage(
            sender,
            sessionId,
            request.expression,
            request.awaitPromise,
            request.returnByValue,
            budget
          );
        }

        await this.detachFromTarget(sender, sessionId, budget).catch(() => {
          // Best effort
        });
        sessionId = undefined;

        ws.close();

        const durationMs = Date.now() - startMs;
        const serializedResult = JSON.stringify(result);
        const resultSize = serializedResult ? serializedResult.length : 0;

        // Record success metrics
        endTimer();
        metrics.recordEvaluateComplete(request.agentId, this.isolationLevel, 'success');

        // Record stats
        stats.recordRequest(
          this.engineId,
          request.agentId,
          this.isolationLevel,
          durationMs,
          'success'
        );

        // Add tracing attributes
        addResultAttributes(span, durationMs, resultSize);
        endSpan();

        logger.debug('Evaluation completed', {
          agentId: request.agentId,
          browserMode: request.browserMode,
          browserInstanceId: request.browserInstanceId,
          targetId: request.targetId,
          durationMs,
          engineId: this.engineId,
        });

        return {
          result,
          metadata: {
            durationMs,
            isolationLevel: this.isolationLevel,
            engineId: this.engineId,
            browserMode: request.browserMode,
            browserInstanceId: request.browserInstanceId,
            targetId: request.targetId,
          },
        };
      } catch (error) {
        // On timeout/abort, try to terminate execution in the attached target session.
        if (budget.signal.aborted && sessionId) {
          await this.terminateExecution(sender, sessionId).catch(() => {
            // Best effort
          });
        }

        if (sessionId) {
          await this.detachFromTarget(sender, sessionId, budget).catch(() => {
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
        request.agentId,
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
        request.agentId,
        this.isolationLevel,
        durationMs,
        isTimeout ? 'timeout' : 'error'
      );

      // End tracing span with error
      endSpan(error instanceof Error ? error : new Error(String(error)));

      logger.error('Evaluation failed', error, {
        agentId: request.agentId,
        browserMode: request.browserMode,
        browserInstanceId: request.browserInstanceId,
        targetId: request.targetId,
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
    await sendWithBudget(sender, 'Target.detachFromTarget', { sessionId }, undefined, budget);
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
    await sendWithBudget(sender, 'Runtime.enable', {}, sessionId, budget);

    // Execute evaluation
    const result = await sendWithBudget<{
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: {
        text: string;
        exception?: {
          description?: string;
          value?: unknown;
        };
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
        text:
          result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'Evaluation exception',
        lineNumber: result.exceptionDetails.lineNumber,
        columnNumber: result.exceptionDetails.columnNumber,
        stackTrace: result.exceptionDetails.stackTrace,
      };
      const location =
        error.lineNumber !== undefined && error.columnNumber !== undefined
          ? ` at ${error.lineNumber}:${error.columnNumber}`
          : '';
      throw new Error(`${error.text}${location}`);
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

  private async terminateExecution(sender: CdpSendFn, sessionId: string): Promise<void> {
    const logger = getLogger();
    const terminateBudget = getBudgetManager().createBudget({ timeoutMs: 1500 });

    try {
      await sendWithBudget(
        sender,
        'Runtime.terminateExecution',
        {},
        sessionId,
        terminateBudget
      );

      logger.warn('Execution terminated', { engineId: this.engineId, sessionId });
    } catch (error) {
      logger.error('Failed to terminate execution', error, {
        engineId: this.engineId,
        sessionId,
      });
    } finally {
      terminateBudget.cleanup();
    }
  }

  getId(): string {
    return this.engineId;
  }

  getIsolationLevel(): IsolationLevel {
    return this.isolationLevel;
  }
}
