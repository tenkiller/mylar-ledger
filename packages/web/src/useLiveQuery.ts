import { liveQuery } from 'dexie'
import { useEffect, useState } from 'preact/hooks'

export function useLiveQuery<T>(querier: () => T | Promise<T>): T | undefined {
  const [state, setState] = useState<{ value: T } | undefined>(undefined)
  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: value => {
        setState({ value })
      },
      error: (err: unknown) => {
        console.error('live query failed', err)
      },
    })
    return () => {
      sub.unsubscribe()
    }
  }, [])
  return state?.value
}
