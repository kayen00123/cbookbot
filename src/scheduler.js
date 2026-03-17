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
    
    // Schedule only the AI tweet posting jobs
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
    
    logger.info(`Scheduled ${times.length} tweet posting jobs`);
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
