/**
 * PDF access through pdf.js: open (with password), per-page text items → units, ruling lines and
 * font names from the operator list, and rasterization for OCR.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PageInput, Rule, Unit } from './model'
import { applyAffine, itemAngle, itemToUnits, multiplyAffine, type Affine, type FontLike, type TextItemLike } from './items'
import { isGarbageChar } from './chars'
import { ReadError } from './errors'
import { env } from './nodeEnv'
import { toGray, type Gray } from './preprocess'
import { glyphStream, respaceItem, streamCursor } from './spacing'

export { ReadError }

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  try {
    return await pdfjs.getDocument({
      // pdf.js transfers (detaches) the buffer it is given: pass a copy so the caller keeps theirs.
      data: bytes.slice(),
      password,
      verbosity: 0,
      fontExtraProperties: true,
      useSystemFonts: false,
      ...env.pdfOptions(),
    }).promise
  } catch (err) {
    const e = err as { name?: string; code?: number; message?: string }
    if (e?.name === 'PasswordException') {
      if (e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
        throw new ReadError('password-incorrect', 'The PDF is password-protected and the password given is incorrect.')
      throw new ReadError('password-required', 'The PDF is password-protected: pass opts.password.')
    }
    throw new ReadError('invalid-input', `Cannot open the PDF: ${e?.message ?? String(err)}`)
  }
}

export interface PdfInfo {
  producer: string | null
}

export async function pdfInfo(pdf: PDFDocumentProxy): Promise<PdfInfo> {
  try {
    const meta = await pdf.getMetadata()
    const info = meta.info as Record<string, unknown>
    const producer = typeof info?.Producer === 'string' && info.Producer.trim() ? info.Producer.trim() : null
    return { producer }
  } catch {
    return { producer: null }
  }
}

export interface PdfPageText {
  page: PDFPageProxy
  input: PageInput
  /** Viewport rotation used (page /Rotate plus a correction for sideways text). */
  rotation: number
  /** Why the text layer cannot be used, or null when it can. */
  unusable: string | null
  warnings: string[]
}

const BOLD_FONT = /bold|black|heavy|semibold|demibold|extrabold|ultrabold|[-,]bd?$/i

/** Text items of a page and everything derived from them, in page points at the chosen rotation. */
export async function readPdfPage(pdf: PDFDocumentProxy, number: number): Promise<PdfPageText> {
  const page = await pdf.getPage(number)
  const tc = await page.getTextContent()
  const items = tc.items.filter((it): it is (typeof it & TextItemLike) => 'str' in it) as TextItemLike[]
  const warnings: string[] = []

  const rotation = uprightRotation(page, items)
  if (rotation !== page.rotate % 360) warnings.push(`rotated-text-page-${number}`)
  const viewport = page.getViewport({ scale: 1, rotation })
  const vt: Affine = viewport.transform

  let chars = 0
  let garbage = 0
  for (const it of items)
    for (const ch of it.str) {
      if (/\s/u.test(ch)) continue
      chars++
      if (isGarbageChar(ch)) garbage++
    }

  const base: PageInput = { number, width: viewport.width, height: viewport.height, source: 'pdf', units: [], rules: [] }
  if (!chars) return { page, input: base, rotation, unusable: 'no-text-layer', warnings }
  if (garbage / chars > 0.3) return { page, input: base, rotation, unusable: 'garbage-text-layer', warnings }

  const ops = await operatorInfo(page, vt, viewport.width * viewport.height)
  if (chars < 25 && ops.imageCoverage > 0.5) return { page, input: base, rotation, unusable: 'image-only', warnings }

  const fonts = new Map<string, FontLike>()
  const fontFor = (name: string): FontLike => {
    let f = fonts.get(name)
    if (f) return f
    const style = tc.styles[name] as { ascent?: number; descent?: number; fontFamily?: string } | undefined
    let fontName = ''
    try {
      if (page.commonObjs.has(name)) fontName = String((page.commonObjs.get(name) as { name?: string })?.name ?? '')
    } catch {
      // Font not loaded: no name, no bold.
    }
    f = {
      ascent: clamp(style?.ascent, 0.6, 1.0, 0.8),
      descent: -clamp(style?.descent !== undefined ? -style.descent : undefined, 0.1, 0.3, 0.2),
      bold: BOLD_FONT.test(fontName.replace(/^[A-Z]{6}\+/, '')),
      mono: style?.fontFamily === 'monospace',
    }
    fonts.set(name, f)
    return f
  }

  let seq = 0
  const units: Unit[] = []
  const legacy = new Set<string>()
  // Spaces of letter-spaced items are rebuilt from the content stream's space glyphs.
  const cursor = streamCursor(glyphStream(ops.showText))
  const respace = (drawn: readonly string[]): string[] | null => respaceItem(drawn, cursor)
  items.forEach((it, run) => {
    const font = fontFor(it.fontName)
    units.push(...itemToUnits(it, { viewport: vt, run, font, nextSeq: () => seq++, respace }, (code) => legacy.add(code)))
  })
  for (const code of legacy) warnings.push(`${code}-page-${number}`)
  return { page, input: { ...base, units: dedupe(units), rules: ops.rules }, rotation, unusable: null, warnings }
}

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
  v === undefined || !Number.isFinite(v) || v < lo || v > hi ? dflt : v

