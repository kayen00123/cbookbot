const schedule = require('node-schedule');
const config = require('./config');
const logger = require('./logger');
const twitterClient = require('./twitterClient');
const tweetQueue = require('./tweetQueue');
const aiClient = require('./aiClient');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Scheduler {
  constructor() {
    this.jobs = [];
    this.isRunning = false;
    this.isExecutingTweet = false;
    this.lastEngagementTime = 0;
    this.engagementCooldown = 60 * 60 * 1000; // 1 hour cooldown

    // Already-commented tweet IDs persistence
    this.commentedStorePath = path.join(__dirname, '..', 'user-data', 'commented_tweets.json');
    this.ensureCommentedStore();

    // Already-posted content signatures persistence (to avoid duplicate tweets/threads)
    this.postedStorePath = path.join(__dirname, '..', 'user-data', 'posted_content.json');
    this.ensurePostedStore();
    
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

    // Schedule hashtag engagement at specific times (from HASHTAG_TIME env var)
    const hashtagTimes = config.bot.hashtagTimes || [];
    if (hashtagTimes.length > 0) {
      for (const time of hashtagTimes) {
        const [hashtagHour, hashtagMinute] = time.split(':').map(Number);
        const hashtagJob = schedule.scheduleJob(
          { hour: hashtagHour, minute: hashtagMinute },
          () => this.engageWithTrendingHashtags()
        );
        if (hashtagJob) {
          this.jobs.push(hashtagJob);
          logger.info('Scheduled hashtag engagement job', { time: time });
        }
      }
    } else {
      // Default: run every 30 minutes if no specific time set
      const trendingJob = schedule.scheduleJob('*/30 * * * *', () => this.engageWithTrendingHashtags());
      if (trendingJob) {
        this.jobs.push(trendingJob);
        logger.info('Scheduled trending hashtag engagement job', { interval: 'every 30 minutes' });
      }
    }

    // Schedule account monitoring at specific times (from ACCOUNT_TIME env var)
    const accountTimes = config.bot.accountTimes || [];
    if (accountTimes.length > 0) {
      for (const time of accountTimes) {
        const [accountHour, accountMinute] = time.split(':').map(Number);
        const accountJob = schedule.scheduleJob(
          { hour: accountHour, minute: accountMinute },
          () => this.engageWithMonitoredAccounts()
        );
        if (accountJob) {
          this.jobs.push(accountJob);
          logger.info('Scheduled account monitoring job', { time: time });
        }
      }
    } else {
      // Default: run at 9 AM and 9 PM if no time set
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
  }

  async executeScheduledTweet() {
    // Prevent concurrent executions
    if (this.isExecutingTweet) {
      logger.debug('Scheduled tweet already in progress, skipping...');
      return;
    }
    
    this.isExecutingTweet = true;
    
    try {
      logger.info('Executing scheduled tweet...');

      // Load next prompt from rotation
      const prompt = this.getNextPromptFromRotation();
      logger.info('Generating AI thread for prompt:', prompt);

      // Generate thread using AI with de-duplication of content
      let threadTweets = await aiClient.generateTweetThread(prompt, 3);

      // Attempt regeneration up to 3 times if content was posted before
      let attempts = 0;
      while (threadTweets && threadTweets.length > 0 && attempts < 3) {
        const sig = this.getContentSignature(threadTweets);
        if (!this.hasPostedSignature(sig)) break;
        logger.warn('Generated thread matches a previously posted thread; regenerating...');
        attempts++;
        threadTweets = await aiClient.generateTweetThread(prompt, 3);
      }
      
      if (threadTweets && threadTweets.length > 0) {
        logger.info(`Generated ${threadTweets.length} tweets for thread`);

        // Final duplicate check before posting
        const sig = this.getContentSignature(threadTweets);
        if (this.hasPostedSignature(sig)) {
          logger.warn('Thread content still duplicates a previous post after regeneration attempts; skipping this schedule');
        } else {
          // Post the thread
          const result = await twitterClient.postThread(threadTweets);
          
          if (result) {
            // Record signature to prevent duplicates
            this.savePostedSignature(sig);
            logger.success('AI thread posted successfully', { tweetCount: threadTweets.length });
          } else {
            logger.error('Failed to post AI thread');
          }
        }
      } else {
        // Fallback to single tweet if AI fails
        logger.warn('AI generation failed, attempting single tweet');
        const singleText = prompt;
        const singleSig = this.getContentSignature(singleText);
        if (this.hasPostedSignature(singleSig)) {
          logger.warn('Single tweet content duplicates a previous post; skipping this schedule');
        } else {
          const result = await twitterClient.tweet(singleText);
          if (result) {
            this.savePostedSignature(singleSig);
            logger.success('Scheduled tweet posted successfully');
          } else {
            logger.error('Failed to post scheduled tweet');
          }
        }
      }
    } finally {
      this.isExecutingTweet = false;
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
      
      // Always target #memecoin - no random hashtags
      const targetHashtag = '#memecoin';
      
      logger.info(`Targeting hashtag: ${targetHashtag}`);
      
      // Engage with memecoin hashtag
      await this.engageWithHashtag(targetHashtag);
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
        const result = await this.postComment(tweet.id, comment);

        if (result) {
          // Persist commented tweet id
          this.saveCommentedTweetId(tweet.id);
          // Update last engagement time
          this.lastEngagementTime = Date.now();
          logger.success(`Successfully engaged with ${hashtag}!`);
        }
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
      
      logger.info(`Found ${tweets.length} total tweets to filter`);

      // Load already-commented tweet IDs
      const commented = this.loadCommentedTweetIds();
      const commentedSet = new Set(commented);
      
      if (tweets.length > 0) {
        // Filter for tweets within the last month (30 days) and with good engagement
        const now = Date.now();
        const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000); // 30 days in milliseconds
        
        // Score and filter tweets
        const scoredTweets = tweets.filter(tweet => {
          // Skip already-commented tweets
          if (!tweet.id || commentedSet.has(tweet.id)) {
            return false;
          }

          // Calculate total engagement (proxy for impressions)
          const totalEngagement = (tweet.likes || 0) + (tweet.retweets || 0) + (tweet.replies || 0);

          // Check if it's a memecoin-related post
          const text = (tweet.text || '').toLowerCase();
          const isMemecoin = text.includes('memecoin') ||
                             text.includes('#memecoin') ||
                             text.includes('meme coin') ||
                             text.includes(hashtag.toLowerCase().replace('#', ''));

          // Check timestamp if available - allow tweets from last 30 days
          let isRecent = true;
          if (tweet.timestamp) {
            const tweetTime = new Date(tweet.timestamp).getTime();
            isRecent = tweetTime > thirtyDaysAgo;
          }

          // Only engage if total engagement >= 100
          const hasGoodEngagement = totalEngagement >= 100;

          const passes = isRecent && hasGoodEngagement;

          logger.info(`Tweet: id=${tweet.id}, engagement=${totalEngagement}, alreadyCommented=${commentedSet.has(tweet.id)}, isMemecoin=${isMemecoin}, isRecent=${isRecent}, passes=${passes}`);

          return passes;
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
    // Cookbook DEX promotion comment
    const comment = `Introducing cookbook dex,

For Traders
✨ Earn reward points just for trading
⚡ Access and trade new tokens instantly at launch on a high performance orderbook.
📊 Trade across thousands of pairs freely

For Token Owners
🚀 List tokens instantly — zero listing fees.`;
    
    return comment;
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
            // Save the commented tweet ID (with account prefix to avoid duplicates across accounts)
            this.saveCommentedTweetId(`${account}_${tweet.id}`);
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
      
      // Get multiple tweets and detect pinned/reposts from social context
      const tweetsData = await twitterClient.page.evaluate(() => {
        const tweetEls = Array.from(document.querySelectorAll('[data-testid="tweet"]')).slice(0, 12);
        const results = [];
        for (const tweet of tweetEls) {
          const ctxEl = tweet.querySelector('[data-testid="socialContext"]');
          const ctx = ctxEl ? (ctxEl.textContent || '').toLowerCase() : '';
          const isPinned = /pinned/.test(ctx);
          const isRepost = /(reposted|retweeted)/.test(ctx);
          const isReply = /replying to/.test(ctx);

          const textEl = tweet.querySelector('[data-testid="tweetText"]');
          const text = textEl ? textEl.textContent : '';

          const linkEl = tweet.querySelector('a[href*="/status/"]');
          const link = linkEl ? linkEl.getAttribute('href') : '';

          results.push({ text, link, isPinned, isRepost, isReply });
        }
        return results;
      });

      // Filter out pinned and repost tweets, pick the first valid original post
      const validTweets = tweetsData.filter(t => !t.isPinned && !t.isRepost && t.text && t.link);
      
      if (validTweets.length === 0) {
        logger.warn(`No valid (non-pinned, non-retweet) tweets found from @${account}`);
        return null;
      }
      
      // Get the first valid tweet
      const tweetData = validTweets[0];
      
      // Check if we've already commented on this tweet
      const tweetId = tweetData.link.split('/').pop();
      const commentedIds = this.loadCommentedTweetIds();
      if (commentedIds.includes(`${account}_${tweetId}`)) {
        logger.info(`Already commented on @${account}'s tweet ${tweetId}, skipping...`);
        return null;
      }
      
      logger.info(`Found valid tweet from @${account}: ${tweetData.text.substring(0, 50)}... (pinned=${tweetData.isPinned}, repost=${tweetData.isRepost})`);
      
      return {
        id: tweetId,
        text: tweetData.text.substring(0, 100),
        author: account
      };
    } catch (error) {
      logger.error(`Failed to get latest tweet from @${account}`, { error: error.message });
      return null;
    }
  }

  generateAccountComment(account) {
    // Cookbook DEX promotion comment
    const comment = `Introducing cookbook dex,

For Traders
✨ Earn reward points just for trading
⚡ Access and trade new tokens instantly at launch on a high performance orderbook.
📊 Trade across thousands of pairs freely

For Token Owners
🚀 List tokens instantly — zero listing fees.`;
    
    return comment;
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

    const sig = this.getContentSignature(text);
    if (this.hasPostedSignature(sig)) {
      logger.warn('Manual tweet matches previously posted content; aborting to avoid duplicate');
      return null;
    }

    const res = await twitterClient.tweet(text);
    if (res) this.savePostedSignature(sig);
    return res;
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
// ===== Persistence: commented tweet IDs =====
  ensureCommentedStore() {
    try {
      const dir = path.dirname(this.commentedStorePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.commentedStorePath)) {
        fs.writeFileSync(this.commentedStorePath, JSON.stringify({ tweetIds: [] }, null, 2));
      }
    } catch (e) {
      logger.error('Failed to ensure commented store', { error: e.message });
    }
  }

  loadCommentedTweetIds() {
    try {
      if (!fs.existsSync(this.commentedStorePath)) this.ensureCommentedStore();
      const raw = fs.readFileSync(this.commentedStorePath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.tweetIds) ? data.tweetIds : [];
    } catch (e) {
      logger.warn('Failed to read commented store, recreating', { error: e.message });
      this.ensureCommentedStore();
      return [];
    }
  }

  saveCommentedTweetId(id) {
    if (!id) return;
    try {
      const list = this.loadCommentedTweetIds();
      if (list.includes(id)) return;
      list.unshift(id);
      // Cap size to avoid unbounded growth
      const capped = list.slice(0, 1000);
      fs.writeFileSync(this.commentedStorePath, JSON.stringify({ tweetIds: capped }, null, 2));
      logger.info('Recorded commented tweet ID', { id });
    } catch (e) {
      logger.error('Failed to save commented tweet ID', { error: e.message });
    }
  }
// ===== Persistence: posted content signatures =====
  ensurePostedStore() {
    try {
      const dir = path.dirname(this.postedStorePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.postedStorePath)) {
        fs.writeFileSync(this.postedStorePath, JSON.stringify({ signatures: [] }, null, 2));
      }
    } catch (e) {
      logger.error('Failed to ensure posted store', { error: e.message });
    }
  }

  loadPostedSignatures() {
    try {
      if (!fs.existsSync(this.postedStorePath)) this.ensurePostedStore();
      const raw = fs.readFileSync(this.postedStorePath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.signatures) ? data.signatures : [];
    } catch (e) {
      logger.warn('Failed to read posted store, recreating', { error: e.message });
      this.ensurePostedStore();
      return [];
    }
  }

  hasPostedSignature(sig) {
    if (!sig) return false;
    const list = this.loadPostedSignatures();
    return list.includes(sig);
  }

  savePostedSignature(sig) {
    if (!sig) return;
    try {
      const list = this.loadPostedSignatures();
      if (list.includes(sig)) return;
      list.unshift(sig);
      const capped = list.slice(0, 2000);
      fs.writeFileSync(this.postedStorePath, JSON.stringify({ signatures: capped }, null, 2));
    } catch (e) {
      logger.error('Failed to save posted signature', { error: e.message });
    }
  }

  // Compute a stable signature for a single tweet or a thread (array of strings)
  getContentSignature(content) {
    let normalized;
    if (Array.isArray(content)) {
      normalized = content.map((t) => this.normalizeText(t)).join('\n---\n');
    } else {
      normalized = this.normalizeText(String(content || ''));
    }
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  normalizeText(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '') // strip URLs
      .replace(/[#@][\w_]+/g, '') // strip hashtags and mentions
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim();
  }
// ===== Prompt rotation helpers =====
  getNextPromptFromRotation() {
    try {
      const promptsPath = path.join(__dirname, '..', 'user-data', 'prompts.json');
      const idxPath = path.join(__dirname, '..', 'user-data', 'prompt_index.json');

      const promptsRaw = fs.readFileSync(promptsPath, 'utf8');
      const prompts = JSON.parse(promptsRaw);
      if (!Array.isArray(prompts) || prompts.length === 0) return 'Share an engaging thread about our DEX orderbook on BNB/Base.';

      let idxData = { index: 0 };
      if (fs.existsSync(idxPath)) {
        try { idxData = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
      }
      const i = Number.isInteger(idxData.index) ? idxData.index : 0;
      const prompt = prompts[i % prompts.length];

      // advance index and persist
      const next = (i + 1) % prompts.length;
      fs.writeFileSync(idxPath, JSON.stringify({ index: next }, null, 2));
      return prompt;
    } catch (e) {
      logger.warn('Prompt rotation failed, using fallback prompt', { error: e.message });
      return 'Explain how our decentralized orderbook gives precise, no-slippage trades on BNB/Base.';
    }
  }
}

module.exports = new Scheduler();
