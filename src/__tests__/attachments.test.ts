import sharp from 'sharp';
import {
  attachmentToContent,
  classifyAttachment,
  listConversationAttachments,
  listInlineImages,
  findSignatureImages,
  type ConversationAttachment,
} from '../attachments.js';

function minimalPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const solid = (width: number, height: number, alpha = 1) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha } },
  });

const attachment = (fileName: string, mimeType: string): ConversationAttachment => ({
  id: 9,
  threadId: 3,
  fileName,
  mimeType,
  size: 0,
  fileUrl: 'https://support.example.com/storage/attachment/x',
});

describe('listConversationAttachments', () => {
  it('reads FreeScout _embedded attachments and legacy flat attachments', () => {
    const result = listConversationAttachments({
      id: 1,
      number: 1,
      subject: 's',
      status: 'active',
      _embedded: {
        threads: [
          {
            id: 10,
            _embedded: {
              attachments: [
                {
                  id: 71,
                  fileName: 'a.pdf',
                  fileUrl: 'https://x/a',
                  mimeType: 'application/pdf',
                  size: 5,
                },
              ],
            },
          },
          {
            id: 11,
            attachments: [{ id: 72, file_name: 'b.png', mime_type: 'image/png', size: 6 }],
          },
        ],
      },
    });

    expect(result).toEqual([
      {
        id: 71,
        threadId: 10,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        size: 5,
        fileUrl: 'https://x/a',
      },
      {
        id: 72,
        threadId: 11,
        fileName: 'b.png',
        mimeType: 'image/png',
        size: 6,
        fileUrl: undefined,
      },
    ]);
  });
});

describe('classifyAttachment', () => {
  it('falls back to the file extension when the MIME type is generic', () => {
    expect(classifyAttachment('application/octet-stream', 'photo.AVIF')).toBe('image');
    expect(classifyAttachment('application/octet-stream', 'invoice.pdf')).toBe('pdf');
    expect(classifyAttachment('', 'debug.log')).toBe('text');
    expect(classifyAttachment('application/zip', 'site.zip')).toBe('unsupported');
  });
});

