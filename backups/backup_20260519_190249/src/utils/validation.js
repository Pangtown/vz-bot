/**
 * Input validation utilities for vz-bot
 * Provides reusable validation functions for API inputs
 */

/**
 * Validate that a string is not empty or just whitespace
 * @param {string} value - The string to validate
 * @param {string} fieldName - Name of the field for error messages
 * @returns {string|null} - Error message if invalid, null if valid
 */
export function validateRequiredString(value, fieldName) {
  if (value === undefined || value === null) {
    return `${fieldName} is required`;
  }
  if (typeof value !== 'string') {
    return `${fieldName} must be a string`;
  }
  if (value.trim() === '') {
    return `${fieldName} cannot be empty`;
  }
  return null;
}

/**
 * Validate that a string is a valid URL
 * @param {string} value - The string to validate
 * @param {string} fieldName - Name of the field for error messages
 * @returns {string|null} - Error message if invalid, null if valid
 */
export function validateUrl(value, fieldName) {
  if (!value) return null; // Allow empty URLs (handled by required validation)
  
  try {
    new URL(value);
    return null;
  } catch (error) {
    return `${fieldName} must be a valid URL`;
  }
}

/**
 * Validate that a number is within a specified range
 * @param {number} value - The number to validate
 * @param {string} fieldName - Name of the field for error messages
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {string|null} - Error message if invalid, null if valid
 */
export function validateNumberRange(value, fieldName, min, max) {
  if (value === undefined || value === null) {
    return `${fieldName} is required`;
  }
  if (typeof value !== 'number' || isNaN(value)) {
    return `${fieldName} must be a valid number`;
  }
  if (value < min || value > max) {
    return `${fieldName} must be between ${min} and ${max}`;
  }
  return null;
}

/**
 * Validate that a string is one of the allowed values
 * @param {string} value - The string to validate
 * @param {string} fieldName - Name of the field for error messages
 * @param {Array<string>} allowedValues - Array of allowed string values
 * @returns {string|null} - Error message if invalid, null if valid
 */
export function validateEnum(value, fieldName, allowedValues) {
  if (value === undefined || value === null) {
    return `${fieldName} is required`;
  }
  if (typeof value !== 'string') {
    return `${fieldName} must be a string`;
  }
  if (!allowedValues.includes(value)) {
    return `${fieldName} must be one of: ${allowedValues.join(', ')}`;
  }
  return null;
}

/**
 * Validate an array
 * @param {Array} value - The array to validate
 * @param {string} fieldName - Name of the field for error messages
 * @param {number} minLength - Minimum array length
 * @param {number} maxLength - Maximum array length
 * @returns {string|null} - Error message if invalid, null if valid
 */
export function validateArray(value, fieldName, minLength = 0, maxLength = null) {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }
  if (value.length < minLength) {
    return `${fieldName} must have at least ${minLength} element(s)`;
  }
  if (maxLength !== null && value.length > maxLength) {
    return `${fieldName} must have no more than ${maxLength} element(s)`;
  }
  return null;
}