const fetch = require("node-fetch");

function assertUrl(gasWebappUrl) {
  if (!gasWebappUrl) {
    throw new Error(
      "GAS_WEBAPP_URLが設定されていません。.envを確認してください。"
    );
  }
}

// GAS側の「勤務コード」マスタ(勤務番号・勤務内容・出退勤時間)を取得する
async function fetchMaster(gasWebappUrl) {
  assertUrl(gasWebappUrl);

  const url = `${gasWebappUrl}?action=master`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`マスタ取得に失敗しました (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.master || [];
}

// 確認済みの勤務データをGASに送り、スプレッドシート登録・カレンダー反映を行う
async function sendRowsToGas(gasWebappUrl, rows) {
  assertUrl(gasWebappUrl);

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

module.exports = { fetchMaster, sendRowsToGas };
