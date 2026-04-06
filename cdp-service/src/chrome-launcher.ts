/**
 * Chrome launcher for dedicated browser instances.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserInstanceRecord, BrowserStateMode, ProfileStorageScope, ServiceConfig } from './types.js';
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

export interface LaunchBrowserOptions {
  instanceKey: string;
  agentId: string;
  stateMode: BrowserStateMode;
  userDataDir: string;
  deleteUserDataDirOnShutdown: boolean;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
}

export class ChromeLauncher {
  private config: ServiceConfig['browser']['dedicated'];

  constructor(config: ServiceConfig['browser']['dedicated']) {
    this.config = config;
  }

  async launch(options: LaunchBrowserOptions, port: number): Promise<{
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
    mkdirSync(options.userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=${this.config.host}`,
      `--user-data-dir=${options.userDataDir}`,
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
      instanceKey: options.instanceKey,
      agentId: options.agentId,
      stateMode: options.stateMode,
      profileId: options.profileId,
      profileScope: options.profileScope,
      port,
      userDataDir: options.userDataDir,
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
        instanceId: options.instanceKey,
        instanceKey: options.instanceKey,
        mode: 'dedicated',
        stateMode: options.stateMode,
        cdpUrl,
        ownerAgentId: options.agentId,
        port,
        pid: childProcess.pid,
        userDataDir: options.userDataDir,
        profileId: options.profileId,
        profileScope: options.profileScope,
        workspacePath: options.workspacePath,
        profileRootDir: options.profileId ? options.userDataDir.replace(/\/user-data$/, '') : undefined,
        deleteUserDataDirOnShutdown: options.deleteUserDataDirOnShutdown,
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

    if (instance.userDataDir && instance.deleteUserDataDirOnShutdown) {
      try {
        rmSync(instance.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }
}
