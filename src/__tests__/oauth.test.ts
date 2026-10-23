import { describe, expect, it, vi } from 'vitest';
import { bearerToken, createFreeScoutIntrospector } from '../oauth.js';
import { MailboxAccessError, scopeApiToPrincipal } from '../scoped-api.js';
import type { Principal } from '../oauth.js';

const NOW = 1_800_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bearerToken', () => {
  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('createFreeScoutIntrospector', () => {
  const active = {
    active: true,
    scope: 'freescout:read freescout:write',
    client_id: 'mcp_client',
    exp: NOW / 1000 + 3600,
    user_id: 7,
    user_name: 'Pat Agent',
    is_admin: false,
    mailbox_ids: [2, 3],
  };

  it('asks FreeScout with the API key and maps the answer', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(active));
    const introspect = createFreeScoutIntrospector('https://fs.example.com/', 'api-key', {
      fetchFn: fetchFn as never,
      now: () => NOW,
    });

    await expect(introspect('fsat_token')).resolves.toEqual({
      userId: 7,
      userName: 'Pat Agent',
      clientId: 'mcp_client',
      scopes: ['freescout:read', 'freescout:write'],
      mailboxIds: [2, 3],
      isAdmin: false,
      expiresAt: NOW / 1000 + 3600,
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fs.example.com/oauth/introspect');
    expect((init.headers as Record<string, string>)['X-FreeScout-API-Key']).toBe('api-key');
    expect(init.body).toBe('token=fsat_token');
  });

  it('caches active answers for the cache time', async () => {
    let now = NOW;
    const fetchFn = vi.fn(async () => jsonResponse(active));
    const introspect = createFreeScoutIntrospector('https://fs.example.com', 'k', {
      fetchFn: fetchFn as never,
      now: () => now,
      cacheMs: 60_000,
    });

    await introspect('t');
    await introspect('t');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 61_000;
    await introspect('t');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('treats inactive or expired tokens as invalid', async () => {
    const inactive = createFreeScoutIntrospector('https://fs.example.com', 'k', {
      fetchFn: (async () => jsonResponse({ active: false })) as never,
      now: () => NOW,
    });
    await expect(inactive('t')).resolves.toBeNull();

    const expired = createFreeScoutIntrospector('https://fs.example.com', 'k', {
      fetchFn: (async () => jsonResponse({ ...active, exp: NOW / 1000 - 1 })) as never,
      now: () => NOW,
    });
    await expect(expired('t')).resolves.toBeNull();
  });

  it('throws when FreeScout rejects the API key', async () => {
    const introspect = createFreeScoutIntrospector('https://fs.example.com', 'k', {
      fetchFn: (async () => jsonResponse({ error: 'unauthorized' }, 401)) as never,
    });
    await expect(introspect('t')).rejects.toThrow(/HTTP 401/);
  });
});

describe('scopeApiToPrincipal', () => {
  const principal: Principal = {
    userId: 7,
    userName: 'Pat',
    clientId: 'c',
    scopes: ['freescout:read', 'freescout:write'],
    mailboxIds: [2],
    isAdmin: false,
    expiresAt: NOW / 1000 + 3600,
  };

  function fakeApi() {
    const conversations: Record<string, { id: number; mailboxId: number }> = {
      '10': { id: 10, mailboxId: 2 },
      '20': { id: 20, mailboxId: 9 },
    };
    return {
      getConversation: vi.fn(async (id: string) => conversations[id]),
      addThread: vi.fn(async () => ({ id: 1 })),
      createDraftReply: vi.fn(async () => ({ id: 1 })),
      sendDraft: vi.fn(async () => ({ id: 1 })),
      deleteDraft: vi.fn(async () => undefined),
      updateConversation: vi.fn(async () => undefined),
      downloadAttachment: vi.fn(),
      parseTicketInput: vi.fn((input: string) => input),
      searchConversations: vi.fn(async () => ({
        _embedded: { conversations: Object.values(conversations) },
      })),
      getMailboxes: vi.fn(async () => ({ _embedded: { mailboxes: [{ id: 2 }, { id: 9 }] } })),
      createConversation: vi.fn(async () => ({ id: 1, number: 1 })),
    };
  }

  it('allows tickets in the user mailboxes', async () => {
    const api = fakeApi();
    const scoped = scopeApiToPrincipal(api as never, principal);

    await expect(scoped.getConversation('10')).resolves.toMatchObject({ id: 10 });
    await scoped.addThread('10', 'note', 'hi', 7);
    expect(api.addThread).toHaveBeenCalled();
  });

  it('blocks tickets in other mailboxes, including writes', async () => {
    const api = fakeApi();
    const scoped = scopeApiToPrincipal(api as never, principal);

    await expect(scoped.getConversation('20')).rejects.toBeInstanceOf(MailboxAccessError);
    await expect(scoped.sendDraft('20', 5, 7)).rejects.toBeInstanceOf(MailboxAccessError);
    expect(api.sendDraft).not.toHaveBeenCalled();
  });

  it('only starts conversations from the user mailboxes', async () => {
    const api = fakeApi();
    const scoped = scopeApiToPrincipal(api as never, principal);
    const input = { customerEmail: 'a@example.com', subject: 's', text: 't', userId: 7 };

    await scoped.createConversation({ ...input, mailboxId: 2 });
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    await expect(scoped.createConversation({ ...input, mailboxId: 9 })).rejects.toBeInstanceOf(
      MailboxAccessError
    );
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it('filters search results and mailboxes', async () => {
    const scoped = scopeApiToPrincipal(fakeApi() as never, principal);

    const results = await scoped.searchConversations({} as never);
    expect(results._embedded?.conversations?.map((c) => c.id)).toEqual([10]);
    await expect(scoped.searchConversations({ mailboxId: 9 } as never)).rejects.toBeInstanceOf(
      MailboxAccessError
    );
    await expect(scoped.getMailboxes()).resolves.toEqual({ _embedded: { mailboxes: [{ id: 2 }] } });
  });
});
