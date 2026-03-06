const config = require('./config');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

class Logger {
  constructor() {
    this.logLevel = config.bot.logLevel;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
  }

  _shouldLog(level) {
    return this.levels[level] >= this.levels[this.logLevel];
  }

  _formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelUpper = level.toUpperCase().padEnd(5);
    let formatted = `${colors.cyan}[${timestamp}]${colors.reset} ${levelUpper} ${message}`;
    
    if (data) {
      formatted += ` ${colors.yellow}${JSON.stringify(data)}${colors.reset}`;
    }
    
    return formatted;
  }

  debug(message, data = null) {
    if (this._shouldLog('debug')) {
      console.log(this._formatMessage('debug', message, data));
    }
  }

  info(message, data = null) {
    if (this._shouldLog('info')) {
      console.log(this._formatMessage('info', message, data));
    }
  }

  warn(message, data = null) {
    if (this._shouldLog('warn')) {
      console.warn(this._formatMessage('warn', message, data));
    }
  }

  error(message, data = null) {
    if (this._shouldLog('error')) {
      console.error(this._formatMessage('error', message, data));
    }
  }

  success(message, data = null) {
    if (this._shouldLog('info')) {
      console.log(this._formatMessage('info', `${colors.green}✓${colors.reset} ${message}`, data));
    }
  }
}

module.exports = new Logger();
