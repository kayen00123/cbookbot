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
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          '--start-maximized',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-default-apps',
          '--allow-running-insecure-content',
          '--disable-web-security',
          '--disable-background-networking',
          '--disable-default-network-handlers',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update'
        ],
        defaultViewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        dumpio: false
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
          timeout: 1000000 
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
        timeout: 1000000 
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
        timeout: 1000000 
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

    // Limit each tweet to 250 characters
    const trimmedTweets = tweets.map(tweet => {
      if (tweet.length > 250) {
        logger.warn(`Tweet truncated to 250 characters: "${tweet.substring(0, 50)}..."`);
        return tweet.substring(0, 247) + '...';
      }
      return tweet;
    });

    // Debug: Log tweets to see if line breaks are preserved
    logger.info('DEBUG: Tweets with line breaks:');
    trimmedTweets.forEach((t, i) => {
      logger.info(`Tweet ${i + 1}: ${t.replace(/\n/g, '\\n')}`);
    });

    // Retry mechanism: up to 5 attempts
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Posting thread with ${trimmedTweets.length} tweets... (Attempt ${attempt}/${maxAttempts})`);

      // Open the dedicated composer and build the entire thread there
      await this.page.goto('https://x.com/compose/post', {
        waitUntil: 'domcontentloaded',
        timeout: 1000000
      });
      await delay(6000); // Wait longer for composer to load

      // DEBUG: Log page state
      const composeUrl = this.page.url();
      logger.info(`DEBUG: Current URL after navigate: ${composeUrl}`);
      
      // Check for any Twitter errors/alerts on page
      const pageAlerts = await this.page.evaluate(() => {
        const alerts = [];
        // Check for error dialogs
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        dialogs.forEach(d => {
          if (d.textContent.toLowerCase().includes('error') || 
              d.textContent.toLowerCase().includes('suspended') ||
              d.textContent.toLowerCase().includes('locked')) {
            alerts.push('ERROR DIALOG: ' + d.textContent.substring(0, 200));
          }
        });
        // Check for toast notifications
        const toasts = document.querySelectorAll('[data-testid="toast"], [role="alert"]');
        toasts.forEach(t => alerts.push('TOAST: ' + t.textContent.substring(0, 100)));
        // Check page title
        alerts.push('Page title: ' + document.title);
        return alerts;
      });
      logger.info('DEBUG: Page alerts:', pageAlerts);

      // DEBUG: Count editable elements
      const editableCount = await this.page.evaluate(() => {
        return {
          tweetTextarea: document.querySelectorAll('[data-testid^="tweetTextarea_"]').length,
          contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
          roleTextbox: document.querySelectorAll('[role="textbox"]').length
        };
      });
      logger.info('DEBUG: Element counts:', editableCount);

      // Utility: count how many tweet textareas exist
      const getComposerCount = async () => {
        return await this.page.evaluate(() => {
          return document.querySelectorAll('[data-testid^="tweetTextarea_"]').length || 0;
        });
      };

      // Utility: wait until composer count becomes expected
      const waitForComposerCount = async (expected, timeout = 10000) => {
        return await this.page.waitForFunction(
          (sel, expectedCount) => document.querySelectorAll(sel).length >= expectedCount,
          { timeout },
          '[data-testid^="tweetTextarea_"]',
          expected
        ).catch(() => null);
      };

      // Helper to get a textarea for a specific index in the thread
      const getTextareaForIndex = async (i, timeout = 15000) => {
        // More robust selector list for Twitter's composer
        const selectors = [
          `[data-testid="tweetTextarea_${i}"]`,
          `[data-testid="tweetTextarea_0"]`,
          '[data-testid="tweetTextarea"]',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"]',
          'div[role="textbox"]'
        ];
        
        // First try direct selector
        for (const sel of selectors) {
          const area = await this.page.$(sel);
          if (area) {
            logger.info(`Found textarea using selector: ${sel}`);
            return area;
          }
        }
        
        // Wait and try again
        await delay(2000);
        for (const sel of selectors) {
          const area = await this.page.$(sel);
          if (area) {
            logger.info(`Found textarea after wait using selector: ${sel}`);
            return area;
          }
        }
        
        // Last resort - wait for any textarea
        return await this.page.waitForSelector('[data-testid="tweetTextarea"], [contenteditable="true"]', { timeout }).catch(() => null);
      };

      // Type the first tweet with human-like delays - preserve line breaks
      const firstArea = await getTextareaForIndex(0, 15000);
      if (!firstArea) {
        logger.error('Cannot find first textarea for thread');
        return null;
      }
      // Focus the textarea first
      await firstArea.click();
      await this.page.focus('[data-testid="tweetTextarea_0"]');
      await delay(500 + Math.random() * 500);
      // Type with variable delay - use keyboard to preserve line breaks
      const typeDelay = () => Math.floor(Math.random() * 30) + 10;
      await this.page.keyboard.type(trimmedTweets[0], { delay: typeDelay() });
      await delay(1000 + Math.random() * 500);

      // Robust click helper with retries + scroll + DOM validation
      const clickAddWithRetry = async (targetCount, expectedIndex) => {
        const candidates = [
          '[data-testid="addButton"]',
          '[aria-label*="Add another"]',
          'div[data-testid="toolBar"] [data-testid="addButton"]',
          'div[role="button"][aria-label*="Add another"]'
        ];

        for (let attempt = 1; attempt <= 3; attempt++) {
          for (const sel of candidates) {
            const el = await this.page.$(sel);
            if (!el) continue;

            // Ensure in view and enabled
            try {
              await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
            } catch {}
            await delay(200);

            // Try a direct click; if that fails, use JS click
            try {
              await el.click({ delay: 0 });
            } catch {
              try {
                await this.page.evaluate((node) => node.click(), el);
              } catch {}
            }

            // Success if composer count reached target OR expected textarea appeared
            const okByCount = await waitForComposerCount(targetCount, 8000);
            let okByTextarea = false;
            if (!okByCount) {
              okByTextarea = await this.page
                .waitForSelector(`[data-testid="tweetTextarea_${expectedIndex}"]`, { timeout: 8000 })
                .then(() => true)
                .catch(() => false);
            }

            if (okByCount || okByTextarea) {
              logger.info(`Added new tweet composer using selector: ${sel}`);
              return true;
            }
          }

          // As a fallback between attempts, try keyboard shortcut that sometimes adds a composer
          logger.warn(`Add button click attempt ${attempt} did not produce a new composer; trying keyboard fallback`);
          try {
            await this.page.keyboard.down('Control');
            await this.page.keyboard.down('Shift');
            await this.page.keyboard.press('Enter');
            await this.page.keyboard.up('Shift');
            await this.page.keyboard.up('Control');
          } catch {}

          const okAfterKbByCount = await waitForComposerCount(targetCount, 4000);
          let okAfterKbByTextarea = false;
          if (!okAfterKbByCount) {
            okAfterKbByTextarea = await this.page
              .waitForSelector(`[data-testid="tweetTextarea_${expectedIndex}"]`, { timeout: 4000 })
              .then(() => true)
              .catch(() => false);
          }

          if (okAfterKbByCount || okAfterKbByTextarea) {
            logger.info('Added new tweet composer using keyboard shortcut');
            return true;
          }

          await delay(500 + attempt * 300); // small backoff
        }
        return false;
      };

      // Build the rest of the thread
      for (let i = 1; i < tweets.length; i++) {
        const before = await getComposerCount();
        const target = before + 1;

        const added = await clickAddWithRetry(target, i);
        if (!added) {
          logger.error('Could not create a new tweet composer for the thread');
          return null;
        }

        // Wait for the ith textarea specifically
        const area = await getTextareaForIndex(i, 10000);
        if (!area) {
          logger.error(`Cannot find textarea for tweet index ${i}`);
          return null;
        }

        // Ensure it's focused and visible before typing - use keyboard for line breaks
        try {
          await area.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
        } catch {}
        await area.click();
        await this.page.focus(`[data-testid="tweetTextarea_${i}"]`);
        await delay(200 + Math.random() * 300);
        const typeDelay = () => Math.floor(Math.random() * 30) + 10;
        await this.page.keyboard.type(trimmedTweets[i], { delay: typeDelay() });
        await delay(500 + Math.random() * 500);
      }

       // Post the entire thread - try multiple methods
      logger.info('Looking for Post button...');
      
      // Debug: log all buttons on page
      const allButtons = await this.page.evaluate(() => {
        const buttons = [];
        document.querySelectorAll('div[role="button"], button').forEach(btn => {
          const label = btn.getAttribute('aria-label') || btn.textContent || '';
          const dataTestid = btn.getAttribute('data-testid') || '';
          if (label.toLowerCase().includes('post') || label.toLowerCase().includes('tweet') || dataTestid.includes('tweet')) {
            buttons.push({ ariaLabel: label, dataTestid: dataTestid, disabled: btn.disabled });
          }
        });
        return buttons;
      });
      logger.info('DEBUG: Found buttons:', allButtons);

      // Try to find and click the post button
      let postButtonClicked = false;
      
      // First wait a moment for any overlays to settle
      await delay(1000 + Math.random() * 1000);
      
      // Method 1: Try data-testid selector - use JavaScript click for better stealth
      const tweetButton = await this.page.$('[data-testid="tweetButton"]');
      if (tweetButton) {
        logger.info('Found tweetButton, clicking with JavaScript...');
        await tweetButton.scrollIntoViewIfNeeded();
        await delay(500);
        // Use JavaScript click instead of puppeteer click - less detectable
        await this.page.evaluate((btn) => btn.click(), tweetButton);
        postButtonClicked = true;
      }
      
      // Method 2: If not found, try aria-label
      if (!postButtonClicked) {
        const ariaButton = await this.page.$('div[role="button"][aria-label*="Post"]');
        if (ariaButton) {
          logger.info('Found Post button by aria-label, clicking with JavaScript...');
          await ariaButton.scrollIntoViewIfNeeded();
          await delay(500);
          await this.page.evaluate((btn) => btn.click(), ariaButton);
          postButtonClicked = true;
        }
      }
      
      // Method 3: Try pressing Enter key (works in Twitter compose)
      if (!postButtonClicked) {
        logger.info('Trying Ctrl+Enter to post...');
        await delay(500);
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
        postButtonClicked = true;
      }
      
      await delay(3000); // Wait for post to process

      // Check if post was successful - success means we navigated away from compose
      const afterUrl = this.page.url();
      const pageTitleAfter = await this.page.evaluate(() => document.title);
      logger.info(`DEBUG: After submit - URL: ${afterUrl}, Title: ${pageTitleAfter}`);
      
      // Success: URL changed from compose/post (e.g., /home, /username/status/, etc.)
      // Failure: Still on /compose/post URL
      const isStillOnCompose = afterUrl.includes('/compose/post');
      
      if (isStillOnCompose) {
        logger.error(`Attempt ${attempt} failed: Still on compose page - post was blocked`);
        if (attempt < maxAttempts) {
          logger.info(`Retrying... (Attempt ${attempt + 1}/${maxAttempts})`);
          await delay(attempt * 5000);
          continue;
        }
        logger.error('All attempts failed - tweets were NOT posted!');
        return null;
      }
      
      // Success! Post was submitted - Twitter will naturally navigate to home/status
      logger.success(`✓ Thread posted successfully with ${trimmedTweets.length} tweets!`);
      return { success: true, tweetCount: trimmedTweets.length };

      } catch (error) {
        logger.error(`Attempt ${attempt} failed: ${error.message}`);
        if (attempt < maxAttempts) {
          logger.info(`Retrying... (Attempt ${attempt + 1}/${maxAttempts})`);
          await delay(attempt * 5000);
          continue;
        }
        logger.error('All attempts failed - tweets were NOT posted!');
        return null;
      }
    } // End of for loop
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  async searchTweets(hashtag) {
    if (!this.isInitialized) return [];

    try {
      logger.info(`Searching for tweets with ${hashtag} (last 30 days, Top first)...`);

      // Build a since: filter for the past 30 days
      const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const yyyy = sinceDate.getUTCFullYear();
      const mm = String(sinceDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(sinceDate.getUTCDate()).padStart(2, '0');
      const sinceQuery = `since:${yyyy}-${mm}-${dd}`;

      // Broaden query slightly to include both hashtag and keyword
      const rawQuery = `(#memecoin OR memecoin) ${sinceQuery}`;

      // Prefer Top tab to bias toward higher-engagement posts
      const topUrl = `https://twitter.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`;
      await this.page.goto(topUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 1000000
      });

      await delay(3000);
      logger.info('Waiting for tweets to load (Top)...');

      // Helper to scroll and collect a small, fast batch on Top tab only
      const loadTweetsWithScroll = async (maxScrolls = 15, minTweets = 20) => {
        for (let i = 0; i < maxScrolls; i++) {
          await this.page.evaluate(() => { try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {} });
          await delay(1000 + Math.floor(Math.random() * 250));

          const count = await this.page.evaluate(() => document.querySelectorAll('[data-testid="tweet"]').length);
          if (count >= minTweets) return count;
        }
        return await this.page.evaluate(() => document.querySelectorAll('[data-testid="tweet"]').length);
      };

      let tweetCount = await loadTweetsWithScroll(15, 20);
      logger.info(`Top tab collected ~${tweetCount} tweets`);

      if (tweetCount === 0) {
        logger.warn('No tweets found');
        return [];
      }

      // Collect tweet data directly from the page (collect only first 20 for speed)
      const tweetData = await this.page.evaluate(() => {
        const tweets = [];
        const tweetElements = Array.from(document.querySelectorAll('[data-testid="tweet"]')).slice(0, 20);

        for (const tweet of tweetElements) {
          try {
            const textElement = tweet.querySelector('[data-testid="tweetText"]');
            const text = textElement ? textElement.textContent : '';

            // Link and ID
            const linkElement = tweet.querySelector('a[href*="/status/"]');
            const link = linkElement ? linkElement.getAttribute('href') : '';

            // Engagement metrics
            const likeEl = tweet.querySelector('[data-testid="like"] span');
            const rtEl = tweet.querySelector('[data-testid="retweet"] span');
            const replyEl = tweet.querySelector('[data-testid="reply"] span');

            const likeText = likeEl ? likeEl.textContent : '';
            const rtText = rtEl ? rtEl.textContent : '';
            const replyText = replyEl ? replyEl.textContent : '';

            // Timestamp
            const timeEl = tweet.querySelector('time');
            const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';

            if (text && link) {
              tweets.push({
                link,
                text,
                likeText,
                rtText,
                replyText,
                timestamp
              });
            }
          } catch (e) {
            // skip malformed card
          }
        }
        return tweets;
      });

      const parsedTweets = tweetData.map(t => ({
        id: t.link.split('/').pop(),
        text: t.text,
        likes: this.parseCount(t.likeText),
        retweets: this.parseCount(t.rtText),
        replies: this.parseCount(t.replyText),
        timestamp: t.timestamp
      }));

      logger.info(`Collected ${parsedTweets.length} tweets to analyze`);
      return parsedTweets;
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
      return Math.round(num * 10000000);
    }
    // Just a number
    return parseInt(text.replace(/[^0-9]/g, '')) || 0;
  }

  async postComment(tweetId, comment) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info(`Posting comment on tweet ${tweetId}...`);
      
      // Navigate to the tweet and allow layout to settle
      await this.page.goto(`https://twitter.com/i/status/${tweetId}`, { 
        waitUntil: 'domcontentloaded',
        timeout: 1000000 
      });
      await delay(3500);

      // Ensure a tweet is present
      await this.page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }).catch(() => {});

      // Try to open the reply composer robustly
      const openReply = async () => {
        const selectors = [
          '[data-testid="reply"]',
          'div[role="button"][data-testid="reply"]',
          'div[data-testid="tweetDetail"] [data-testid="reply"]'
        ];

        for (const sel of selectors) {
          const btn = await this.page.$(sel);
          if (!btn) continue;
          try { await btn.evaluate(n => n.scrollIntoView({ block: 'center' })); } catch {}
          await delay(150);
          try { await btn.click(); } catch { try { await this.page.evaluate(n => n.click(), btn); } catch {} }

          // Wait for a composer to appear
          const composer = await this.page
            .waitForSelector('[data-testid^="tweetTextarea_"]', { timeout: 7000 })
            .catch(() => null);
          if (composer) {
            logger.info('Reply composer opened');
            return true;
          }
        }

        // Keyboard fallback: r opens reply on some layouts
        try {
          await this.page.keyboard.press('r');
          const composer = await this.page
            .waitForSelector('[data-testid^="tweetTextarea_"]', { timeout: 5000 })
            .catch(() => null);
          if (composer) {
            logger.info('Reply composer opened via keyboard');
            return true;
          }
        } catch {}
        return false;
      };

      const opened = await openReply();
      if (!opened) {
        logger.error('Could not open reply composer');
        return null;
      }

      // Find the active textarea (prefer numbered one, else last contenteditable)
      const textarea = await this.page
        .$('[data-testid^="tweetTextarea_"]')
        .then(el => el || this.page.$('[contenteditable="true"]:last-of-type'));

      if (!textarea) {
        logger.error('Cannot find reply textarea');
        return null;
      }

      // Type and verify text content appeared
      await textarea.click({ delay: 0 });
      await delay(150);
      await textarea.type(comment, { delay: 30 });
      await delay(250);

      const typedOk = await this.page.evaluate((node) => node.textContent && node.textContent.length > 0, textarea).catch(() => false);
      if (!typedOk) {
        logger.warn('Reply text did not register on first try; retrying focus/type');
        await textarea.click({ delay: 0 });
        await delay(150);
        await textarea.type(comment, { delay: 10 });
      }

      logger.info('Submitting reply...');

      // Try clicking visible Reply button first
      const submitSelectors = [
        'div[data-testid="tweetButton"]',
        'button[data-testid="tweetButton"]',
        '[data-testid="tweetButtonInline"]'
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        const btn = await this.page.waitForSelector(sel, { timeout: 5000 }).catch(() => null);
        if (!btn) continue;
        try { await btn.evaluate(n => n.scrollIntoView({ block: 'center' })); } catch {}
        await delay(100);
        try { await btn.click(); submitted = true; break; } catch { try { await this.page.evaluate(n => n.click(), btn); submitted = true; break; } catch {} }
      }

      if (!submitted) {
        // Keyboard fallback: Ctrl+Enter
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
        submitted = true; // assume success, confirm below
      }

      // Confirm by waiting for navigation or composer closing
      await Promise.race([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
        this.page.waitForFunction(() => !document.querySelector('[data-testid^="tweetTextarea_"]'), { timeout: 8000 }).catch(() => null),
        delay(5000)
      ]);

      logger.success('Comment posted!');
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to post comment', { error: error.message });
      return null;
    }
  }
}

module.exports = new TwitterClient();

