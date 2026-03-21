/**
 * Configuration loader for CDP Service
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { ServiceConfig } from './types.js';

const DEFAULT_CONFIG_PATH = './config.yaml';

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): ServiceConfig {
  try {
    const fileContents = readFileSync(configPath, 'utf8');
    const config = parse(fileContents) as ServiceConfig;

    // Substitute environment variables
    config.service.authToken = substituteEnvVars(config.service.authToken);

    if (config.browser?.dedicated?.executablePath) {
      config.browser.dedicated.executablePath = substituteEnvVars(config.browser.dedicated.executablePath);
    }

    if (config.browser?.dedicated?.userDataDirBase) {
      config.browser.dedicated.userDataDirBase = resolve(
        substituteEnvVars(config.browser.dedicated.userDataDirBase)
      );
      mkdirSync(config.browser.dedicated.userDataDirBase, { recursive: true });
    }

    // Validate configuration
    validateConfig(config);

    return config;
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error}`);
  }
}

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const result = process.env[envVar];
    if (!result) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return result;
  });
}

function validateConfig(config: ServiceConfig): void {
  if (!config.service?.host) {
    throw new Error('service.host is required');
  }
  if (!config.service?.port || config.service.port < 1 || config.service.port > 65535) {
    throw new Error('service.port must be between 1 and 65535');
  }
  if (!config.service?.authToken) {
    throw new Error('service.authToken is required');
  }
  if (!config.cdp?.endpoints || config.cdp.endpoints.length === 0) {
    throw new Error('At least one CDP endpoint is required');
  }

  // Validate CDP endpoints
  for (const endpoint of config.cdp.endpoints) {
    try {
      new URL(endpoint.url);
    } catch {
      throw new Error(`Invalid CDP endpoint URL: ${endpoint.url}`);
    }
    if (endpoint.weight < 0) {
      throw new Error(`CDP endpoint weight must be >= 0: ${endpoint.url}`);
    }
  }

  if (!config.browser) {
    throw new Error('browser configuration is required');
  }

  if (!config.browser.shared?.cdpUrl) {
    throw new Error('browser.shared.cdpUrl is required');
  }

  try {
    new URL(config.browser.shared.cdpUrl);
  } catch {
    throw new Error(`Invalid browser.shared.cdpUrl: ${config.browser.shared.cdpUrl}`);
  }

  if (!['shared', 'dedicated'].includes(config.browser.defaultMode)) {
    throw new Error('browser.defaultMode must be shared or dedicated');
  }

  if (!config.browser.target?.createUrl) {
    throw new Error('browser.target.createUrl is required');
  }

  if (config.browser.cleanupIntervalMs < 1000) {
    throw new Error('browser.cleanupIntervalMs must be at least 1000ms');
  }

  const dedicated = config.browser.dedicated;
  if (dedicated.enabled) {
    if (!dedicated.executablePath) {
      throw new Error('browser.dedicated.executablePath is required when dedicated mode is enabled');
    }
    if (!dedicated.host) {
      throw new Error('browser.dedicated.host is required when dedicated mode is enabled');
    }
    if (dedicated.startingPort < 1024 || dedicated.startingPort > 65535) {
      throw new Error('browser.dedicated.startingPort must be between 1024 and 65535');
    }
    if (dedicated.maxInstances < 1) {
      throw new Error('browser.dedicated.maxInstances must be at least 1');
    }
    if (dedicated.idleTimeoutMs < 1000) {
      throw new Error('browser.dedicated.idleTimeoutMs must be at least 1000ms');
    }
    if (dedicated.startupTimeoutMs < 1000) {
      throw new Error('browser.dedicated.startupTimeoutMs must be at least 1000ms');
    }
    if (!dedicated.userDataDirBase) {
      throw new Error('browser.dedicated.userDataDirBase is required when dedicated mode is enabled');
    }
  } else if (config.browser.defaultMode === 'dedicated') {
    throw new Error('browser.defaultMode cannot be dedicated when browser.dedicated.enabled is false');
  }
}

export function getDefaultConfig(): ServiceConfig {
  return {
    service: {
      host: '127.0.0.1',
      port: 3100,
      authToken: process.env.CDP_SERVICE_TOKEN || '',
    },
    isolation: {
      strategy: 'dynamic',
      default: 'context',
      rules: [],
    },
    cdp: {
      endpoints: [
        {
          url: 'http://localhost:9222',
          weight: 1,
        },
      ],
      connectionPool: {
        maxPerEndpoint: 10,
        idleTimeoutMs: 300000,
      },
    },
    browser: {
      defaultMode: 'shared',
      shared: {
        cdpUrl: 'http://localhost:9222',
      },
      dedicated: {
        enabled: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        host: '127.0.0.1',
        startingPort: 9230,
        maxInstances: 10,
        idleTimeoutMs: 300000,
        startupTimeoutMs: 15000,
        headless: false,
        userDataDirBase: resolve('/tmp/browser-automation-sessions'),
        extraArgs: [],
      },
      target: {
        createUrl: 'about:blank',
        enforceOwnership: true,
        allowClientTargetOverride: false,
      },
      cleanupIntervalMs: 30000,
    },
    timeouts: {
      defaultBudgetMs: 30000,
      maxBudgetMs: 120000,
      gracefulTerminationMs: 5000,
    },
    monitoring: {
      metricsPort: 3101,
      logLevel: 'info',
      enableTracing: false,
    },
  };
}
