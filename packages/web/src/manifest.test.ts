import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Icon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url)
const manifest = JSON.parse(readFileSync(publicFile('manifest.webmanifest'), 'utf8')) as {
  icons: Icon[]
}
const pngIcons = manifest.icons.filter(i => i.type === 'image/png')

describe('web app manifest icons', () => {
  it('declares the PNG sizes Android needs, including a maskable icon', () => {
    const has = (sizes: string, purpose: string) => pngIcons.some(i => i.sizes === sizes && i.purpose === purpose)
    expect(has('192x192', 'any')).toBe(true)
    expect(has('512x512', 'any')).toBe(true)
    expect(has('512x512', 'maskable')).toBe(true)
  })

  it.each(pngIcons)('$src exists and matches its declared size', icon => {
    const file = readFileSync(publicFile(icon.src.replace(/^\//, '')))
    // PNG signature, then the IHDR chunk: width and height are big-endian u32 at bytes 16 and 20.
    expect(file.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(`${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`).toBe(icon.sizes)
  })
})
