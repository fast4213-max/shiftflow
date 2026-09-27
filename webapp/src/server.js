require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");

const { parseShiftPdf } = require("./parsePdf");
const { sendRowsToGas } = require("./gasClient");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "";

app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/upload", upload.single("shiftPdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "PDFファイルが選択されていません。" });
    }

    const rows = await parseShiftPdf(req.file.buffer);
    if (rows.length === 0) {
      return res.status(422).json({
        error:
          "PDFから勤務データを読み取れませんでした。フォーマットを確認してください。",
      });
    }

    const result = await sendRowsToGas(GAS_WEBAPP_URL, rows);
    res.json({ rows, gasResult: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`shiftflow webapp listening on http://localhost:${PORT}`);
});
