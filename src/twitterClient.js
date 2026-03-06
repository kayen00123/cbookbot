const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class TwitterClient {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isInitialized = false;
    this.cookiesPath = path.join(__dirname, '..', 'twitter_cookies.json');
  }

  async initialize() {
    try {
      logger.info('Launching Chrome...');
      
      // Check if cookies exist
      const hasCookies = fs.existsSync(this.cookiesPath);
      
      // Launch Chrome
      this.browser = await puppeteer.launch({
        headless: false,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled'
        ]
      });

      this.page = await this.browser.newPage();
      
      // Try to load saved cookies
      if (hasCookies) {
        logger.info('Found saved cookies, loading...');
        const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
        await this.page.setCookie(...cookies);
        
        // Try to go to home
        await this.page.goto('https://twitter.com/home', { 
          waitUntil: 'domcontentloaded', 
          timeout: 100000 
        });
        await delay(3000);
        
        // Check if still logged in
        const url = this.page.url();
        if (url.includes('/home') && !url.includes('/login')) {
          logger.success('Logged in using saved cookies!');
          this.isInitialized = true;
          return true;
        } else {
          logger.warn('Cookies expired, need to login again');
        }
      }

      // Need to login
      logger.info('Opening Twitter login...');
      await this.page.goto('https://twitter.com/login', { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      logger.info('='.repeat(50));
      logger.info('🔐 Please login manually in the browser');
      logger.info('Session will be saved for next time');
      logger.info('='.repeat(50));

      // Wait for login
      await this.waitForLogin();
      
      // Save cookies
      const cookies = await this.page.cookies();
      fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies));
      logger.success('Session saved! You wont need to login next time.');
      
      this.isInitialized = true;
      return true;

    } catch (error) {
      logger.error('Failed to initialize', { error: error.message });
      return false;
    }
  }

  async waitForLogin() {
    let loggedIn = false;
    let attempts = 0;
    
    while (!loggedIn && attempts < 180) { // Wait up to 6 minutes
      await delay(2000);
      const url = this.page.url();
      
      if (url.includes('/home') && !url.includes('/login')) {
        loggedIn = true;
      }
      
      attempts++;
      if (attempts % 10 === 0) {
        logger.info(`Waiting for login... (${attempts}/180)`);
      }
    }
    
    if (loggedIn) {
      logger.success('Login successful!');
    } else {
      throw new Error('Login timeout');
    }
  }

  async tweet(text) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info('Posting tweet...');
      await this.page.goto('https://twitter.com/compose/tweet', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      await delay(4000);

      // Type tweet
      const textarea = await this.page.$('[data-testid="tweetTextarea_0"], [contenteditable="true"]');
      if (!textarea) {
        logger.error('Cannot find textarea');
        return null;
      }

      await textarea.click();
      await textarea.type(text, { delay: 50 });
      await delay(2000);
      
      // Post with Ctrl+Enter
      logger.info('Sending tweet...');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      
      await delay(4000);
      logger.success('Tweet posted!');
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to tweet', { error: error.message });
      return null;
    }
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  async searchTweets(hashtag) {
    if (!this.isInitialized) return [];
    
    try {
      logger.info(`Searching for tweets with ${hashtag}...`);
      
      // Navigate to Twitter search - use f=live to get latest tweets
      const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(hashtag)}&src=typed_query&f=live`;
      await this.page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      await delay(5000);
      
      // Wait for tweets to load
      await this.page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
      await delay(3000);
      
      // Find tweet elements - use $$ for array of elements
      const tweets = await this.page.$$('[data-testid="tweet"]');
      
      if (!tweets || tweets.length === 0) {
        logger.warn('No tweets found');
        return [];
      }
      
      logger.info(`Found ${tweets.length} tweets`);
      
      // Extract tweet data
      const tweetData = [];
      for (let i = 0; i < Math.min(tweets.length, 5); i++) {
        try {
          const tweet = tweets[i];
          const textElement = await tweet.$('[data-testid="tweetText"]');
          const text = textElement ? await textElement.evaluate(el => el.textContent) : '';
          
          // Get tweet link
          const linkElement = await tweet.$('a[href*="/status/"]');
          const link = linkElement ? await linkElement.evaluate(el => el.getAttribute('href')) : '';
          
          if (text && link) {
            tweetData.push({
              id: link.split('/').pop(),
              text: text.substring(0, 100),
              element: tweet
            });
          }
        } catch (e) {
          // Skip this tweet
        }
      }
      
      return tweetData;
      
    } catch (error) {
      logger.error('Failed to search tweets', { error: error.message });
      return [];
    }
  }

  async postComment(tweetId, comment) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info(`Posting comment on tweet ${tweetId}...`);
      
      // Navigate to the tweet
      await this.page.goto(`https://twitter.com/i/status/${tweetId}`, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      await delay(4000);
      
      // Click the reply button
      const replyButton = await this.page.$('[data-testid="reply"]');
      if (!replyButton) {
        logger.error('Cannot find reply button');
        return null;
      }
      
      await replyButton.click();
      await delay(2000);
      
      // Type the comment
      const textarea = await this.page.$('[data-testid="tweetTextarea_0"], [contenteditable="true"]');
      if (!textarea) {
        logger.error('Cannot find textarea');
        return null;
      }
      
      await textarea.click();
      await textarea.type(comment, { delay: 50 });
      await delay(2000);
      
      // Post with Ctrl+Enter
      logger.info('Sending comment...');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      
      await delay(4000);
      logger.success('Comment posted!');
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to post comment', { error: error.message });
      return null;
    }
  }
}

module.exports = new TwitterClient();
