const logger = require('./logger');
const config = require('./config');
const twitterClient = require('./twitterClient');
const tweetQueue = require('./tweetQueue');
const scheduler = require('./scheduler');

class TwitterBot {
  constructor() {
    this.isRunning = false;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('🚀 Twitter DEX Bot Starting...');
    logger.info('='.repeat(50));

    // Display configuration
    this.displayConfig();

    // Initialize Twitter client (browser automation)
    logger.info('Initializing Twitter browser...');
    const initialized = await twitterClient.initialize();
    
    if (!initialized) {
      logger.error('Failed to initialize Twitter. Please try again.');
      process.exit(1);
    }

    // Display tweet queue stats
    const stats = tweetQueue.getStats();
    logger.info('Tweet queue stats', stats);

    // Skip test tweet - bot is verified by manual login
    logger.info('Skipping test tweet - manual login verified');

    // Start the scheduler
    scheduler.start();

    this.isRunning = true;
    logger.info('='.repeat(50));
    logger.success('🎉 Twitter DEX Bot is now running!');
    logger.info('='.repeat(50));

    // Handle graceful shutdown
    this.setupGracefulShutdown();
  }

  displayConfig() {
    logger.info('Configuration:');
    logger.info(`  Timezone: ${config.bot.timezone}`);
    logger.info(`  Scheduled Times: ${config.bot.scheduledTimes.join(', ')}`);
    logger.info(`  Random Mode: ${config.bot.enableRandomMode}`);
    logger.info(`  Log Level: ${config.bot.logLevel}`);
    logger.info('');
  }

  setupGracefulShutdown() {
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await this.shutdown();
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await this.shutdown();
    });

    // Handle errors without shutting down
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      // Don't shutdown, continue running
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('Unhandled rejection', { reason });
      // Don't shutdown, continue running
    });
  }

  async shutdown() {
    logger.info('Shutting down...');
    scheduler.stop();
    await twitterClient.close();
    this.isRunning = false;
    logger.success('Bot shutdown complete');
    process.exit(0);
  }

  // Manual tweet method
  async manualTweet(text) {
    return await scheduler.triggerManualTweet(text);
  }

  // Get bot status
  getStatus() {
    return {
      isRunning: this.isRunning,
      scheduledJobs: scheduler.getScheduledJobs(),
      tweetQueue: tweetQueue.getStats(),
      timezone: config.bot.timezone
    };
  }
}

// Export for use in other modules
module.exports = TwitterBot;

// Start the bot if this is the main module
if (require.main === module) {
  const bot = new TwitterBot();
  bot.start();
  
  // Expose bot instance globally for testing/console access
  global.twitterBot = bot;
}
