const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class TweetQueue {
  constructor() {
    this.tweets = [];
    this.usedTweetIds = new Set();
    this.loadTweets();
  }

  loadTweets() {
    try {
      const tweetsPath = path.join(__dirname, '..', config.files.tweets);
      const data = JSON.parse(fs.readFileSync(tweetsPath, 'utf8'));
      this.tweets = data.tweets || [];
      logger.info(`Loaded ${this.tweets.length} tweets from file`);
    } catch (error) {
      logger.error('Failed to load tweets', { error: error.message });
      this.tweets = [];
    }
  }

  loadUsedTweets() {
    try {
      const usedPath = path.join(__dirname, '..', config.files.usedTweets);
      if (fs.existsSync(usedPath)) {
        const data = JSON.parse(fs.readFileSync(usedPath, 'utf8'));
        this.usedTweetIds = new Set(data.usedIds || []);
        logger.info(`Loaded ${this.usedTweetIds.size} used tweet IDs`);
      }
    } catch (error) {
      logger.error('Failed to load used tweets', { error: error.message });
      this.usedTweetIds = new Set();
    }
  }

  saveUsedTweets() {
    try {
      const usedPath = path.join(__dirname, '..', config.files.usedTweets);
      const data = {
        usedIds: Array.from(this.usedTweetIds),
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(usedPath, JSON.stringify(data, null, 2));
      logger.debug('Saved used tweets', { count: this.usedTweetIds.size });
    } catch (error) {
      logger.error('Failed to save used tweets', { error: error.message });
    }
  }

  getNextTweet() {
    if (config.bot.enableRandomMode) {
      return this.getRandomTweet();
    } else {
      return this.getSequentialTweet();
    }
  }

  getRandomTweet() {
    // Filter out used tweets if we have unused ones
    const unusedTweets = this.tweets.filter(t => !this.usedTweetIds.has(t.id));
    
    // If all tweets have been used, reset the pool
    if (unusedTweets.length === 0) {
      logger.info('All tweets have been used, resetting pool');
      this.usedTweetIds.clear();
      this.saveUsedTweets();
      return this.getRandomTweet();
    }

    const randomIndex = Math.floor(Math.random() * unusedTweets.length);
    const selectedTweet = unusedTweets[randomIndex];
    
    // Mark as used
    this.usedTweetIds.add(selectedTweet.id);
    this.saveUsedTweets();

    logger.debug('Selected random tweet', { 
      id: selectedTweet.id,
      category: selectedTweet.category 
    });

    return selectedTweet;
  }

  getSequentialTweet() {
    if (this.tweets.length === 0) {
      logger.warn('No tweets available');
      return null;
    }

    // Get the first tweet that hasn't been used
    const nextTweet = this.tweets.find(t => !this.usedTweetIds.has(t.id));
    
    if (!nextTweet) {
      // All tweets used, reset
      logger.info('All tweets have been used, resetting pool');
      this.usedTweetIds.clear();
      this.saveUsedTweets();
      return this.tweets[0];
    }

    // Mark as used
    this.usedTweetIds.add(nextTweet.id);
    this.saveUsedTweets();

    logger.debug('Selected sequential tweet', { 
      id: nextTweet.id,
      category: nextTweet.category 
    });

    return nextTweet;
  }

  getTweetById(id) {
    return this.tweets.find(t => t.id === id);
  }

  getTweetsByCategory(category) {
    return this.tweets.filter(t => t.category === category);
  }

  getAvailableCategories() {
    const categories = new Set(this.tweets.map(t => t.category));
    return Array.from(categories);
  }

  getStats() {
    return {
      totalTweets: this.tweets.length,
      usedTweets: this.usedTweetIds.size,
      availableTweets: this.tweets.length - this.usedTweetIds.size,
      categories: this.getAvailableCategories()
    };
  }
}

module.exports = new TweetQueue();
