/** CSV records with quoted commas, escaped quotes, CRLF and quoted newlines. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new SyntaxError('CSV ends inside a quoted field');
  record.push(field);
  if (record.some((value) => value !== '')) records.push(record);
  return records;
}

export function parseCsvObjects(text: string): readonly Record<string, string>[] {
  const [header, ...records] = parseCsvRecords(text);
  if (header === undefined) return [];
  return records.map((record, index) => {
    if (record.length !== header.length) {
      throw new SyntaxError(`CSV record ${index + 2} has ${record.length} fields; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((key, at) => [key, record[at] ?? '']));
  });
}
