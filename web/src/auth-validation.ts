export type AuthMode = 'login' | 'signup'
export type AuthFields = { name: string, email: string, password: string }

export function validateAuth(mode: AuthMode, fields: AuthFields) {
  const errors: Partial<Record<keyof AuthFields, string>> = {}
  if (mode === 'signup' && fields.name.trim().length < 2) errors.name = 'Enter your name using at least 2 characters.'
  const email = fields.email.trim()
  if (!email) errors.email = 'Enter your email address.'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.'
  if (!fields.password) errors.password = 'Enter your password.'
  else if (mode === 'signup' && fields.password.length < 8) errors.password = 'Use at least 8 characters for your password.'
  return errors
}
