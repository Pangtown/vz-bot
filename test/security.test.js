import { extractContext, verifyWebPassword } from '../src/gateway/vhi-api/helpers.js';
import { validateVinfraArgs } from '../src/vhi/vinfra.js';
import { vinfraCli } from '../src/tools/vinfra.js';

describe('Security & Authentication Gates', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('verifyWebPassword - validates when WEB_PASSWORD is unset or matching', () => {
    delete process.env.WEB_PASSWORD;
    expect(verifyWebPassword({ headers: {} })).toBe(true);

    process.env.WEB_PASSWORD = 'super-secret-pw';
    expect(verifyWebPassword({ headers: {} })).toBe(false);
    expect(verifyWebPassword({ headers: { 'x-web-password': 'wrong' } })).toBe(false);
    expect(verifyWebPassword({ headers: { 'x-web-password': 'super-secret-pw' } })).toBe(true);
    expect(verifyWebPassword({ headers: { 'authorization': 'Bearer super-secret-pw' } })).toBe(true);
  });

  test('extractContext - prevents unauthorized fallback to server .env credentials', () => {
    process.env.WEB_PASSWORD = 'admin-password';
    process.env.VHI_BASE_URL = 'https://cluster.internal';
    process.env.VHI_USER = 'admin';
    process.env.VHI_PASSWORD = 'cluster-root-secret';

    // Unauthenticated request must NOT get server credentials
    const unauthed = extractContext({ headers: {} });
    expect(unauthed.vhiUser).toBe('');
    expect(unauthed.vhiPassword).toBe('');
    expect(unauthed.vhiBaseUrl).toBe('');

    // Authenticated request with correct web password gets fallback if headers omitted
    const authed = extractContext({ headers: { 'x-web-password': 'admin-password' } });
    expect(authed.vhiUser).toBe('admin');
    expect(authed.vhiPassword).toBe('cluster-root-secret');
    expect(authed.vhiBaseUrl).toBe('https://cluster.internal');

    // Explicit client credentials always override
    const explicit = extractContext({
      headers: {
        'x-vhi-user': 'custom-user',
        'x-vhi-password': 'custom-password',
        'x-vhi-base-url': 'https://custom-cluster.local'
      }
    });
    expect(explicit.vhiUser).toBe('custom-user');
    expect(explicit.vhiPassword).toBe('custom-password');
  });

  test('validateVinfraArgs - restricts raw shell execution and allows safe commands', () => {
    // Prohibited raw binaries
    expect(() => validateVinfraArgs(['/bin/bash', '-c', 'whoami'])).toThrow(/prohibited/);
    expect(() => validateVinfraArgs(['/usr/bin/python3', '-c', 'import os'])).toThrow(/prohibited/);
    expect(() => validateVinfraArgs(['/bin/rm', '-rf', '/'])).toThrow(/prohibited/);

    // Allowed raw commands
    expect(validateVinfraArgs(['/sbin/ip', '-j', 'addr'])).toEqual({ isRaw: true });
    expect(validateVinfraArgs(['/sbin/reboot'])).toEqual({ isRaw: true });
    expect(validateVinfraArgs(['reboot'])).toEqual({ isRaw: true });

    // Allowed vinfra commands
    expect(validateVinfraArgs(['cluster', 'list'])).toEqual({ isRaw: false });
    expect(validateVinfraArgs(['node', 'list'])).toEqual({ isRaw: false });
  });

  test('vinfraCli tool - rejects raw shell execution from LLM', async () => {
    await expect(vinfraCli.execute({ args: ['/bin/sh', '-c', 'echo evil'] }))
      .rejects.toThrow(/Raw shell command execution is prohibited/);
    await expect(vinfraCli.execute({ args: ['reboot'] }))
      .rejects.toThrow(/Raw shell command execution is prohibited/);
    await expect(vinfraCli.execute({ args: ['bash'] }))
      .rejects.toThrow(/Raw shell command execution is prohibited/);
  });
});
