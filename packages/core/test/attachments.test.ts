import { describe, expect, it } from 'vitest';
import { ATTACHED_TEXT_MAX_CHARS, ATTACHED_TEXT_TOTAL_CHARS, attachedText, cachedLoader, decodeText, isTextAttachment, TEXT_FILE_MAX_BYTES, withAttachedText, type Attachment } from '../src/attachments';
import type { MessageData, SessionEvent } from '../src/types';

const enc = (t: string) => new TextEncoder().encode(t);
const file = (name: string, mime: string, size = 10, artifactId = name): Attachment => ({ artifactId, name, mime, size });
const msg = (text: string, attachments: Attachment[], seq = 1): SessionEvent => ({ id: `e${seq}`, seq, runId: 'r', type: 'message', status: 'done', data: { role: 'user', text, attachments } });
const textOf = (e: SessionEvent) => (e.data as MessageData).text;

describe('which attachments are text', () => {
  it('goes by type or extension, never images, at most 1 MB', () => {
    expect(isTextAttachment(file('a.txt', 'text/plain'))).toBe(true);
    expect(isTextAttachment(file('data.json', 'application/json'))).toBe(true);
    expect(isTextAttachment(file('server.log', ''))).toBe(true); // browsers give no type for .log
    expect(isTextAttachment(file('main.py', 'application/octet-stream'))).toBe(true);
    expect(isTextAttachment(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isTextAttachment(file('logo.svg', 'image/svg+xml'))).toBe(false);
    expect(isTextAttachment(file('big.csv', 'text/csv', TEXT_FILE_MAX_BYTES + 1))).toBe(false);
    expect(isTextAttachment(file('README', 'application/octet-stream'))).toBe(false);
  });

  it('reads only UTF-8 without NUL bytes, dropping a byte-order mark', () => {
    expect(decodeText(enc('﻿hé'))).toBe('hé');
    expect(decodeText(new Uint8Array([0x68, 0, 0x69]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe('attached text in the message the model gets', () => {
  it('adds each text file and says which files it couldn’t pass on', async () => {
    const d = msg('Look at these', [file('a.txt', 'text/plain'), file('shot.png', 'image/png'), file('r.pdf', 'application/pdf'), file('bin.txt', 'text/plain'), file('gone.md', 'text/markdown')]).data as MessageData;
    const load = async (id: string) => (id === 'a.txt' ? enc('alpha') : id === 'bin.txt' ? new Uint8Array([1, 0, 2]) : null);
    const r = await attachedText(d, load, ATTACHED_TEXT_TOTAL_CHARS);
    expect(r.text).toBe(
      'Look at these\n\n<attached-file name="a.txt">\nalpha\n</attached-file>\n\n' +
        '[Wren can\'t give you the contents of: r.pdf (not a text file); bin.txt (not a text file); gone.md (it couldn’t be loaded).]',
    );
    expect(r.used).toBe(5);
  });

  it('cuts a message’s files at its limit and says so', async () => {
    const big = 'x'.repeat(ATTACHED_TEXT_MAX_CHARS + 50);
    const r = await attachedText(msg('', [file('a.txt', 'text/plain'), file('b.txt', 'text/plain')]).data as MessageData, async () => enc(big), ATTACHED_TEXT_TOTAL_CHARS);
    expect(r.used).toBe(ATTACHED_TEXT_MAX_CHARS);
    expect(r.text).toContain(`[Cut here: a.txt has ${(ATTACHED_TEXT_MAX_CHARS + 50).toLocaleString('en-US')} characters`);
    expect(r.text).toContain('b.txt (left out to keep the conversation short');
  });

  it('keeps the newest messages’ files when the conversation’s total runs out, and changes no event', async () => {
    const half = 'y'.repeat(ATTACHED_TEXT_MAX_CHARS);
    const events = [msg('one', [file('1.txt', 'text/plain')], 1), msg('two', [file('2.txt', 'text/plain')], 2), msg('three', [file('3.txt', 'text/plain')], 3)];
    const before = structuredClone(events);
    const out = await withAttachedText(events, async () => enc(half));
    expect(events).toEqual(before);
    expect(textOf(out[2])).toContain('<attached-file name="3.txt">');
    expect(textOf(out[1])).toContain('<attached-file name="2.txt">');
    expect(textOf(out[0])).toContain('1.txt (left out');
    expect(ATTACHED_TEXT_TOTAL_CHARS).toBe(2 * ATTACHED_TEXT_MAX_CHARS);
  });

  it('leaves messages without files alone and names no images', async () => {
    const events = [msg('hi', []), msg('pic', [file('a.png', 'image/png')], 2)];
    const out = await withAttachedText(events, async () => {
      throw new Error('not called');
    });
    expect(out.map(textOf)).toEqual(['hi', 'pic']);
  });

  it('skips a file that fails to load, but stops on Stop or a lost lease', async () => {
    const d = msg('x', [file('a.txt', 'text/plain')]).data as MessageData;
    expect((await attachedText(d, async () => Promise.reject(new Error('blob down')), 1000)).text).toContain('a.txt (it couldn’t be loaded)');
    const lost = Object.assign(new Error('lease'), { status: 409 });
    await expect(attachedText(d, async () => Promise.reject(lost), 1000)).rejects.toBe(lost);
    const ac = new AbortController();
    ac.abort();
    await expect(attachedText(d, async () => Promise.reject(new Error('aborted')), 1000, ac.signal)).rejects.toThrow('aborted');
  });

  it('keeps file names from breaking out of their tag', async () => {
    const r = await attachedText(msg('', [file('a"><b.txt', 'text/plain')]).data as MessageData, async () => enc('t'), 100);
    expect(r.text).toContain('<attached-file name="a\'\'\'b.txt">');
  });

  it('reads each file once per loader, and again after a failure', async () => {
    let n = 0;
    const load = cachedLoader(async () => {
      n++;
      if (n === 1) throw new Error('first try fails');
      return enc('ok');
    });
    await expect(load('a')).rejects.toThrow();
    await load('a');
    await load('a');
    expect(n).toBe(2);
  });
});
