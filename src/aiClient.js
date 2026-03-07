const axios = require('axios');
const logger = require('./logger');

// AI Provider: 'openrouter', 'minimax', or 'gemini'
const AI_PROVIDER = process.env.AI_PROVIDER || 'openrouter';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MINIMAX_API_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

class AIClient {
  constructor() {
    this.isInitialized = false;
  }

  async initialize() {
    if (AI_PROVIDER === 'openrouter' && OPENROUTER_API_KEY) {
      this.isInitialized = true;
      logger.info('AI Client initialized with OpenRouter (free tier)');
      return true;
    } else if (AI_PROVIDER === 'minimax' && MINIMAX_API_KEY) {
      this.isInitialized = true;
      logger.info('AI Client initialized with MiniMax');
      return true;
    } else if (AI_PROVIDER === 'gemini' && GEMINI_API_KEY) {
      this.isInitialized = true;
      logger.info('AI Client initialized with Gemini');
      return true;
    }
    logger.warn('AI not initialized - no API key found');
    return false;
  }

  async generateTweetThread(topic, numTweets = 3) {
    if (!this.isInitialized) return null;

    if (AI_PROVIDER === 'openrouter') {
      return this.generateOpenRouterThread(topic, numTweets);
    } else if (AI_PROVIDER === 'minimax') {
      return this.generateMinimaxThread(topic, numTweets);
    } else {
      return this.generateGeminiThread(topic, numTweets);
    }
  }

  async generateSingleTweet(topic) {
    if (!this.isInitialized) return null;

    if (AI_PROVIDER === 'openrouter') {
      return this.generateOpenRouterSingleTweet(topic);
    } else if (AI_PROVIDER === 'minimax') {
      return this.generateMinimaxSingleTweet(topic);
    } else {
      return this.generateGeminiSingleTweet(topic);
    }
  }

  async generateEngagementComment(topic) {
    if (!this.isInitialized) return null;

    if (AI_PROVIDER === 'openrouter') {
      return this.generateOpenRouterComment(topic);
    } else if (AI_PROVIDER === 'minimax') {
      return this.generateMinimaxComment(topic);
    } else {
      return this.generateGeminiComment(topic);
    }
  }

  // ==================== OpenRouter Implementation ====================
  
