import { useEffect, useState } from 'preact/hooks'
import { login, logout, type LoginResult } from './auth.ts'
import { db } from './instance.ts'
import { addSeries, deleteSeries } from './store.ts'
import { SyncAuthError, SyncRejectedError, syncOnce } from './sync.ts'
import { useLiveQuery } from './useLiveQuery.ts'

type Status = 'idle' | 'syncing' | 'offline' | 'auth' | 'error'

const SYNC_INTERVAL_MS = 120_000

function describeLoginFailure(result: Extract<LoginResult, { ok: false }>): string {
  switch (result.reason) {
    case 'invalid':
      return 'Wrong password.'
    case 'rate_limited':
      return `Too many attempts. Try again in ${Math.ceil((result.retryAfterSeconds ?? 60) / 60)} min.`
    case 'busy':
      return 'Server busy. Try again in a moment.'
    case 'error':
      return 'Could not sign in.'
  }
}

function describeError(err: unknown): string {
  if (err instanceof SyncRejectedError && err.code === 'timestamp_in_future') {
    return 'This device clock is ahead of the server. Fix the clock, then sync again.'
  }
  return err instanceof Error ? err.message : 'Sync failed.'
}

export function App() {
  const series = useLiveQuery(async () =>
    (await db.series.orderBy('title').toArray()).filter(s => s.deletedAt === undefined),
  )
  const pending = useLiveQuery(() => db.outbox.count())
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [title, setTitle] = useState('')
  const [publisher, setPublisher] = useState('')

  const sync = async (): Promise<void> => {
    setStatus('syncing')
    try {
      await syncOnce(db)
      setStatus('idle')
    } catch (err) {
      if (err instanceof SyncAuthError) setStatus('auth')
      // fetch() rejects with TypeError when the network is unreachable.
      else if (err instanceof TypeError) setStatus('offline')
      else {
        setErrorMessage(describeError(err))
        setStatus('error')
      }
    }
  }

  useEffect(() => {
    void sync()
    const onOnline = () => void sync()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(onVisible, SYNC_INTERVAL_MS)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])

  const onLogin = async (e: Event): Promise<void> => {
    e.preventDefault()
    try {
      const result = await login(password)
      if (!result.ok) {
        setLoginError(describeLoginFailure(result))
        return
      }
    } catch {
      setLoginError('Could not reach the server.')
      return
    }
    setPassword('')
    setLoginError('')
    // Queued offline writes were kept while signed out; send them now.
    void sync()
  }

  const onLogout = async (): Promise<void> => {
    await logout().catch(() => undefined)
    setStatus('auth')
  }

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    const p = publisher.trim()
    await addSeries(db, p ? { title: t, publisher: p } : { title: t })
    setTitle('')
    setPublisher('')
    void sync()
  }

  return (
    <main>
      <h1>Mylar Ledger</h1>
      <p>
        <button type="button" onClick={() => void sync()} disabled={status === 'syncing'}>
          {status === 'syncing' ? 'Syncing…' : 'Sync'}
        </button>{' '}
        {status === 'offline' && 'Offline — changes are saved locally. '}
        {status === 'auth' && 'Sign-in required. '}
        {status === 'error' && `${errorMessage} `}
        {pending ? `${pending} pending` : ''}
      </p>
      {status === 'auth' && (
        <form onSubmit={e => void onLogin(e)}>
          <input
            type="password"
            autocomplete="current-password"
            placeholder="Password"
            value={password}
            onInput={e => {
              setPassword(e.currentTarget.value)
            }}
            required
          />
          <button type="submit">Sign in</button> {loginError}
        </form>
      )}
      {status !== 'auth' && (
        <button type="button" onClick={() => void onLogout()}>
          Sign out
        </button>
      )}
      <form onSubmit={e => void onSubmit(e)}>
        <input
          placeholder="Series title"
          value={title}
          onInput={e => {
            setTitle(e.currentTarget.value)
          }}
          required
        />
        <input
          placeholder="Publisher"
          value={publisher}
          onInput={e => {
            setPublisher(e.currentTarget.value)
          }}
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {series?.map(s => (
          <li key={s.id}>
            {s.title}
            {s.publisher ? ` (${s.publisher})` : ''}{' '}
            <button
              type="button"
              onClick={() =>
                void deleteSeries(db, s.id).then(() => {
                  void sync()
                })
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
