require('dotenv').config();

const config = {
  // Bot Settings
  bot: {
    timezone: process.env.TIMEZONE || 'UTC',
    scheduledTimes: (process.env.SCHEDULED_TIMES || '07:27,11:40,12:27,13:00')
      .split(',')
      .map(t => t.trim()),
    hashtagTimes: (process.env.HASHTAG_TIME || '07:16,09:16,11:16,13:16')
      .split(',')
      .map(t => t.trim()),
    accountTimes: (process.env.ACCOUNT_TIME || '08:27,10:30')
      .split(',')
      .map(t => t.trim()),
    enableRandomMode: process.env.ENABLE_RANDOM_MODE !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // Files
  files: {
    tweets: 'tweets.json',
    usedTweets: 'used_tweets.json',
  },
};

module.exports = config;
