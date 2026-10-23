import type { FreeScoutAPI } from './freescout-api.js';
import type { Principal } from './oauth.js';
import type { FreeScoutConversation } from './types.js';

/** The FreeScout API calls the MCP tools make. */
export type FreeScoutApiPort = Pick<
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

export class MailboxAccessError extends Error {}

type Conversations = { _embedded?: { conversations?: FreeScoutConversation[] } };

function mailboxIdOf(conversation: FreeScoutConversation): number | undefined {
  return (conversation as { mailboxId?: number }).mailboxId ?? conversation.mailbox_id;
}

/**
 * Wraps the FreeScout API client so every ticket read or change is limited to
 * the mailboxes the signed-in user can view. The API key itself can reach every
 * mailbox, so this is what keeps an OAuth connection to its user's mailboxes.
 */
export function scopeApiToPrincipal<T extends FreeScoutApiPort>(api: T, principal: Principal): T {
  const allowed = new Set(principal.mailboxIds);

  const assertConversation = <T extends FreeScoutConversation>(conversation: T): T => {
    const mailboxId = mailboxIdOf(conversation);
    if (mailboxId === undefined || !allowed.has(mailboxId)) {
      throw new MailboxAccessError(
        `Ticket ${conversation.id} is not in a mailbox ${principal.userName || 'you'} can access`
      );
    }
    return conversation;
  };

  const assertTicket = async (ticketId: string): Promise<void> => {
    assertConversation(await api.getConversation(ticketId, false));
  };

  const filterConversations = <T extends Conversations>(result: T): T => {
    const conversations = result._embedded?.conversations;
    if (conversations) {
      result._embedded!.conversations = conversations.filter((conversation) => {
        const mailboxId = mailboxIdOf(conversation);
        return mailboxId !== undefined && allowed.has(mailboxId);
      });
    }
    return result;
  };

  const assertMailboxFilter = (mailboxId: number | undefined): void => {
    if (mailboxId != null && !allowed.has(mailboxId)) {
      throw new MailboxAccessError(`Mailbox ${mailboxId} is not one you can access`);
    }
  };

  const overrides: Partial<Record<keyof FreeScoutApiPort, unknown>> = {
    getConversation: async (...args: Parameters<FreeScoutAPI['getConversation']>) =>
      assertConversation(await api.getConversation(...args)),
    addThread: async (...args: Parameters<FreeScoutAPI['addThread']>) => {
      await assertTicket(args[0]);
      return api.addThread(...args);
    },
    createDraftReply: async (...args: Parameters<FreeScoutAPI['createDraftReply']>) => {
      await assertTicket(args[0]);
      return api.createDraftReply(...args);
    },
    sendDraft: async (...args: Parameters<FreeScoutAPI['sendDraft']>) => {
      await assertTicket(args[0]);
      return api.sendDraft(...args);
    },
    deleteDraft: async (...args: Parameters<FreeScoutAPI['deleteDraft']>) => {
      await assertTicket(args[0]);
      return api.deleteDraft(...args);
    },
    updateConversation: async (...args: Parameters<FreeScoutAPI['updateConversation']>) => {
      await assertTicket(args[0]);
      return api.updateConversation(...args);
    },
    searchConversations: async (...args: Parameters<FreeScoutAPI['searchConversations']>) => {
      assertMailboxFilter(args[0].mailboxId);
      return filterConversations(await api.searchConversations(...args));
    },
    getMailboxes: async () => {
      const result = (await api.getMailboxes()) as {
        _embedded?: { mailboxes?: Array<{ id: number }> };
      };
      const mailboxes = result?._embedded?.mailboxes;
      if (mailboxes) {
        result._embedded!.mailboxes = mailboxes.filter((mailbox) => allowed.has(mailbox.id));
      }
      return result;
    },
  };

  return new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in overrides) {
        return overrides[property as keyof FreeScoutApiPort];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
