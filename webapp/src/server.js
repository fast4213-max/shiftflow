require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");

const { parseShiftPdf } = require("./parsePdf");
const { fetchMaster, sendRowsToGas } = require("./gasClient");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// PDFを解析するだけ。まだスプレッドシート/カレンダーへの登録は行わない。
app.post("/api/parse", upload.single("shiftPdf"), async (req, res) => {
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

    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// カレンダープレビューで勤務番号を選び直すためのマスタ(勤務番号/勤務内容/出退勤時間)
app.get("/api/master", async (req, res) => {
  try {
    const master = await fetchMaster(GAS_WEBAPP_URL);
    res.json({ master });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// カレンダープレビューでユーザーが最終確認した内容をGASへ送り、
// スプレッドシート登録・カレンダー反映を行う。
app.post("/api/confirm", async (req, res) => {
  try {
    const rows = req.body.rows || [];
    if (rows.length === 0) {
      return res.status(400).json({ error: "登録するデータがありません。" });
    }

    const result = await sendRowsToGas(GAS_WEBAPP_URL, rows);
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`shiftflow webapp listening on http://localhost:${PORT}`);
});
