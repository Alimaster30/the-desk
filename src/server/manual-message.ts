import { z } from 'zod'

export const attachmentLimit = 5 * 1024 * 1024
const schema = z.object({
  requestId: z.string().uuid().optional(),
  text: z.string().max(4000).default(''),
  attachment: z.object({
    kind: z.enum(['image', 'document', 'sticker']),
    name: z.string().min(1).max(180),
    data: z.string().min(4).max(Math.ceil(attachmentLimit / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0),
  }).optional(),
})

export type ManualAttachment = { kind: 'image' | 'document' | 'sticker'; name: string; mimetype: string; data: Buffer }

export function manualMessage(input: unknown) {
  const parsed = schema.safeParse(input)
  const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }) }
  if (!parsed.success) return fail('Enter a message of up to 4,000 characters or attach a file of up to 5 MB.')
  const text = parsed.data.text.trim()
  if (!text && !parsed.data.attachment) return fail('Enter a message or choose an attachment.')
  let attachment: ManualAttachment | undefined
  if (parsed.data.attachment) {
    const file = parsed.data.attachment
    const data = Buffer.from(file.data, 'base64')
    if (!data.length || data.length > attachmentLimit) return fail('Attachments must be between 1 byte and 5 MB.')
    const webp = data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    let mimetype = 'application/octet-stream'
    if (file.kind === 'sticker') {
      if (!webp || data.length > 512 * 1024) return fail('Choose a WebP sticker of up to 512 KB.')
      if (text) return fail('Stickers cannot have a caption. Send your text separately.')
      mimetype = 'image/webp'
    } else if (file.kind === 'image') {
      if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimetype = 'image/png'
      else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mimetype = 'image/jpeg'
      else if (webp) mimetype = 'image/webp'
      else return fail('Choose a PNG, JPEG or WebP image, or send the file as a document.')
    }
    attachment = { kind: file.kind, data, mimetype, name: file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_') }
  }
  return { text, attachment, requestId: parsed.data.requestId }
}