describe('attachmentToContent', () => {
  it('converts WebP to JPEG for vision clients', async () => {
    const data = await solid(40, 30).flatten().webp().toBuffer();
    const [, image] = await attachmentToContent(attachment('s.webp', 'image/webp'), data);

    expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('converts AVIF with transparency to PNG', async () => {
    const data = await solid(40, 30, 0.5).avif().toBuffer();
    const [, image] = await attachmentToContent(attachment('s.avif', 'image/avif'), data);

    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('downscales large images to the vision size limit', async () => {
    const data = await solid(4000, 1000).png().toBuffer();
    const [, image] = await attachmentToContent(attachment('big.png', 'image/png'), data);
    const meta = await sharp(Buffer.from((image as { data: string }).data, 'base64')).metadata();

    expect(meta.width).toBe(1568);
  });

  it('extracts PDF text and attaches the raw PDF', async () => {
    const content = await attachmentToContent(
      attachment('invoice.pdf', 'application/pdf'),
      minimalPdf('Invoice 4417')
    );

    expect(content[0]).toMatchObject({ type: 'text' });
    expect((content[0] as { text: string }).text).toContain('Invoice 4417');
    expect(content[1]).toMatchObject({
      type: 'resource',
      resource: { mimeType: 'application/pdf' },
    });
  });

  it('reports unsupported files instead of failing', async () => {
    const [block] = await attachmentToContent(
      attachment('a.zip', 'application/zip'),
      Buffer.from('x')
    );

    expect((block as { text: string }).text).toContain('Skipped');
  });
});

describe('listInlineImages', () => {
  const thread = (body: string) => ({ id: 20, body }) as never;

  it('reads FreeScout inline images from the body as relative URLs', () => {
    const result = listInlineImages(
      thread(
        '<p>See:</p><img alt="x" src="https://support.example.com/storage/attachment/0/5/14/image.png?id=7509&amp;token=abc123">'
      )
    );
    expect(result).toEqual([
      {
        id: 7509,
        threadId: 20,
        fileName: 'image.png',
        mimeType: 'image/*',
        size: 0,
        fileUrl: '/storage/attachment/0/5/14/image.png?id=7509&token=abc123',
        inline: true,
      },
    ]);
  });

  it('ignores images that are not FreeScout attachments', () => {
    expect(
      listInlineImages(
        thread(
          [
            '<img src="https://evil.example.com/pixel.png">',
            "<img src='http://127.0.0.1:8787/healthz?id=1&token=x'>",
            '<img src="/storage/attachment/../../.env?id=3&token=x">',
            '<img src="/storage/attachment/a.png?id=abc&token=x">',
            '<img src="/storage/attachment/a.png?id=4">',
            '<img src="cid:image001.png">',
          ].join('')
        )
      )
    ).toEqual([]);
  });

  it('points lookalike hosts back at FreeScout', () => {
    const [image] = listInlineImages(
      thread('<img src="https://evil.example.com/storage/attachment/a.png?id=5&token=t">')
    );
    expect(image.fileUrl).toBe('/storage/attachment/a.png?id=5&token=t');
  });

  it('adds inline images after attachments without duplicating them', () => {
    const result = listConversationAttachments({
      id: 1,
      number: 1,
      subject: 's',
      status: 'active',
      _embedded: {
        threads: [
          {
            id: 10,
            body: '<img src="/storage/attachment/a.png?id=71&token=t"><img src="/storage/attachment/b.png?id=80&token=t">',
            _embedded: {
              attachments: [
                {
                  id: 71,
                  fileName: 'a.png',
                  fileUrl: 'https://x/a',
                  mimeType: 'image/png',
                  size: 5,
                },
              ],
            },
          },
        ],
      },
    } as never);
    expect(result.map((a) => [a.id, a.inline ?? false])).toEqual([
      [71, false],
      [80, true],
    ]);
  });
});

describe('findSignatureImages', () => {
  let nextId = 1;
  const image = (threadId: number, hash: string, bytes: number, width: number, height: number) => ({
    attachment: {
      id: nextId++,
      threadId,
      fileName: 'image.png',
      mimeType: 'image/png',
      size: bytes,
    },
    probe: { hash, bytes, width, height },
  });

  it('skips small images', () => {
    const icon = image(1, 'icon', 700, 37, 37);
    const logo = image(1, 'logo', 2_700, 150, 48);
    const narrow = image(1, 'narrow', 40_000, 240, 240);
    const screenshot = image(1, 'shot', 200_000, 1206, 2622);
    const skipped = findSignatureImages([icon, logo, narrow, screenshot]);
    expect(skipped.get(icon.attachment.id)).toBe('small');
    expect(skipped.get(logo.attachment.id)).toBe('small');
    expect(skipped.get(narrow.attachment.id)).toBe('small');
    expect(skipped.has(screenshot.attachment.id)).toBe(false);
  });

  it('skips large images repeated in three or more messages', () => {
    const banners = [1, 2, 3, 4].map((thread) => image(thread, 'banner', 199_000, 3215, 853));
    const skipped = findSignatureImages(banners);
    banners.forEach((b) => expect(skipped.get(b.attachment.id)).toBe('repeated'));
  });

  it('reads the earliest copy of an image repeated in two messages', () => {
    const later = image(9, 'quoted', 300_000, 1200, 800);
    const earlier = image(5, 'quoted', 300_000, 1200, 800);
    const sameThreadCopy = image(5, 'quoted', 300_000, 1200, 800);
    const skipped = findSignatureImages([later, earlier, sameThreadCopy]);
    expect(skipped.has(earlier.attachment.id)).toBe(false);
    expect(skipped.get(later.attachment.id)).toBe('duplicate');
    expect(skipped.get(sameThreadCopy.attachment.id)).toBe('duplicate');
  });
});
