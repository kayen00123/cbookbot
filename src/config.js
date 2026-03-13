require('dotenv').config();

const config = {
  // Bot Settings
  bot: {
    timezone: process.env.TIMEZONE || 'UTC',
    scheduledTimes: (process.env.SCHEDULED_TIMES || '20:10,20:40,18:12,22:17')
      .split(',')
      .map(t => t.trim()),
    hashtagTimes: (process.env.HASHTAG_TIME || '20:20,20:48')
      .split(',')
      .map(t => t.trim()),
    accountTimes: (process.env.ACCOUNT_TIME || '13:27,20:30')
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
