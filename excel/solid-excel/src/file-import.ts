import type {
  ImportCellWire,
  WorkerWorkbookClient,
  WorkbookImportStatsWire,
} from './wasm-workbook-proxy'

const DEFAULT_CHUNK_SIZE = 1_000
const WORKER_MAX_IMPORT_CHUNK_CELLS = 10_000

const CRLF_SUFFIX = /\r+$/
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

export interface ImportProgress {
  rowsRead: number
  cellsQueued: number
  cellsImported: number
  chunks: number
  status: 'running' | 'flushing' | 'committed' | 'cancelled' | 'failed'
}

export interface FileImportResult extends ImportProgress {
  sessionId: number
  status: 'committed' | 'cancelled'
  stats?: WorkbookImportStatsWire
  error?: Error
}

export interface ImportDelimitedFileOptions {
  sheet?: number
  startRow?: number
  startCol?: number
  chunkSize?: number
  delimiter?: ',' | '\t'
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

export function parseDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  const fields: string[] = []
  let inQuotes = false
  let field = ''
  let i = 0

  while (i < line.length) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      inQuotes = !inQuotes
      i += 1
      continue
    }
    if (!inQuotes && ch === delimiter) {
      fields.push(field)
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (line.endsWith('\r')) {
    field = field.replace(CRLF_SUFFIX, '')
  }
  fields.push(field)
  return fields
}

function countUnquoted(text: string, delimiter: ',' | '\t'): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && ch === delimiter) count += 1
  }
  return count
}

export function detectDelimiter(fileName: string, sample?: string): ',' | '\t' {
  const normalizedName = fileName.toLowerCase()
  if (normalizedName.endsWith('.tsv') || normalizedName.endsWith('.tab')) {
    return '\t'
  }
  if (normalizedName.endsWith('.csv')) {
    return ','
  }
  if (!sample) return ','
  const line = sample.replace(/\r\n?/g, '\n').split('\n', 1)[0]
  const csvSeparators = countUnquoted(line, ',')
  const tsvSeparators = countUnquoted(line, '\t')

  if (tsvSeparators > csvSeparators) return '\t'
  return ','
}

function parseCell(raw: string, sheet: number, row: number, col: number): ImportCellWire | null {
  if (raw === '') return null
  if (raw[0] === '=') return { sheet, row, col, kind: 'formula', value: raw }
  const upper = raw.toUpperCase()
  if (upper === 'TRUE') return { sheet, row, col, kind: 'boolean', value: true }
  if (upper === 'FALSE') return { sheet, row, col, kind: 'boolean', value: false }
  const parsedNumber = Number(raw)
  if (Number.isFinite(parsedNumber) && NUMBER_RE.test(raw)) {
    return { sheet, row, col, kind: 'number', value: parsedNumber }
  }
  return { sheet, row, col, kind: 'text', value: raw }
}

function normalizeChunkSize(raw?: number): number {
  const normalized = Math.floor(Number(raw))
  if (!Number.isFinite(normalized) || normalized <= 0) return DEFAULT_CHUNK_SIZE
  return Math.min(normalized, WORKER_MAX_IMPORT_CHUNK_CELLS)
}

function makeAbortError(): DOMException {
  return new DOMException('import operation was aborted', 'AbortError')
}

