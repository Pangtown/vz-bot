/**
 * Simple TTL (Time To Live) cache for vz-bot
 * Provides in-memory caching with automatic expiration
 */

export class TTLCache {
  /**
   * @param {number} defaultTTL - Default time to live in milliseconds (default: 5 minutes)
   */
  constructor(defaultTTL = 300000) {
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
  }
  
  /**
   * Get a value from the cache
   * @param {string} key - The cache key
   * @returns {*} - The cached value or null if not found/expired
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // Check if expired
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }
  
  /**
   * Set a value in the cache
   * @param {string} key - The cache key
   * @param {*} value - The value to cache
   * @param {number} ttl - Time to live in milliseconds (optional)
   */
  set(key, value, ttl = this.defaultTTL) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl
    });
  }
  
  /**
   * Delete a value from the cache
   * @param {string} key - The cache key
   * @returns {boolean} - True if key was deleted, false if not found
   */
  delete(key) {
    return this.cache.delete(key);
  }
  
  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
  }
  
  /**
   * Get the number of items in the cache
   * @returns {number} - Number of cached items
   */
  size() {
    return this.cache.size;
  }
  
  /**
   * Get cache statistics
   * @returns {Object} - Cache statistics
   */
  stats() {
    let expiredCount = 0;
    const now = Date.now();
    
    for (const item of this.cache.values()) {
      if (now > item.expiresAt) {
        expiredCount++;
      }
    }
    
    return {
      totalItems: this.cache.size,
      expiredItems: expiredCount,
      validItems: this.cache.size - expiredCount
    };
  }
  
  /**
   * Clean up expired entries
   * @returns {number} - Number of expired entries removed
   */
  cleanup() {
    let removedCount = 0;
    const now = Date.now();
    
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    
    return removedCount;
  }
}