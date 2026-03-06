# Twitter DEX Bot

A Twitter bot that automatically posts scheduled tweets for your DEX exchange. Built with Node.js.

## Features

- ⏰ **Scheduled Tweets** - Automatically post tweets at specified times
- 🎲 **Random/Sequential Mode** - Choose between random tweet selection or sequential order
- 🔄 **Tweet Queue** - Manage multiple pre-written tweets
- 📊 **Category Support** - Organize tweets by category (promotion, security, features, etc.)
- 🔐 **Secure** - All API credentials stored in environment variables
- 🛡️ **Graceful Shutdown** - Handles SIGINT/SIGTERM properly

## Prerequisites

- Node.js 16.x or higher
- npm or yarn
- Twitter Developer Account

## Twitter API Setup

1. Go to [Twitter Developer Portal](https://developer.twitter.com/)
2. Create a new project and app
3. Generate the following credentials:
   - API Key
   - API Secret
   - Access Token
   - Access Token Secret
   - Bearer Token (optional, for read operations)
4. Ensure your app has "Read and Write" permissions

## Installation

1. Clone this repository or download the files

2. Install dependencies:
```bash
npm install
```

3. Copy the example environment file:
```bash
copy .env.example .env
```

4. Edit `.env` file with your credentials:
```env
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET=your_api_secret_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret_here
TWITTER_BEARER_TOKEN=your_bearer_token_here

# Bot Settings
TIMEZONE=UTC
SCHEDULED_TIMES=09:00,12:00,15:00,18:00,21:00
ENABLE_RANDOM_MODE=true
LOG_LEVEL=info
```

## Configuration

### Scheduled Times

Edit `SCHEDULED_TIMES` in `.env`:
```env
SCHEDULED_TIMES=09:00,12:00,15:00,18:00,21:00
```
Format: 24-hour time, comma-separated

### Tweet Content

Edit `tweets.json` to add your own tweets:
```json
{
  "tweets": [
    {
      "id": 1,
      "text": "Your tweet text here! #hashtags",
      "category": "promotion"
    }
  ]
}
```

### Random vs Sequential Mode

- `ENABLE_RANDOM_MODE=true` - Bot randomly selects tweets
- `ENABLE_RANDOM_MODE=false` - Bot posts tweets in order

## Usage

### Start the bot

```bash
npm start
```

### View logs

The bot logs to console with timestamps and color-coded messages.

### Stop the bot

Press `Ctrl+C` for graceful shutdown.

## Tweet Categories

The bot supports these categories:
- `promotion` - Marketing and promotional content
- `security` - Security announcements and tips
- `feature` - Platform feature highlights
- `update` - Platform updates
- `community` - Community engagement
- `milestone` - Milestone celebrations
- `alert` - Important alerts
- `announcement` - Big announcements
- `tip` - Trading tips

## Bot Status

The bot exposes a global variable for console access:
```javascript
// Get bot status
twitterBot.getStatus()

// Manual tweet
twitterBot.manualTweet("Your custom tweet text")
```

## Files Structure

```
twitter-bot/
├── src/
│   ├── index.js         # Main entry point
│   ├── config.js        # Configuration loader
│   ├── logger.js        # Logging utility
│   ├── twitterClient.js # Twitter API client
│   ├── tweetQueue.js    # Tweet queue manager
│   └── scheduler.js     # Tweet scheduler
├── tweets.json          # Tweet content
├── .env                 # Environment variables
├── .env.example         # Example configuration
├── package.json         # Dependencies
└── README.md            # This file
```

## Troubleshooting

### "Failed to initialize Twitter client"

- Check your API credentials in `.env`
- Ensure your Twitter Developer app has "Read and Write" permissions
- Verify your API keys are correct

### "No tweet available"

- Check `tweets.json` exists and has valid content
- Ensure tweets array is not empty

### Scheduler not posting

- Check timezone setting in `.env`
- Verify `SCHEDULED_TIMES` format is correct (HH:MM)

## Security Notes

- Never commit your `.env` file to version control
- Keep your API keys secure
- Regularly rotate your credentials

## License

MIT