/**
 * The view rotation that makes most text upright. Usually the page's own /Rotate; when a page is
 * displayed sideways (a landscape scan stored portrait, or /Rotate set on upright content) the
 * reader turns it so lines run left to right, since nobody reads an invoice sideways.
 */
export function uprightRotation(page: Pick<PDFPageProxy, 'rotate' | 'getViewport'>, items: readonly TextItemLike[]): number {
  const own = ((page.rotate % 360) + 360) % 360
  const vt = page.getViewport({ scale: 1, rotation: own }).transform
  const weight = new Map<number, number>()
  let total = 0
  for (const it of items) {
    const n = it.str.replace(/\s/gu, '').length
    if (!n) continue
    const a = itemAngle(it.transform, vt)
    weight.set(a, (weight.get(a) ?? 0) + n)
    total += n
  }
  let best = 0
  let bestW = -1
  for (const [a, w] of weight) if (w > bestW) [best, bestW] = [a, w]
  if (!total || best === 0 || bestW / total <= 0.5 || best % 90 !== 0) return own
  return (own + 360 - best) % 360
}

/**
 * Two units with the same text drawn at the same place: fake bold (text overprinted with a small
 * offset) or a shadow. Keep one, marked bold.
 */
export function dedupe(units: readonly Unit[]): Unit[] {
  const out: Unit[] = []
  const byText = new Map<string, Unit[]>()
  for (const u of units) {
    const same = byText.get(u.text) ?? []
    const dup = same.find((v) => iou(u.bbox, v.bbox) > 0.6)
    if (dup) {
      dup.bold = true
      continue
    }
    same.push(u)
    byText.set(u.text, same)
    out.push(u)
  }
  return out
}

function iou(a: Unit['bbox'], b: Unit['bbox']): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter
  return ua > 0 ? inter / ua : 0
}

interface OperatorInfo {
  rules: Rule[]
  /** Share of the page covered by the largest image (0..1). */
  imageCoverage: number
  /** The arguments of every showText operator, in content order (see spacing.ts). */
  showText: unknown[][]
}

const FILL_OPS = new Set([22, 23, 24, 25, 26, 27]) // fill, eoFill, fillStroke, eoFillStroke, closeFillStroke, closeEOFillStroke
const STROKE_OPS = new Set([20, 21, 24, 25, 26, 27]) // stroke, closeStroke, and the fill+stroke ops
const RULE_THICKNESS = 2.5
const RULE_MIN_LENGTH = 6

/**
 * Walks the operator list for thin filled rectangles and straight stroked segments (ruling
 * lines) and painted images. Loading the operator list also loads the fonts, which gives their
 * names (for bold). Any failure just means no rules: they are a hint, not a requirement.
 */
