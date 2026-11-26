import { describe, expect, it } from 'vitest';
import { scrubSecrets, secretNameProblem, taskSecretEnv } from '../src/secrets';

// Secrets an agent asks the user for (task.request_secret, 0.1.55).

describe('secret names', () => {
  it('are environment variable names a program doesn’t already use', () => {
    expect(secretNameProblem('STRIPE_API_KEY')).toBeNull();
    expect(secretNameProblem('MY_PATH')).toBeNull();
    expect(secretNameProblem('stripe_key')).toMatch(/capital letters/);
    expect(secretNameProblem('1KEY')).toMatch(/capital letters/);
    expect(secretNameProblem('A'.repeat(65))).toMatch(/at most 64/);
    for (const n of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'PYTHONPATH', 'WREN_URL', 'ANTHROPIC_API_KEY', 'DOCKER_HOST']) {
      expect(secretNameProblem(n), n).toMatch(/something else/);
    }
  });

  it('only such names reach a command', () => {
    expect(taskSecretEnv({ API_TOKEN: 'abcd1234', PATH: '/evil', lower: 'x' })).toEqual({ API_TOKEN: 'abcd1234' });
    expect(taskSecretEnv(undefined)).toEqual({});
  });
});

describe('blanking secrets out', () => {
  it('replaces every copy, in any string, quotes and backslashes included', () => {
    const secrets = [
      { name: 'TOKEN', value: 'sk-live-1234567890' },
      { name: 'ODD', value: 'pa"ss\\word' },
      { name: 'SHORT', value: 'abc' },
    ];
    const data = { output: 'token=sk-live-1234567890\nagain sk-live-1234567890', args: { command: 'echo "pa\\"ss\\\\word"', list: ['pa"ss\\word'] }, n: 3, short: 'abc' };
    expect(scrubSecrets(data, secrets)).toEqual({
      output: 'token=[secret TOKEN]\nagain [secret TOKEN]',
      args: { command: 'echo "pa\\"ss\\\\word"', list: ['[secret ODD]'] },
      n: 3,
      short: 'abc',
    });
  });

  it('replaces a longer secret before one it contains, and leaves data without them as it was', () => {
    const secrets = [
      { name: 'PART', value: 'abcd1234' },
      { name: 'WHOLE', value: 'xx-abcd1234-yy' },
    ];
    expect(scrubSecrets({ t: 'xx-abcd1234-yy and abcd1234' }, secrets)).toEqual({ t: '[secret WHOLE] and [secret PART]' });
    const same = { t: 'nothing here' };
    expect(scrubSecrets(same, secrets)).toBe(same);
    expect(scrubSecrets(undefined, secrets)).toBeUndefined();
  });
});
