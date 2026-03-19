/**
 * Configuration loader for CDP Service
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ServiceConfig } from './types.js';

const DEFAULT_CONFIG_PATH = './config.yaml';

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): ServiceConfig {
  try {
    const fileContents = readFileSync(configPath, 'utf8');
    const config = parse(fileContents) as ServiceConfig;

    // Substitute environment variables
    config.service.authToken = substituteEnvVars(config.service.authToken);

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
