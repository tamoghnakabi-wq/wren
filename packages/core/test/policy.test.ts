import { describe, expect, it } from 'vitest';
import { assessCall, assessShell, needsApproval } from '../src/policy';
import { isPrivateAddress } from '../src/net';

describe('shell risk', () => {
  const desk = (c: string) => assessShell(c, 'desktop');
  it('treats read-only commands as low', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'cat README.md | head -20', 'node --version', 'rg TODO src', 'gh pr list']) {
      expect(desk(c).risk, c).toBe('low');
    }
  });
  it('treats ordinary programs as medium on desktop, low in the cloud', () => {
    expect(desk('npm test').risk).toBe('medium');
    expect(assessShell('npm test', 'cloud').risk).toBe('low');
    expect(desk('echo hi > notes.txt').risk).toBe('medium');
  });
  it('flags destructive and external actions', () => {
    expect(desk('rm notes.txt').risk).toBe('high');
    expect(desk('git push origin main').risk).toBe('high');
    expect(desk('curl -X POST https://api.example.com -d x=1').risk).toBe('high');
    expect(desk('npm publish').risk).toBe('high');
    expect(desk('ls && git push').risk).toBe('high');
    expect(assessShell('git push', 'cloud').risk).toBe('high');
  });
  it('only flags network/process commands in command position', () => {
    expect(desk('echo READ-SSH || echo ssh-blocked').risk).toBe('low');
    expect(desk('ls && ssh host uptime').risk).toBe('high');
    expect(desk('echo "kill switch"').risk).toBe('low');
    expect(desk('pkill node').risk).toBe('high');
    expect(desk('ps aux | xargs kill').risk).toBe('high');
  });
  it('marks privileged and credential access critical', () => {
    expect(desk('sudo apt install x').risk).toBe('critical');
    expect(desk('security find-generic-password -s foo').risk).toBe('critical');
    expect(desk('cat ~/.ssh/id_rsa').risk).toBe('critical');
  });
  it('blocks catastrophic commands', () => {
    expect(desk('rm -rf /').blocked).toBeTruthy();
    expect(desk('rm -rf ~').blocked).toBeTruthy();
    expect(desk('sudo rm -rf / --no-preserve-root').blocked).toBeTruthy();
    expect(desk('dd if=/dev/zero of=/dev/disk2').blocked).toBeTruthy();
    expect(desk('rm -rf ./build').blocked).toBeFalsy();
  });
});

describe('approval thresholds', () => {
  it('maps autonomy to thresholds', () => {
    expect(needsApproval('medium', 'careful')).toBe(true);
    expect(needsApproval('medium', 'balanced')).toBe(false);
    expect(needsApproval('high', 'balanced')).toBe(true);
    expect(needsApproval('high', 'autonomous')).toBe(false);
    expect(needsApproval('critical', 'autonomous')).toBe(true);
  });
});

describe('browser + other tools', () => {
  it('blocks typing into password and card fields', () => {
    expect(assessCall('browser.type', { ref: 'e1', text: 'x' }, 'cloud', { browserTarget: { inputType: 'password' } }).blocked).toBeTruthy();
    expect(assessCall('browser.type', { ref: 'e1', text: 'x' }, 'cloud', { browserTarget: { autocomplete: 'cc-number' } }).blocked).toBeTruthy();
  });
  it('treats purchase buttons as critical', () => {
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Place order' } }).risk).toBe('critical');
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Next page' } }).risk).toBe('low');
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Send message' } }).risk).toBe('high');
  });
  it('rates GitHub writes', () => {
    expect(assessCall('github.request', { method: 'GET', path: '/user' }, 'cloud').risk).toBe('low');
    expect(assessCall('github.request', { method: 'POST', path: '/repos/a/b/issues' }, 'cloud').risk).toBe('high');
    expect(assessCall('github.request', { method: 'DELETE', path: '/repos/a/b' }, 'cloud').risk).toBe('critical');
  });
});

describe('ssrf guard', () => {
  it('recognises private ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
