#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { ContentBlock } from '@modelcontextprotocol/server';
import { attachmentToContent, listConversationAttachments } from './attachments.js';
import { resolveDraftReplyRecipients, shouldInheritDraftRecipients } from './draft-recipients.js';
import { FreeScoutAPI } from './freescout-api.js';
import { createHttpServer, loadHttpServerConfig } from './http-server.js';
import { installStdioLifecycle, type StdioLifecycle } from './stdio-lifecycle.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import { SearchFiltersSchema, type FreeScoutRecipients } from './types.js';
import { loadEnv } from './env.js';

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

type FreeScoutApiPort = Pick<
  FreeScoutAPI,
  | 'addThread'
  | 'createDraftReply'
  | 'deleteDraft'
  | 'downloadAttachment'
  | 'getConversation'
  | 'getMailboxes'
  | 'parseTicketInput'
  | 'searchConversations'
  | 'sendDraft'
  | 'updateConversation'
>;

type TicketAnalyzerPort = Pick<TicketAnalyzer, 'analyzeConversation' | 'stripHtml'>;

export interface BuildServerOptions {
  api?: FreeScoutApiPort;
  analyzer?: TicketAnalyzerPort;
  defaultUserId?: number;
  version?: string;
}

interface RuntimeConfiguration {
  url: string;
  apiKey: string;
  defaultUserId: number;
}

function loadRuntimeConfiguration(): RuntimeConfiguration {
  loadEnv();

  const url = process.env.FREESCOUT_URL;
  const apiKey = process.env.FREESCOUT_API_KEY;
  const defaultUserId = Number.parseInt(process.env.FREESCOUT_DEFAULT_USER_ID ?? '1', 10);

  if (!url || !apiKey) {
    throw new Error('Missing required environment variables: FREESCOUT_URL and FREESCOUT_API_KEY');
  }

  if (!Number.isSafeInteger(defaultUserId) || defaultUserId < 1) {
    throw new Error('FREESCOUT_DEFAULT_USER_ID must be a positive integer');
  }

  return { url, apiKey, defaultUserId };
}

const allowedThreadTypes = new Set(['customer', 'message', 'note']);
type ThreadType = 'customer' | 'message' | 'note';

const isValidThreadType = (type: unknown): type is ThreadType =>
  typeof type === 'string' && allowedThreadTypes.has(type as ThreadType);

const hasCreatedAt = (createdAt: unknown): createdAt is string =>
  typeof createdAt === 'string' && createdAt.length > 0;

const normalizeThreadBody = (body: unknown) => (typeof body === 'string' ? body : '');

