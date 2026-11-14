import { Icon } from './ui'

export type AutomationSetup = { enabled: boolean; whatsAppReady?: boolean; textAgent?: { enabled: boolean; ready: boolean }; voice?: { enabled: boolean; ready: boolean } }
export function OrderAutomationMenu({ id = 'order-automation-settings', admin, setup, controlBusy, controlError, toggleControl, telnyx = false }: { id?: string; admin: boolean; setup: AutomationSetup | null; controlBusy: boolean; controlError: string; toggleControl: (key: 'enabled' | 'text' | 'voice', value: boolean) => void; telnyx?: boolean }) {
  return <>
    <button type="button" className="icon-button" aria-label={telnyx ? 'Telnyx settings' : 'Order automation settings'} popoverTarget={id}><Icon name="more" /></button>
      <section id={id} className="whatsapp-settings order-automation" aria-label="Order automation" popover="auto">
        <p className="note">{telnyx ? 'Order assistants · shared organization settings' : 'Order automation'}</p>
        <button type="button" role="switch" className="settings-toggle automation-master" aria-checked={setup?.enabled ?? false} disabled={!admin || !setup || controlBusy} onClick={() => void toggleControl('enabled', !setup?.enabled)}>
          <span>Live actions</span>
          <span className="toggle-track" data-on={setup?.enabled ?? false} aria-hidden="true" />
        </button>
        <p className="note">{setup == null ? 'Checking configurationâ€¦' : setup.enabled ? 'Messages and calls can reach customers.' : 'Customer messages and calls are paused.'}</p>
        <div className="automation-assistants">
          <button type="button" role="switch" className="settings-toggle" aria-checked={Boolean(setup?.enabled && setup.textAgent?.enabled)} disabled={!admin || !setup?.enabled || controlBusy} onClick={() => void toggleControl('text', !setup?.textAgent?.enabled)}>
            <span>Text assistant</span>
            <span className="toggle-track" data-on={Boolean(setup?.enabled && setup.textAgent?.enabled)} aria-hidden="true" />
          </button>
          <button type="button" role="switch" className="settings-toggle" aria-checked={Boolean(setup?.enabled && setup.voice?.enabled)} disabled={!admin || !setup?.enabled || controlBusy} onClick={() => void toggleControl('voice', !setup?.voice?.enabled)}>
            <span>Voice assistant</span>
            <span className="toggle-track" data-on={Boolean(setup?.enabled && setup.voice?.enabled)} aria-hidden="true" />
          </button>
        </div>
        {!admin ? <p className="note">An admin manages these settings for your organization.</p> : null}
        {controlBusy ? <p className="note" role="status">Saving automation settingsâ€¦</p> : null}
        {controlError ? <p role="alert">{controlError}</p> : null}
        {setup?.enabled && setup.textAgent?.enabled && !setup.textAgent.ready ? <p className="note">Configure Gemini before using the text assistant.</p> : null}
        {!telnyx && setup?.enabled && setup.voice?.ready && !setup?.whatsAppReady ? <p className="note">{admin ? <><a href="#/whatsapp">Connect WhatsApp</a> to use WhatsApp callbacks.</> : 'Ask an admin to connect WhatsApp for callbacks.'}</p> : null}
        {telnyx ? <p className="note">These assistants handle order conversations and customer-requested callbacks. Manual SMS and calls stay available.</p> : null}
      </section>
  </>
}
