/**
 * A minimal .xlsx writer (one sheet, inline strings, numbers, real dates, a bold header row,
 * coloured cells), so exports open in Excel without a spreadsheet library. An .xlsx file is a zip
 * of a few XML parts; this zip stores them uncompressed, which every reader accepts.
 */

export interface SheetCell {
  text: string
  /** Written as a number when set. */
  number?: number
  /** ISO date (yyyy-mm-dd): written as an Excel date when set. */
  date?: string
  /** 0 none, 1 amber (proposed), 2 red (needs review). */
  mark?: 0 | 1 | 2
}

export interface SheetSpec {
  name: string
  headers: string[]
  rows: SheetCell[][]
  /** Excel number format for dates, e.g. "dd/mm/yyyy". */
  dateFormat: string
  rightToLeft: boolean
}

const enc = new TextEncoder()

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function serial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  return (Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - Date.UTC(1899, 11, 30)) / 86_400_000
}

/** Style index: 1 is the header; then 2 + base * 3 + mark, base 0 text, 1 date, 2 number. */
const style = (base: 0 | 1 | 2, mark: 0 | 1 | 2) => 2 + base * 3 + mark

function stylesXml(dateFormat: string): string {
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>', '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" applyFont="1" applyFill="1"/>']
  for (const numFmt of [0, 164, 4])
    for (const fill of [0, 2, 3]) xfs.push(`<xf numFmtId="${numFmt}" fontId="0" fillId="${fill}" borderId="0"${numFmt ? ' applyNumberFormat="1"' : ''}${fill ? ' applyFill="1"' : ''}/>`)
  const solid = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="${xml(dateFormat)}"/></numFmts>` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    `<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${solid('FFFFF2CC')}${solid('FFFDE2DD')}${solid('FFEFF1F4')}</fills>` +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '</styleSheet>'
  )
}

function sheetXml(spec: SheetSpec): string {
  const widths = spec.headers.map((h, i) => Math.min(50, Math.max(8, h.length + 2, ...spec.rows.map((r) => (r[i]?.text.length ?? 0) + 2))))
  const cell = (ref: string, c: SheetCell) => {
    const mark = c.mark ?? 0
    const d = c.date ? serial(c.date) : null
    if (d !== null) return `<c r="${ref}" s="${style(1, mark)}"><v>${d}</v></c>`
    if (c.number !== undefined && Number.isFinite(c.number)) return `<c r="${ref}" s="${style(2, mark)}"><v>${c.number}</v></c>`
    if (!c.text) return mark ? `<c r="${ref}" s="${style(0, mark)}"/>` : ''
    return `<c r="${ref}" t="inlineStr" s="${style(0, mark)}"><is><t xml:space="preserve">${xml(c.text)}</t></is></c>`
  }
  const header = `<row r="1">${spec.headers.map((h, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(h)}</t></is></c>`).join('')}</row>`
  const rows = spec.rows.map((r, ri) => `<row r="${ri + 2}">${r.map((c, ci) => cell(`${colName(ci)}${ri + 2}`, c)).join('')}</row>`).join('')
  const last = colName(Math.max(0, spec.headers.length - 1))
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0"${spec.rightToLeft ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${header}${rows}</sheetData>` +
    (spec.headers.length ? `<autoFilter ref="A1:${last}${spec.rows.length + 1}"/>` : '') +
    '</worksheet>'
  )
}

export function buildXlsx(spec: SheetSpec): Uint8Array {
  const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const sheetName = xml(spec.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>${spec.headers.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$1:$${colName(spec.headers.length - 1)}$${spec.rows.length + 1}</definedName></definedNames>` : ''}</workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE}/styles" Target="styles.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', stylesXml(spec.dateFormat)],
    ['xl/worksheets/sheet1.xml', sheetXml(spec)],
  ])
}

// ---------------------------------------------------------------------------------------------
// zip (stored, no compression)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zip(files: readonly [string, string | Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  // 1980-01-01 00:00: a fixed time keeps the output reproducible.
  const time = 0
  const date = (0 << 9) | (1 << 5) | 1
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
