# shiftflow

勤務表(PDF)をアップロードすると、内容を読み取ってGoogleスプレッドシートに記録し、
Googleカレンダー(勤務用・休日用の2種類)に自動登録する、個人用の勤務管理Webアプリです。
ライフベアへはGoogleカレンダー側の連携機能を使って反映する想定のため、本アプリからの直接連携は行いません。

このプロジェクトは今後も機能追加していく前提のため、リポジトリ名は特定の1機能に縛られない汎用名にしています。

## 全体の流れ

1. 勤務表の写真から本人の勤務を抽出しPDF化する(`/kinmu` スキル等、別プロセス)
2. できたPDFを本Webアプリにアップロードする
3. Webアプリ(Node.js/Express)がPDFのテキストを解析し、日付・曜日・勤務内容の一覧を作る
4. その一覧をGAS(Google Apps Script)のWebアプリ(doPost)に送信する
5. GASがGoogleスプレッドシートに書き込み、勤務用/休日用の2つのGoogleカレンダーに予定を登録する
6. Googleカレンダー → ライフベアへはライフベア側の既存の連携機能で反映される(本アプリの対象外)

```
[勤務表PDF] --upload--> [webapp: Node/Express] --HTTP POST--> [GAS Web App]
                                                                    |
                                                         +----------+----------+
                                                         |                     |
                                                 [Googleスプレッドシート]   [Googleカレンダー x2]
                                                                                  |
                                                                          (ライフベアへは
                                                                           カレンダー側連携)
```

## ディレクトリ構成

```
webapp/   Node.js/Express製のWebアプリ(PDFアップロード・解析・GASへの送信)
gas/      Google Apps Script(スプレッドシート書き込み・カレンダー登録)
```

## セットアップ

### 1. GAS(Google Apps Script)側

1. Google スプレッドシートを新規作成し、そのスプレッドシートに紐づく形で
   [Apps Script](https://script.google.com/) プロジェクトを作成する
2. `gas/Code.gs` の内容をコピーし、`gas/appsscript.json` の内容でマニフェストを設定する
3. スクリプトのプロパティ(「プロジェクトの設定」→「スクリプト プロパティ」)に以下を設定する
   - `SPREADSHEET_ID`: 書き込み先スプレッドシートのID
   - `WORK_CALENDAR_ID`: 勤務用GoogleカレンダーのID
   - `HOLIDAY_CALENDAR_ID`: 休日用GoogleカレンダーのID
4. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」で公開し、発行されたURLを控える
   (アクセスできるユーザーは自分のみに設定する)

これらのID・URLは個人情報にあたるため、リポジトリには一切含めません。

### 2. Webアプリ側

```
cd webapp
cp ../.env.example .env   # GAS_WEBAPP_URL などを自分の値に書き換える
npm install
npm start
```

`.env` はコミットしないでください(`.gitignore` で除外済みです)。

## 個人情報の扱いについて

このリポジトリには以下のような個人情報を一切含めません。

- 氏名、勤務先名
- 実際のスプレッドシートID・カレンダーID
- 実際のGAS WebアプリURL

これらは `.env`(webapp側)およびGASのスクリプトプロパティ(GAS側)で管理し、
`.env.example` のようなサンプルファイルのみをリポジトリに含めます。

## Git運用

個人開発・個人使用のプロジェクトのため、ブランチは `main` 1本のみで運用します。
PRは作成せず、修正は基本的に `main` へ直接コミット・プッシュします。