export async function importDelimitedFileToWorkbook(
  client: WorkerWorkbookClient,
  file: Blob & { name?: string },
  opts: ImportDelimitedFileOptions = {},
): Promise<FileImportResult> {
  const sheet = opts.sheet ?? 0
  const startRow = opts.startRow ?? 0
  const startCol = opts.startCol ?? 0
  const chunkSize = normalizeChunkSize(opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const delimiter = opts.delimiter
  const signal = opts.signal
  const emitProgress = opts.onProgress
  const result: ImportProgress = {
    rowsRead: 0,
    cellsQueued: 0,
    cellsImported: 0,
    chunks: 0,
    status: 'running',
  }

  let abortCleanup: (() => void) | undefined
  const abortError = new Promise<never>((_, reject) => {
    if (!signal) return
    const onAbort = () => reject(makeAbortError())
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    abortCleanup = () => signal.removeEventListener('abort', onAbort)
  })

  const runWithAbort = <T>(work: () => Promise<T>): Promise<T> => {
    return signal ? Promise.race([work(), abortError]) : work()
  }

  const checkAborted = () => {
    if (signal?.aborted) throw makeAbortError()
  }

  let sessionId = -1
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (signal?.aborted) {
      throw makeAbortError()
    }

    sessionId = await client.beginImport()
    const stream = file.stream()
    reader = stream.getReader()
    const streamReader = reader
    const decoder = new TextDecoder()
    let lineBuffer = ''
    let pending: ImportCellWire[] = []
    const emit = () => {
      emitProgress?.({
        ...result,
        status: result.status,
      })
    }

    const { value: firstValue, done } = await runWithAbort(() => streamReader.read())
    let text = firstValue ? decoder.decode(firstValue, { stream: !done }) : ''
    lineBuffer += text

    const finalDelimiter = delimiter ?? detectDelimiter(file.name ?? '', lineBuffer)
    let rowCursor = startRow

    const flush = async () => {
      if (pending.length === 0) return
      result.status = 'flushing'
      emit()
      const accepted = await runWithAbort(() => client.importChunk(sessionId, pending))
      result.cellsImported += accepted
      result.chunks += 1
      pending = []
      result.status = 'running'
      emit()
    }

    const processLine = async (line: string) => {
      const fields = parseDelimitedLine(line, finalDelimiter)
      let colCursor = startCol
      for (const field of fields) {
        const cell = parseCell(field, sheet, rowCursor, colCursor)
        if (cell) {
          pending.push(cell)
          result.cellsQueued += 1
          if (pending.length >= chunkSize) {
            await flush()
          }
        }
        colCursor += 1
      }
      rowCursor += 1
      result.rowsRead += 1
      emit()
    }

    const consumeBufferLines = async () => {
      while (true) {
        const nextNewLine = lineBuffer.indexOf('\n')
        if (nextNewLine === -1) break
        const line = lineBuffer.slice(0, nextNewLine).replace(/\r+$/, '')
        lineBuffer = lineBuffer.slice(nextNewLine + 1)
        await processLine(line)
        checkAborted()
      }
    }

    const parseAndFinish = async () => {
      text = decoder.decode(undefined, { stream: false })
      if (text.length > 0) {
        lineBuffer += text
      }
      await consumeBufferLines()
      if (lineBuffer.length > 0) {
        await processLine(lineBuffer)
        lineBuffer = ''
      }
    }

    const readLoop = async () => {
      await consumeBufferLines()

      if (done) {
        await parseAndFinish()
        return
      }

      while (true) {
        checkAborted()
        const { value, done: isDone } = await runWithAbort(() => streamReader.read())
        if (value) {
          lineBuffer += decoder.decode(value, { stream: !isDone })
        }
        await consumeBufferLines()
        if (isDone) {
          await parseAndFinish()
          return
        }
      }
    }

    await readLoop()
    await flush()
    const stats = await runWithAbort(() => client.commitImport(sessionId))
    result.status = 'committed'
    emit()
    abortCleanup?.()
    return {
      ...result,
      status: 'committed',
      sessionId,
      stats,
    }
  } catch (error) {
    abortCleanup?.()
    const cancelReader = (reader as { cancel?: () => Promise<unknown> } | undefined)?.cancel
    await cancelReader?.call(reader).catch(() => undefined)
    if (sessionId >= 0) {
      await client.cancelImport(sessionId).catch(() => false)
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ...result,
        status: 'cancelled',
        sessionId,
        error,
      }
    }
    throw error
  }
}
