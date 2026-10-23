import { createHash } from 'node:crypto';

export const SCOPE_READ = 'freescout:read';
export const SCOPE_WRITE = 'freescout:write';
export const SCOPE_SEND = 'freescout:send';
export type FreeScoutScope = typeof SCOPE_READ | typeof SCOPE_WRITE | typeof SCOPE_SEND;

/** The FreeScout user an OAuth access token acts for, and what it may do. */
export interface Principal {
  userId: number;
  userName: string;
  clientId: string;
  scopes: string[];
  /** Mailboxes the user can view in FreeScout. */
  mailboxIds: number[];
  isAdmin: boolean;
  /** Seconds since epoch. */
  expiresAt: number;
}

export type TokenIntrospector = (token: string) => Promise<Principal | null>;

interface IntrospectionResponse {
  active?: boolean;
  scope?: string;
  client_id?: string;
  exp?: number;
  user_id?: number;
  user_name?: string;
  is_admin?: boolean;
  mailbox_ids?: number[];
}

export interface IntrospectorOptions {
  /** How long a positive answer is reused before asking FreeScout again. */
  cacheMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_INTROSPECTION_CACHE_MS = 60_000;

/**
 * Checks access tokens with the McpOAuth FreeScout module's introspection
 * endpoint, authenticated with the API & Webhooks key. Active answers are
 * cached briefly (never past the token's expiry) so each tool call does not
 * cost a round trip; revocation therefore takes effect within the cache time.
 */
export function createFreeScoutIntrospector(
  baseUrl: string,
  apiKey: string,
  options: IntrospectorOptions = {}
): TokenIntrospector {
  const cacheMs = options.cacheMs ?? DEFAULT_INTROSPECTION_CACHE_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/oauth/introspect`;
  const cache = new Map<string, { principal: Principal; until: number }>();

  return async (token: string) => {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.until > now()) {
      return cached.principal;
    }
    cache.delete(key);

    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'X-FreeScout-API-Key': apiKey,
      },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Token introspection failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as IntrospectionResponse;
    if (!body.active || typeof body.user_id !== 'number' || typeof body.exp !== 'number') {
      return null;
    }
    if (body.exp * 1000 <= now()) {
      return null;
    }

    const principal: Principal = {
      userId: body.user_id,
      userName: body.user_name ?? '',
      clientId: body.client_id ?? '',
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
      mailboxIds: Array.isArray(body.mailbox_ids) ? body.mailbox_ids : [],
      isAdmin: body.is_admin === true,
      expiresAt: body.exp,
    };

    // Prune occasionally so the cache cannot grow without bound.
    if (cache.size > 1000) {
      cache.clear();
    }
    cache.set(key, { principal, until: Math.min(now() + cacheMs, body.exp * 1000) });
    return principal;
  };
}

/** Reads a bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}
