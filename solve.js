// fast-csv-reader: a byte-exact, much faster drop-in for csv-reader 1.0.0 (make.fun's reference program).
//
// run(input) returns, for every input {text, header}, exactly the answer csv-reader 1.0.0's readCsv returns:
// {columns, rows, errors} under the same broken-row policy — BOM dropped only at position 0; records end at LF or
// CRLF; empty lines (and lines holding only stray CRs) are no record, though their stray_cr errors stay; a CR not
// followed by LF outside quotes is dropped (stray_cr); a field opening with '"' runs to the next undoubled quote
// ("" inside it is one quote; CRLF or a lone CR inside it reads as LF); junk after a closing quote is appended as it
// stands (quote_junk when at least one character was kept); a quote that never closes is a literal character and the
// rest is re-read as an unquoted field (unterminated_quote); a quote inside an unquoted field is literal; fields are
// never trimmed; rows are padded (short_row, with fields: the count) or cut (long_row, with extra: the cut fields)
// to the first record's width; each error is {code, line, row} with line the 1-based line its record starts on and
// row its record's index in rows (null for the header).
//
// Why it is faster: the reference reads one character at a time and builds every field by concatenation. This reader
// keeps the same single left-to-right pass but works on slices: it scans with charCodeAt and indexOf jumps and cuts
// each field (or each clean run inside a field) out of the text with one slice instead of appending character by
// character. Quoted fields first jump quote-to-quote with indexOf to find the closing quote; when the content needs
// no rewriting (no doubled quote, no CR) the value is a single slice and only its newlines are counted. Pure: no
// state is kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters an unquoted read kept.
  const res = { value: '', ended: END, added: 0 };

  // Reads unquoted characters onto `prefix` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Clean runs between stray CRs are sliced, never concatenated character by character.
  function readUnquoted(prefix) {
    let i = pos;
    let seg = pos; // start of the current clean run
    let added = 0;
    let buf = null; // clean runs, only when a stray CR splits the field
    let ended = END;
    let end = n;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ','
        ended = COMMA;
        end = i;
        break;
      }
      if (c === 10) { // '\n'
        ended = LINE_BREAK;
        end = i;
        break;
      }
      if (c === 13) { // '\r'
        if (text.charCodeAt(i + 1) === 10) {
          ended = LINE_BREAK;
          end = i;
          break;
        }
        if (buf === null) buf = [];
        if (i > seg) buf.push(text.slice(seg, i));
        added += i - seg;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    added += end - seg;
    let value;
    if (buf === null) {
      value = prefix + text.slice(seg, end);
    } else {
      if (end > seg) buf.push(text.slice(seg, end));
      value = prefix + buf.join('');
    }
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      pos = text.charCodeAt(end) === 13 ? end + 2 : end + 1;
      line += 1;
    } else {
      pos = end;
    }
    res.value = value;
    res.ended = ended;
    res.added = added;
  }

  // Ends a quoted field whose value is known and whose closing quote has just been consumed (pos is past it): the
  // field ends at a comma, a line break or the end of the text, or what follows is appended as junk.
  function finishQuoted(value) {
    if (pos >= n) {
      res.value = value;
      res.ended = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      res.value = value;
      res.ended = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      res.value = value;
      res.ended = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      res.value = value;
      res.ended = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (res.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;

    // Find the closing quote, jumping quote to quote: a quote followed by another quote is a doubled quote, not
    // the end. Nothing is mutated during the scan, so an unterminated field can restart cleanly.
    let j = start;
    let closePos = -1;
    let doubled = false;
    while (j < n) {
      const q = text.indexOf('"', j);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        j = q + 2;
        continue;
      }
      closePos = q;
      break;
    }
    if (closePos === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }

    if (!doubled) {
      // The value may be one slice of the text: it is, unless a CR inside rewrites to LF. Count the LFs either way.
      let hasCR = false;
      let lf = 0;
      if (closePos - start <= 48) {
        for (let k = start; k < closePos; k++) {
          const c = text.charCodeAt(k);
          if (c === 13) {
            hasCR = true;
            break;
          }
          if (c === 10) lf += 1;
        }
      } else {
        const r = text.indexOf('\r', start);
        hasCR = r !== -1 && r < closePos;
        if (!hasCR) {
          let m = text.indexOf('\n', start);
          while (m !== -1 && m < closePos) {
            lf += 1;
            m = text.indexOf('\n', m + 1);
          }
        }
      }
      if (!hasCR) {
        line += lf;
        pos = closePos + 1;
        finishQuoted(text.slice(start, closePos));
        return;
      }
    }

    // General path: doubled quotes and CRs rewrite the content, so build it from clean runs between rewrites.
    let i = start;
    let seg = start;
    let parts = null;
    let contentEnd = -1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { // '"'
        if (text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          if (i > seg) parts.push(text.slice(seg, i));
          parts.push('"');
          i += 2;
          seg = i;
          continue;
        }
        contentEnd = i;
        i += 1;
        break;
      }
      if (c === 13) { // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        if (i > seg) parts.push(text.slice(seg, i));
        parts.push('\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    if (contentEnd === -1) {
      // Unreachable (the scan above proved a closing quote exists); restart as unterminated rather than guess.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    let value;
    if (parts === null) {
      value = text.slice(start, contentEnd);
    } else {
      if (contentEnd > seg) parts.push(text.slice(seg, contentEnd));
      value = parts.join('');
    }
    pos = i;
    finishQuoted(value);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(res.value);
    } while (res.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
