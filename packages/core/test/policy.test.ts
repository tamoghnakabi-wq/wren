import { describe, expect, it } from 'vitest';
import { assessCall, assessShell, isReadOnlyCommand, needsApproval } from '../src/policy';
import { isPrivateAddress } from '../src/net';

describe('shell risk', () => {
  const desk = (c: string) => assessShell(c, 'desktop');
  it('treats read-only commands as low', () => {
    for (const c of ['ls -la', 'git branch -v', 'git rev-parse --abbrev-ref HEAD', 'cat README.md | head -20', 'node --version', 'rg TODO src', 'gh pr list']) {
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
  it('catches writes hidden in read-only commands', () => {
    expect(desk('git log > out.txt').risk).toBe('medium');
    expect(desk('git diff --output=x.patch').risk).toBe('medium');
    expect(desk('sort -o out.txt in.txt').risk).toBe('medium');
    expect(desk('ls 2>&1').risk).toBe('low');
    expect(desk('cat a 2>/dev/null').risk).toBe('low');
    expect(desk('gh api repos/o/r/issues -f title=hi').risk).toBe('high');
    expect(desk('gh api repos/o/r/issues --input body.json').risk).toBe('high');
    expect(desk('gh api repos/o/r').risk).toBe('low');
    expect(desk('find . -name "*.log" -delete').risk).toBe('high');
  });
  it('catches writing and executing forms of listed read commands', () => {
    for (const c of ['xxd -r -p input.hex out.bin', 'xxd in.bin out.hex', 'uniq input.txt output.txt', 'sort -ooutput.txt input.txt', 'sort -rno out.txt in.txt', 'yq -i .a=1 file.yml', 'rg --pre ./run.sh TODO', 'fd -x rm {}', 'fd --exec-batch touch', 'date -s 2026-01-01', 'date 0101000026', 'hostname evil']) {
      expect(desk(c).risk, c).not.toBe('low');
    }
    for (const c of ['xxd file.bin', 'uniq -c input.txt', 'sort -n data.txt', 'yq .a file.yml', 'rg TODO src', 'fd .ts src', 'date +%s', 'hostname']) expect(desk(c).risk, c).toBe('low');
  });
  it('sees every spelling of a GitHub write method', () => {
    for (const c of ['gh api --method=DELETE repos/o/r', 'gh api -XDELETE repos/o/r', 'gh api -X=PATCH repos/o/r', 'gh api --method PUT repos/o/r/x']) expect(desk(c).risk, c).toBe('high');
  });
  it('reads options the way the program receives them (quotes removed)', () => {
    for (const c of ['sort "-o" output.txt input.txt', "sort '-o' out in", 'yq "-i" ".a = 1" file.yml', 'rg "--pre=/x/pre" pattern file', 'fd "-x" rm', 'tree "-o" out.txt', 'find . "-delete"', 'xxd "-r" in out', 's\\ort -o out in']) {
      expect(desk(c).risk, c).not.toBe('low');
    }
    for (const c of ["gh api repos/o/r -X'DELETE'", 'gh api repos/o/r -X"DELETE"', 'gh api repos/o/r "-X" DELETE', "gh api repos/o/r '--method=DELETE'", 'gh api repos/o/r "-f" a=b']) {
      expect(desk(c).risk, c).toBe('high');
    }
    expect(desk('"rm" -rf ~').blocked, 'quoted rm').toBeTruthy();
    expect(desk("'git' push origin main").risk).toBe('high');
    expect(desk('echo $(rm -rf build)').risk).toBe('high');
  });
  it('treats unknown values conservatively', () => {
    expect(desk('sort $OPTS data.txt').risk).toBe('medium');
    expect(desk('$CMD file').risk).toBe('high');
    expect(desk('"$(which git)" status').risk).toBe('high');
    expect(desk('./*/ls').risk).toBe('high');
    expect(desk('rg "$(cat flags)" src').risk).toBe('medium');
    expect(desk('echo $HOME').risk).toBe('low');
    expect(desk('cat "$FILE"').risk).toBe('low');
  });
  it('keeps quoted operators inside their argument', () => {
    for (const c of ['grep "a|b" notes.txt', "grep 'x;y' f", 'echo "a && b"', 'git tag -l "v1;x"', 'echo $(date) done', 'LC_ALL=C sort data.txt', 'cat a.txt 2>&1 | wc -l']) {
      expect(desk(c).risk, c).toBe('low');
    }
  });
  it('looks inside substitutions within double quotes', () => {
    expect(desk('echo "$(sort -o result.txt input.txt)"').risk).not.toBe('low');
    expect(desk('echo "$(g\'it\' push)"').risk).toBe('high');
    expect(desk('echo "`git push --force`"').risk).toBe('high');
    expect(isReadOnlyCommand('echo "$(sort -o result.txt input.txt)"')).toBe(false);
    expect(desk("$'\\x67it' push").risk).toBe('high');
    expect(desk('echo "$(date)"').risk).toBe('low');
  });
  it('never counts git commands that can run repository-configured programs as read-only (W-88)', () => {
    // fsmonitor/post-index-change hooks, clean filters, external diff, textconv, gpg.program: all
    // named in .git/config, which agents can write.
    for (const c of ['git status', 'git status --short', 'git diff', 'git diff --ext-diff', 'git log --oneline -5', 'git show HEAD', 'git ls-files', 'git blame a.txt', 'git shortlog', 'git reflog', 'git stash list', 'git describe --dirty', 'git rev-parse :a.txt', 'git config --get-urlmatch http https://x']) {
      expect(isReadOnlyCommand(c), c).toBe(false);
      expect(desk(c).risk, c).not.toBe('low');
    }
    expect(desk('git status').reason).toMatch(/repository’s own settings/);
    // A prefix of a read subcommand is a different command (an alias can run anything: !./helper).
    for (const c of ['git statusprobe', 'git branchx', 'git rev-parsex', 'git configx --get a', 'git tagger -l', 'git remote-helper']) expect(isReadOnlyCommand(c), c).toBe(false);
    // Global options and -c come before the subcommand: never read-only.
    for (const c of ['git -c core.fsmonitor=./x branch', 'git -C ../other branch', 'git --git-dir=x branch', 'git --exec-path=. branch']) expect(isReadOnlyCommand(c), c).toBe(false);
    for (const c of ['git branch', 'git branch -a', 'git branch -vv', 'git remote -v', 'git tag -l', 'git tag -l "v*" -n', 'git rev-parse HEAD', 'git rev-parse --show-toplevel', 'git describe --tags', 'git config --get user.name', 'git config --list --show-origin', 'git --version']) {
      expect(isReadOnlyCommand(c), c).toBe(true);
    }
    for (const c of ['git branch -D x', 'git branch new', 'git remote add o u', 'git tag v2', 'git tag -l -d v1', 'git config user.name x', 'git config --get a --unset b', 'git rev-parse --git-path hooks']) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });
  it('treats pager variables as choosing a program (PAGER=./x man ls runs ./x)', () => {
    for (const c of ['PAGER=./x man ls', 'GIT_PAGER=./x git branch', 'MANPAGER=./x man ls']) expect(isReadOnlyCommand(c), c).toBe(false);
    expect(isReadOnlyCommand('TERM=dumb ls')).toBe(true);
  });
  it('only trusts the system copies of read-only commands', () => {
    expect(isReadOnlyCommand('/allowed/project/ls')).toBe(false);
    expect(isReadOnlyCommand('./ls -la')).toBe(false);
    expect(isReadOnlyCommand('PATH=/tmp/x ls')).toBe(false);
    expect(isReadOnlyCommand('DYLD_INSERT_LIBRARIES=/tmp/x.dylib cat a')).toBe(false);
    expect(desk('PATH=. ls').risk).not.toBe('low');
    expect(isReadOnlyCommand('/bin/ls -la')).toBe(true);
    expect(isReadOnlyCommand('LC_ALL=C sort data.txt')).toBe(true);
    expect(desk('LC_ALL=C sort data.txt').risk).toBe('low');
  });
  it('replays only read commands with known arguments', () => {
    expect(isReadOnlyCommand('ls -la && cat a.txt')).toBe(true);
    expect(isReadOnlyCommand('sort "-o" out in')).toBe(false);
    expect(isReadOnlyCommand('cat $FILE')).toBe(false);
    expect(isReadOnlyCommand('echo hi > x')).toBe(false);
  });
  it('W-74: a bare name counts as read-only only if the host vouches for the program it resolves to', () => {
    const trust = (name: string) => name !== 'ls' && name !== 'node';
    expect(assessShell('ls -la', 'desktop', trust)).toMatchObject({ risk: 'medium', reason: expect.stringMatching(/folder agents can write/) });
    expect(assessShell('cat a.txt | ls', 'desktop', trust).risk).toBe('medium');
    expect(assessShell('node --version', 'desktop', trust).risk).toBe('medium');
    expect(isReadOnlyCommand('ls', trust)).toBe(false);
    expect(assessShell('cat a.txt', 'desktop', trust).risk).toBe('low');
    // The system's own utility by full path doesn't depend on PATH.
    expect(assessShell('/bin/ls -la', 'desktop', trust).risk).toBe('low');
    expect(isReadOnlyCommand('/bin/ls', () => false)).toBe(true);
    // Through assessCall, as the desktop host supplies it.
    expect(assessCall('computer.shell', { command: 'ls' }, 'desktop', { trustedProgram: () => false }).risk).toBe('medium');
    expect(assessCall('computer.shell', { command: 'ls' }, 'desktop', { trustedProgram: () => true }).risk).toBe('low');
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
  it('asks for every unsandboxed (Windows) command unless autonomous', () => {
    expect(assessCall('computer.shell', { command: 'ls' }, 'desktop', { unsandboxed: true }).risk).toBe('high');
    expect(assessCall('computer.shell', { command: 'type C:\\Users\\me\\notes.txt' }, 'desktop', { unsandboxed: true }).risk).toBe('high');
    expect(assessCall('computer.shell', { command: 'ls' }, 'desktop').risk).toBe('low');
    expect(assessCall('computer.shell', { command: 'rm -rf /' }, 'desktop', { unsandboxed: true }).blocked).toBeTruthy();
  });

  it('blocks typing into password and card fields', () => {
    expect(assessCall('browser.type', { ref: 'e1', text: 'x' }, 'cloud', { browserTarget: { inputType: 'password' } }).blocked).toBeTruthy();
    expect(assessCall('browser.type', { ref: 'e1', text: 'x' }, 'cloud', { browserTarget: { autocomplete: 'cc-number' } }).blocked).toBeTruthy();
  });
  it('treats purchase buttons as critical', () => {
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Place order' } }).risk).toBe('critical');
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Next page' } }).risk).toBe('low');
    expect(assessCall('browser.click', { ref: 'e2' }, 'cloud', { browserTarget: { label: 'Send message' } }).risk).toBe('high');
  });
  it('assesses the focused element for activating key presses', () => {
    expect(assessCall('browser.press', { key: 'Tab' }, 'cloud').risk).toBe('low');
    expect(assessCall('browser.press', { key: 'Enter' }, 'cloud', { browserTarget: { label: 'Buy now' } }).risk).toBe('critical');
    expect(assessCall('browser.press', { key: 'Space' }, 'cloud', { browserTarget: { label: 'Delete account' } }).risk).toBe('high');
    expect(assessCall('browser.press', { key: 'Control+Enter' }, 'cloud', { browserTarget: { label: 'Send' } }).risk).toBe('high');
    // A literal space is Space to the browser, alone or with modifiers.
    expect(assessCall('browser.press', { key: ' ' }, 'cloud', { browserTarget: { label: 'Place order' } }).risk).toBe('critical');
    expect(assessCall('browser.press', { key: 'Shift+ ' }, 'cloud', { browserTarget: { label: 'Place order' } }).risk).toBe('critical');
    expect(assessCall('browser.press', { key: 'ArrowDown' }, 'cloud').risk).toBe('low');
  });
  it('fails closed when the element cannot be inspected', () => {
    expect(assessCall('browser.click', { ref: 'e9' }, 'cloud').risk).toBe('high');
    expect(assessCall('browser.press', { key: 'Enter' }, 'desktop').risk).toBe('high');
  });
  it('never trusts an MCP server to lower its own risk', () => {
    expect(assessCall('mcp_abc123.delete_all', {}, 'cloud', { mcpReadOnly: true }).risk).toBe('high');
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
