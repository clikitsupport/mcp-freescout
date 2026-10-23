import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpServer,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  loadHttpServerConfig,
  protectedResourceMetadataUrl,
} from '../http-server.js';
import { buildServer, isHttpMode } from '../index.js';
import type { Principal } from '../oauth.js';

const PUBLIC_URL = 'https://freescout.example.com/mcp';
const VALID_TOKEN = 'fsat_valid';

const principal = (scopes: string[]): Principal => ({
  userId: 7,
  userName: 'Pat Agent',
  clientId: 'mcp_client',
  scopes,
  mailboxIds: [2],
  isAdmin: false,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

describe('loadHttpServerConfig', () => {
  it('uses localhost defaults and the public URL', () => {
    expect(loadHttpServerConfig({ FREESCOUT_MCP_PUBLIC_URL: `${PUBLIC_URL}/` })).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      path: DEFAULT_HTTP_PATH,
      publicUrl: PUBLIC_URL,
    });
  });

  it('requires an https public URL', () => {
    expect(() => loadHttpServerConfig({})).toThrow(/FREESCOUT_MCP_PUBLIC_URL/);
    expect(() =>
      loadHttpServerConfig({ FREESCOUT_MCP_PUBLIC_URL: 'http://freescout.example.com/mcp' })
    ).toThrow(/https/);
  });

  it('rejects an invalid port or path', () => {
    expect(() =>
      loadHttpServerConfig({ FREESCOUT_MCP_PUBLIC_URL: PUBLIC_URL, FREESCOUT_MCP_HTTP_PORT: '0' })
    ).toThrow(/FREESCOUT_MCP_HTTP_PORT/);
    expect(() =>
      loadHttpServerConfig({ FREESCOUT_MCP_PUBLIC_URL: PUBLIC_URL, FREESCOUT_MCP_HTTP_PATH: 'mcp' })
    ).toThrow(/FREESCOUT_MCP_HTTP_PATH/);
  });
});

describe('protectedResourceMetadataUrl', () => {
  it('inserts the well-known prefix before the resource path', () => {
    expect(protectedResourceMetadataUrl(PUBLIC_URL)).toBe(
      'https://freescout.example.com/.well-known/oauth-protected-resource/mcp'
    );
  });
});

describe('isHttpMode', () => {
  it('is enabled by env or flag only', () => {
    expect(isHttpMode(['node', 'index.js'], {})).toBe(false);
    expect(isHttpMode(['node', 'index.js', '--http'], {})).toBe(true);
    expect(isHttpMode(['node', 'index.js'], { FREESCOUT_MCP_TRANSPORT: 'http' })).toBe(true);
  });
});

describe('createHttpServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(scopes: string[]): Promise<string> {
    server = createHttpServer(
      (ctx) =>
        buildServer({
          api: {} as never,
          principal: ctx.authInfo?.extra?.principal as Principal | undefined,
        }),
      { host: '127.0.0.1', port: 0, path: DEFAULT_HTTP_PATH, publicUrl: PUBLIC_URL },
      async (token) => (token === VALID_TOKEN ? principal(scopes) : null)
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  const listTools = (base: string, token?: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  it('answers health checks and 404s other paths', async () => {
    const base = await start(['freescout:read']);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('challenges requests without a token', async () => {
    const base = await start(['freescout:read']);

    const response = await listTools(base);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://freescout.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('rejects an invalid token', async () => {
    const base = await start(['freescout:read']);

    const response = await listTools(base, 'fsat_wrong');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('lists only the tools the token scopes allow', async () => {
    const base = await start(['freescout:read', 'freescout:write']);

    const response = await listTools(base, VALID_TOKEN);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"name":"freescout_list_drafts"');
    expect(text).toContain('"name":"freescout_create_draft_reply"');
    expect(text).not.toContain('"name":"freescout_send_draft"');
  });
});
