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
          '--disable-web-security',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-sync',
          '--metrics-recording-only',
          '--no-first-run',
          '--window-size=1920,1080',
          '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
      };
      
      // On Windows, use system Chrome if available
      if (!isLinux && fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) {
        launchOptions.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      }
      
      this.browser = await puppeteer.launch(launchOptions);
      
      this.page = await this.browser.newPage();
      
      // Set realistic viewport
      await this.page.setViewport({ width: 1920, height: 1080 });
      
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
        await this.page.goto('https://x.com/home', { 
          waitUntil: 'domcontentloaded', 
          timeout: 100000 
        });
        await delay(3000);
        
        // Check if still logged in - go to profile to verify
        const url = this.page.url();
        logger.info('Current URL after loading cookies:', url);
        
        // Navigate to profile to properly load the session
        const username = process.env.TWITTER_USERNAME || 'newtrader4u';
        await this.page.goto('https://x.com/' + username, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await delay(2000);
        
        const profileUrl = this.page.url();
        logger.info('Profile URL:', profileUrl);
        
        // Check if we're actually logged in (not on login page)
        if (!profileUrl.includes('/login') && !profileUrl.includes('login')) {
          // Additional check: verify we can see the username in the page
          const pageContent = await this.page.content();
          if (pageContent.includes(username)) {
            logger.success('Cookie validation passed - session is valid');
            this.isInitialized = true;
            return true;
          } else {
            logger.warn('Cookie session may be invalid - username not found on page');
          }
        } else {
          logger.error('==============================================');
          logger.error('COOKIES ARE INVALID OR EXPIRED!');
          logger.error('==============================================');
          logger.error('This is expected when running on fly.io - cookies from your local machine');
          logger.error('typically dont work due to different IP addresses.');
          logger.error('');
          logger.error('SOLUTION:');
          logger.error('1. You need to set up Twitter cookies directly on the server OR');
          logger.error('2. Use Twitter API instead of browser automation');
          logger.error('3. For fly.io, you may need a VPN/proxy to match your local IP');
          logger.error('');
          logger.error('To get new cookies:');
          logger.error('- Run locally: node src/index.js');
          logger.error('- Login manually when prompted');
          logger.error('- Copy the new twitter_cookies.json to fly.io');
          logger.error('- Or set TWITTER_COOKIES as a base64-encoded secret in fly.io');
          logger.error('==============================================');
        }
      }

      // Need to login
      logger.info('Opening Twitter login...');
      await this.page.goto('https://x.com/login', { 
        waitUntil: 'domcontentloaded', 
        timeout: 100000 
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
      await this.page.goto('https://x.com/home', { 
        waitUntil: 'domcontentloaded',
        timeout: 100000 
      });
      await delay(3000);
      
      // Click the tweet button
      const tweetButton = await this.page.$('[data-testid="SideNav_NewTweet_Button"]');
      if (tweetButton) {
        await tweetButton.click();
        await delay(3000);
      } else {
        // Fallback to direct URL
        await this.page.goto('https://x.com/compose/post', { 
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
      
      // Ensure text actually registered
      const textPresent = await this.page.evaluate((sel) => {
        const el = document.querySelector(sel) || document.querySelector('[data-testid="tweetTextarea_0"]') || document.querySelector('[contenteditable="true"]');
        return !!(el && el.textContent && el.textContent.length > 0);
      }, '[data-testid="tweetTextarea_0"], [contenteditable="true"][role="textbox"]').catch(() => false);
      if (!textPresent) {
        logger.error('Tweet text did not register in composer');
        return null;
      }

      // Prefer clicking enabled Post button; fallback to Ctrl+Enter
      const postBtn = await this.page.$('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
      let clicked = false;
      if (postBtn) {
        try {
          const enabled = await this.page.evaluate((node) => node.getAttribute('aria-disabled') !== 'true', postBtn).catch(() => true);
          if (enabled) {
            logger.info('Sending tweet via button click...');
            try { await postBtn.evaluate(n => n.scrollIntoView({ block: 'center' })); } catch {}
            await delay(100);
            try { await postBtn.click(); clicked = true; } catch { await this.page.evaluate(n => n.click(), postBtn).then(() => clicked = true).catch(() => {}); }
          }
        } catch {}
      }
      if (!clicked) {
        logger.info('Sending tweet via Ctrl+Enter...');
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
      }

      // Wait for navigation or composer close
      await Promise.race([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null),
        this.page.waitForFunction(() => !document.querySelector('[data-testid^="tweetTextarea_"]'), { timeout: 10000 }).catch(() => null),
        delay(7000)
      ]);

      // Detect errors/modals keeping us on composer
      const stillCompose = this.page.url().includes('compose');
      if (stillCompose) {
        const hadDialog = await this.page.$('div[role="dialog"]');
        const alertText = await this.page.evaluate(() => {
          const t = [];
          const alert = document.querySelector('[role="alert"], [data-testid="toast"], div[aria-live="polite"]');
          if (alert && alert.innerText) t.push(alert.innerText.trim());
          const dlg = document.querySelector('div[role="dialog"]');
          if (dlg && dlg.innerText) t.push(dlg.innerText.trim());
          return t.join(' | ');
        }).catch(() => '');

        if (hadDialog) {
          // Try to confirm dialog
          const confirmSel = 'div[role="dialog"] [data-testid="confirmationSheetConfirm"], div[role="dialog"] [data-testid="sheetDialog"] [role="button"], div[role="dialog"] button';
          const confirmBtn = await this.page.$(confirmSel);
          if (confirmBtn) {
            try { await confirmBtn.click(); } catch { try { await this.page.evaluate(n => n.click(), confirmBtn); } catch {} }
            await delay(3000);
          }
        }

        // Re-evaluate if navigated
        if (this.page.url().includes('compose')) {
          logger.error('Tweet failed to post; composer still open', { alert: alertText });
          return null;
        }
      }

      // Success if we navigated to a status URL or composer closed
      const successUrl = this.page.url();
      const ok = /\/status\//.test(successUrl) || !await this.page.$('[data-testid^="tweetTextarea_"]');
      if (!ok) {
        logger.error('Tweet may not have posted (no status URL and composer still present)');
        return null;
      }
      
      // CRITICAL: Verify tweet actually appears on profile
      logger.info('Verifying tweet was actually posted...');
      const verified = await this.verifyTweetPosted(text);
      
      if (!verified) {
        logger.error('Tweet verification FAILED - tweet may have been silently blocked by Twitter');
        logger.error('This often happens on fly.io due to: IP mismatch, cookie invalidation, or bot detection');
        return null;
      }
      
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

      // Try going to home first and clicking the new tweet button (more reliable)
      await this.page.goto('https://x.com/home', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await delay(3000);
      
      // Click the new tweet button
      const newTweetBtnSelectors = [
        '[data-testid="SideNav_NewTweet_Button"]',
        '[data-testid="newTweetButton"]',
        'a[href="/compose/tweet"]',
        'a[href="/compose/post"]'
      ];
      
      let clicked = false;
      for (const sel of newTweetBtnSelectors) {
        const btn = await this.page.$(sel);
        if (btn) {
          try {
            await btn.click();
            logger.info('Clicked new tweet button');
            clicked = true;
            break;
          } catch {}
        }
      }
      
      // If button click failed, try going to compose URL directly
      if (!clicked) {
        logger.info('Button click failed, trying compose URL...');
        await this.page.goto('https://x.com/compose/post', {
          waitUntil: 'domcontentloaded',
          timeout: 100000
        });
      }
      
      // Wait for composer to fully load with explicit wait
      logger.info('Waiting for composer to load...');
      await delay(8000);
      
      // Also wait for any contenteditable to appear
      try {
        await this.page.waitForSelector('[contenteditable="true"]', { timeout: 10000 });
        logger.info('Composer element detected');
      } catch {
        logger.warn('Composer may not have loaded properly');
      }

      // Utility: count how many tweet composer textboxes exist
      const getComposerCount = async () => {
        return await this.page.evaluate(() => {
          // Try multiple selectors
          let count = document.querySelectorAll('[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]').length;
          if (count === 0) count = document.querySelectorAll('[data-testid^="tweetTextarea_"]').length;
          if (count === 0) count = document.querySelectorAll('[contenteditable="true"][role="textbox"]').length;
          if (count === 0) count = document.querySelectorAll('[contenteditable="true"]').length;
          return count;
        });
      };

      // Utility: wait until composer count becomes expected
      const waitForComposerCount = async (expected, timeout = 10000) => {
        // Try multiple selectors
        const selectors = [
          '[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]',
          '[data-testid^="tweetTextarea_"]',
          '[contenteditable="true"][role="textbox"]'
        ];
        
        for (const sel of selectors) {
          try {
            await this.page.waitForFunction(
              (s, expectedCount) => document.querySelectorAll(s).length >= expectedCount,
              { timeout: timeout / selectors.length },
              sel,
              expected
            );
            return true;
          } catch { continue; }
        }
        return false;
      };

      // Helper to get a textarea (actual contenteditable textbox) for a specific index in the thread
      const getTextareaForIndex = async (i, timeout = 15000) => {
        // Multiple selector strategies for Twitter's changing page structure
        const selectors = [
          '[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]',
          '[data-testid^="tweetTextarea_"]',
          '[contenteditable="true"][role="textbox"]',
          '.public-DraftStyleDefault-block',
          'div[contenteditable="true"]'
        ];
        
        const start = Date.now();
        while (Date.now() - start < timeout) {
          for (const selector of selectors) {
            const boxes = await this.page.$(selector);
            if (boxes && boxes.length > i) {
              logger.info(`Found textarea using selector "${selector}" at index ${i}`);
              return boxes[i];
            }
          }
          await delay(500);
        }
        
        // Last resort: try to find any editable element
        logger.warn('Could not find composer with standard selectors, trying fallback');
        const anyEditable = await this.page.$('[contenteditable="true"]');
        if (anyEditable && anyEditable.length > i) {
          return anyEditable[i];
        }
        
        logger.error('No textarea found for thread composer');
        return null;
      };

      // First tweet will be typed using the verified helper below

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

      // Helper: enforce 280-char limit for free accounts
      const toSafeTweet = (t) => {
        const txt = String(t || '').trim();
        if (txt.length <= 280) return txt;
        const sliced = txt.slice(0, 276).replace(/\s+$/,'');
        return `${sliced} …`;
      };

      // Verify that a given textarea actually contains text after typing
      const verifyTyped = async (elHandle) => {
        try {
          return await this.page.evaluate((node) => !!(node && node.textContent && node.textContent.trim().length > 0), elHandle);
        } catch { return false; }
      };

      // Type helper targeting a specific composer index reliably
      const typeIntoComposer = async (index, text) => {
        const safeText = toSafeTweet(text);
        const area = await getTextareaForIndex(index, 15000);
        if (!area) return false;
        try { await area.evaluate(n => n.scrollIntoView({ block: 'center', inline: 'center' })); } catch {}
        await area.click({ delay: 0 });
        await delay(150);
        // Focus via DOM as well
        try { await this.page.evaluate(n => n.focus && n.focus(), area); } catch {}
        await delay(50);
        // Clear existing content (Ctrl+A + Backspace)
        try {
          await this.page.keyboard.down('Control');
          await this.page.keyboard.press('KeyA');
          await this.page.keyboard.up('Control');
          await this.page.keyboard.press('Backspace');
          await delay(50);
        } catch {}
        await area.type(safeText, { delay: 20 });
        await delay(200);
        const ok = await verifyTyped(area);
        if (!ok) {
          // Fallback: direct JS insertion
          try {
            await this.page.evaluate((node, val) => {
              if (!node) return;
              const setText = (n, v) => { n.textContent = v; };
              setText(node, '');
              setText(node, val);
            }, area, safeText);
          } catch {}
          await delay(200);
          return verifyTyped(area);
        }
        return true;
      };

      // Type the first tweet safely (enforce 280 chars)
      {
        const ok = await typeIntoComposer(0, tweets[0]);
        if (!ok) {
          logger.error('Failed to type into first composer');
          return null;
        }
      }

      // Build the rest of the thread, verifying each composer and enforcing 280 chars
      for (let i = 1; i < tweets.length; i++) {
        const before = await getComposerCount();
        const target = before + 1;

        const added = await clickAddWithRetry(target, i);
        if (!added) {
          logger.error('Could not create a new tweet composer for the thread');
          return null;
        }

        const typed = await typeIntoComposer(i, tweets[i]);
        if (!typed) {
          logger.error(`Failed to type into composer index ${i}`);
          return null;
        }
      }

      // Pre-submit validation: ensure each composer has content
      const perIndexLengths = await this.page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]'));
        return nodes.map(n => (n.textContent || '').trim().length);
      }).catch(() => []);
      if (perIndexLengths.length < tweets.length || perIndexLengths.some(len => len === 0)) {
        logger.error('One or more composers are empty before submit', { lengths: perIndexLengths });
        return null;
      }

      // Post the entire thread: prefer the main Tweet/Post button (Tweet all / Post)
      const postSelectors = [
        '[data-testid="tweetButton"]',
        '[data-testid="tweetButtonInline"]',
        'div[role="button"][data-testid="tweetButton"]',
        'button[data-testid="tweetButton"]'
      ];

      let posted = false;
      for (const sel of postSelectors) {
        const btn = await this.page.waitForSelector(sel, { timeout: 12000 }).catch(() => null);
        if (btn) {
          const enabled = await this.page.evaluate((node) => node.getAttribute('aria-disabled') !== 'true', btn).catch(() => true);
          if (!enabled) {
            logger.warn('Post button is disabled; re-checking text content and focus');
          }
          logger.info('Submitting thread...');
          try { await btn.evaluate((n) => n.scrollIntoView({ block: 'center' })); } catch {}
          await delay(150);
          try { await btn.click(); } catch { await this.page.evaluate((n) => n.click(), btn).catch(() => {}); }
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

      // If Post button was disabled due to content length, try to detect and auto-trim offending composer, then retry once
      try {
        const disabled = await this.page.$eval('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]', n => n.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (disabled) {
          logger.warn('Post button disabled before navigation; checking for over-limit content');
          const idxOver = await this.page.evaluate(() => {
            const areas = Array.from(document.querySelectorAll('[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]'));
            const max = 280;
            let offender = -1;
            areas.forEach((n, i) => { const len = (n.textContent || '').trim().length; if (len > max && offender === -1) offender = i; });
            return offender;
          }).catch(() => -1);
          if (idxOver >= 0 && idxOver < tweets.length) {
            logger.warn(`Composer index ${idxOver} exceeds 280 chars; auto-trimming and retrying submit`);
            const area = await getTextareaForIndex(idxOver, 5000);
            if (area) {
              try {
                await area.click({ delay: 0 });
                await delay(50);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyA');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.press('Backspace');
                await delay(80);
                const safe = toSafeTweet(tweets[idxOver]);
                await area.type(safe, { delay: 10 });
                await delay(150);
              } catch {}
            }
            // Retry submit via button or shortcut
            const btn = await this.page.$('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
            if (btn) {
              try { await btn.click(); } catch { try { await this.page.evaluate(n => n.click(), btn); } catch {} }
            } else {
              await this.page.keyboard.down('Control');
              await this.page.keyboard.press('Enter');
              await this.page.keyboard.up('Control');
            }
          }
        }
      } catch {}

      // Wait for navigation away from composer or composer closing
      await Promise.race([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
        this.page.waitForFunction(() => !document.querySelector('[data-testid^="tweetTextarea_"]'), { timeout: 12000 }).catch(() => null),
        delay(9000)
      ]);

      // Verify the tweet was actually posted by checking the page
      await delay(2000);
      const currentUrl = this.page.url();
      logger.info(`Current URL after posting: ${currentUrl}`);
      try {
        const lens = await this.page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="tweetTextarea_"] [contenteditable="true"][role="textbox"]')).map(n => (n.textContent || '').trim().length));
        logger.info('Composer lengths after submit attempt', { lengths: lens });
      } catch {}

      // If still on composer page, the tweet was NOT posted
      if (currentUrl.includes('compose')) {
        logger.error('Tweet FAILED to post - still on composer page!');
        // Try one more time with keyboard shortcut
        logger.info('Retrying with Ctrl+Enter...');
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Control');
        await delay(5000);
        
        const retryUrl = this.page.url();
        logger.info(`URL after retry: ${retryUrl}`);
        
        if (retryUrl.includes('compose')) {
          // Capture alert/toast text for debugging
          const alertText = await this.page.evaluate(() => {
            const t = [];
            const alert = document.querySelector('[role="alert"], [data-testid="toast"], div[aria-live="polite"]');
            if (alert && alert.innerText) t.push(alert.innerText.trim());
            const dlg = document.querySelector('div[role="dialog"]');
            if (dlg && dlg.innerText) t.push(dlg.innerText.trim());
            return t.join(' | ');
          }).catch(() => '');
          logger.error('Tweet failed to post even after retry', { alert: alertText });
          return null;
        }
      }

      // CRITICAL: Verify thread actually appears on profile
      logger.info('Verifying thread was actually posted...');
      const threadText = tweets.join(' ');
      const verified = await this.verifyTweetPosted(threadText);
      
      if (!verified) {
        logger.error('Thread verification FAILED - thread may have been silently blocked by Twitter');
        logger.error('This often happens on fly.io due to: IP mismatch, cookie invalidation, or bot detection');
        return null;
      }

      logger.success(`Thread posted with ${tweets.length} tweets!`);
      return { success: true };

    } catch (error) {
      logger.error('Failed to post thread', { error: error.message });
      return null;
    }
  }

  // Verify tweet was actually posted by checking profile
  async verifyTweetPosted(expectedText) {
    try {
      const username = process.env.TWITTER_USERNAME || 'newtrader4u';
      if (!username) {
        logger.warn('No username configured, skipping verification');
        return true;
      }
      
      // Go to profile to check recent tweets
      await this.page.goto(`https://x.com/${username}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await delay(3000);
      
      // Get recent tweets from the page
      const recentTweets = await this.page.evaluate(() => {
        const tweets = [];
        const tweetSelectors = [
          '[data-testid="tweet"]',
          'article[data-testid="tweet"]',
          '.css-175oi2z.r-1habvwh.r-18u37iz.r-1ny4l3l'
        ];
        
        for (const selector of tweetSelectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            elements.forEach(el => {
              const text = el.textContent || '';
              if (text.length > 10) {
                tweets.push(text);
              }
            });
            break;
          }
        }
        return tweets.slice(0, 5);
      });
      
      logger.info(`Found ${recentTweets.length} recent tweets on profile`);
      
      // Check if any of the recent tweets contains our expected text
      const textToCheck = expectedText.substring(0, 50).toLowerCase();
      
      for (const tweet of recentTweets) {
        if (tweet.toLowerCase().includes(textToCheck)) {
          logger.success('Tweet verified on profile!');
          return true;
        }
      }
      
      logger.warn('Tweet not found on profile - it may have been silently blocked');
      return false;
      
    } catch (error) {
      logger.error('Error verifying tweet', { error: error.message });
      return false;
    }
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
        timeout: 100000
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
      return Math.round(num * 1000000);
    }
    // Just a number
    return parseInt(text.replace(/[^0-9]/g, '')) || 0;
  }

  async postComment(tweetId, comment) {
    if (!this.isInitialized) return null;
    
    try {
      logger.info(`Posting comment on tweet ${tweetId}...`);
      
      // Navigate to the tweet and allow layout to settle
      await this.page.goto(`https://x.com/i/status/${tweetId}`, { 
        waitUntil: 'domcontentloaded',
        timeout: 100000 
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
