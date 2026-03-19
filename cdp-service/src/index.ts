/**
 * CDP Service Entry Point
 */
import { loadConfig } from './config-loader.js';
import { initLogger, getLogger } from './logger.js';
import { ServiceManager } from './service-manager.js';

async function main() {
  try {
    // Load configuration
    const configPath = process.argv[2] || './config.yaml';
    const config = loadConfig(configPath);

    // Initialize logger
    initLogger(config);
    const logger = getLogger();

    logger.info('CDP Service initializing', { configPath });

    // Create and start service
    const serviceManager = new ServiceManager(config);
    const serviceInfo = await serviceManager.start();

    logger.info('CDP Service ready', serviceInfo as unknown as Record<string, unknown>);

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
