const fetch = require("node-fetch");

// GAS(Google Apps Script)側でデプロイしたWebアプリのURLに、
// 解析済みの勤務データをJSONで送信する。
async function sendRowsToGas(gasWebappUrl, rows) {
  if (!gasWebappUrl) {
    throw new Error(
      "GAS_WEBAPP_URLが設定されていません。.envを確認してください。"
    );
  }

  const response = await fetch(gasWebappUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GASへの送信に失敗しました (${response.status}): ${body}`);
  }

  return response.json();
}

module.exports = { sendRowsToGas };
