import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { bearerToken, type Principal, type TokenIntrospector } from './oauth.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_PATH = '/mcp';
export const MAX_HTTP_BODY_BYTES = 5 * 1024 * 1024;

export interface HttpServerConfig {
  host: string;
  port: number;
  /** Local path that serves MCP, e.g. `/mcp`. */
  path: string;
  /** Public URL clients connect to, e.g. `https://freescout.example.com/mcp`. */
  publicUrl: string;
}

/**
 * Reads the HTTP transport settings. The public URL is what clients add as
 * the connector and what OAuth tokens are issued for.
 */
export function loadHttpServerConfig(env: NodeJS.ProcessEnv = process.env): HttpServerConfig {
  const path = env.FREESCOUT_MCP_HTTP_PATH || DEFAULT_HTTP_PATH;
  if (!path.startsWith('/')) {
    throw new Error('FREESCOUT_MCP_HTTP_PATH must start with "/"');
  }

  const port = Number.parseInt(env.FREESCOUT_MCP_HTTP_PORT ?? String(DEFAULT_HTTP_PORT), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('FREESCOUT_MCP_HTTP_PORT must be a port number between 1 and 65535');
  }

  const publicUrl = env.FREESCOUT_MCP_PUBLIC_URL ?? '';
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(
      'FREESCOUT_MCP_PUBLIC_URL must be the full public URL of the MCP endpoint, e.g. https://freescout.example.com/mcp'
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error('FREESCOUT_MCP_PUBLIC_URL must use https');
  }

  return {
    host: env.FREESCOUT_MCP_HTTP_HOST || DEFAULT_HTTP_HOST,
    port,
    path,
    publicUrl: publicUrl.replace(/\/+$/, ''),
  };
}

/**
 * RFC 9728 metadata URL for a resource: the well-known prefix inserted
 * between the origin and the resource path.
 */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_HTTP_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(url, { method, headers, body });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Stream so server-sent events reach the client as they are produced.
  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

function sendUnauthorized(res: ServerResponse, metadataUrl: string, invalidToken: boolean): void {
  const params = [`resource_metadata="${metadataUrl}"`];
  if (invalidToken) {
    params.push(
      'error="invalid_token"',
      'error_description="The access token is invalid or expired"'
    );
  }
  res.statusCode = 401;
  res.setHeader('www-authenticate', `Bearer ${params.join(', ')}`);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: invalidToken ? 'invalid_token' : 'unauthorized' }));
}

/**
 * Serves MCP over streamable HTTP at the configured path. Every MCP request
 * needs an OAuth access token; requests without a valid one get 401 with a
 * `WWW-Authenticate` challenge pointing at the protected resource metadata,
 * which is how clients discover where to sign in. `/healthz` answers 200 for
 * keep-alive checks and every other path answers 404.
 */
export function createHttpServer(
  factory: McpServerFactory,
  config: HttpServerConfig,
  introspect: TokenIntrospector
): Server {
  const handler = createMcpHandler(factory);
  const metadataUrl = protectedResourceMetadataUrl(config.publicUrl);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendText(res, 200, 'ok');
      return;
    }

    if (url.pathname !== config.path && url.pathname !== `${config.path}/`) {
      sendText(res, 404, 'Not found');
      return;
    }

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      sendUnauthorized(res, metadataUrl, false);
      return;
    }

    introspect(token)
      .then(async (principal: Principal | null) => {
        if (!principal) {
          sendUnauthorized(res, metadataUrl, true);
          return;
        }
        const request = await toWebRequest(req, url);
        const response = await handler.fetch(request, {
          authInfo: {
            token,
            clientId: principal.clientId,
            scopes: principal.scopes,
            expiresAt: principal.expiresAt,
            resource: new URL(config.publicUrl),
            resourceMetadataUrl: metadataUrl,
            extra: { principal },
          },
        });
        await writeWebResponse(res, response);
      })
      .catch((error: unknown) => {
        if (error instanceof BodyTooLargeError) {
          sendText(res, 413, 'Request body too large');
          return;
        }
        console.error('FreeScout MCP HTTP error:', error);
        if (!res.headersSent) {
          sendText(res, 500, 'Internal server error');
        } else {
          res.end();
        }
      });
  });

  server.on('close', () => {
    void handler.close();
  });

  return server;
}