async function operatorInfo(page: PDFPageProxy, vt: Affine, pageArea: number): Promise<OperatorInfo> {
  const rules: Rule[] = []
  const showText: unknown[][] = []
  let imageCoverage = 0
  let list: { fnArray: number[]; argsArray: unknown[] }
  try {
    list = await page.getOperatorList()
  } catch {
    return { rules, imageCoverage, showText }
  }
  const O = pdfjs.OPS
  let ctm: number[] = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  const toPage = (x: number, y: number): [number, number] => {
    const [ux, uy] = applyAffine(ctm, x, y)
    return applyAffine(vt, ux, uy)
  }
  const addBox = (pts: [number, number][]) => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const w = box.x1 - box.x0
    const h = box.y1 - box.y0
    if (w <= RULE_THICKNESS && h >= RULE_MIN_LENGTH) rules.push({ ...box, axis: 'v' })
    else if (h <= RULE_THICKNESS && w >= RULE_MIN_LENGTH) rules.push({ ...box, axis: 'h' })
  }
  try {
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i] as unknown[] | null
      if (fn === O.save) stack.push(ctm)
      else if (fn === O.restore) ctm = stack.pop() ?? ctm
      else if (fn === O.transform && args) ctm = multiplyAffine(ctm, args as number[])
      else if (fn === O.paintFormXObjectBegin) {
        stack.push(ctm)
        const m = args?.[0] as number[] | null | undefined
        if (m && m.length === 6) ctm = multiplyAffine(ctm, Array.from(m))
      } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
      else if (fn === O.showText && args) showText.push(args)
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
        const pts = [toPage(0, 0), toPage(1, 0), toPage(0, 1), toPage(1, 1)]
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
        imageCoverage = Math.max(imageCoverage, Math.min(1, area / pageArea))
      } else if (fn === O.constructPath && args && typeof args[0] === 'number') {
        const paint = args[0]
        const data = (args[1] as ArrayLike<number>[] | undefined)?.[0]
        if (!data || (!FILL_OPS.has(paint) && !STROKE_OPS.has(paint))) continue
        const subpaths = pathPoints(data)
        if (FILL_OPS.has(paint)) for (const sp of subpaths) if (sp.length) addBox(sp.map(([x, y]) => toPage(x, y)))
        if (STROKE_OPS.has(paint))
          for (const sp of subpaths)
            for (let k = 1; k < sp.length; k++) {
              const a = toPage(...sp[k - 1])
              const b = toPage(...sp[k])
              if (Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5) addBox([a, b])
            }
      }
    }
  } catch {
    // Unknown operator argument shapes in another pdf.js version: keep what was found.
  }
  return { rules: mergeRules(rules), imageCoverage, showText }
}

/** Points of each subpath of a pdf.js path (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4). */
export function pathPoints(data: ArrayLike<number>): [number, number][][] {
  const out: [number, number][][] = []
  let cur: [number, number][] = []
  let i = 0
  while (i < data.length) {
    const op = data[i]
    if (op === 0) {
      if (cur.length) out.push(cur)
      cur = [[data[i + 1], data[i + 2]]]
      i += 3
    } else if (op === 1) {
      cur.push([data[i + 1], data[i + 2]])
      i += 3
    } else if (op === 2) {
      cur.push([data[i + 5], data[i + 6]])
      i += 7
    } else if (op === 3) {
      cur.push([data[i + 3], data[i + 4]])
      i += 5
    } else if (op === 4) {
      if (cur.length) cur.push(cur[0])
      i += 1
    } else break
  }
  if (cur.length) out.push(cur)
  return out
}

/** Collinear touching segments (a border drawn cell by cell) become one rule. */
export function mergeRules(rules: readonly Rule[]): Rule[] {
  const out: Rule[] = []
  for (const axis of ['h', 'v'] as const) {
    const rs = rules
      .filter((r) => r.axis === axis)
      .sort((a, b) => (axis === 'h' ? a.y0 - b.y0 || a.x0 - b.x0 : a.x0 - b.x0 || a.y0 - b.y0))
    const merged: Rule[] = []
    for (const r of rs) {
      const m = merged.find((q) =>
        axis === 'h'
          ? Math.abs((q.y0 + q.y1) / 2 - (r.y0 + r.y1) / 2) < 1 && r.x0 <= q.x1 + 1.5 && r.x1 >= q.x0 - 1.5
          : Math.abs((q.x0 + q.x1) / 2 - (r.x0 + r.x1) / 2) < 1 && r.y0 <= q.y1 + 1.5 && r.y1 >= q.y0 - 1.5,
      )
      if (m) {
        m.x0 = Math.min(m.x0, r.x0)
        m.y0 = Math.min(m.y0, r.y0)
        m.x1 = Math.max(m.x1, r.x1)
        m.y1 = Math.max(m.y1, r.y1)
      } else merged.push({ ...r })
    }
    out.push(...merged)
  }
  return out
}

/** Largest bitmap we render for OCR (pixels); bigger pages get a lower resolution. */
const MAX_PIXELS = 40_000_000

/**
 * Renders a page for OCR as grayscale pixels (no PNG round trip: the OCR pass cleans the pixels
 * up before tesseract sees them). `scale` converts page points to pixels.
 */
export async function rasterizePage(page: PDFPageProxy, rotation: number, dpi = 300): Promise<{ gray: Gray; scale: number; width: number; height: number }> {
  const base = page.getViewport({ scale: 1, rotation })
  let scale = dpi / 72
  if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height))
  const viewport = page.getViewport({ scale, rotation })
  const width = Math.ceil(viewport.width)
  const height = Math.ceil(viewport.height)
  const { canvas, ctx } = env.createCanvas(width, height)
  await page.render({ canvas: canvas as HTMLCanvasElement, canvasContext: ctx, viewport }).promise
  const pixels = ctx.getImageData(0, 0, width, height)
  return { gray: toGray(pixels.data, width, height), scale, width: base.width, height: base.height }
}