/**
 * Builds a fresh server for each stdio connection. `serveStdio` uses this
 * factory for both the legacy 2025 handshake and the 2026 protocol era.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const runtime = options.api ? undefined : loadRuntimeConfiguration();
  const api = options.api ?? new FreeScoutAPI(runtime!.url, runtime!.apiKey);
  const analyzer = options.analyzer ?? new TicketAnalyzer();
  const defaultUserId = options.defaultUserId ?? runtime?.defaultUserId ?? 1;
  const server = new McpServer({
    name: 'mcp-freescout',
    version: options.version ?? packageJson.version,
  });

  // Tool 1: Get Ticket
  server.registerTool(
    'freescout_get_ticket',
    {
      title: 'Get FreeScout Ticket',
      description: 'Fetch and analyze a FreeScout ticket by ID or URL',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        includeThreads: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include all conversation threads'),
      }),
    },
    async ({ ticket, includeThreads }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, includeThreads ?? true);

      return {
        content: [{ type: 'text', text: JSON.stringify(conversation, null, 2) }],
      };
    }
  );

  // Tool 2: Analyze Ticket
  server.registerTool(
    'freescout_analyze_ticket',
    {
      title: 'Analyze FreeScout Ticket',
      description:
        'Analyze a FreeScout ticket to determine issue type, root cause, and suggested solution',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      }),
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);

      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
        structuredContent: analysis,
      };
    }
  );

  // Tool 3: Add Note
  server.registerTool(
    'freescout_add_note',
    {
      title: 'Add Note to Ticket',
      description: 'Add an internal note to a FreeScout ticket',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        note: z.string().describe('The note content to add'),
        userId: z.number().optional().describe('User ID for the note (default: from env)'),
      }),
    },
    async ({ ticket, note, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = userId ?? defaultUserId;

      await api.addThread(ticketId, 'note', note, actualUserId);

      const output = {
        success: true,
        message: `Note added to ticket #${ticketId}`,
        ticketId,
      };

      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // Tool 4: Update Ticket
  server.registerTool(
    'freescout_update_ticket',
    {
      title: 'Update Ticket Status/Assignment',
      description: 'Update ticket status and/or assignment',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        status: z
          .enum(['active', 'pending', 'closed', 'spam'])
          .optional()
          .describe('New ticket status'),
        assignTo: z.number().optional().describe('User ID to assign the ticket to'),
        userId: z.number().optional().describe('User ID recording this update (default: from env)'),
      }),
    },
    async ({ ticket, status, assignTo, userId }) => {
      const ticketId = api.parseTicketInput(ticket);

      const updates: {
        status?: 'active' | 'pending' | 'closed' | 'spam';
        assignTo?: number;
        byUser?: number;
      } = { byUser: userId ?? defaultUserId };
      if (status) updates.status = status;
      if (assignTo) updates.assignTo = assignTo;

      await api.updateConversation(ticketId, updates);

      const output = {
        success: true,
        message: `Ticket #${ticketId} updated successfully`,
        ticketId,
      };

      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // Tool 5: Create Draft Reply
  server.registerTool(
    'freescout_create_draft_reply',
    {
      title: 'Create Draft Reply',
      description: 'Create a draft reply in FreeScout that can be edited before sending',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        replyText: z.string().describe('The draft reply content (generated by the LLM)'),
        userId: z
          .number()
          .optional()
          .describe('User ID creating the draft (defaults to env setting)'),
        to: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional TO recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
        cc: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional CC recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional BCC recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
      }),
    },
    async ({ ticket, replyText, userId, to, cc, bcc }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = userId ?? defaultUserId;
      const requestedRecipients: FreeScoutRecipients = { to, cc, bcc };
      let recipientWarning: string | null = null;

      let inheritedRecipients: FreeScoutRecipients = {};
      if (shouldInheritDraftRecipients(requestedRecipients)) {
        try {
          const conversation = await api.getConversation(ticketId, false);
          inheritedRecipients = {
            to: conversation.to,
            cc: conversation.cc,
            bcc: conversation.bcc,
          };
        } catch {
          recipientWarning =
            'Unable to load existing recipients, so FreeScout default recipients were used for omitted fields.';
        }
      }

      const resolvedRecipients = resolveDraftReplyRecipients(
        requestedRecipients,
        inheritedRecipients
      );

      const draftThread = await api.createDraftReply(
        ticketId,
        replyText,
        actualUserId,
        resolvedRecipients
      );

      const output = {
        success: true,
        message: `Draft reply created successfully in FreeScout ticket #${ticketId}`,
        ticketId,
        draftId: draftThread.id,
      };

      return {
        content: [
          {
            type: 'text',
            text: `✅ ${output.message}\n\nDraft ID: ${draftThread.id}\n\nThe draft reply is now saved in FreeScout and can be reviewed, edited, and sent from the FreeScout interface.${recipientWarning ? `\n\nWarning: ${recipientWarning}` : ''}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // Tool 6: Get Ticket Context
  server.registerTool(
    'freescout_get_ticket_context',
    {
      title: 'Get Ticket Context',
      description: 'Get ticket context and customer info to help draft personalized replies',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      }),
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);

      const threads = conversation._embedded?.threads || [];
      const safeThreads = threads.filter(
        (t) => isValidThreadType(t.type) && hasCreatedAt(t.created_at)
      );
      const customerMessages = safeThreads.filter((t) => t.type === 'customer');
      const teamMessages = safeThreads.filter((t) => t.type === 'message' || t.type === 'note');

      const context = {
        ticketId,
        customer: {
          name: analysis.customerName,
          email: analysis.customerEmail,
        },
        subject: conversation.subject,
        status: conversation.status,
        issueDescription: analysis.issueDescription,
        customerMessages: customerMessages.map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 500) + (stripped.length > 500 ? '...' : '');
          })(),
        })),
        teamMessages: teamMessages.slice(-3).map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');
          })(),
        })),
        analysis: {
          isBug: analysis.isBug,
          isThirdPartyIssue: analysis.isThirdPartyIssue,
          testedByTeam: analysis.testedByTeam,
          rootCause: analysis.rootCause,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
      };
    }
  );

  // Tool 7: Search Tickets
  server.registerTool(
    'freescout_search_tickets',
    {
      title: 'Search FreeScout Tickets',
      description:
        'Search for FreeScout tickets with explicit filter parameters. Text search is subject-only (FreeScout has no message-body full-text search): use subject (or its alias textSearch) to match the conversation subject, customerEmail to filter by the customer, and number to look up a single ticket. Use assignee: "unassigned" for unassigned tickets, or assignee: number for a specific user. Supports relative time filters like "7d", "24h". Use includeLastMessage: true to get a preview of the most recent message for each ticket.',
      inputSchema: SearchFiltersSchema,
    },
    async (filters) => {
      const results = await api.searchConversations(filters);
      const conversations = results._embedded?.conversations || [];

      // If includeLastMessage is true, fetch threads for each conversation
      // and include a preview of the most recent message
      let conversationsWithPreview = conversations;
      if (filters.includeLastMessage && conversations.length > 0) {
        conversationsWithPreview = await Promise.all(
          conversations.map(async (conv) => {
            try {
              const fullConv = await api.getConversation(String(conv.id), true);
              const threads = fullConv._embedded?.threads || [];

              // Filter to actual messages (customer or message type, not notes)
              const messages = threads
                .filter((t) => t.type === 'customer' || t.type === 'message')
                .filter((t) => hasCreatedAt(t.created_at));

              // Sort by created_at descending and get the most recent
              const sortedMessages = messages.sort((a, b) => {
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
              });

              const lastMessage = sortedMessages[0];
              if (lastMessage) {
                const body = normalizeThreadBody(lastMessage.body);
                const stripped = analyzer.stripHtml(body);
                const preview = stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');

                return {
                  ...conv,
                  lastMessage: {
                    type: lastMessage.type,
                    date: lastMessage.created_at,
                    preview,
                  },
                };
              }
            } catch {
              // If fetching threads fails, just return the conversation without preview
            }
            return conv;
          })
        );
      }

      const output = {
        conversations: conversationsWithPreview,
        totalCount: results.page?.totalElements ?? 0,
        page: results.page?.number,
        totalPages: results.page?.totalPages,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // Tool 8: Get Mailboxes
  server.registerTool(
    'freescout_get_mailboxes',
    {
      title: 'Get Mailboxes',
      description: 'Get list of available mailboxes',
      inputSchema: z.object({}),
    },
    async () => {
      const mailboxes = await api.getMailboxes();

      return {
        content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }],
      };
    }
  );

  // Tool 9: Get Attachments
  server.registerTool(
    'freescout_get_attachments',
    {
      title: 'Get Ticket Attachments',
      description:
        'Download and read the files attached to a FreeScout ticket. Images (PNG, JPEG, GIF, WebP, AVIF, HEIC) are returned as viewable images, PDFs as extracted text plus the raw PDF, and text files as text. Omit attachmentIds to read every attachment on the ticket (up to limit).',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        attachmentIds: z
          .array(z.number())
          .optional()
          .describe('Only read these attachment IDs (default: all attachments)'),
        limit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe('Maximum number of attachments to read'),
      }),
    },
    async ({ ticket, attachmentIds, limit }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const all = listConversationAttachments(conversation);
      const wanted = attachmentIds ? all.filter((a) => attachmentIds.includes(a.id)) : all;
      const selected = wanted.slice(0, limit ?? 10);

      if (selected.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: attachmentIds
                ? `No matching attachments on ticket #${ticketId}. Available IDs: ${all.map((a) => a.id).join(', ') || 'none'}`
                : `Ticket #${ticketId} has no attachments.`,
            },
          ],
        };
      }

      const content: ContentBlock[] = [
        {
          type: 'text',
          text: `Ticket #${ticketId}: reading ${selected.length} of ${all.length} attachment(s).`,
        },
      ];

      for (const attachment of selected) {
        try {
          if (!attachment.fileUrl) {
            throw new Error('FreeScout did not return a download URL');
          }
          const data = await api.downloadAttachment(attachment.fileUrl);
          content.push(...(await attachmentToContent(attachment, data)));
        } catch (error) {
          content.push({
            type: 'text',
            text: `Attachment ${attachment.id} (${attachment.fileName}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      return { content };
    }
  );

  // Tool 10: List Drafts
  server.registerTool(
    'freescout_list_drafts',
    {
      title: 'List Draft Replies',
      description:
        'List the unsent reply drafts on a FreeScout ticket, newest first, with their IDs and a text preview. Use the IDs with freescout_send_draft or freescout_delete_draft.',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      }),
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const drafts = (conversation._embedded?.threads ?? [])
        .filter((t) => t.state === 'draft')
        .sort((a, b) => b.id - a.id)
        .map((t) => {
          const stripped = analyzer.stripHtml(normalizeThreadBody(t.body));
          return {
            draftId: t.id,
            createdAt: t.createdAt ?? t.created_at,
            to: t.to ?? [],
            cc: t.cc ?? [],
            preview: stripped.substring(0, 300) + (stripped.length > 300 ? '...' : ''),
          };
        });

      const output = { ticketId, drafts };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // Tool 11: Send Draft
  server.registerTool(
    'freescout_send_draft',
    {
      title: 'Send Draft Reply',
      description:
        'Send an existing reply draft to the customer immediately, exactly as written in FreeScout. This emails the customer and cannot be undone, so only call it when the user has explicitly approved sending. Requires the McpDrafts FreeScout module.',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        draftId: z.number().describe('Draft thread ID (from freescout_list_drafts)'),
        status: z
          .enum(['active', 'pending', 'closed'])
          .optional()
          .describe('Optionally change the ticket status when sending'),
        userId: z.number().optional().describe('User ID sending the reply (default: from env)'),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ ticket, draftId, status, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      await api.sendDraft(ticketId, draftId, userId ?? defaultUserId, status);

      const output = {
        success: true,
        message: `Draft ${draftId} sent on ticket #${ticketId}`,
        ticketId,
        draftId,
      };

      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // Tool 12: Delete Draft
  server.registerTool(
    'freescout_delete_draft',
    {
      title: 'Delete Draft Replies',
      description:
        'Delete one or more unsent reply drafts from a FreeScout ticket, for example older versions left behind after edits. Sent replies cannot be deleted. Requires the McpDrafts FreeScout module.',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        draftIds: z
          .array(z.number())
          .min(1)
          .describe('Draft thread IDs to delete (from freescout_list_drafts)'),
        userId: z.number().optional().describe('User ID deleting the drafts (default: from env)'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ ticket, draftIds, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const deleted: number[] = [];
      const failed: { draftId: number; error: string }[] = [];

      for (const draftId of draftIds) {
        try {
          await api.deleteDraft(ticketId, draftId, userId ?? defaultUserId);
          deleted.push(draftId);
        } catch (error) {
          failed.push({
            draftId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const output = { success: failed.length === 0, ticketId, deleted, failed };
      const lines = [
        `Deleted ${deleted.length} of ${draftIds.length} draft(s) on ticket #${ticketId}.`,
      ];
      for (const f of failed) lines.push(`Draft ${f.draftId} not deleted: ${f.error}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: output,
        isError: deleted.length === 0,
      };
    }
  );

  return server;
}

export function startStdioServer(options: Omit<ServeStdioOptions, 'onerror'> = {}): StdioLifecycle {
  // Preserve the original launcher PID before any startup work can yield.
  const parentPid = process.ppid;

  // Fail fast before opening stdio, while buildServer still returns a fresh
  // isolated instance for each legacy or modern connection.
  loadRuntimeConfiguration();

  const handle = serveStdio(() => buildServer(), {
    ...options,
    onerror: (error) => {
      console.error('FreeScout MCP server error:', error);
    },
  });

  return installStdioLifecycle({
    handle,
    parentPid,
    onError: (error) => {
      console.error('FreeScout MCP server shutdown error:', error);
    },
  });
}

/**
 * Serves MCP over streamable HTTP for hosted use. Each request gets a fresh
 * server from `buildServer`, the same factory the stdio entry uses.
 */
export function startHttpServer(): Promise<Server> {
  loadRuntimeConfiguration();
  const config = loadHttpServerConfig();
  const server = createHttpServer(() => buildServer(), config);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      console.error(
        `FreeScout MCP Server v${packageJson.version} listening on http://${config.host}:${config.port}`
      );
      resolve(server);
    });
  });
}

export function isHttpMode(argv: string[] = process.argv, env = process.env): boolean {
  return env.FREESCOUT_MCP_TRANSPORT === 'http' || argv.includes('--http');
}

function main(): void {
  if (isHttpMode()) {
    startHttpServer().catch((error: unknown) => {
      console.error(
        'FreeScout MCP server startup error:',
        error instanceof Error ? error.message : String(error)
      );
      process.exitCode = 1;
    });
    return;
  }

  try {
    startStdioServer();
    console.error(`FreeScout MCP Server v${packageJson.version} running...`);
  } catch (error) {
    console.error(
      'FreeScout MCP server startup error:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main();
}
