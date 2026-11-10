// What agent-written markdown may point at. Agent output is untrusted (a page an agent read can put
// words in its mouth), so links are limited to ordinary web, mail and in-app addresses, and an image
// loads only if it is one of the account's own files.

/** A link's address as given, or nothing for anything but http(s), mailto and paths on this site. */
export function safeHref(href: string | undefined | null): string | undefined {
  return href && /^(https?:|mailto:|\/)/.test(href) ? href : undefined;
}

const FILE = /^\/api\/files\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Whether an image address is exactly a stored file (`/api/files/<id>`). A browser loads an image as
 * soon as it is drawn, so "starts with /api/files/" wasn't enough: `/api/files/../models?source=…`
 * (or any other address on this site) would be requested with the user's sign-in just by showing the
 * agent's answer.
 */
export function isFileImage(src: unknown): src is string {
  return typeof src === 'string' && FILE.test(src);
}
