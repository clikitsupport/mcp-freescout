import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpServer,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  isSecretPath,
  loadHttpServerConfig,
} from '../http-server.js';
import { buildServer, isHttpMode } from '../index.js';

const SECRET_PATH = '/mcp/test-secret-0123456789abcdef';

describe('loadHttpServerConfig', () => {
  it('uses localhost defaults with a valid secret path', () => {
    expect(loadHttpServerConfig({ FREESCOUT_MCP_HTTP_PATH: SECRET_PATH })).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      path: SECRET_PATH,
    });
  });

  it('rejects a missing or short secret path', () => {
    expect(() => loadHttpServerConfig({})).toThrow(/FREESCOUT_MCP_HTTP_PATH/);
    expect(() => loadHttpServerConfig({ FREESCOUT_MCP_HTTP_PATH: '/mcp' })).toThrow(
      /FREESCOUT_MCP_HTTP_PATH/
    );
  });

  it('rejects an invalid port', () => {
    expect(() =>
      loadHttpServerConfig({ FREESCOUT_MCP_HTTP_PATH: SECRET_PATH, FREESCOUT_MCP_HTTP_PORT: '0' })
    ).toThrow(/FREESCOUT_MCP_HTTP_PORT/);
  });
});

describe('isSecretPath', () => {
  it('matches only the exact path', () => {
    expect(isSecretPath(SECRET_PATH, SECRET_PATH)).toBe(true);
    expect(isSecretPath(`${SECRET_PATH}x`, SECRET_PATH)).toBe(false);
    expect(isSecretPath('/mcp/test-secret-0123456789abcdeX', SECRET_PATH)).toBe(false);
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

  async function start(): Promise<string> {
    server = createHttpServer(() => buildServer({ api: {} as never }), {
      host: '127.0.0.1',
      port: 0,
      path: SECRET_PATH,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('answers health checks and hides every other path', async () => {
    const base = await start();

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);

    const wrong = await fetch(`${base}/mcp/guess`, { method: 'POST', body: '{}' });
    expect(wrong.status).toBe(404);
  });

  it('lists tools over the secret path', async () => {
    const base = await start();

    const response = await fetch(`${base}${SECRET_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('freescout_list_drafts');
    expect(text).toContain('freescout_send_draft');
  });
});
