import { stderr, stdin, stdout } from 'node:process'
import { hashPassword } from './password.ts'

const MIN_LENGTH = 12

function fail(message: string): never {
  stderr.write(`${message}\n`)
  process.exit(1)
}

/** Piped input is read as-is (scriptable); only a trailing newline is dropped. */
async function readPiped(): Promise<string> {
  let text = ''
  for await (const chunk of stdin) text += String(chunk)
  return text.replace(/\r?\n$/, '')
}

/** Reads a line from a TTY without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const finish = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stderr.write('\n')
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          finish()
          reject(new Error('cancelled'))
          return
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  let password: string
  if (stdin.isTTY) {
    password = await readHidden('Password: ')
    if (password !== (await readHidden('Repeat password: '))) fail('Passwords do not match.')
  } else {
    password = await readPiped()
  }
  if (password.length < MIN_LENGTH) fail(`Password must be at least ${MIN_LENGTH} characters.`)
  // Only the hash goes to stdout, so it can be captured; everything else uses stderr.
  stdout.write(`${await hashPassword(password)}\n`)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : 'failed')
})
