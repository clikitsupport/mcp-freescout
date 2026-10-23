import type { ContentBlock } from '@modelcontextprotocol/server';
import sharp from 'sharp';
import { extractText, getDocumentProxy } from 'unpdf';
import type { FreeScoutConversation, FreeScoutThread } from './types.js';

export interface ConversationAttachment {
  id: number;
  threadId: number;
  fileName: string;
  mimeType: string;
  size: number;
  fileUrl?: string;
  /** Pasted into the message body rather than attached as a file. */
  inline?: boolean;
}

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'unsupported';

// Longest edge recommended for vision models; larger images only cost tokens.
const MAX_IMAGE_EDGE = 1568;
const MAX_TEXT_CHARS = 50_000;

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'heic',
  'heif',
  'tif',
  'tiff',
  'bmp',
  'svg',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'json', 'xml', 'md', 'html', 'htm', 'ini']);

const INLINE_IMAGE_PATH = '/storage/attachment/';
const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
}

/**
 * Images pasted into a message body. FreeScout stores them as attachments but
 * the API leaves them out of the attachment list; the body still links each
 * one with a signed URL (`/storage/attachment/...?id=N&token=...`).
 *
 * Bodies come from customers, so only FreeScout attachment paths are used and
 * the result is relative: it always downloads from FreeScout itself, whatever
 * host the tag names.
 */
export function listInlineImages(thread: FreeScoutThread): ConversationAttachment[] {
  const result: ConversationAttachment[] = [];
  const body = typeof thread.body === 'string' ? thread.body : '';

  for (const match of body.matchAll(IMG_SRC)) {
    let url: URL;
    try {
      url = new URL(decodeHtmlAttribute(match[2]), 'https://freescout.invalid');
    } catch {
      continue;
    }
    const id = Number(url.searchParams.get('id'));
    if (!url.pathname.startsWith(INLINE_IMAGE_PATH) || !Number.isSafeInteger(id) || id < 1) {
      continue;
    }
    if (!url.searchParams.get('token') || url.pathname.includes('..')) {
      continue;
    }

    const fileName = decodeURIComponent(url.pathname.split('/').pop() ?? '') || 'image';
    result.push({
      id,
      threadId: thread.id,
      fileName,
      // Referenced by an <img> tag, so read it as an image whatever its name.
      mimeType: 'image/*',
      size: 0,
      fileUrl: `${url.pathname}?${url.searchParams.toString()}`,
      inline: true,
    });
  }

  return result;
}

/**
 * Collect attachments from every thread, followed by images pasted into the
 * thread bodies. The FreeScout API nests attachments under
 * `_embedded.attachments` with camelCase keys; the flat snake_case shape is
 * still accepted for older responses.
 */
export function listConversationAttachments(
  conversation: FreeScoutConversation
): ConversationAttachment[] {
  const threads: FreeScoutThread[] = conversation._embedded?.threads ?? [];
  const result: ConversationAttachment[] = [];

  for (const thread of threads) {
    for (const a of thread._embedded?.attachments ?? []) {
      result.push({
        id: a.id,
        threadId: thread.id,
        fileName: a.fileName,
        mimeType: a.mimeType ?? '',
        size: a.size ?? 0,
        fileUrl: a.fileUrl,
      });
    }
    for (const a of thread.attachments ?? []) {
      result.push({
        id: a.id,
        threadId: thread.id,
        fileName: a.file_name,
        mimeType: a.mime_type,
        size: a.size,
        fileUrl: a.url,
      });
    }
  }

  const seen = new Set(result.map((a) => a.id));
  for (const thread of threads) {
    for (const image of listInlineImages(thread)) {
      if (!seen.has(image.id)) {
        seen.add(image.id);
        result.push(image);
      }
    }
  }

  return result;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function classifyAttachment(mimeType: string, fileName: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  const ext = extensionOf(fileName);

  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return 'unsupported';
}

/**
 * Normalize any image sharp can decode (including WebP, AVIF, HEIC, GIF) into
 * PNG or JPEG, which every vision-capable client accepts.
 */
export async function toVisionImage(data: Buffer): Promise<{ data: string; mimeType: string }> {
  const image = sharp(data, { animated: false }).rotate();
  const metadata = await image.metadata();
  const resized = image.resize({
    width: MAX_IMAGE_EDGE,
    height: MAX_IMAGE_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (metadata.format === 'jpeg' || !metadata.hasAlpha) {
    const out = await resized.jpeg({ quality: 85 }).toBuffer();
    return { data: out.toString('base64'), mimeType: 'image/jpeg' };
  }

  const out = await resized.png().toBuffer();
  return { data: out.toString('base64'), mimeType: 'image/png' };
}

export async function extractPdfText(
  data: Buffer
): Promise<{ pages: string[]; totalPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  return { pages: text, totalPages };
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n...[truncated, ${text.length - MAX_TEXT_CHARS} more characters]`
    : text;
}

/**
 * Turn a downloaded attachment into MCP content blocks the model can read.
 */
export async function attachmentToContent(
  attachment: ConversationAttachment,
  data: Buffer
): Promise<ContentBlock[]> {
  const label = `${attachment.inline ? 'Inline image' : 'Attachment'} ${attachment.id} (thread ${attachment.threadId}): ${attachment.fileName}`;
  const kind = classifyAttachment(attachment.mimeType, attachment.fileName);

  switch (kind) {
    case 'image': {
      const image = await toVisionImage(data);
      return [
        { type: 'text', text: label },
        { type: 'image', data: image.data, mimeType: image.mimeType },
      ];
    }
    case 'pdf': {
      const { pages, totalPages } = await extractPdfText(data);
      const body = pages
        .map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`)
        .join('\n\n')
        .trim();
      const hasText = pages.some((page) => page.trim().length > 0);
      return [
        {
          type: 'text',
          text: hasText
            ? `${label}\nPDF, ${totalPages} page(s). Extracted text:\n\n${truncate(body)}`
            : `${label}\nPDF, ${totalPages} page(s). No text layer found (likely a scanned PDF); the raw PDF is attached as a resource.`,
        },
        {
          type: 'resource',
          resource: {
            uri: attachment.fileUrl ?? `freescout://attachments/${attachment.id}`,
            mimeType: 'application/pdf',
            blob: data.toString('base64'),
          },
        },
      ];
    }
    case 'text':
      return [{ type: 'text', text: `${label}\n\n${truncate(data.toString('utf8'))}` }];
    default:
      return [
        {
          type: 'text',
          text: `${label}\nSkipped: ${attachment.mimeType || 'unknown type'} is not an image, PDF, or text file.`,
        },
      ];
  }
}
