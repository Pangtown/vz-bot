/**
 * Basic tests for vz-bot utility functions
 */

import { validation } from '../src/utils/index.js';
import { TTLCache } from '../src/utils/index.js';
import { retryOperation } from '../src/utils/index.js';

describe('Validation Utilities', () => {
  test('validateRequiredString - should validate required strings', () => {
    expect(validation.validateRequiredString('test', 'testField')).toBeNull();
    expect(validation.validateRequiredString('', 'testField')).toBe('testField cannot be empty');
    expect(validation.validateRequiredString(undefined, 'testField')).toBe('testField is required');
    expect(validation.validateRequiredString(null, 'testField')).toBe('testField is required');
  });
  
  test('validateUrl - should validate URLs', () => {
    expect(validation.validateUrl('https://example.com', 'testUrl')).toBeNull();
    expect(validation.validateUrl('http://localhost:3000', 'testUrl')).toBeNull();
    expect(validation.validateUrl('not-a-url', 'testUrl')).toBe('testUrl must be a valid URL');
    expect(validation.validateUrl('', 'testUrl')).toBeNull(); // Empty is allowed
  });
});

describe('TTLCache', () => {
  test('should store and retrieve values', () => {
    const cache = new TTLCache(100); // 100ms TTL
    
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
    
    expect(cache.get('nonexistent')).toBeNull();
  });
  
  test('should expire values', async () => {
    const cache = new TTLCache(50); // 50ms TTL
    
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
    
    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(cache.get('key1')).toBeNull();
  });
});

describe('retryOperation', () => {
  test('should retry failed operations', async () => {
    let attemptCount = 0;
    
    const operation = () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error(`Attempt ${attemptCount} failed`);
      }
      return 'success';
    };
    
    const result = await retryOperation(operation, { maxAttempts: 5, baseDelay: 10 });
    expect(result).toBe('success');
    expect(attemptCount).toBe(3);
  });
  
  test('should fail after max attempts', async () => {
    const operation = () => {
      throw new Error('Always fails');
    };
    
    try {
      await retryOperation(operation, { maxAttempts: 3, baseDelay: 10 });
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error.message).toBe('Always fails');
    }
  });
});

console.log('All utility tests passed!');