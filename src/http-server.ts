import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8787;
export const MIN_HTTP_PATH_LENGTH = 24;
export const MAX_HTTP_BODY_BYTES = 5 * 1024 * 1024;

export interface HttpServerConfig {
  host: string;
  port: number;
  /** Secret endpoint path, e.g. `/mcp/<long random string>`. The only path that serves MCP. */
  path: string;
}

/**
 * Reads the HTTP transport settings. The endpoint path doubles as the shared
 * secret, so it must be long enough not to be guessed.
 */
export function loadHttpServerConfig(env: NodeJS.ProcessEnv = process.env): HttpServerConfig {
  const path = env.FREESCOUT_MCP_HTTP_PATH ?? '';
  if (!path.startsWith('/') || path.length < MIN_HTTP_PATH_LENGTH) {
    throw new Error(
      `FREESCOUT_MCP_HTTP_PATH must start with "/" and be at least ${MIN_HTTP_PATH_LENGTH} characters, e.g. /mcp/<random secret>`
    );
  }

  const port = Number.parseInt(env.FREESCOUT_MCP_HTTP_PORT ?? String(DEFAULT_HTTP_PORT), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('FREESCOUT_MCP_HTTP_PORT must be a port number between 1 and 65535');
  }

  return { host: env.FREESCOUT_MCP_HTTP_HOST || DEFAULT_HTTP_HOST, port, path };
}

/** Constant-time comparison so response timing does not leak the secret path. */
export function isSecretPath(requestPath: string, secretPath: string): boolean {
  const actual = Buffer.from(requestPath);
  const expected = Buffer.from(secretPath);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

/**
 * Serves MCP over streamable HTTP at the configured secret path only. Every
 * other path answers 404, and `/healthz` answers 200 for keep-alive checks.
 */
export function createHttpServer(factory: McpServerFactory, config: HttpServerConfig): Server {
  const handler = createMcpHandler(factory);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendText(res, 200, 'ok');
      return;
    }

    if (!isSecretPath(url.pathname, config.path)) {
      sendText(res, 404, 'Not found');
      return;
    }

    toWebRequest(req, url)
      .then((request) => handler.fetch(request))
      .then((response) => writeWebResponse(res, response))
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
