<?php

namespace Modules\McpDrafts\Http\Controllers;

use App\Conversation;
use App\Events\ConversationStatusChanged;
use App\Events\UserReplied;
use App\Folder;
use App\Thread;
use App\User;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

/**
 * Send or delete reply drafts on existing conversations.
 *
 * Mirrors the reply-from-draft and discard-draft branches of
 * App\Http\Controllers\ConversationsController::ajax() so FreeScout's own
 * events, folders, counters and outgoing email behave the same as clicking
 * Send or Discard in the UI.
 */
class DraftsController extends Controller
{
    const STATUSES = [
        'active'  => Conversation::STATUS_ACTIVE,
        'pending' => Conversation::STATUS_PENDING,
        'closed'  => Conversation::STATUS_CLOSED,
    ];

    /**
     * POST api/conversations/{conversationId}/drafts/{threadId}/send
     *
     * Body: user (required int, the acting FreeScout user),
     *       status (optional: active, pending, closed).
     */
    public function send(Request $request, $conversationId, $threadId)
    {
        $resolved = $this->resolve($request, $conversationId, $threadId);
        if (!is_array($resolved)) {
            return $resolved;
        }
        list($user, $conversation, $thread) = $resolved;

        if ($conversation->state == Conversation::STATE_DRAFT) {
            return $this->error('Drafts of new conversations are not supported; send them from FreeScout.', 422);
        }
        if ($thread->type != Thread::TYPE_MESSAGE) {
            return $this->error('Only reply drafts can be sent.', 422);
        }
        if (!trim(strip_tags($thread->body ?? ''))) {
            return $this->error('Draft body is empty.', 422);
        }

        $request_status = null;
        if ($request->filled('status')) {
            if (!array_key_exists($request->status, self::STATUSES)) {
                return $this->error('status must be one of: '.implode(', ', array_keys(self::STATUSES)), 422);
            }
            $request_status = self::STATUSES[$request->status];
        }

        // Log the acting user in for this request only, as listeners and
        // observers read auth()->user().
        \Auth::setUser($user);

        $now = date('Y-m-d H:i:s');
        $body = $thread->body;

        $to = $thread->getToFirst() ?: $conversation->customer_email;
        if (!$to && $conversation->customer) {
            $to = $conversation->customer->getMainEmail();
        }
        if (!$to) {
            return $this->error('Draft has no recipient.', 422);
        }
        $cc = $thread->getCcArray();
        $bcc = $thread->getBccArray();

        $prev_status = $conversation->status;
        $status_changed = $request_status && $request_status != (int) $prev_status;

        $conversation->status = $request_status ?: $conversation->status;
        if ($status_changed && $conversation->isClosed()) {
            $conversation->closed_by_user_id = $user->id;
            $conversation->closed_at = $now;
        }
        $conversation->customer_email = $to;
        $conversation->setCc(array_diff($cc, [$to]));
        $conversation->setBcc($bcc);
        $conversation->last_reply_at = $now;
        $conversation->last_reply_from = Conversation::PERSON_USER;
        $conversation->user_updated_at = $now;
        $conversation->updateFolder();
        $conversation->threads_count++;
        $conversation->setPreview($body);
        $conversation->save();

        if ($status_changed) {
            event(new ConversationStatusChanged($conversation));
            \Eventy::action('conversation.status_changed', $conversation, $user, true, $prev_status);
        }

        $thread->type = Thread::TYPE_MESSAGE;
        $thread->created_at = $now;
        $thread->user_id = $conversation->user_id;
        $thread->status = $conversation->status;
        $thread->state = Thread::STATE_PUBLISHED;
        $thread->customer_id = $conversation->customer_id;
        $thread->created_by_user_id = $user->id;
        $thread->edited_by_user_id = null;
        $thread->edited_at = null;
        $thread->setTo($to);
        $thread->setCc($cc);
        $thread->setBcc($bcc);
        $thread->save();

        $conversation->maybeRemoveFromDrafts();
        $conversation->mailbox->updateFoldersCounters();

        if ($conversation->user_id != $user->id) {
            $user->followConversation($conversation->id);
        }

        event(new UserReplied($conversation, $thread));
        \Eventy::action('conversation.user_replied_can_undo', $conversation, $thread);
        \Helper::backgroundAction('conversation.user_replied', [$conversation, $thread], now()->addSeconds(Conversation::UNDO_TIMOUT));

        return response()->json([
            'id'             => $thread->id,
            'conversationId' => $conversation->id,
            'state'          => 'published',
            'to'             => [$to],
            'cc'             => array_values($cc),
            'bcc'            => array_values($bcc),
        ]);
    }

    /**
     * DELETE api/conversations/{conversationId}/drafts/{threadId}
     *
     * Body or query: user (required int, the acting FreeScout user).
     */
    public function destroy(Request $request, $conversationId, $threadId)
    {
        $resolved = $this->resolve($request, $conversationId, $threadId);
        if (!is_array($resolved)) {
            return $resolved;
        }
        list($user, $conversation, $thread) = $resolved;

        if ($conversation->state == Conversation::STATE_DRAFT) {
            return $this->error('Drafts of new conversations are not supported; discard them from FreeScout.', 422);
        }

        $thread->deleteThread();
        if ($conversation->maybeRemoveFromDrafts()) {
            $conversation->mailbox->updateFoldersCounters(Folder::TYPE_DRAFTS);
        }

        return response('', 204);
    }

    /**
     * Load and authorize the acting user, conversation and draft thread.
     *
     * @return array|\Illuminate\Http\JsonResponse
     */
    private function resolve(Request $request, $conversationId, $threadId)
    {
        $user = User::find((int) $request->input('user'));
        if (!$user) {
            return $this->error('user is required and must be an existing FreeScout user ID.', 422);
        }

        $conversation = Conversation::find((int) $conversationId);
        if (!$conversation) {
            return $this->error('Conversation not found.', 404);
        }
        if (!$user->can('view', $conversation)) {
            return $this->error('User cannot access this conversation.', 403);
        }

        $thread = Thread::find((int) $threadId);
        if (!$thread || $thread->conversation_id != $conversation->id) {
            return $this->error('Draft not found in this conversation.', 404);
        }
        if ($thread->state != Thread::STATE_DRAFT) {
            return $this->error('Thread is not a draft (it may already have been sent).', 409);
        }

        return [$user, $conversation, $thread];
    }

    private function error($message, $status)
    {
        return response()->json(['message' => $message], $status);
    }
}
