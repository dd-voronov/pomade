// Pomade E-009 — a lossless, header-aware CSV model.
//
// Why not just Papa.parse: the round-trip discipline (T-002) needs the file on disk to differ
// ONLY in an edited cell — every other byte identical. papaparse gives decoded values but
// discards the exact source of each field (its quoting, spacing, the delimiter run), so
// re-serializing a papaparse result rewrites the whole file. This model keeps, per field, the
// EXACT source slice (`raw`) alongside the decoded `value`; serialize() emits `raw` verbatim
// for untouched fields and only re-encodes the ones actually edited. serialize(parse(text))
// therefore reproduces `text` byte-for-byte, and a one-cell edit changes exactly that cell.
//
// It is also header-aware (fixes T-034): a data row with MORE fields than the header — the
// classic "trailing free-text column has unquoted commas" case the Owner hit — has its overflow
// fields folded back into the last column for display, instead of spilling into phantom
// columns. The folded cell's `raw` is the original slice (delimiters included), so an unedited
// ragged row still round-trips exactly; editing it re-quotes only that cell.
//
// Input/output are LF-normalized text: EditorPane owns CRLF and trailing-newline reconstruction
// (see normalize/reconstruct there), so this model never sees '\r'. A quoted field may still
// contain embedded '\n' (a multiline cell) — that is preserved.

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const
const QUOTE = '"'

export interface CsvField {
  /** Exact source slice of this field (quotes included), between its surrounding delimiters. */
  raw: string
  /** Decoded value shown/edited in the grid. */
  value: string
  /** True once the value has been edited — serialize() re-encodes it instead of emitting raw. */
  edited?: boolean
}

interface CsvRecord {
  fields: CsvField[]
  /** The newline that terminated this record ('\n'), or '' for a final record with no EOL. */
  eol: string
}

export interface CsvModelData {
  ok: true
  delimiter: string
  /** All physical records, header included, in file order (blank lines kept as records). */
  records: CsvRecord[]
  /** Index of the header record in `records`. */
  headerIndex: number
  /** Number of grid columns (= header field count). */
  colCount: number
  /** True iff serialize() reproduces the parsed text exactly — the precondition for editing. */
  editable: boolean
}

export type CsvModel = CsvModelData | { ok: false; error: string }

/** Pick the delimiter by counting candidates on the first physical line, outside quotes. */
function detectDelimiter(text: string): string {
  const end = text.indexOf('\n')
  const firstLine = end === -1 ? text : text.slice(0, end)
  let best = ','
  let bestCount = -1
  for (const cand of DELIMITER_CANDIDATES) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i]
      if (ch === QUOTE) inQuotes = !inQuotes
      else if (ch === cand && !inQuotes) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = cand
    }
  }
  return best
}

/** Scan LF-normalized text into physical records. Returns null on an unterminated quoted field. */
function scan(text: string, delimiter: string): CsvRecord[] | null {
  const records: CsvRecord[] = []
  let fields: CsvField[] = []
  let i = 0
  const n = text.length

  const pushRecord = (eol: string): void => {
    records.push({ fields, eol })
    fields = []
  }

  while (i < n) {
    // Parse one field starting at i.
    const start = i
    let value: string
    if (text[i] === QUOTE) {
      // Quoted field: consume to the matching close quote, un-doubling "".
      i++ // opening quote
      let buf = ''
      let closed = false
      while (i < n) {
        const ch = text[i]
        if (ch === QUOTE) {
          if (text[i + 1] === QUOTE) {
            buf += QUOTE
            i += 2
          } else {
            i++ // closing quote
            closed = true
            break
          }
        } else {
          buf += ch
          i++
        }
      }
      if (!closed) return null // unterminated quote → unparseable
      // Tolerate any trailing junk after the close quote up to the next delimiter/EOL.
      while (i < n && text[i] !== delimiter && text[i] !== '\n') i++
      value = buf
    } else {
      // Unquoted field: to next delimiter or newline.
      while (i < n && text[i] !== delimiter && text[i] !== '\n') i++
      value = text.slice(start, i)
    }
    fields.push({ raw: text.slice(start, i), value })

    if (i >= n) {
      pushRecord('')
      return records
    }
    if (text[i] === delimiter) {
      i++
      if (i >= n) {
        // A trailing delimiter means one more (empty) field, then EOF.
        fields.push({ raw: '', value: '' })
        pushRecord('')
        return records
      }
      continue
    }
    // Newline → end of record.
    pushRecord('\n')
    i++
  }
  // Reached only when text is empty or ended exactly on a newline (handled above); an empty
  // trailing record is intentionally NOT added so "a\n" round-trips as one record + eol.
  return records
}

