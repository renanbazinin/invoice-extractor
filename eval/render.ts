/**
 * Renders test invoices written as HTML into PDFs (and PNG "scans") with the installed headless
 * Chrome/Edge. Chrome lays out Hebrew/RTL and mixed text with a real shaping engine and writes
 * glyphs in visual order with ToUnicode maps, like the invoicing software real PDFs come from.
 *
 *   npx tsx eval/render.ts <file.html | dir> [...]      renders every .html that has no newer .pdf
 *   npx tsx eval/render.ts --force <dir>                re-renders everything
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => !!p)

export function findBrowser(): string {
  const found = BROWSERS.find((p) => existsSync(p))
  if (!found) throw new Error('No Chrome/Edge found; set CHROME_PATH')
  return found
}

async function withProfile<T>(fn: (profile: string) => Promise<T>): Promise<T> {
  // A profile of its own per call, so renders can run in parallel.
  const profile = mkdtempSync(join(tmpdir(), 'fx-chrome-'))
  try {
    return await fn(profile)
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const COMMON = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars']

/** HTML file → PDF. Page size/margins come from the HTML's own `@page` CSS. */
export async function renderPdf(htmlPath: string, pdfPath: string): Promise<void> {
  await withProfile((profile) =>
    run(findBrowser(), [...COMMON, `--user-data-dir=${profile}`, '--no-pdf-header-footer', `--print-to-pdf=${resolve(pdfPath)}`, pathToFileURL(resolve(htmlPath)).href], {
      timeout: 60_000,
    }),
  )
  if (!existsSync(pdfPath)) throw new Error(`Chrome wrote no PDF for ${htmlPath}`)
}

/** HTML file → PNG screenshot of the first `height` CSS pixels (A4 at 96 dpi is 794×1123). */
export async function renderPng(htmlPath: string, pngPath: string, opts: { width?: number; height?: number; scale?: number } = {}): Promise<void> {
  const { width = 794, height = 1123, scale = 2 } = opts
  await withProfile((profile) =>
    run(
      findBrowser(),
      [
        ...COMMON,
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--force-device-scale-factor=${scale}`,
        `--screenshot=${resolve(pngPath)}`,
        pathToFileURL(resolve(htmlPath)).href,
      ],
      { timeout: 60_000 },
    ),
  )
  if (!existsSync(pngPath)) throw new Error(`Chrome wrote no PNG for ${htmlPath}`)
}

function htmlFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === '.html')
    .map((e) => join(e.parentPath, e.name))
}

/** Runs `tasks` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++])
    }),
  )
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force')
  const targets = argv.filter((a) => a !== '--force')
  if (!targets.length) throw new Error('usage: render.ts [--force] <file.html|dir>...')
  const files = targets.flatMap(htmlFiles)
  let done = 0
  await pool(files, 6, async (html) => {
    const pdf = join(dirname(html), `${basename(html, '.html')}.pdf`)
    if (!force && existsSync(pdf) && statSync(pdf).mtimeMs >= statSync(html).mtimeMs) return
    await renderPdf(html, pdf)
    done++
  })
  console.log(`rendered ${done} of ${files.length} HTML file(s)`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
