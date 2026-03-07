const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Download base64 image and save to file
async function downloadBase64Image(base64Data, filename) {
  try {
    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Image, 'base64');
    const filepath = path.join(__dirname, '..', 'temp_images', filename);
    
    // Create temp_images directory if it doesn't exist
    const dir = path.join(__dirname, '..', 'temp_images');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, imageBuffer);
    return filepath;
  } catch (error) {
    logger.error('Failed to save image', { error: error.message });
    return null;
  }
}

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
      
      // Check if cookies exist (file or environment variable)
      const hasCookiesFile = fs.existsSync(this.cookiesPath);
      const hasCookiesEnv = process.env.TWITTER_COOKIES && process.env.TWITTER_COOKIES.length > 0;
      const hasCookies = hasCookiesFile || hasCookiesEnv;
      
      // Detect if running on Linux (fly.io) or Windows
      const isLinux = process.platform === 'linux';
      
      // Launch Chrome - use bundled Chromium for cross-platform
      const launchOptions = {
        headless: isLinux ? true : false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled'
        ]
      };
      
      // On Windows, use system Chrome if available
      if (!isLinux && fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) {
        launchOptions.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      }
      
      this.browser = await puppeteer.launch(launchOptions);
      
      this.page = await this.browser.newPage();
      
      // Try to load saved cookies
      if (hasCookies) {
        logger.info('Found saved cookies, loading...');
        let cookies;
        if (hasCookiesEnv) {
          // Load from environment variable (base64 encoded)
          cookies = JSON.parse(Buffer.from(process.env.TWITTER_COOKIES, 'base64').toString('utf8'));
        } else {
          // Load from file
          cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
        }
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
      
      // Also output base64 for easy copy to fly.io
      const base64Cookies = Buffer.from(JSON.stringify(cookies)).toString('base64');
      logger.success('Session saved! You wont need to login next time.');
      logger.info('Base64 cookies for fly.io (copy this to TWITTER_COOKIES secret):');
      logger.info(base64Cookies);
      
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

  async tweet(text, imagePath = null) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info('Posting tweet...');
      
      // Go to home first to avoid detached frame
      await this.page.goto('https://twitter.com/home', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      await delay(3000);
      
      // Click the tweet button
      const tweetButton = await this.page.$('[data-testid="SideNav_NewTweet_Button"]');
      if (tweetButton) {
        await tweetButton.click();
        await delay(3000);
      } else {
        // Fallback to direct URL
        await this.page.goto('https://twitter.com/compose/tweet', { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
        await delay(4000);
      }

      // Type tweet
      const textarea = await this.page.$('[data-testid="tweetTextarea_0"], [contenteditable="true"]');
      if (!textarea) {
        logger.error('Cannot find textarea');
        return null;
      }

      await textarea.click();
      await textarea.type(text, { delay: 50 });
      await delay(2000);

      // If image provided, upload it
      if (imagePath && fs.existsSync(imagePath)) {
        logger.info('Uploading image...');
        const imageInput = await this.page.$('input[type="file"]');
        if (imageInput) {
          await imageInput.uploadFile(imagePath);
          await delay(3000);
          logger.success('Image uploaded!');
        }
      }
      
      // Post with Ctrl+Enter
      logger.info('Sending tweet...');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      
      await delay(5000);
      logger.success('Tweet posted!');
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to tweet', { error: error.message });
      return null;
    }
  }

  async postThread(tweets) {
    if (!this.isInitialized) return null;

    try {
      logger.info(`Posting thread with ${tweets.length} tweets...`);

      // Go to compose once and build the whole thread there
      await this.page.goto('https://twitter.com/compose/tweet', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await delay(4000);

      // Helper to get a textarea for a specific index in the thread
      const getTextareaForIndex = async (i, timeout = 8000) => {
        // Twitter usually numbers the textareas as tweetTextarea_0, _1, ...
        const selector = `[data-testid="tweetTextarea_${i}"]`;
        let area = await this.page.$(selector);
        if (!area) {
          // Fallback: grab the last contenteditable
          area = await this.page.$('[data-testid^="tweetTextarea_"], [contenteditable="true"]:last-of-type');
        }
        if (!area) {
          // Wait briefly if not present yet
          area = await this.page.waitForSelector(selector, { timeout }).catch(() => null);
        }
        return area;
      };

      // Type the first tweet
      const firstArea = await getTextareaForIndex(0, 12000);
      if (!firstArea) {
        logger.error('Cannot find first textarea for thread');
        return null;
      }
      await firstArea.click();
      await firstArea.type(tweets[0], { delay: 35 });
      await delay(1000);

      // For each subsequent tweet, click Add another tweet, then type
      for (let i = 1; i < tweets.length; i++) {
        const addSelectors = [
          '[data-testid="addButton"]',                    // add another tweet
          '[aria-label*="Add another"]',                 // aria label fallback
          'div[role="button"][data-testid="toolBar"] [data-testid="addButton"]'
        ];

        let added = false;
        for (const sel of addSelectors) {
          const el = await this.page.waitForSelector(sel, { timeout: 5000 }).catch(() => null);
          if (el) {
            await el.click();
            await delay(1000);
            logger.info(`Added new tweet composer using selector: ${sel}`);
            added = true;
            break;
          }
        }
        if (!added) {
          logger.warn('Could not find "Add another tweet" button; attempting keyboard shortcut');
          // Try Ctrl+Shift+Enter which sometimes adds another tweet in the thread composer
          await this.page.keyboard.down('Control');
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.up('Shift');
          await this.page.keyboard.up('Control');
          await delay(800);
        }

        const area = await getTextareaForIndex(i, 8000);
        if (!area) {
          logger.error(`Cannot find textarea for tweet index ${i}`);
          return null;
        }
        await area.click();
        await area.type(tweets[i], { delay: 35 });
        await delay(600);
      }

      // Post the entire thread: prefer the main Tweet/Post button (not Inline)
      const postSelectors = [
        '[data-testid="tweetButton"]',                  // main post button (Tweet all / Post)
        'div[role="button"][data-testid="tweetButton"]',
        'button[data-testid="tweetButton"]'
      ];

      let posted = false;
      for (const sel of postSelectors) {
        const btn = await this.page.waitForSelector(sel, { timeout: 6000 }).catch(() => null);
        if (btn) {
          logger.info('Submitting thread...');
          await btn.click();
          posted = true;
          break;
        }
      }

      if (!posted) {
        logger.warn('Post button not found; attempting Ctrl+Enter to submit thread');
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
      }

      await delay(7000);
      logger.success(`Thread posted with ${tweets.length} tweets!`);
      return { success: true };

    } catch (error) {
      logger.error('Failed to post thread', { error: error.message });
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
      
      // Find tweet elements - use $ for array of elements
      const tweets = await this.page.$('[data-testid="tweet"]');
      
      if (!tweets || tweets.length === 0) {
        logger.warn('No tweets found');
        return [];
      }
      
      logger.info(`Found ${tweets.length} tweets`);
      
      // Extract tweet data with engagement metrics
      const tweetData = [];
      for (let i = 0; i < Math.min(tweets.length, 10); i++) {
        try {
          const tweet = tweets[i];
          const textElement = await tweet.$('[data-testid="tweetText"]');
          const text = textElement ? await textElement.evaluate(el => el.textContent) : '';
          
          // Get tweet link
          const linkElement = await tweet.$('a[href*="/status/"]');
          const link = linkElement ? await linkElement.evaluate(el => el.getAttribute('href')) : '';
          
          // Get engagement metrics - likes and retweets
          let likes = 0;
          let retweets = 0;
          let replies = 0;
          
          // Try to find like count
          const likeElement = await tweet.$('[data-testid="like"]');
          if (likeElement) {
            const likeSpan = await likeElement.$('span');
            if (likeSpan) {
              const likeText = await likeSpan.evaluate(el => el.textContent);
              likes = this.parseCount(likeText);
            }
          }
          
          // Try to find retweet count
          const retweetElement = await tweet.$('[data-testid="retweet"]');
          if (retweetElement) {
            const rtSpan = await retweetElement.$('span');
            if (rtSpan) {
              const rtText = await rtSpan.evaluate(el => el.textContent);
              retweets = this.parseCount(rtText);
            }
          }
          
          // Try to find reply count
          const replyElement = await tweet.$('[data-testid="reply"]');
          if (replyElement) {
            const replySpan = await replyElement.$('span');
            if (replySpan) {
              const replyText = await replySpan.evaluate(el => el.textContent);
              replies = this.parseCount(replyText);
            }
          }
          
          // Get timestamp
          let timeElement = await tweet.$('time');
          let timestamp = '';
          if (timeElement) {
            timestamp = await timeElement.evaluate(el => el.getAttribute('datetime'));
          }
          
          if (text && link) {
            tweetData.push({
              id: link.split('/').pop(),
              text: text,
              likes: likes,
              retweets: retweets,
              replies: replies,
              timestamp: timestamp,
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

  // Parse count strings like "1.2K", "500" etc
  parseCount(text) {
    if (!text || text === '') return 0;
    text = text.trim();
    if (text === '') return 0;
    
    // Handle K (thousands)
    if (text.toLowerCase().includes('k')) {
      const num = parseFloat(text.toLowerCase().replace('k', ''));
      return Math.round(num * 1000);
    }
    // Handle M (millions)
    if (text.toLowerCase().includes('m')) {
      const num = parseFloat(text.toLowerCase().replace('m', ''));
      return Math.round(num * 1000000);
    }
    // Just a number
    return parseInt(text.replace(/[^0-9]/g, '')) || 0;
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
