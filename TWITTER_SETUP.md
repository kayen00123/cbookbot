# Twitter Developer Portal - Setup Guide

## Where to Find All Your Keys

Go to **Keys and Tokens** tab in Twitter Developer Portal:

---

### 1. API Key and Secret (also called Consumer Key/Secret)

Located under **"API Key and Secret"** section:
- **API Key** = Consumer Key
- **API Secret** = Consumer Secret

---

### 2. Access Token and Secret

Located under **"Access Token and Secret"** section:
- Click **Generate** button if not shown
- **Access Token**
- **Access Token Secret** (only shows once!)

---

### 3. Bearer Token (Optional)

Located under **"Authentication Tokens"** section:
- **Bearer Token**

---

## Fill in Your .env File

Open `.env` and fill in what you found:

```env
# API Key and Secret (Consumer Key/Secret)
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET=your_api_secret_here

# Access Token and Secret
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret_here

# Bearer Token (optional)
TWITTER_BEARER_TOKEN=your_bearer_token_here
```

---

## Ready to Run?

```bash
npm start
```

The bot will start posting tweets automatically at your scheduled times! 🚀
