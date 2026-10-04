import { z } from 'zod';
import { HttpError } from './auth';

// Small helpers so route handlers stay short and always return JSON errors.

export function json(data: unknown, init?: number | ResponseInit) {
  return Response.json(data, typeof init === 'number' ? { status: init } : init);
}

export function route<C = unknown>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      if (e instanceof z.ZodError) return json({ error: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'invalid' }, 400);
      console.error('route error', e);
      return json({ error: 'Something went wrong on our side.', code: 'internal' }, 500);
    }
  };
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, 'Expected a JSON body.', 'invalid');
  }
  return schema.parse(raw);
}

export const uuid = z.string().uuid();

export function notFound(what = 'Not found'): never {
  throw new HttpError(404, what, 'not_found');
}
