'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isFileImage, safeHref } from '@/lib/markdown-rules';

// Agent output is untrusted: no raw HTML, links open in a new tab without referrer.

const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, children }) => (
    <a href={safeHref(href)} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (isFileImage(src) ? <img src={src} alt={alt ?? ''} className="max-h-96 rounded-xl border border-border" /> : <span>[image: {alt}]</span>),
};

/**
 * Rendered again only when its text changes. A task's timeline re-renders on every live update (a streaming
 * answer sends many), and parsing each of its replies again each time blocked the page for up to ~90 ms per update
 * on a 4× slower CPU (150 replies): clicks waited.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-wren">
      <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
