'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isFileImage, safeHref } from '@/lib/markdown-rules';

// Agent output is untrusted: no raw HTML, links open in a new tab without referrer.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-wren">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={safeHref(href)} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (isFileImage(src) ? <img src={src} alt={alt ?? ''} className="max-h-96 rounded-xl border border-border" /> : <span>[image: {alt}]</span>),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
