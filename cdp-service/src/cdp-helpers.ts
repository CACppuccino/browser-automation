/**
 * CDP Helpers - Low-level CDP communication utilities
 * Adapted from openclaw/src/browser/cdp.helpers.ts
 */
import WebSocket from 'ws';
import type { Budget } from './types.js';
import { getBudgetManager } from './budget-manager.js';
import { getLogger } from './logger.js';

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
) => Promise<unknown>;

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string; code?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Create a CDP sender function for a WebSocket
 */
export function createCdpSender(ws: WebSocket): CdpSendFn {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };

    ws.send(JSON.stringify(msg));

    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on('error', (err) => {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as CdpResponse;
      if (typeof parsed.id !== 'number') {
        return;
      }

      const p = pending.get(parsed.id);
      if (!p) {
        return;
      }

      pending.delete(parsed.id);

      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
        return;
      }

      p.resolve(parsed.result);
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    closeWithError(new Error('CDP socket closed'));
  });

  return send;
}

/**
 * Execute a CDP command with budget timeout
 */
export async function sendWithBudget<T>(
  sender: CdpSendFn,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  budget: Budget
): Promise<T> {
  const logger = getLogger();
  const budgetManager = getBudgetManager();

  if (budget.remainingMs() <= 0) {
    throw new Error(`Budget exceeded before ${method}`);
  }

  logger.debug(`CDP command: ${method}`, {
    sessionId,
    remainingMs: budget.remainingMs(),
  });

  const promise = sender(method, params, sessionId) as Promise<T>;

  return budgetManager.raceWithBudget(
    budget,
    promise,
    `CDP ${method} timeout (${budget.timeoutMs}ms)`
  );
}

/**
 * Open a WebSocket to CDP endpoint
 */
export async function openCdpWebSocket(
  wsUrl: string,
  budget: Budget
): Promise<WebSocket> {
  const logger = getLogger();

  return new Promise<WebSocket>((resolve, reject) => {
    let completed = false;

    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: Math.min(5000, budget.remainingMs()),
    });

    const cleanup = () => {
      ws.removeAllListeners();
    };

    const abortHandler = () => {
      if (!completed) {
        completed = true;
        cleanup();
        ws.close();
        reject(new Error('WebSocket connection aborted'));
      }
    };

    budget.signal.addEventListener('abort', abortHandler, { once: true });

    ws.on('open', () => {
      if (!completed) {
        completed = true;
        budget.signal.removeEventListener('abort', abortHandler);
        logger.debug('CDP WebSocket connected', { wsUrl });
        resolve(ws);
      }
    });

    ws.on('error', (err) => {
      if (!completed) {
        completed = true;
        cleanup();
        budget.signal.removeEventListener('abort', abortHandler);
        logger.error('CDP WebSocket error', err);
        reject(err);
      }
    });
  });
}

/**
 * Get WebSocket URL from CDP endpoint
 * Gets first available page or creates one if none exist
 */
export async function getCdpWebSocketUrl(
  cdpUrl: string,
  budget: Budget
): Promise<string> {
  const logger = getLogger();

  // If already a WebSocket URL, return as-is
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
    return cdpUrl;
  }

  try {
    const controller = new AbortController();
    budget.signal.addEventListener('abort', () => controller.abort(), { once: true });

    // Get list of targets/pages
    const listUrl = `${cdpUrl}/json/list`;
    logger.debug('Fetching CDP targets', { listUrl });

    const listResponse = await fetch(listUrl, {
      signal: controller.signal,
    });

    if (!listResponse.ok) {
      throw new Error(`HTTP ${listResponse.status}: ${listResponse.statusText}`);
    }

    const targets = await listResponse.json() as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
      url?: string;
    }>;

    // Find first page target
    const pageTarget = targets.find(t => t.type === 'page');

    if (pageTarget?.webSocketDebuggerUrl) {
      logger.debug('Using existing page', { url: pageTarget.url });
      return pageTarget.webSocketDebuggerUrl;
    }

    // No page found, create new one
    logger.debug('Creating new page');
    const newPageUrl = `${cdpUrl}/json/new`;
    const newResponse = await fetch(newPageUrl, {
      method: 'PUT',
      signal: controller.signal,
    });

    if (!newResponse.ok) {
      throw new Error(`Failed to create page: HTTP ${newResponse.status}`);
    }

    const newPage = await newResponse.json() as { webSocketDebuggerUrl?: string };

    if (!newPage.webSocketDebuggerUrl) {
      throw new Error('No webSocketDebuggerUrl in new page response');
    }

    return newPage.webSocketDebuggerUrl;
  } catch (error) {
    logger.error('Failed to get CDP WebSocket URL', error);
    throw error;
  }
}