  async generateOpenRouterThread(topic, numTweets) {
    try {
      logger.info(`OpenRouter: Generating ${numTweets}-tweet thread about: ${topic}`);

      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a ${numTweets}-tweet thread about: ${topic}

Style requirements:
- Keep each tweet under 200 characters
- Use line breaks within tweets (like paragraphs)
- Leave empty line between paragraphs in same tweet
- Be concise and impactful
- Make each tweet feel complete and valuable on its own
- Naturally promote Cookbook DEX without being spammy

Format the response as a JSON array of tweet strings, like: ["tweet1", "tweet2", "tweet3"]
Do not include any other text - just the JSON array.`;

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'stepfun/step-3.5-flash:free',
          messages: [
            { role: 'system', content: 'You are a helpful crypto Twitter bot assistant.' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://cookbook.xyz',
            'X-Title': 'Cookbook DEX Bot'
          },
          timeout: 100000
        }
      );

      if (response.data && response.data.choices && response.data.choices[0]) {
        const text = response.data.choices[0].message.content;
        logger.info(`OpenRouter raw response: ${text.substring(0, 200)}...`);
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const tweets = JSON.parse(jsonMatch[0]);
            logger.success(`OpenRouter: Generated ${tweets.length} tweets`);
            return tweets;
          }
        } catch (parseError) {
          logger.error('Failed to parse OpenRouter response', { error: parseError.message });
        }
        // Fallback: split by numbered tweets or just return as single tweet
        const tweets = text.split('\n').filter(t => t.trim().length > 10);
        if (tweets.length > 0) {
          return tweets.slice(0, numTweets);
        }
      }

      return null;

    } catch (error) {
      logger.error('OpenRouter thread generation failed', { 
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return null;
    }
  }

  async generateOpenRouterSingleTweet(topic) {
    try {
      logger.info(`OpenRouter: Generating single tweet about: ${topic}`);

      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a short tweet (under 200 characters) about: ${topic}

Style:
- Use line breaks (like paragraphs)
- Be concise but impactful
- Promote Cookbook DEX naturally

Just return the tweet text, nothing else.`;

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'stepfun/step-3.5-flash:free',
          messages: [
            { role: 'system', content: 'You are a helpful crypto Twitter bot assistant.' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://cookbook.xyz',
            'X-Title': 'Cookbook DEX Bot'
          },
          timeout: 100000
        }
      );

      if (response.data && response.data.choices && response.data.choices[0]) {
        const tweet = response.data.choices[0].message.content.trim();
        return tweet;
      }

      return null;

    } catch (error) {
      logger.error('OpenRouter single tweet failed', { 
        error: error.message,
        status: error.response?.status 
      });
      return null;
    }
  }

  async generateOpenRouterComment(topic) {
    try {
      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a short reply comment (under 150 characters) to a ${topic} tweet.

Style:
- Use line breaks if needed
- Be concise and natural
- Promote Cookbook DEX without being spammy

Just return the comment text, nothing else.`;

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'stepfun/step-3.5-flash:free',
          messages: [
            { role: 'system', content: 'You are a helpful crypto Twitter bot assistant.' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://cookbook.xyz',
            'X-Title': 'Cookbook DEX Bot'
          },
          timeout: 100000
        }
      );

      if (response.data && response.data.choices && response.data.choices[0]) {
        const comment = response.data.choices[0].message.content.trim();
        return comment;
      }

      return null;

    } catch (error) {
      logger.error('OpenRouter comment failed', { error: error.message });
      return null;
    }
  }

  // ==================== MiniMax Implementation ====================
  
  async generateMinimaxThread(topic, numTweets) {
    try {
      logger.info(`MiniMax: Generating ${numTweets}-tweet thread about: ${topic}`);

      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a ${numTweets}-tweet thread about: ${topic}

Style requirements:
- Keep each tweet under 200 characters
- Use line breaks within tweets
- Be concise and impactful
- Naturally promote Cookbook DEX

Format the response as a JSON array: ["tweet1", "tweet2", "tweet3"]`;

      const response = await axios.post(
        MINIMAX_API_URL,
        {
          model: 'MiniMax-M2.5',
          messages: [
            { role: 'system', content: 'You are a helpful crypto Twitter bot assistant.' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${MINIMAX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.choices?.[0]) {
        const text = response.data.choices[0].message.content;
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch (e) {}
        return text.split('\n').filter(t => t.trim()).slice(0, numTweets);
      }
      return null;
    } catch (error) {
      logger.error('MiniMax thread failed', { error: error.message });
      return null;
    }
  }

  async generateMinimaxSingleTweet(topic) {
    try {
      const prompt = `Create a short tweet (under 200 chars) about: ${topic}. Promote Cookbook DEX. Just return tweet.`;
      
      const response = await axios.post(
        MINIMAX_API_URL,
        {
          model: 'MiniMax-M2.5',
          messages: [{ role: 'user', content: prompt }]
        },
        {
          headers: {
            'Authorization': `Bearer ${MINIMAX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.choices?.[0]) {
        return response.data.choices[0].message.content.trim();
      }
      return null;
    } catch (error) {
      logger.error('MiniMax single tweet failed', { error: error.message });
      return null;
    }
  }

  async generateMinimaxComment(topic) {
    try {
      const prompt = `Create a short reply (under 150 chars) to a ${topic} tweet. Promote Cookbook DEX. Just return comment.`;
      
      const response = await axios.post(
        MINIMAX_API_URL,
        {
          model: 'MiniMax-M2.5',
          messages: [{ role: 'user', content: prompt }]
        },
        {
          headers: {
            'Authorization': `Bearer ${MINIMAX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.choices?.[0]) {
        return response.data.choices[0].message.content.trim();
      }
      return null;
    } catch (error) {
      logger.error('MiniMax comment failed', { error: error.message });
      return null;
    }
  }

  // ==================== Gemini Implementation ====================

  async generateGeminiThread(topic, numTweets) {
    try {
      const prompt = `Create a ${numTweets}-tweet thread about: ${topic}. Keep under 200 chars per tweet. Use line breaks. Format: ["tweet1", "tweet2", "tweet3"]`;
      
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
        }
      );

      if (response.data?.candidates?.[0]) {
        const text = response.data.candidates[0].content.parts[0].text;
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch (e) {}
        return text.split('\n').filter(t => t.trim()).slice(0, numTweets);
      }
      return null;
    } catch (error) {
      logger.error('Gemini thread failed', { error: error.message });
      return null;
    }
  }

  async generateGeminiSingleTweet(topic) {
    try {
      const prompt = `Create a short tweet (under 200 chars) about: ${topic}. Promote Cookbook DEX. Just return tweet.`;
      
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 280 }
        }
      );

      if (response.data?.candidates?.[0]) {
        return response.data.candidates[0].content.parts[0].text.trim();
      }
      return null;
    } catch (error) {
      logger.error('Gemini single tweet failed', { error: error.message });
      return null;
    }
  }

  async generateGeminiComment(topic) {
    try {
      const prompt = `Create a short reply (under 150 chars) to a ${topic} tweet. Promote Cookbook DEX. Just return comment.`;
      
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 150 }
        }
      );

      if (response.data?.candidates?.[0]) {
        return response.data.candidates[0].content.parts[0].text.trim();
      }
      return null;
    } catch (error) {
      logger.error('Gemini comment failed', { error: error.message });
      return null;
    }
  }
}

module.exports = new AIClient();
