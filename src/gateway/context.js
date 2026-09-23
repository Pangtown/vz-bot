import { AsyncLocalStorage } from 'node:async_hooks';

export const vhiContext = new AsyncLocalStorage();

/**
 * Run a function with the given context values available via vhiContext.getStore()
 */
export function runWithContext(contextState, fn) {
    return vhiContext.run(contextState, fn);
}

/**
 * Get a value from the current async context, falling back to process.env only when no context is active.
 */
export function getContextValue(key, fallbackEnvKey) {
    const store = vhiContext.getStore();
    if (store) {
        if (store[key] !== undefined && store[key] !== null) {
            return store[key];
        }
        return '';
    }
    if (fallbackEnvKey) {
        return process.env[fallbackEnvKey] || '';
    }
    return '';
}
