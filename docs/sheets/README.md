# A4 のまとめ(セキュリティシート・管理者の手引き)

| ファイル | 中身 |
|---|---|
| `security-sheet.pdf` | 使うサービス・預ける情報・漏洩対策・保存期間・事故のとき(元は [`SECURITY.md`](../../SECURITY.md)) |
| `admin-guide.pdf` | 管理者の役割・交代のしかた・ダイヤ改正/修正のときのマスタ更新(AI で CSV にする指示文つき) |
| `master-prompt.txt` | マスタ CSV を作る指示文(Claude のチャットに画像と一緒に貼る)。`admin-guide.pdf` にも同じ文が入る |
| `make_sheets.py` | 上の2つの PDF を作る(`pip install reportlab`、`python3 docs/sheets/make_sheets.py`) |

- 公開リポジトリなので、パスワード・キー・URL の実際の値、氏名などの個人情報は載せない
- 文字の大きさは、A4 1枚に収まるいちばん大きい値に自動で合わせる。フォントは IPA ゴシックを埋め込む
- SECURITY.md・管理画面・マスタの CSV の形を変えたら、ここも直して作り直す
- 指示文は Skill「kinmu-master-csv」を短くしたもの。CSV の形を変えたら両方を直す