/** A record is "blank" (skipped in the grid) when it is a single empty field. */
function isBlank(r: CsvRecord): boolean {
  return r.fields.length === 1 && r.fields[0].value === '' && r.fields[0].raw === ''
}

function encodeField(value: string, delimiter: string): string {
  const needsQuote =
    value.includes(delimiter) ||
    value.includes(QUOTE) ||
    value.includes('\n') ||
    value.includes('\r')
  if (!needsQuote) return value
  return QUOTE + value.replace(/"/g, '""') + QUOTE
}

function serializeRecord(r: CsvRecord, delimiter: string): string {
  const body = r.fields
    .map((f) => (f.edited ? encodeField(f.value, delimiter) : f.raw))
    .join(delimiter)
  return body + r.eol
}

export function serialize(model: CsvModelData): string {
  return model.records.map((r) => serializeRecord(r, model.delimiter)).join('')
}

export function parseCsvModel(text: string): CsvModel {
  if (text.length === 0) return { ok: false, error: 'Empty CSV' }
  const delimiter = detectDelimiter(text)
  const records = scan(text, delimiter)
  if (!records) return { ok: false, error: 'Unterminated quoted field' }

  const headerIndex = records.findIndex((r) => !isBlank(r))
  if (headerIndex === -1) return { ok: false, error: 'No data rows' }
  const colCount = records[headerIndex].fields.length

  const model: CsvModelData = {
    ok: true,
    delimiter,
    records,
    headerIndex,
    colCount,
    editable: false
  }
  // Editing is only offered when we can reproduce the input exactly — otherwise a save would
  // silently rewrite untouched bytes (round-trip discipline: fall back to read-only instead).
  model.editable = serialize(model) === text
  return model
}

/** Header cell values (length === colCount). */
export function headerValues(model: CsvModelData): string[] {
  return model.records[model.headerIndex].fields.map((f) => f.value)
}

/** Indices into `records` of the non-blank data rows, in file order. */
export function dataRecordIndices(model: CsvModelData): number[] {
  const out: number[] = []
  for (let i = model.headerIndex + 1; i < model.records.length; i++) {
    if (!isBlank(model.records[i])) out.push(i)
  }
  return out
}

/**
 * Grid value at display column `col` of a data record. Columns before the last map 1:1 to
 * fields; the LAST column folds together every overflow field (header-aware fix for T-034),
 * re-joining them with the delimiter so an unquoted-comma free-text tail reads as one cell.
 */
export function cellValue(model: CsvModelData, recordIndex: number, col: number): string {
  const fields = model.records[recordIndex].fields
  const last = model.colCount - 1
  if (col < last) return fields[col]?.value ?? ''
  if (col > last) return ''
  // Last display column: fold fields[last..] back into one value.
  if (fields.length <= last) return fields[last]?.value ?? ''
  return fields
    .slice(last)
    .map((f) => f.value)
    .join(model.delimiter)
}

/**
 * Return a NEW model with one cell edited (immutably; other records/fields shared by reference).
 * The last column replaces any folded overflow fields with a single re-encoded field; earlier
 * columns edit in place, padding with empty fields if the row was short.
 */
export function editCell(
  model: CsvModelData,
  recordIndex: number,
  col: number,
  value: string
): CsvModelData {
  const last = model.colCount - 1
  const records = model.records.slice()
  const old = records[recordIndex]
  const fields = old.fields.slice()

  if (col >= last) {
    // Collapse fields[last..] (the folded tail) into one edited field.
    const head = fields.slice(0, last)
    while (head.length < last) head.push({ raw: '', value: '', edited: true })
    head.push({ raw: '', value, edited: true })
    records[recordIndex] = { fields: head, eol: old.eol }
  } else {
    while (fields.length <= col) fields.push({ raw: '', value: '', edited: true })
    fields[col] = { raw: '', value, edited: true }
    records[recordIndex] = { fields, eol: old.eol }
  }
  // Any edit means the file will change, so `editable` (input-reproduction) no longer applies;
  // it stays true so the grid remains editable, and serialize() reflects the edits.
  return { ...model, records }
}

// ─── T-051: structural edits (insert/delete row & column), lossless ────────────
// Untouched fields keep their exact source (`raw`); only the added empty fields are re-encoded.
// Blank records (blank source lines) are left as-is so they still round-trip. Row/column count
// never drops below 1 (a 1×1 minimum, per spec).

const emptyField = (): CsvField => ({ raw: '', value: '', edited: true })

/** Insert a new empty column at display index `at` (existing columns at/after shift right). */
export function insertColumn(model: CsvModelData, at: number): CsvModelData {
  const col = Math.max(0, Math.min(at, model.colCount))
  const records = model.records.map((r) => {
    if (isBlank(r)) return r
    const fields = r.fields.slice()
    fields.splice(Math.min(col, fields.length), 0, emptyField())
    return { fields, eol: r.eol }
  })
  return { ...model, records, colCount: model.colCount + 1 }
}

/** Delete the column at display index `col`. The last display column also drops any folded
 *  overflow fields (T-034). No-op when only one column remains (1×1 minimum). */
export function deleteColumn(model: CsvModelData, col: number): CsvModelData {
  if (model.colCount <= 1) return model
  const last = model.colCount - 1
  const records = model.records.map((r) => {
    if (isBlank(r)) return r
    const fields = r.fields.slice()
    if (col >= last) fields.splice(last, fields.length - last)
    else if (col < fields.length) fields.splice(col, 1)
    return { fields, eol: r.eol }
  })
  return { ...model, records, colCount: model.colCount - 1 }
}

/** Insert a new empty data row at display row index `at` (0 = before the first data row;
 *  `at >= rowCount` appends after the last data row). Preserves the file's trailing-newline
 *  state: appending after a final record that has no EOL terminates it and leaves the new row
 *  un-terminated. */
export function insertRow(model: CsvModelData, at: number): CsvModelData {
  const rowIdx = dataRecordIndices(model)
  const newRecord: CsvRecord = {
    fields: Array.from({ length: model.colCount }, emptyField),
    eol: '\n'
  }
  const records = model.records.slice()
  let pos: number
  if (at >= rowIdx.length) {
    pos = rowIdx.length ? rowIdx[rowIdx.length - 1] + 1 : model.headerIndex + 1
  } else {
    pos = rowIdx[Math.max(0, at)]
  }
  if (pos >= records.length) {
    const lastRec = records[records.length - 1]
    if (lastRec && lastRec.eol === '') {
      records[records.length - 1] = { ...lastRec, eol: '\n' }
      newRecord.eol = ''
    }
    records.push(newRecord)
  } else {
    records.splice(pos, 0, newRecord)
  }
  return { ...model, records }
}

/** Delete the data row at display index `r`. No-op when only one data row remains (1×1
 *  minimum). Preserves trailing-newline state when the physically-last record is removed. */
export function deleteRow(model: CsvModelData, r: number): CsvModelData {
  const rowIdx = dataRecordIndices(model)
  if (rowIdx.length <= 1 || r < 0 || r >= rowIdx.length) return model
  const pos = rowIdx[r]
  const removed = model.records[pos]
  const records = model.records.slice()
  records.splice(pos, 1)
  // If we removed the physically-last record and it had no trailing newline, the new last
  // record must also end without one so the file's trailing-newline state is preserved.
  if (pos === model.records.length - 1 && removed.eol === '' && records.length) {
    const li = records.length - 1
    records[li] = { ...records[li], eol: '' }
  }
  return { ...model, records }
}
