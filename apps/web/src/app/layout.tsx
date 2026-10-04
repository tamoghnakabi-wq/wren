import type { Metadata, Viewport } from 'next';
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--font-display-serif', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Wren — agents that get things done', template: '%s · Wren' },
  description: 'Personal AI agents that work on their own computer in the cloud or on your Mac and PC. Start tasks from your phone, approve what matters, get results while you are away.',
  applicationName: 'Wren',
  appleWebApp: { capable: true, title: 'Wren', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/apple-icon.png' },
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

// Applies the saved theme before paint (system by default).
const themeScript = `try{var t=localStorage.getItem('wren-theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-bg text-text">
        <Script id="wren-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
