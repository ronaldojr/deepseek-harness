/**
 * The OAuth connect area of a provider editor card: sign-in button, the
 * device-code panel with copy affordances, live states, and disconnect.
 * States arrive from the host through the shared {@link OauthViewStore}, so
 * this block renders whatever phase the service is in and nothing else.
 * @module dsh-client-ui-settings-models/client/OauthConnectBlock
 */

import { useCallback, useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import type { OauthConnectionView } from '@deepseek-ai/dsh-api-remotes/client'
import type { OauthView } from './oauth-store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link OauthConnectBlock}. */
export interface OauthConnectBlockProps {
  /** Provider route key the block connects. */
  provider: string
  /** Shared connection-state store. */
  store: OauthView
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable the actions (read-only or in-flight card). */
  disabled: boolean
}

/** Render one provider's OAuth connection state and actions. */
export function OauthConnectBlock(props: OauthConnectBlockProps): ReactNode {
  const { provider, store, t } = props
  const view = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    () => store.get(provider),
  )
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // A pushed view wins over a fetch racing it: load only fills the gap.
    void store.load(provider)
  }, [store, provider])

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard refusal (permissions, insecure context) leaves the code
      // visible to copy by hand; nothing to correct.
    }
  }

  const connect = async (): Promise<void> => {
    setFailure(undefined)
    const message = await store.login(provider)
    if (message !== undefined) setFailure(message)
  }

  const disconnect = async (): Promise<void> => {
    setFailure(undefined)
    const message = await store.disconnect(provider)
    if (message !== undefined) setFailure(message)
  }

  if (view === undefined) return null

  // The catalog's human name for the provider's OAuth method ("GitHub
  // Copilot", "OpenAI (ChatGPT Plus/Pro)"); the route key is the fallback.
  const providerName = view.name ?? provider

  if (view.phase === 'device-code' && view.device !== undefined) {
    return (
      <div className={styles['oauthPanel']}>
        <p className={styles['oauthTitle']}>{t('oauthDeviceTitle')}</p>
        <p className={styles['oauthHint']}>{t('oauthDeviceHint').replace('{provider}', providerName)}</p>
        <div className={styles['oauthRow']}>
          <a className={styles['oauthLink']} href={view.device.verificationUri} target="_blank" rel="noreferrer">
            {view.device.verificationUri}
          </a>
          <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
            onClick={() => { void copy(view.device?.verificationUri ?? '') }}>
            {copied ? t('oauthCopied') : t('oauthCopyCode')}
          </button>
        </div>
        <div className={styles['oauthRow']}>
          <span className={styles['oauthCode']}>{view.device.userCode}</span>
          <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
            onClick={() => { void copy(view.device?.userCode ?? '') }}>
            {copied ? t('oauthCopied') : t('oauthCopyCode')}
          </button>
        </div>
        <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
          onClick={() => { void store.cancel(provider) }}>
          {t('oauthCancelLogin')}
        </button>
      </div>
    )
  }

  if (view.phase === 'connecting' || view.phase === 'failed') {
    return (
      <div className={styles['oauthPanel']}>
        <p className={styles['oauthHint']}>{view.message ?? t('oauthConnecting')}</p>
        {view.phase === 'failed'
          ? (
            <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
              onClick={() => { void connect() }}>
              {t('oauthRetry')}
            </button>
          )
          : (
            <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
              onClick={() => { void store.cancel(provider) }}>
              {t('oauthCancelLogin')}
            </button>
          )}
      </div>
    )
  }

  if (view.phase === 'connected') {
    const expiry = view.expiresAt === undefined ? undefined : new Date(view.expiresAt).toLocaleString()
    return (
      <div className={styles['oauthPanel']}>
        <p className={styles['oauthHint']}>
          {expiry === undefined
            ? t('oauthConnected')
            : t('oauthConnectedExpires').replace('{time}', expiry)}
        </p>
        {view.message === undefined ? null : <p className={styles['error']}>{view.message}</p>}
        <div className={styles['oauthRow']}>
          <button type="button" className={styles['secondaryButton']} disabled={props.disabled}
            onClick={() => { void connect() }}>
            {t('oauthReconnect')}
          </button>
          <button type="button" className={styles['dangerButton']} disabled={props.disabled}
            onClick={() => { void disconnect() }}>
            {t('oauthDisconnect')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('oauthConnect').replace('{provider}', providerName)}</span>
      <button type="button" className={styles['primaryButton']} disabled={props.disabled}
        onClick={() => { void connect() }}>
        {t('oauthConnect').replace('{provider}', providerName)}
      </button>
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
    </div>
  )
}

export type { OauthConnectionView }
