const schedule = require('node-schedule');
const config = require('./config');
const logger = require('./logger');
const twitterClient = require('./twitterClient');
const tweetQueue = require('./tweetQueue');
const aiClient = require('./aiClient');

class Scheduler {
  constructor() {
    this.jobs = [];
    this.isRunning = false;
    this.lastEngagementTime = 0;
    this.engagementCooldown = 60 * 60 * 1000; // 1 hour cooldown
    
    // Accounts to monitor and comment on
    this.monitoredAccounts = ['cz_binance', 'BNBCHAIN', 'base'];
    this.accountCommentTimes = {}; // Track when we last commented on each account
    this.accountCommentCooldown = 12 * 60 * 60 * 1000; // 12 hours between comments on same account
  }

  start() {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info('Starting tweet scheduler...');
    
    // Initialize AI Client
    aiClient.initialize();
    
    this.scheduleJobs();
    this.isRunning = true;
    
    logger.success('Tweet scheduler started', {
      timezone: config.bot.timezone,
      scheduledTimes: config.bot.scheduledTimes
    });
  }

  stop() {
    logger.info('Stopping scheduler...');
    this.jobs.forEach(job => job.cancel());
    this.jobs = [];
    this.isRunning = false;
    logger.success('Scheduler stopped');
  }

  scheduleJobs() {
    const times = config.bot.scheduledTimes;
    
    times.forEach((time, index) => {
      const [hour, minute] = time.split(':').map(Number);
      
      const job = schedule.scheduleJob(
        { hour, minute },
        () => this.executeScheduledTweet()
      );
      
      if (job) {
        this.jobs.push(job);
        logger.debug(`Scheduled job ${index + 1}`, { time, hour, minute });
      } else {
        logger.error(`Failed to schedule job for ${time}`);
      }
    });

    // Schedule trending hashtag engagement every 30 minutes
    const trendingJob = schedule.scheduleJob('*/30 * * * *', () => this.engageWithTrendingHashtags());
    if (trendingJob) {
      this.jobs.push(trendingJob);
      logger.info('Scheduled trending hashtag engagement job', { interval: 'every 30 minutes' });
    }

    // Schedule account monitoring twice a day (9 AM and 9 PM)
    const accountJob1 = schedule.scheduleJob({ hour: 9, minute: 0 }, () => this.engageWithMonitoredAccounts());
    const accountJob2 = schedule.scheduleJob({ hour: 21, minute: 0 }, () => this.engageWithMonitoredAccounts());
    if (accountJob1) {
      this.jobs.push(accountJob1);
      logger.info('Scheduled account monitoring job', { time: '09:00' });
    }
    if (accountJob2) {
      this.jobs.push(accountJob2);
      logger.info('Scheduled account monitoring job', { time: '21:00' });
    }
  }

  async executeScheduledTweet() {
    logger.info('Executing scheduled tweet...');
    
    // Get topic from tweet queue
    const tweet = tweetQueue.getNextTweet();
    
    if (!tweet) {
      logger.error('No tweet available to post');
      return;
    }

    // Generate AI thread
    logger.info('Generating AI thread for topic', {
      id: tweet.id,
      category: tweet.category
    });

    // Generate thread using AI
    const threadTweets = await aiClient.generateTweetThread(tweet.text, 3);
    
    if (threadTweets && threadTweets.length > 0) {
      logger.info(`Generated ${threadTweets.length} tweets for thread`);
      
      // Post the thread
      const result = await twitterClient.postThread(threadTweets);
      
      if (result) {
        logger.success('AI thread posted successfully', {
          category: tweet.category,
          tweetCount: threadTweets.length
        });
      } else {
        logger.error('Failed to post AI thread');
      }
    } else {
      // Fallback to single tweet if AI fails
      logger.warn('AI generation failed, posting single tweet');
      const result = await twitterClient.tweet(tweet.text);
      
      if (result) {
        logger.success('Scheduled tweet posted successfully', {
          category: tweet.category
        });
      } else {
        logger.error('Failed to post scheduled tweet');
      }
    }
  }

