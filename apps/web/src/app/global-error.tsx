'use client';

// Last resort when the root layout itself fails: it renders its own document without the app's
// styles, so everything it needs is inline and it follows the OS light/dark setting.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100dvh', display: 'grid', placeItems: 'center', fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', background: 'Canvas', color: 'CanvasText', colorScheme: 'light dark' }}>
        <title>Wren</title>
        <main style={{ maxWidth: 360, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Wren couldn’t load</h1>
          <p style={{ fontSize: 14, opacity: 0.7, lineHeight: 1.5 }}>Your agents and tasks are safe. Try again in a moment.</p>
          {error.digest && <p style={{ fontSize: 12, opacity: 0.5, fontFamily: 'ui-monospace, monospace' }}>Reference: {error.digest}</p>}
          <button onClick={() => retry()} style={{ marginTop: 8, height: 40, padding: '0 18px', borderRadius: 12, border: 0, background: '#d9622b', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
