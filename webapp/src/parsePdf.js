const pdfParse = require("pdf-parse");

// 「/kinmu」スキルが出力する勤務表PDF(日付・曜日・勤務の3列テーブル)を想定した簡易パーサー。
// 1行が「日付 曜日 勤務内容」の形式(例: "9/1 月 日勤" や "9/1(月) 日勤")であることを前提にしている。
// PDFのレイアウトが変わった場合は、このファイルの正規表現だけを調整すればよい。
const LINE_PATTERN = /^(\d{1,2}\/\d{1,2})\s*[(（]?([月火水木金土日])[)）]?\s+(.+)$/;

async function parseShiftPdf(buffer) {
  const { text } = await pdfParse(buffer);

  const rows = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(LINE_PATTERN);
    if (!match) continue;

    const [, date, weekday, duty] = match;
    rows.push({ date, weekday, duty: duty.trim() });
  }

  return rows;
}

module.exports = { parseShiftPdf };
