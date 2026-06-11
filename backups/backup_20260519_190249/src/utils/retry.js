/**
 * Retry utility with exponential backoff for vz-bot
 * Helps handle transient failures in external service calls
 */

import { logger } from './index.js';

/**
 * Execute a function with retry logic and exponential backoff
 * @param {Function} operation - The async function to retry
 * @param {Object} options - Retry configuration
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in milliseconds (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in milliseconds (default: 10000)
 * @param {number} options.jitter - Jitter factor (0-1) to prevent thundering herd (default: 0.1)
 * @returns {Promise<any>} - Result of the operation
 * @throws {Error} - Last error if all attempts fail
 */
export async function retryOperation(operation, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelay = options.baseDelay || 1000; // 1 second
  const maxDelay = options.maxDelay || 10000; // 10 seconds
  const jitter = options.jitter !== undefined ? options.jitter : 0.1;
  
  let lastError;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // If this was the last attempt, don't retry
      if (attempt === maxAttempts - 1) {
        logger.debug(`Operation failed after ${attempt + 1} attempts`, { error: error.message });
        throw error;
      }
      
      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitterAmount = Math.random() * jitter * exponentialDelay;
      const delay = Math.min(exponentialDelay + jitterAmount, maxDelay);
      
      logger.debug(`Operation attempt ${attempt + 1} failed, retrying in ${delay}ms`, { 
        error: error.message,
        attempt: attempt + 1,
        maxAttempts
      });
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached, but just in case
  throw lastError;
}