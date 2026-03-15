const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

// Wait for page to be fully loaded with network idle
async function waitForPageReady(page, timeout = 30000) {
  try {
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout }
    );
    // Additional wait for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (e) {
    return false;
  }
}

// Wait for specific element with retries
async function waitForElement(page, selector, timeout = 15000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    return true;
  } catch (e) {
    return false;
  }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Exponential backoff helper
const getBackoffDelay = (attempt) => Math.min(30000, Math.pow(2, attempt) * 1000);

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
      
      logger.info(`Cookie sources - File exists: ${hasCookiesFile}, Env exists: ${hasCookiesEnv}`);
      
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
        let cookies = null;
        
        // Priority: Try file first, then env var
        if (hasCookiesFile) {
          try {
            let cookieData = fs.readFileSync(this.cookiesPath, 'utf8');
            // Remove BOM if present
            if (cookieData.charCodeAt(0) === 0xFEFF) {
              cookieData = cookieData.slice(1);
            }
            cookies = JSON.parse(cookieData);
            logger.info('Successfully loaded cookies from file');
          } catch (fileError) {
            logger.error('Failed to parse cookies file', { error: fileError.message });
          }
        }
        
        // If file didn't work or doesn't exist, try env var
        if (!cookies && hasCookiesEnv) {
          try {
            const envCookies = process.env.TWITTER_COOKIES;
            if (!envCookies || envCookies.trim().length === 0) {
              throw new Error('TWITTER_COOKIES env var is empty');
            }
            cookies = JSON.parse(Buffer.from(envCookies.trim(), 'base64').toString('utf8'));
            logger.info('Successfully loaded cookies from env var');
          } catch (envError) {
            logger.error('Failed to parse TWITTER_COOKIES env var', { error: envError.message });
          }
        }
        
        if (!cookies) {
          throw new Error('Could not load cookies from any source');
        }
        await this.page.setCookie(...cookies);
        
        // Try to go to home
        await this.page.goto('https://x.com/home', { 
          waitUntil: 'networkidle2', 
          timeout: 60000 
        });
        await waitForPageReady(this.page, 15000);
        
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
      await this.page.goto('https://x.com/login', { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
      });
      await waitForPageReady(this.page, 15000);
      
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
      
      // Normalize newlines to ensure Twitter preserves paragraph breaks
      const normalized = String(text)
        .replace(/\\n/g, '\n')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
      const parts = normalized.split('\n');
      
      // Use direct compose link instead of navigating through home
      await this.page.goto('https://x.com/compose/post', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      await waitForPageReady(this.page, 15000);
      
      // Wait for textarea to be ready
      const textareaReady = await waitForElement(this.page, '[data-testid^="tweetTextarea_"], [contenteditable="true"]', 15000);
      if (!textareaReady) {
        logger.error('Tweet textarea not ready');
        return null;
      }

      // Type tweet with explicit Shift+Enter for line breaks
      const textarea = await this.page.$('[data-testid^="tweetTextarea_"], [contenteditable="true"]');
      if (!textarea) {
        logger.error('Cannot find textarea');
        return null;
      }

      await textarea.click();
      await delay(500);
      
      for (let i = 0; i < parts.length; i++) {
        const segment = parts[i];
        if (segment) await textarea.type(segment, { delay: 50 });
        if (i < parts.length - 1) {
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.up('Shift');
        }
      }
      await delay(2000);

      // If image provided, upload it
      if (imagePath && fs.existsSync(imagePath)) {
        logger.info('Uploading image...');
        const imageInput = await this.page.$('input[type="file"]');
        if (imageInput) {
          await imageInput.uploadFile(imagePath);
          // Wait for image to be processed
          await waitForElement(this.page, '[data-testid="tweetImage"]', 10000).catch(() => {});
          await delay(2000);
          logger.success('Image uploaded!');
        }
      }
      
      // Wait for post button to be ready
      await waitForElement(this.page, '[data-testid="tweetButton"]', 10000);
      await delay(1000);
      
      // Post with Ctrl+Enter
      logger.info('Sending tweet...');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      
      // Wait for navigation away from compose
      await this.page.waitForFunction(
        () => !window.location.href.includes('/compose/'),
        { timeout: 15000 }
      ).catch(() => {});
      
      await delay(3000);
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

    // Retry mechanism: up to 5 attempts with exponential backoff
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Posting thread with ${trimmedTweets.length} tweets... (Attempt ${attempt}/${maxAttempts})`);

        // Open the dedicated composer with better wait conditions
        await this.page.goto('https://x.com/compose/post', {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        
        // Wait for page to be fully ready
        await waitForPageReady(this.page, 20000);
        
        // Wait for the first textarea to be ready
        const textareaReady = await waitForElement(this.page, '[data-testid^="tweetTextarea_"], [contenteditable="true"]', 20000);
        if (!textareaReady) {
          logger.error('Thread composer not ready, retrying...');
          if (attempt < maxAttempts) {
            await delay(getBackoffDelay(attempt));
            continue;
          }
          return null;
        }
        
        logger.info('Composer ready, building thread...');

      // Wait for network to be idle and content to load
      await this.page.waitForFunction(
        () => document.readyState === 'complete' && !!document.querySelector('[data-testid^="tweetTextarea_"]'),
        { timeout: 30000 }
      ).catch(() => {
        logger.warn('Timeout waiting for composer, continuing anyway...');
      });
      
      await delay(2000);
      
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

      // Type the first tweet with human-like delays
      const firstArea = await getTextareaForIndex(0, 15000);
      if (!firstArea) {
        logger.error('Cannot find first textarea for thread');
        return null;
      }
      await firstArea.click({ delay: Math.floor(Math.random() * 100) });
      await delay(500 + Math.random() * 500);
      // Type with variable delay
      const typeDelay = () => Math.floor(Math.random() * 50) + 20;
      await firstArea.type(trimmedTweets[0], { delay: typeDelay() });
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

        // Ensure it's focused and visible before typing
        try {
          await area.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
        } catch {}
        await area.click({ delay: Math.floor(Math.random() * 100) });
        await delay(200 + Math.random() * 300);
        const typeDelay = () => Math.floor(Math.random() * 50) + 20;
        await area.type(trimmedTweets[i], { delay: typeDelay() });
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
          const backoffDelay = getBackoffDelay(attempt);
          logger.info(`Retrying in ${backoffDelay/1000}s... (Attempt ${attempt + 1}/${maxAttempts})`);
          await delay(backoffDelay);
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
          const backoffDelay = getBackoffDelay(attempt);
          logger.info(`Retrying in ${backoffDelay/1000}s... (Attempt ${attempt + 1}/${maxAttempts})`);
          await delay(backoffDelay);
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
      const topUrl = `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`;
      await this.page.goto(topUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      await waitForPageReady(this.page, 15000);
      logger.info('Waiting for tweets to load (Top)...');
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
      return Math.round(num * 1000000);
    }
    // Just a number
    return parseInt(text.replace(/[^0-9]/g, '')) || 0;
  }

  async postComment(tweetId, comment) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info(`Posting comment on tweet ${tweetId}...`);
      
      // Navigate to the tweet directly using x.com
      await this.page.goto(`https://x.com/i/status/${tweetId}`, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      await waitForPageReady(this.page, 15000);

      // Wait for the tweet to be visible
      const tweetReady = await waitForElement(this.page, '[data-testid="tweet"]', 15000);
      if (!tweetReady) {
        logger.warn('Tweet not immediately visible, continuing...');
      }
      await delay(2000);

      // Scroll to make sure tweet is visible
      await this.page.evaluate(() => {
        const tweet = document.querySelector('[data-testid="tweet"]');
        if (tweet) tweet.scrollIntoView({ block: 'center' });
      });
      await delay(1000);

      // Method 1: Try to click on the tweet itself to open it (in case we're on a list view)
      const tweetElement = await this.page.$('[data-testid="tweet"]');
      if (tweetElement) {
        try {
          await tweetElement.click();
          await delay(2000);
        } catch (e) {
          logger.debug('Could not click tweet element, trying other methods');
        }
      }

      // Try multiple selectors to find the reply button
      const clickReplyButton = async () => {
        const replySelectors = [
          // Primary selectors
          '[data-testid="reply"]',
          '[data-testid="tweetDetailReply"]',
          // Fallback selectors
          'div[role="button"][aria-label*="Reply"]',
          'div[aria-label*="Reply"][role="button"]',
          // SVG-based selectors (Twitter sometimes uses these)
          'svg[aria-label="Reply"]',
          // Try finding by text
          'div[role="button"]:has-text("Reply")'
        ];

        for (const sel of replySelectors) {
          try {
            const btn = await this.page.$(sel);
            if (!btn) continue;
            
            // Make sure button is visible and enabled
            const isVisible = await btn.isIntersectingViewport().catch(() => false);
            if (!isVisible) continue;
            
            // Scroll to button
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await delay(300);
            
            // Try clicking
            await btn.click().catch(() => {});
            await delay(2000);
            
            // Check if reply composer appeared
            const composerSelectors = [
              '[data-testid^="tweetTextarea_"]',
              '[data-testid="reply"]',
              '[data-testid="tweetBox"]',
              '[contenteditable="true"][role="textbox"]'
            ];
            
            for (const compSel of composerSelectors) {
              const composer = await this.page.$(compSel);
              if (composer) {
                logger.info(`Reply composer found with selector: ${compSel}`);
                return true;
              }
            }
          } catch (e) {
            continue;
          }
        }
        return false;
      };

      // Try clicking reply button
      let replyOpened = await clickReplyButton();
      
      // If that didn't work, try keyboard shortcut
      if (!replyOpened) {
        logger.info('Trying keyboard shortcut to open reply...');
        await this.page.keyboard.press('r');
        await delay(3000);
        
        // Check again for composer
        const composerAfterKeyboard = await this.page.$('[data-testid^="tweetTextarea_"]') || 
                                        await this.page.$('[contenteditable="true"][role="textbox"]');
        if (composerAfterKeyboard) {
          replyOpened = true;
          logger.info('Reply composer opened via keyboard');
        }
      }

      if (!replyOpened) {
        logger.error('Could not open reply composer - reply button not found or not clickable');
        return null;
      }

      // Find the reply textarea - look for the reply-specific composer
      const findReplyTextarea = async () => {
        // First try numbered tweetTextarea (reply composer)
        const replyTextarea = await this.page.$('[data-testid^="tweetTextarea_"]');
        if (replyTextarea) return replyTextarea;
        
        // Try contenteditable in a reply context
        const editableAreas = await this.page.$('[contenteditable="true"][role="textbox"]');
        if (editableAreas.length > 0) {
          // The reply textarea is usually the last one or has specific characteristics
          return editableAreas[editableAreas.length - 1];
        }
        
        // Try data-testid tweetBox
        return await this.page.$('[data-testid="tweetBox"]');
      };

      const textarea = await findReplyTextarea();
      if (!textarea) {
        logger.error('Cannot find reply textarea');
        return null;
      }

      // Click and type in the textarea
      await textarea.click().catch(() => {});
      await delay(500);
      
      // Clear any existing text
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('a');
      await this.page.keyboard.up('Control');
      await delay(200);
      
      // Type the comment
      await textarea.type(comment, { delay: 50 });
      await delay(1000);

      // Verify text was typed
      const textContent = await textarea.evaluate(el => el.textContent);
      logger.info(`Typed comment (${textContent.length} chars): ${textContent.substring(0, 30)}...`);

      // Find and click the reply button to submit
      const submitReply = async () => {
        const submitSelectors = [
          '[data-testid="tweetButton"]',
          '[data-testid="tweetButtonInline"]',
          'div[data-testid="tweetButton"]',
          'div[role="button"][data-testid="tweetButton"]'
        ];

        for (const sel of submitSelectors) {
          const btn = await this.page.$(sel);
          if (!btn) continue;
          
          try {
            // Check if button is enabled
            const isDisabled = await btn.evaluate(el => el.getAttribute('disabled') !== null);
            if (isDisabled) {
              logger.debug('Submit button is disabled, waiting...');
              await delay(2000);
            }
            
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await delay(200);
            await btn.click();
            return true;
          } catch (e) {
            try {
              await this.page.evaluate((el) => el.click(), btn);
              return true;
            } catch (e2) {
              continue;
            }
          }
        }
        return false;
      };

      const submitted = await submitReply();
      if (!submitted) {
        // Try Ctrl+Enter as fallback
        logger.info('Trying Ctrl+Enter to submit reply...');
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
      }

      // Wait for reply to be posted
      await delay(5000);

      // Verify we didn't just post a new tweet (check URL or page state)
      const currentUrl = this.page.url();
      logger.info(`Current URL after reply: ${currentUrl}`);

      logger.success('Comment posted successfully!');
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to post comment', { error: error.message });
      return null;
    }
  }
}

module.exports = new TwitterClient();
