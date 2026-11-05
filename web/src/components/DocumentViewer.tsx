import { useEffect, useMemo, useRef, useState } from 'react'
import type { BBox, Page, Word } from '../../../src/model/types'
import type { Box, Focus } from '../focus'
import type { Job } from '../jobs'
import { renderPages, type PagePicture } from '../pages'

interface Props {
  job: Job
  focus: Focus | null
  showWords: boolean
  onWordClick: (word: Word) => void
  /** When set, dragging on a page draws a box (in page points) and reports it. */
  onSelectBox?: (page: number, box: BBox) => void
}

/** The document's pages with the extracted evidence drawn over them. */
export function DocumentViewer({ job, focus, showWords, onWordClick, onSelectBox }: Props) {
  const doc = job.result!.document
  const [pictures, setPictures] = useState<(PagePicture | undefined)[]>([])

  useEffect(() => {
    let cancelled = false
    setPictures([])
    renderPages(
      job.bytes,
      doc,
      job.password,
      (i, p) => !cancelled && setPictures((prev) => Object.assign([...prev], { [i]: p })),
      () => cancelled,
    ).catch((err) => {
      console.error(err)
      if (!cancelled) setPictures(doc.pages.map(() => ({ kind: 'none', reason: 'The page could not be drawn; the words are drawn from the extracted text.' })))
    })
    return () => {
      cancelled = true
    }
  }, [job.bytes, job.password, doc])

  const wordsByPage = useMemo(() => {
    const m = new Map<number, Word[]>()
    for (const w of doc.words) m.set(w.page, [...(m.get(w.page) ?? []), w])
    return m
  }, [doc])

  return (
    <div className="pages">
      {doc.pages.map((page, i) => (
        <PageView
          key={page.number}
          page={page}
          picture={pictures[i]}
          words={wordsByPage.get(page.number) ?? []}
          boxes={focus?.boxes.filter((b) => b.page === page.number) ?? []}
          showWords={showWords}
          onWordClick={onWordClick}
          onSelectBox={onSelectBox}
          many={doc.pages.length > 1}
        />
      ))}
    </div>
  )
}

interface PageProps {
  page: Page
  picture: PagePicture | undefined
  words: Word[]
  boxes: Box[]
  showWords: boolean
  onWordClick: (word: Word) => void
  onSelectBox?: (page: number, box: BBox) => void
  many: boolean
}

function PageView({ page, picture, words, boxes, showWords, onWordClick, onSelectBox, many }: PageProps) {
  const holder = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const toPage = (e: React.PointerEvent): { x: number; y: number } | null => {
    const m = svg.current?.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }
  const dragBox = drag && { x0: Math.min(drag.x0, drag.x1), y0: Math.min(drag.y0, drag.y1), x1: Math.max(drag.x0, drag.x1), y1: Math.max(drag.y0, drag.y1) }
  useEffect(() => {
    if (holder.current) holder.current.replaceChildren(...(picture?.kind === 'canvas' ? [picture.canvas] : []))
  }, [picture])

  const drawText = picture?.kind === 'none'
  const pad = Math.max(1.5, page.width / 400)
  return (
    <figure className="page">
      {many && <figcaption>Page {page.number}</figcaption>}
      <div className="page-sheet" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
        <div ref={holder} className="page-picture" />
        {!picture && <div className="page-loading">Drawing page…</div>}
        <svg
          ref={svg}
          className={`page-overlay${onSelectBox ? ' is-selecting' : ''}`}
          viewBox={`0 0 ${page.width} ${page.height}`}
          preserveAspectRatio="none"
          onPointerDown={(e) => {
            if (!onSelectBox || e.button !== 0) return
            const p = toPage(e)
            if (p) setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
          }}
          onPointerMove={(e) => {
            if (!drag) return
            const p = toPage(e)
            if (p) setDrag({ ...drag, x1: p.x, y1: p.y })
          }}
          onPointerUp={() => {
            // A drag of a few points is a click: the word's own handler takes it.
            if (dragBox && onSelectBox && dragBox.x1 - dragBox.x0 > 4 && dragBox.y1 - dragBox.y0 > 3) onSelectBox(page.number, dragBox)
            setDrag(null)
          }}
          onPointerLeave={() => setDrag(null)}
        >
          {drawText &&
            words.map((w) => (
              <text key={`t${w.id}`} x={w.bbox.x0} y={w.bbox.y1 - (w.bbox.y1 - w.bbox.y0) * 0.18} fontSize={(w.bbox.y1 - w.bbox.y0) * 0.95} textLength={Math.max(1, w.bbox.x1 - w.bbox.x0)} lengthAdjust="spacingAndGlyphs" className="page-text">
                {w.text}
              </text>
            ))}
          {words.map((w) => (
            <rect
              key={w.id}
              x={w.bbox.x0}
              y={w.bbox.y0}
              width={w.bbox.x1 - w.bbox.x0}
              height={w.bbox.y1 - w.bbox.y0}
              className={`word${showWords ? ' word-visible' : ''}${w.source === 'ocr' && w.confidence < 0.8 ? ' word-unsure' : ''}`}
              onClick={() => onWordClick(w)}
            >
              <title>{`${w.text}${w.source === 'ocr' ? `  (OCR ${Math.round(w.confidence * 100)}%)` : ''}`}</title>
            </rect>
          ))}
          {boxes.map((b, i) => (
            <rect
              key={`h${i}`}
              data-focus={i === 0 ? '1' : undefined}
              x={b.bbox.x0 - pad}
              y={b.bbox.y0 - pad}
              width={b.bbox.x1 - b.bbox.x0 + 2 * pad}
              height={b.bbox.y1 - b.bbox.y0 + 2 * pad}
              rx={pad}
              className={`hl hl-${b.kind}`}
            />
          ))}
          {dragBox && <rect x={dragBox.x0} y={dragBox.y0} width={dragBox.x1 - dragBox.x0} height={dragBox.y1 - dragBox.y0} className="drag-rect" />}
        </svg>
      </div>
      {picture?.kind === 'none' && picture.reason !== 'text' && <p className="page-note">{picture.reason}</p>}
    </figure>
  )
}
