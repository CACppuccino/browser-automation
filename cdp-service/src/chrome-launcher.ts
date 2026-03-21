/**
 * Chrome launcher for dedicated per-agent browser instances.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserInstanceRecord, ServiceConfig } from './types.js';
import { getLogger } from './logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndpoint(cdpUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for Chrome endpoint ${cdpUrl}`);
}

export class ChromeLauncher {
  private config: ServiceConfig['browser']['dedicated'];

  constructor(config: ServiceConfig['browser']['dedicated']) {
    this.config = config;
  }

  async launch(agentId: string, port: number): Promise<{
    instance: BrowserInstanceRecord;
    process: ChildProcess;
  }> {
    if (!this.config.enabled) {
      throw new Error('Dedicated Chrome mode is disabled');
    }
    if (!this.config.executablePath) {
      throw new Error('Dedicated Chrome executablePath is not configured');
    }

    const logger = getLogger();
    const instanceId = `dedicated-${agentId}`;
    const userDataDir = join(this.config.userDataDirBase, sanitizeSegment(agentId));
    mkdirSync(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=${this.config.host}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--disable-popup-blocking',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-breakpad',
      '--disable-dev-shm-usage',
      '--window-size=1440,960',
      ...(this.config.headless ? ['--headless=new', '--disable-gpu'] : []),
      ...(this.config.extraArgs || []),
      'about:blank',
    ];

    logger.info('Launching dedicated Chrome instance', {
      agentId,
      port,
      userDataDir,
      headless: this.config.headless,
    });

    const childProcess = spawn(this.config.executablePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    childProcess.unref();

    if (childProcess.pid === undefined) {
      throw new Error('Failed to spawn Chrome process');
    }

    const cdpUrl = `http://${this.config.host}:${port}`;

    try {
      await waitForEndpoint(cdpUrl, this.config.startupTimeoutMs);
    } catch (error) {
      childProcess.kill();
      throw error;
    }

    const now = Date.now();
    return {
      instance: {
        instanceId,
        mode: 'dedicated',
        cdpUrl,
        ownerAgentId: agentId,
        port,
        pid: childProcess.pid,
        userDataDir,
        createdAt: now,
        lastUsedAt: now,
        status: 'ready',
      },
      process: childProcess,
    };
  }

  async shutdown(instance: BrowserInstanceRecord, childProcess?: ChildProcess): Promise<void> {
    const logger = getLogger();
    logger.info('Stopping dedicated Chrome instance', {
      instanceId: instance.instanceId,
      pid: instance.pid,
    });

    if (childProcess && !childProcess.killed) {
      childProcess.kill('SIGTERM');
      await sleep(500);
      if (!childProcess.killed) {
        childProcess.kill('SIGKILL');
      }
    } else if (instance.pid) {
      try {
        process.kill(instance.pid, 'SIGTERM');
      } catch {
        // ignore if already gone
      }
    }

    if (instance.userDataDir) {
      try {
        rmSync(instance.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