  async engageWithTrendingHashtags() {
    try {
      // Check cooldown
      const now = Date.now();
      if (now - this.lastEngagementTime < this.engagementCooldown) {
        logger.debug('Engagement on cooldown, skipping...');
        return;
      }
      
      logger.info('Checking for trending hashtags...');
      
      // Memecoin-focused hashtags to target (recent posts with good engagement)
      const trendingHashtags = [
        '#memecoin', '#solana', '#bonk', '#dogwifhat', '#wif', '#pepe',
        '#floki', '#shiba', '#dogecoin', '#catcoin', '#turbo', '#mog',
        '#ai16z', '#goat', '#arc', '#virtuals', '#act', '#proc',
        '#bnb', '#base', '#sol', '#eth'
      ];
      
      // Find a trending hashtag
      const trendingHashtag = this.findTrendingHashtag(trendingHashtags);
      
      if (trendingHashtag) {
        logger.info(`Found trending hashtag: ${trendingHashtag}`);
        
        // Engage with the hashtag
        await this.engageWithHashtag(trendingHashtag);
      } else {
        logger.debug('No trending hashtags found');
      }
    } catch (error) {
      logger.error('Failed to engage with trending hashtags', { error: error.message });
    }
  }

  findTrendingHashtag(hashtags) {
    // Simple logic: return a random hashtag from the list
    // In a real implementation, this would check actual trending data
    const randomIndex = Math.floor(Math.random() * hashtags.length);
    return hashtags[randomIndex];
  }

  async engageWithHashtag(hashtag) {
    try {
      logger.info(`Engaging with hashtag: ${hashtag}`);
      
      // Find a relevant tweet to comment on
      const tweet = await this.findRelevantTweet(hashtag);
      
      if (tweet) {
        logger.info(`Found tweet to engage with: ${tweet.text.substring(0, 50)}...`);
        
        // Generate comment (async)
        const comment = await this.generateComment(hashtag);
        await this.postComment(tweet.id, comment);
        
        // Update last engagement time
        this.lastEngagementTime = Date.now();
        
        logger.success(`Successfully engaged with ${hashtag}!`);
      } else {
        logger.debug('No relevant tweets found to engage with');
      }
    } catch (error) {
      logger.error('Failed to engage with hashtag', { error: error.message });
    }
  }

