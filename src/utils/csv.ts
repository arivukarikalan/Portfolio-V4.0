function detectDelimiter(text: string): ',' | '\t' | ';' {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  if (tabCount >= commaCount && tabCount >= semicolonCount && tabCount > 0) return '\t';
  if (semicolonCount > commaCount && semicolonCount > 0) return ';';
  return ',';
}

function parseCsvRows(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (c === '"') {
      const next = text[i + 1];
      if (quoted && next === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (c === delimiter && !quoted) {
      row.push(value.trim());
      value = '';
      continue;
    }

    if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(value.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      value = '';
      continue;
    }

    value += c;
  }

  row.push(value.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }

  return rows;
}

export function parseCsvText(text: string): { headers: string[]; body: string[][] } {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { headers: [], body: [] };
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  return { headers, body: rows.slice(1) };
}
