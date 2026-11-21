// csv-reader-fast: a from-scratch drop-in for csv-reader 1.0.0.
//
// Same answer as csv-reader 1.0.0 for every input {text, header} — the JSON value
// {columns, rows, errors} — but read with slice-based fast paths instead of one
// character at a time:
//
//   - A record with no quote and no stray CR in its line is split in one C++
//     call (String split), after indexOf finds the line end and the stretch up
//     to it is scanned for a quote or a CR. That covers the plain records.
//   - A field is cut out with slice() between delimiters found by a tight
//     charCodeAt scan, never built up a character at a time. A quoted field
//     is cut out with indexOf('"') and slice(); doubled quotes and line breaks
//     inside quotes go through a short segment loop, which is rare.
//   - Every broken-row rule of the reference is kept exactly: BOM drop, blank
//     lines are no records, stray CR dropped with its error, quote junk,
//     unterminated quotes re-read as unquoted, short/long rows padded/cut with
//     their errors, error order and line/row numbers as the reference counts
//     them.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. Dependency-free ES module; run(input) is the entry point.

const LINE_SCAN = /["\r\n]/g;
const FIELD_SCAN = /[,\r\n]/g;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // readUnquoted results (no per-field array allocation).
  let uValue = '';
  let uEnded = END;
  let uAdded = 0;
  // readQuoted results.
  let qValue = '';
  let qEnded = END;

  function readUnquoted(value) {
    let added = 0;
    const start = pos;
    for (;;) {
      let p = pos;
      let c = 0;
      while (p < n) {
        c = text.charCodeAt(p);
        if (c === 44 || c === 10 || c === 13) break;
        p += 1;
      }
      if (p === n) {
        if (p > pos) { value += text.slice(pos, p); added += p - pos; }
        pos = n;
        uValue = value; uEnded = END; uAdded = added;
        return;
      }
      if (c === 44) {
        if (p > pos) { value += text.slice(pos, p); added += p - pos; }
        pos = p + 1;
        uValue = value; uEnded = COMMA; uAdded = added;
        return;
      }
      if (c === 10) {
        if (p > pos) { value += text.slice(pos, p); added += p - pos; }
        pos = p + 1;
        line += 1;
        uValue = value; uEnded = LINE_BREAK; uAdded = added;
        return;
      }
      // A CR: a line break when LF follows it, a dropped stray CR otherwise.
      if (text.charCodeAt(p + 1) === 10) {
        if (p > pos) { value += text.slice(pos, p); added += p - pos; }
        pos = p + 2;
        line += 1;
        uValue = value; uEnded = LINE_BREAK; uAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (p > pos) { value += text.slice(pos, p); added += p - pos; }
      pos = p + 1;
    }
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let parts = null;
    pos += 1;
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      let seg = text.slice(pos, q);
      if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
        let fixed = '';
        for (let i = 0; i < seg.length; i++) {
          const ch = seg.charCodeAt(i);
          if (ch === 13) {
            fixed += '\n';
            line += 1;
            if (seg.charCodeAt(i + 1) === 10) i += 1;
          } else {
            if (ch === 10) line += 1;
            fixed += seg[i];
          }
        }
        seg = fixed;
      }
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [value];
        parts.push(seg, '"');
        pos = q + 2;
        continue;
      }
      if (parts !== null) { parts.push(seg); value = parts.join(''); }
      else value = seg;
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      qValue = uValue; qEnded = uEnded;
      return;
    }
    if (pos >= n) { qValue = value; qEnded = END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; qValue = value; qEnded = COMMA; return; }
    if (c === 10) { pos += 1; line += 1; qValue = value; qEnded = LINE_BREAK; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; qValue = value; qEnded = LINE_BREAK; return; }
    readUnquoted(value);
    if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    qValue = uValue; qEnded = uEnded;
  }

  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; return; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the line holds no quote and no stray CR, so it is one record
    // whose fields are a single split. Found with indexOf: the next LF ends
    // the line, and the stretch up to it is scanned for a quote or a CR.
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      const seg = text.slice(pos);
      if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
        finishRecord(seg.split(','), false);
        pos = n;
        break;
      }
    } else {
      const seg = text.slice(pos, nl);
      if (seg.indexOf('"') === -1) {
        if (seg.charCodeAt(seg.length - 1) === 13) {
          const body = seg.slice(0, -1);
          if (body.indexOf('\r') === -1) {
            finishRecord(body.split(','), false);
            pos = nl + 1;
            line += 1;
            continue;
          }
        } else if (seg.indexOf('\r') === -1) {
          finishRecord(seg.split(','), false);
          pos = nl + 1;
          line += 1;
          continue;
        }
      }
    }

    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) { readQuoted(); fields.push(qValue); ended = qEnded; }
      else { readUnquoted(''); fields.push(uValue); ended = uEnded; }
    } while (ended === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