  async findRelevantTweet(hashtag) {
    try {
      // Search for tweets with the hashtag
      const tweets = await twitterClient.searchTweets(hashtag);
      
      if (tweets.length > 0) {
        // Filter for good engagement (at least 10 likes+retweets) and within 24 hours
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
        
        // Score and filter tweets
        const scoredTweets = tweets.filter(tweet => {
          // Calculate total engagement
          const totalEngagement = (tweet.likes || 0) + (tweet.retweets || 0) + (tweet.replies || 0);
          
          // Check if it's a memecoin-related post
          const text = (tweet.text || '').toLowerCase();
          const isMemecoin = text.includes('memecoin') || 
                             text.includes('#memecoin') ||
                             text.includes('meme coin') ||
                             text.includes(hashtag.toLowerCase().replace('#', ''));
          
          // Check timestamp if available
          let isRecent = true;
          if (tweet.timestamp) {
            const tweetTime = new Date(tweet.timestamp).getTime();
            isRecent = tweetTime > twentyFourHoursAgo;
          }
          
          // Must have decent engagement OR be a direct hashtag match with some engagement
          const hasGoodEngagement = totalEngagement >= 10 || (isMemecoin && totalEngagement >= 5);
          
          return isRecent && hasGoodEngagement && (isMemecoin || totalEngagement >= 20);
        });
        
        // Sort by engagement score (highest first)
        scoredTweets.sort((a, b) => {
          const engA = (a.likes || 0) + (a.retweets || 0) + (a.replies || 0);
          const engB = (b.likes || 0) + (b.retweets || 0) + (b.replies || 0);
          return engB - engA;
        });
        
        if (scoredTweets.length > 0) {
          logger.info(`Found ${scoredTweets.length} relevant memecoin tweets with good engagement`);
          // Return the top engagement tweet
          return scoredTweets[0];
        }
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to find relevant tweet', { error: error.message });
      return null;
    }
  }

  generateComment(hashtag) {
    // Memecoin-focused comments for Cookbook DEX
    const comments = [
      `Great post! 🚀 Trade your memecoins on Cookbook DEX - lowest fees on BNB Chain & Base!`,
      `Thanks for sharing! Swap memecoins on Cookbook DEX - super low fees!`,
      `Nice take! 🔥 Trade memecoins on Cookbook DEX for the best rates!`,
      `Interesting! Don't miss out - trade memecoins on Cookbook DEX now!`,
      `Hot take! 💎 Trade your memecoins on Cookbook DEX - minimal slippage!`,
      `Great insight! Check out Cookbook DEX for trading memecoins with low fees!`,
      `That's the spirit! Trade memecoins on Cookbook DEX - fast & cheap!`
    ];
    
    return comments[Math.floor(Math.random() * comments.length)];
  }

  async postComment(tweetId, comment) {
    try {
      // Use the real twitter client to post a comment
      const result = await twitterClient.postComment(tweetId, comment);
      
      if (result) {
        logger.success('Comment posted successfully!');
        return result;
      } else {
        logger.error('Failed to post comment');
        return null;
      }
    } catch (error) {
      logger.error('Failed to post comment', { error: error.message });
      return null;
    }
  }

  // Monitor and engage with specific accounts
  async engageWithMonitoredAccounts() {
    try {
      logger.info('Checking monitored accounts for engagement...');
      
      for (const account of this.monitoredAccounts) {
        // Check cooldown for this account
        const lastCommentTime = this.accountCommentTimes[account] || 0;
        const now = Date.now();
        
        if (now - lastCommentTime < this.accountCommentCooldown) {
          logger.debug(`Account @${account} on cooldown, skipping...`);
          continue;
        }
        
        logger.info(`Checking latest tweet from @${account}...`);
        
        // Get latest tweet from account
        const tweet = await this.getLatestTweetFromAccount(account);
        
        if (tweet) {
          logger.info(`Found latest tweet from @${account}: ${tweet.text.substring(0, 50)}...`);
          
          // Generate comment (async)
          const comment = await this.generateAccountComment(account);
          
          // Post comment
          const result = await this.postComment(tweet.id, comment);
          
          if (result) {
            // Update last comment time for this account
            this.accountCommentTimes[account] = now;
            logger.success(`Successfully commented on @${account}'s tweet!`);
          }
        } else {
          logger.warn(`Could not find latest tweet from @${account}`);
        }
        
        // Wait a bit between accounts
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      logger.error('Failed to engage with monitored accounts', { error: error.message });
    }
  }

  async getLatestTweetFromAccount(account) {
    try {
      // Navigate to account's profile
      await twitterClient.page.goto(`https://twitter.com/${account}`, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      // Wait for tweets to load
      await twitterClient.page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get the first tweet (latest)
      const tweets = await twitterClient.page.$('[data-testid="tweet"]');
      
      if (!tweets || tweets.length === 0) {
        logger.warn(`No tweets found from @${account}`);
        return null;
      }
      
      const tweet = tweets[0];
      const textElement = await tweet.$('[data-testid="tweetText"]');
      const text = textElement ? await textElement.evaluate(el => el.textContent) : '';
      
      // Get tweet link
      const linkElement = await tweet.$('a[href*="/status/"]');
      const link = linkElement ? await linkElement.evaluate(el => el.getAttribute('href')) : '';
      
      if (text && link) {
        return {
          id: link.split('/').pop(),
          text: text.substring(0, 100),
          author: account
        };
      }
      
      return null;
    } catch (error) {
      logger.error(`Failed to get latest tweet from @${account}`, { error: error.message });
      return null;
    }
  }

  generateAccountComment(account) {
    // Manual predefined comments (no AI needed)
    const comments = [
      `Thanks for the update! Check out Cookbook DEX - best trading experience! 🚀`,
      `Great post! Trade on Cookbook DEX today!`,
      `Cookbook DEX is the best place to trade!`,
      `Don't miss out! Trade on Cookbook DEX now!`,
      `Hot tips! Trade on Cookbook DEX for the best rates!`
    ];
    
    return comments[Math.floor(Math.random() * comments.length)];
  }

  // Manual trigger for testing
  async triggerManualTweet(customText = null) {
    logger.info('Manual tweet triggered');
    
    let text;
    if (customText) {
      text = customText;
    } else {
      const tweet = tweetQueue.getNextTweet();
      if (!tweet) {
        logger.error('No tweet available');
        return null;
      }
      text = tweet.text;
    }

    return await twitterClient.tweet(text);
  }

  getScheduledJobs() {
    return this.jobs.map((job, index) => ({
      index,
      nextInvocation: job.nextInvocation(),
      scheduled: job.scheduled !== false
    }));
  }

  // Add a new scheduled time at runtime
  addScheduledTime(time) {
    const [hour, minute] = time.split(':').map(Number);
    
    const job = schedule.scheduleJob(
      { hour, minute },
      () => this.executeScheduledTweet()
    );
    
    if (job) {
      this.jobs.push(job);
      logger.success('Added new scheduled time', { time });
      return true;
    }
    
    return false;
  }

  // Remove a scheduled time at runtime
  removeScheduledTime(index) {
    if (this.jobs[index]) {
      this.jobs[index].cancel();
      this.jobs.splice(index, 1);
      logger.success('Removed scheduled time', { index });
      return true;
    }
    return false;
  }
}

module.exports = new Scheduler();
