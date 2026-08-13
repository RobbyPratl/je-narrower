/**
 * Minimal xlsx writer: a store-only zip around a few OOXML parts. A workpaper is
 * an Excel file and nothing else will do, and pulling in a spreadsheet library
 * to emit two flat sheets is not worth the weight.
 */

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
  widths: number[];
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encode = (text: string) => new TextEncoder().encode(text);
const u16 = (v: number) => [v & 255, (v >> 8) & 255];
const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];

function zip(files: Array<{ name: string; data: Uint8Array<ArrayBuffer> }>): Blob {
  const parts: Array<Uint8Array<ArrayBuffer>> = [];
  const central: number[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(file.data.length), ...u32(file.data.length),
      ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, file.data);

    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(file.data.length), ...u32(file.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...name,
    );
    offset += local.length + name.length + file.data.length;
  }

  const directory = new Uint8Array(central);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(directory.length), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...parts, directory, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sheetXml(sheet: Sheet): string {
  const columnLetter = (index: number): string => {
    const letter = String.fromCharCode(65 + (index % 26));
    return index < 26 ? letter : columnLetter(Math.floor(index / 26) - 1) + letter;
  };
  const rows = sheet.rows.map((cells, r) => {
    const body = cells
      .map((value, c) => {
        if (value === null || value === '') return '';
        const ref = `${columnLetter(c)}${r + 1}`;
        return typeof value === 'number'
          ? `<c r="${ref}"><v>${value}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      })
      .join('');
    return `<row r="${r + 1}">${body}</row>`;
  });

  const cols = sheet.widths
    .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}"/>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

export function buildWorkbook(sheets: Sheet[]): Blob {
  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  const tabs = sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const rels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('');

  return zip([
    {
      name: '[Content_Types].xml',
      data: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encode(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ),
    },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encode(sheetXml(sheet)),
    })),
  ]);
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
