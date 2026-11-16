export async function readJson<T>(response: Response): Promise<T> {
  let body: T & { error?: unknown }
  try { body = await response.json() }
  catch {
    throw new Error(response.status >= 500
      ? 'The app server is unavailable. Please try again shortly.'
      : 'The app server returned an empty or invalid response. Please try again.')
  }
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Request failed. Please try again.')
  if (body == null) throw new Error('The app server returned an empty response. Please try again.')
  return body
}
