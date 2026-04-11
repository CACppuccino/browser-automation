/**
 * CDP Helpers - Low-level CDP communication utilities
 * Adapted from an earlier browser automation implementation
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

export interface CdpTargetInfo {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

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

async function fetchJson<T>(
  url: string,
  budget: Budget,
  init?: RequestInit
): Promise<T> {
  const logger = getLogger();
  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  budget.signal.addEventListener('abort', abortHandler, { once: true });

  try {
    logger.debug('Fetching CDP HTTP endpoint', {
      url,
      method: init?.method || 'GET',
      remainingMs: budget.remainingMs(),
    });

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    budget.signal.removeEventListener('abort', abortHandler);
  }
}

function assertHttpCdpUrl(cdpUrl: string): void {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
    throw new Error(`HTTP CDP endpoint required, got WebSocket URL: ${cdpUrl}`);
  }
}

/**
 * Get the browser-level WebSocket URL from a CDP HTTP endpoint.
 */
export async function getBrowserWebSocketUrl(
  cdpUrl: string,
  budget: Budget
): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
    return cdpUrl;
  }

  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `${cdpUrl}/json/version`,
    budget
  );

  if (!version.webSocketDebuggerUrl) {
    throw new Error(`No browser webSocketDebuggerUrl found for ${cdpUrl}`);
  }

  return version.webSocketDebuggerUrl;
}

/**
 * List all page targets for a CDP HTTP endpoint.
 */
export async function listPageTargets(
  cdpUrl: string,
  budget: Budget
): Promise<CdpTargetInfo[]> {
  assertHttpCdpUrl(cdpUrl);

  const targets = await fetchJson<CdpTargetInfo[]>(`${cdpUrl}/json/list`, budget);
  return targets.filter((target) => target.type === 'page');
}

/**
 * Check whether a specific page target exists.
 */
export async function targetExists(
  cdpUrl: string,
  targetId: string,
  budget: Budget
): Promise<boolean> {
  const targets = await listPageTargets(cdpUrl, budget);
  return targets.some((target) => target.id === targetId);
}

/**
 * Resolve the target-level WebSocket URL for a specific page target.
 */
export async function getTargetWebSocketUrl(
  cdpUrl: string,
  targetId: string,
  budget: Budget
): Promise<string> {
  const targets = await listPageTargets(cdpUrl, budget);
  const target = targets.find((candidate) => candidate.id === targetId);

  if (!target) {
    throw new Error(`Target ${targetId} not found at ${cdpUrl}`);
  }

  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Target ${targetId} has no webSocketDebuggerUrl`);
  }

  return target.webSocketDebuggerUrl;
}

/**
 * Create a new page target.
 */
export async function createPageTarget(
  cdpUrl: string,
  url: string,
  budget: Budget
): Promise<CdpTargetInfo> {
  assertHttpCdpUrl(cdpUrl);
  return fetchJson<CdpTargetInfo>(
    `${cdpUrl}/json/new?${encodeURIComponent(url)}`,
    budget,
    { method: 'PUT' }
  );
}

/**
 * Delete a page target.
 */
export async function deleteTarget(
  cdpUrl: string,
  targetId: string,
  budget: Budget
): Promise<void> {
  assertHttpCdpUrl(cdpUrl);
  await fetchJson<unknown>(`${cdpUrl}/json/close/${targetId}`, budget);
}

/**
 * Backward-compatible alias for callers that only need a browser WebSocket URL.
 */
export async function getCdpWebSocketUrl(
  cdpUrl: string,
  budget: Budget
): Promise<string> {
  return getBrowserWebSocketUrl(cdpUrl, budget);
}
