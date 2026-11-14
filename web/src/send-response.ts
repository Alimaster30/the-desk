export async function confirmWhatsAppSend(response: Response, service = 'WhatsApp') {
  let body: { ok?: boolean; error?: string } | null
  try { body = await response.json() }
  catch {
    throw new Error(response.status === 413
      ? 'The attachment is too large. Choose a file of up to 5 MB.'
      : `The app server returned no send confirmation. Your draft is kept. Check ${service} before retrying.`)
  }
  if (!response.ok) throw new Error(body?.error || `${service} did not confirm the message. Check the conversation before retrying.`)
  if (body?.ok !== true) throw new Error(`The app server returned no send confirmation. Your draft is kept. Check ${service} before retrying.`)
}
