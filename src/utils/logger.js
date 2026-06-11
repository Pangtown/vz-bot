/**
 * Structured logger for vz-bot
 * Provides consistent logging with levels and formatting
 */

import { createLogger, format, transports } from 'winston';

// Define custom format for consistent logging
const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

// Create logger instance
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'vz-bot' },
  transports: [
    // Console transport with colorized output for development
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(
          info => `${info.timestamp} [${info.level.toUpperCase()}] ${info.service}: ${info.message}${
            info.stack ? `\n${info.stack}` : ''
          }`
        )
      )
    })
  ],
  // Handle unhandled rejections and exceptions
  exitOnError: false
});

// Create a stream object for Morgan or similar middleware compatibility
logger.stream = {
  write: function(message, encoding) {
    // Use the logger's info level to avoid duplicating messages
    logger.info(message.trim());
  }
};

export { logger };