import { render } from 'preact'
import { App } from './App.tsx'

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')
render(<App />, root)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js')
  // Ask for durable storage so the browser does not evict the offline copy under pressure.
  void navigator.storage.persist()
}
