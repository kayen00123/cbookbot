require('dotenv').config();

const config = {
  // Bot Settings
  bot: {
    timezone: process.env.TIMEZONE || 'UTC',
    scheduledTimes: (process.env.SCHEDULED_TIMES || '12:00,15:00,18:00,21:00,00:00')
      .split(',')
      .map(t => t.trim()),
    enableRandomMode: process.env.ENABLE_RANDOM_MODE === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // Files
  files: {
    tweets: 'tweets.json',
    usedTweets: 'used_tweets.json',
  },
};

module.exports = config;
