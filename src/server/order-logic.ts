export type OrderInput = {
  reference: string
  phone: string
  channel: 'whatsapp' | 'sms'
  language: 'en' | 'ur'
  item: string
  amount: string
  currency: string
}

export function orderError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

export function parseOrder(value: Record<string, unknown>): OrderInput {
  const field = (key: string) => typeof value[key] === 'string' ? value[key].trim() : ''
  const reference = field('reference').toUpperCase(), phone = field('phone'), item = field('item')
  const amount = field('amount'), currency = field('currency').toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(reference)) throw orderError('Use a reference of 1–32 letters, numbers or hyphens.')
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw orderError('Enter the customer number with + and country code.')
  if (!item || item.length > 160 || /[\r\n\x00-\x1f]/.test(item)) throw orderError('Enter an item description of 1–160 characters on one line.')
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw orderError('Enter a positive amount with at most two decimal places.')
  if (!/^[A-Z]{3}$/.test(currency)) throw orderError('Use a three-letter currency code, such as PKR or USD.')
  if (value.channel !== 'whatsapp' && value.channel !== 'sms') throw orderError('Choose WhatsApp or SMS.')
  if (value.language !== 'en' && value.language !== 'ur') throw orderError('Choose English or Urdu.')
  return { reference, phone, item, amount: Number(amount).toFixed(2), currency, channel: value.channel, language: value.language }
}

export function orderCommand(text: string): { action: 'confirm' | 'cancel' | 'call' | 'call-whatsapp', reference: string } | null {
  const match = /^(CONFIRM|CANCEL|CALL|CALL-WHATSAPP)\s+([A-Z0-9][A-Z0-9-]{0,31})$/i.exec(text.trim())
  return match ? { action: match[1].toLowerCase() as 'confirm' | 'cancel' | 'call' | 'call-whatsapp', reference: match[2].toUpperCase() } : null
}

export function orderMessage(order: OrderInput, kind: 'invite' | 'confirmed' | 'cancelled' | 'unanswered' | 'help', whatsappCall = false) {
  if (kind === 'help') return order.language === 'ur'
    ? 'براہ کرم CONFIRM، CANCEL یا CALL کے بعد اپنے آرڈر کا ریفرنس لکھیں۔ مثال: CONFIRM ORD-123۔ ابھی آپ کے آرڈر کی حالت تبدیل نہیں ہوئی۔'
    : 'Please reply CONFIRM, CANCEL or CALL followed by your order reference. Example: CONFIRM ORD-123. Your order status has not changed.'
  const details = `${order.reference}: ${order.item} — ${order.amount} ${order.currency}.`
  if (kind === 'confirmed') return `${details}\n${order.language === 'ur' ? 'آپ کا آرڈر کنفرم ہو گیا ہے۔' : 'Your order is confirmed.'}`
  if (kind === 'cancelled') return `${details}\n${order.language === 'ur' ? 'آپ کا آرڈر منسوخ ہو گیا ہے۔' : 'Your order is cancelled.'}`
  const prefix = kind === 'unanswered'
    ? (order.language === 'ur' ? 'کال پر جواب نہیں ملا۔ آرڈر ابھی کنفرم نہیں ہوا۔' : 'We could not get a decision on the call. Your order is still awaiting confirmation.')
    : (order.language === 'ur' ? 'اپنے آرڈر کی تصدیق کریں۔' : 'Please confirm your order.')
  return `${details}\n${prefix}\nCONFIRM ${order.reference} — ${order.language === 'ur' ? 'تصدیق' : 'confirm'}\nCANCEL ${order.reference} — ${order.language === 'ur' ? 'منسوخ' : 'cancel'}${kind === 'invite' ? `\nCALL ${order.reference} — ${order.language === 'ur' ? 'فون کال کے ذریعے تصدیق' : 'request a confirmation phone call'}${whatsappCall ? `\nCALL-WHATSAPP ${order.reference} — ${order.language === 'ur' ? 'واٹس ایپ کال کی درخواست' : 'request a WhatsApp voice call'}` : ''}` : ''}`
}

export function ivrMenu(language: 'en' | 'ur') {
  return language === 'ur'
    ? 'السلام علیکم! یہ آپ کے آرڈر کی تصدیق کے لیے خودکار کال ہے۔ آرڈر کی تفصیل آپ کو میسج میں بھیجی گئی ہے۔ آرڈر کنفرم کرنے کے لیے 1 دبائیں، منسوخ کرنے کے لیے 2 دبائیں، اور دوبارہ سننے کے لیے 9 دبائیں۔'
    : 'Hello! This is an automated order confirmation call. Your order details were sent to you by message. Press 1 to confirm your order, press 2 to cancel, or press 9 to hear this menu again.'
}
