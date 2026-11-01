import type { Metadata, Viewport } from 'next';
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ThemeWatcher } from '@/components/theme-watcher';
import { SiteAnalytics } from '@/components/analytics';
import { PREFS_SCRIPT } from '@/lib/prefs';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--font-display-serif', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Wren — agents that get things done', template: '%s · Wren' },
  description: 'Personal AI agents that work on their own computer in the cloud or on your Mac and PC. Start tasks from your phone, approve what matters, get results while you are away.',
  applicationName: 'Wren',
  appleWebApp: { capable: true, title: 'Wren', statusBarStyle: 'default' },
  
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#121110' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <head>
        {/* A plain inline script in <head> runs before the page is drawn (next/script's
            beforeInteractive is queued and runs after first paint, which flashed the wrong
            theme and expanded panes). */}
        <script id="wren-prefs" dangerouslySetInnerHTML={{ __html: PREFS_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg text-text">
        <ThemeWatcher />
        <SiteAnalytics>{children}</SiteAnalytics>
      </body>
    </html>
  );
}
