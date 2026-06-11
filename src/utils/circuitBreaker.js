/**
 * Simple circuit breaker implementation for vz-bot
 * Protects against cascade failures when external services are unavailable
 */

import { logger } from './index.js';

export class CircuitBreaker {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.failureThreshold - Number of failures before opening circuit (default: 5)
   * @param {number} options.timeout - Timeout in milliseconds before attempting to close circuit (default: 60000)
   * @param {number} options.expectedOperationTimeout - Timeout for the protected operation (default: 5000)
   */
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.timeout = options.timeout || 60000; // 1 minute
    this.expectedOperationTimeout = options.expectedOperationTimeout || 5000; // 5 seconds
    
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  }
  
  /**
   * Execute a function with circuit breaker protection
   * @param {Function} operation - The async function to protect
   * @returns {Promise<any>} - Result of the operation
   * @throws {Error} - If circuit is open or operation fails
   */
  async execute(operation) {
    // Check if circuit is open and timeout has elapsed
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
        logger.debug('Circuit breaker transitioning to HALF_OPEN state');
      } else {
        throw new Error('Circuit breaker is OPEN - rejecting operation');
      }
    }
    
    try {
      // Execute operation with timeout
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Operation timeout')), this.expectedOperationTimeout)
        )
      ]);
      
      // Success - reset failure count and close circuit if half-open
      this.onSuccess();
      return result;
    } catch (error) {
      // Failure - increment failure count and potentially open circuit
      this.onFailure(error);
      throw error;
    }
  }
  
  /**
   * Handle successful operation
   */
  onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      logger.info('Circuit breaker transitioned to CLOSED state after successful operation');
    }
  }
  
  /**
   * Handle failed operation
   * @param {Error} error - The error that caused the failure
   */
  onFailure(error) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    const errorMsg = error ? error.message : 'Unknown error';
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.warn(`Circuit breaker opened after ${this.failureCount} failures (Last error: ${errorMsg})`);
    } else {
      logger.debug(`Operation failed (${this.failureCount}/${this.failureThreshold}): ${errorMsg}`);
    }
  }
  
  /**
   * Get current circuit breaker state
   * @returns {Object} - Current state information
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      timeUntilNextAttempt: this.state === 'OPEN' 
        ? Math.max(0, this.timeout - (Date.now() - this.lastFailureTime))
        : 0
    };
  }
}