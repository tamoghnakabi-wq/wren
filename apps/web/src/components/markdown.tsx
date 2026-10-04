'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent output is untrusted: no raw HTML, links open in a new tab without referrer.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-wren">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href && /^(https?:|mailto:|\/)/.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (typeof src === 'string' && src.startsWith('/api/files/') ? <img src={src} alt={alt ?? ''} className="max-h-96 rounded-xl border border-border" /> : <span>[image: {alt}]</span>),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
