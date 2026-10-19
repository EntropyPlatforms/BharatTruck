'use client'

/**
 * "Scan" — the driver photographs a document and the form beside it is filled in.
 *
 * One button: a phone offers the camera or the gallery, a desktop the file picker.
 * The photo is downsized in the browser first — a 12 MP camera shot is far more than OCR needs,
 * and a small upload matters on a highway data connection — then sent to POST /onboarding/ocr.
 * The server reads it and drops it; nothing is saved until the driver submits the form.
 *
 * Rendered only when the server says scanning is switched on (`enabled`).
 */

import { useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { toast } from 'sonner'

import { ApiError, scanDocument } from '@/lib/api'
import { BTN_BLUE, cx } from '@/lib/ui'
import type { DocumentScan, ScanKind } from '@/lib/types'

/** Long edge, px. Text on a licence is still sharp at this size and the JPEG lands near 300–500 KB. */
const MAX_EDGE = 1800
const MAX_PDF_BYTES = 5 * 1024 * 1024

const base64Of = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A photo, re-encoded as a JPEG no larger than MAX_EDGE on its long side. */
async function downsized(file: File): Promise<{ mime: string; base64: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
  if (!blob) throw new Error('Could not prepare the photo.')
  return { mime: 'image/jpeg', base64: base64Of(await blob.arrayBuffer()) }
}

export default function ScanDocument<K extends ScanKind>({
  kind, enabled, label, onFields, className,
}: {
  kind: K
  enabled: boolean
  label: string
  onFields: (fields: DocumentScan<K>['fields']) => void
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  if (!enabled) return null

  async function onPick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      let payload: { mime: string; base64: string }
      if (file.type === 'application/pdf') {
        if (file.size > MAX_PDF_BYTES) { toast.error('That PDF is too large. Use one under 5 MB, or take a photo.'); return }
        payload = { mime: file.type, base64: base64Of(await file.arrayBuffer()) }
      } else if (file.type.startsWith('image/')) {
        payload = await downsized(file)
      } else {
        toast.error('Use a photo (JPG or PNG) or a PDF.')
        return
      }
      const res = await scanDocument(kind, payload.mime, payload.base64)
      if (res.found === 0) {
        toast.error('Could not read that photo. Try again in good light with the whole document in frame, or type the details.')
        return
      }
      onFields(res.fields)
      toast.success('Details filled in from your photo. Check them, then save.')
    } catch (e) {
      toast.error(e instanceof ApiError || e instanceof Error ? e.message : 'Could not read the document.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = '' // let the same file be picked again
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"

        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className={cx(BTN_BLUE, 'gap-2', className)}>
        <Camera className="w-4 h-4" aria-hidden />
        {busy ? 'Reading…' : label}
      </button>
    </>
  )
}
