const axios = require('axios');
const logger = require('./logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

class GeminiAI {
  constructor() {
    this.apiKey = GEMINI_API_KEY;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.apiKey) {
      this.isInitialized = true;
      logger.info('Gemini AI initialized');
      return true;
    }
    logger.warn('Gemini API key not found');
    return false;
  }

  async generateTweetThread(topic, numTweets = 3) {
    if (!this.isInitialized) {
      logger.error('Gemini AI not initialized');
      return null;
    }

    try {
      logger.info(`Generating ${numTweets}-tweet thread about: ${topic}`);

      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a ${numTweets}-tweet thread about: ${topic}

Style requirements:
- Keep each tweet under 200 characters
- Use line breaks within tweets (like writing paragraphs)
- Leave empty line between paragraphs in same tweet
- Be concise and impactful - like the example: "Creator Fees need change. Not every token deserves Creator Fees.\n\nNow, users have the ability to decide whether a token truly deserves Creator Fees..."
- Make each tweet feel complete and valuable on its own
- Naturally promote Cookbook DEX without being spammy

Format the response as a JSON array of tweet strings, like: ["tweet1", "tweet2", "tweet3"]
Do not include any other text - just the JSON array.`;

      const response = await axios.post(
        `${GEMINI_API_URL}?key=${this.apiKey}`,
        {
          contents: [
            {
              parts: [
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 2048
          }
        }
      );

      if (response.data && response.data.candidates && response.data.candidates[0]) {
        const text = response.data.candidates[0].content.parts[0].text;
        
        // Parse the JSON array from the response
        try {
          // Try to extract JSON array from response
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const tweets = JSON.parse(jsonMatch[0]);
            logger.success(`Generated ${tweets.length} tweets for thread`);
            return tweets;
          }
        } catch (parseError) {
          logger.error('Failed to parse AI response', { error: parseError.message });
        }
        
        // Fallback: split by newlines if JSON parsing fails
        const tweets = text.split('\n').filter(t => t.trim().length > 0);
        return tweets.slice(0, numTweets);
      }

      logger.error('Invalid AI response');
      return null;

    } catch (error) {
      logger.error('Failed to generate tweet thread', { 
        error: error.message,
        status: error.response?.status 
      });
      return null;
    }
  }

  async generateSingleTweet(topic) {
    if (!this.isInitialized) {
      logger.error('Gemini AI not initialized');
      return null;
    }

    try {
      logger.info(`Generating single tweet about: ${topic}`);

      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a short tweet (under 200 characters) about: ${topic}

Style:
- Use line breaks (like paragraphs)
- Like this style: "Creator Fees need change. Not every token deserves Creator Fees.\n\nNow, users have the ability to decide..."
- Be concise but impactful
- Promote Cookbook DEX naturally
Just return the tweet text, nothing else.`;

      const response = await axios.post(
        `${GEMINI_API_URL}?key=${this.apiKey}`,
        {
          contents: [
            {
              parts: [
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 280
          }
        }
      );

      if (response.data && response.data.candidates && response.data.candidates[0]) {
        const tweet = response.data.candidates[0].content.parts[0].text.trim();
        return tweet;
      }

      return null;

    } catch (error) {
      logger.error('Failed to generate tweet', { error: error.message });
      return null;
    }
  }

  async generateTrendingEngagementComment(topic) {
    if (!this.isInitialized) {
      logger.error('Gemini AI not initialized');
      return null;
    }

    try {
      const prompt = `You are a crypto Twitter bot for Cookbook DEX, a decentralized exchange on BNB Chain and Base.
Create a short reply comment (under 150 characters) to a ${topic} tweet.

Style:
- Use line breaks if needed
- Be concise and natural
- Promote Cookbook DEX without being spammy
Just return the comment text, nothing else.`;

      const response = await axios.post(
        `${GEMINI_API_URL}?key=${this.apiKey}`,
        {
          contents: [
            {
              parts: [
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 280
          }
        }
      );

      if (response.data && response.data.candidates && response.data.candidates[0]) {
        const comment = response.data.candidates[0].content.parts[0].text.trim();
        return comment;
      }

      return null;

    } catch (error) {
      logger.error('Failed to generate engagement comment', { error: error.message });
      return null;
    }
  }
}

module.exports = new GeminiAI();
