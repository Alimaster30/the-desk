import { useEffect, useState, type FormEvent } from 'react'
import { PageHeading } from './ui'

type Staff = { id: number; name: string; email: string }

export function OrderStaffPage() {
  const [staff, setStaff] = useState<Staff[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    const response = await fetch('/api/admin/order-staff')
    if (!response.ok) throw new Error('Could not load staff access.')
    setStaff(await response.json())
  }

  useEffect(() => { void load().catch(reason => setError(reason.message)) }, [])

  async function change(address: string, allowed: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/order-staff', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address, allowed }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not change staff access.')
      if (allowed) setEmail('')
      else setStaff(current => current?.filter(person => person.email !== address) ?? null)
      setNotice(allowed ? 'Orders access granted.' : 'Orders access removed.')
      await load().catch(() => setError('The change was saved. Reload this page to refresh the staff list.'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change staff access.')
    } finally { setBusy(false) }
  }

  function grant(event: FormEvent) {
    event.preventDefault()
    void change(email.trim(), true)
  }

  return <main>
    <PageHeading title="Staff access" description="Give an existing account permission to start confirmations and manage its own orders." />
    <form className="dial" onSubmit={grant}>
      <label className="field">Account email
        <input type="email" autoComplete="off" maxLength={254} required disabled={busy} value={email} onChange={event => setEmail(event.target.value)} />
      </label>
      <button className="primary" type="submit" disabled={busy}>Grant Orders access</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <h2>Staff with Orders access</h2>
    {staff == null ? !error && <p className="waiting">Loading staff…</p> : staff.length === 0 ? <p>No regular accounts have Orders access yet.</p> : <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Access</th></tr></thead>
        <tbody>{staff.map(person => <tr key={person.id}>
          <td>{person.name}</td><td>{person.email}</td>
          <td><button type="button" disabled={busy} aria-label={`Remove Orders access for ${person.email}`} onClick={() => change(person.email, false)}>Remove access</button></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </main>
}
