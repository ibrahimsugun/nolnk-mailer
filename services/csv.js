'use strict';

// Saf CSV yardımcıları: parse, serileştirme, alan kaçışı ve formül-enjeksiyon nötrleme.
// DB/ağ/Express bağımlılığı yoktur — yalnızca saf JS.

// CSV metnini { headers, rows } biçimine ayrıştırır.
// Kurallar: virgül ayraç; çift-tırnaklı alan içinde virgül/CRLF/"" desteklenir;
// tırnak DIŞINDAKI boşluklar trim edilir; tamamen boş satırlar atlanır;
// ilk satır başlıklardır; \r\n ve \n satır sonları tolere edilir.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field.trim());
    field = '';
  }

  function endRow() {
    endField();
    // Tamamen boş satırları atla (tek elemanlı ve boş string ise)
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
    row = [];
  }

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      // \r\n veya tek \r'yi satır sonu say
      if (text[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Son satırı kapat (dosya satır sonuyla bitmiyorsa)
  if (field !== '' || row.length > 0) {
    endRow();
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = rows[0];
  return { headers, rows: rows.slice(1) };
}

// Bir alanı gerekirse çift-tırnakla kaçırır.
// v içinde " , \r veya \n varsa tüm alan tırnaklanır ve içindeki " → "" yapılır.
function csvField(v) {
  const s = String(v);
  if (/["\r\n,]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// CSV formül-enjeksiyon koruması: değer = + - @ veya TAB/CR ile başlıyorsa
// başına tek tırnak (') ekler; aksi halde değeri olduğu gibi döndürür.
function neutralizeFormula(v) {
  const s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

// headers ve rows dizisinden CSV metni üretir.
// Her alana önce neutralizeFormula sonra csvField uygulanır (varsayılan enjeksiyon-güvenli export).
// Satır sonu \r\n, alan ayracı ','.
function serializeCsv(headers, rows) {
  const headerLine = headers.map((h) => csvField(neutralizeFormula(h))).join(',');
  const lines = rows.map((row) =>
    row.map((v) => csvField(neutralizeFormula(v))).join(',')
  );
  return [headerLine, ...lines].join('\r\n');
}

module.exports = { parseCsv, serializeCsv, csvField, neutralizeFormula };
