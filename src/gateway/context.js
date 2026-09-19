import { AsyncLocalStorage } from 'node:async_hooks';

export const vhiContext = new AsyncLocalStorage();

let lastValidContext = null;

/**
 * Run a function with the given context values available via vhiContext.getStore()
 */
export function runWithContext(contextState, fn) {
    if (contextState && contextState.persistLast !== false && contextState.vhiUser && contextState.vhiPassword) {
        lastValidContext = { ...contextState };
    }
    return vhiContext.run(contextState, fn);
}

/**
 * Get the last valid credentials if no active context is found
 */
export function getLastValidContext() {
    return lastValidContext;
}

/**
 * Get a value from the current async context, optionally falling back to global session or process.env
 */
export function getContextValue(key, fallbackEnvKey) {
    const store = vhiContext.getStore();
    if (store) {
        if (store[key] !== undefined && store[key] !== null) {
            return store[key];
        }
        return '';
    }
    if (lastValidContext && lastValidContext[key] !== undefined && lastValidContext[key] !== null) {
        return lastValidContext[key];
    }
    if (fallbackEnvKey) {
        return process.env[fallbackEnvKey] || '';
    }
    return '';
}
