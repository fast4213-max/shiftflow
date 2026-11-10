"""A4 1枚のまとめを4つ作る。

  security-sheet.pdf … 使うサービスと預ける情報、漏洩対策の一覧
  admin-guide.pdf    … 管理者の役割・交代のしかた・ダイヤ改正/修正のマスタ更新(AI で CSV 化する指示文つき)
  user-guide.pdf     … 利用者向けの使い方(最初の設定・勤務の入力・写真取込・カレンダー・Google連携・困った時)
  cost-sheet.pdf     … 費用対効果(機能・コードの量・外注した場合の目安。参考資料)

使い方: python3 docs/sheets/make_sheets.py [出力フォルダ]

公開リポジトリなので、パスワード・キー・URL の実際の値、氏名などの個人情報は載せない。
文字の大きさは、A4 1枚に収まるいちばん大きい値に自動で合わせる。
"""
import io
import os
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus.doctemplate import LayoutError
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FONT_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf"
MONO_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
FONT, MONO = "IPAPGothic", "IPAGothic"
pdfmetrics.registerFont(TTFont(FONT, FONT_PATH))
pdfmetrics.registerFont(TTFont(MONO, MONO_PATH))

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else HERE
INK = colors.HexColor("#1a1a1a")
ACCENT = colors.HexColor("#1f4e79")
LIGHT = colors.HexColor("#e8eef5")
CODE_BG = colors.HexColor("#f4f4f4")
WARN = colors.HexColor("#8a1c1c")
MARGIN = 10 * mm
WIDTH = A4[0] - 2 * MARGIN
UPDATED = "2026年11月"


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Kit:
    """文字の大きさ size で部品を作る。"""

    def __init__(self, size):
        self.s = size
        lead = size * 1.42
        self.p = ParagraphStyle("p", fontName=FONT, fontSize=size, leading=lead, textColor=INK, wordWrap="CJK")
        self.li = ParagraphStyle("li", parent=self.p, leftIndent=size * 1.0, firstLineIndent=-size * 1.0)
        self.cell = ParagraphStyle("cell", parent=self.p, fontSize=size * 0.95, leading=size * 1.3)
        self.cellh = ParagraphStyle("cellh", parent=self.cell, textColor=ACCENT)
        self.code = ParagraphStyle("code", fontName=MONO, fontSize=size * 0.86, leading=size * 1.2,
                                   textColor=INK, wordWrap="CJK", leftIndent=size * 0.9,
                                   firstLineIndent=-size * 0.9)

    def title(self, text, sub):
        t = Table([[Paragraph(esc(text), ParagraphStyle("t", fontName=FONT, fontSize=self.s * 1.9,
                                                           leading=self.s * 2.3, textColor=colors.white))],
                   [Paragraph(esc(sub), ParagraphStyle("ts", fontName=FONT, fontSize=self.s * 0.95,
                                                          leading=self.s * 1.3, textColor=colors.white))]],
                  colWidths=[WIDTH])
        t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT),
                               ("BACKGROUND", (0, 0), (-1, -1), ACCENT),
                               ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                               ("TOPPADDING", (0, 0), (-1, 0), 2.2 * mm),
                               ("BOTTOMPADDING", (0, -1), (-1, -1), 2.2 * mm)]))
        return [t, Spacer(1, self.s * 0.5)]

    def h(self, text):
        t = Table([[Paragraph(esc(text), ParagraphStyle("h", fontName=FONT, fontSize=self.s * 1.18,
                                                           leading=self.s * 1.45, textColor=ACCENT))]],
                  colWidths=[WIDTH])
        t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT),
                               ("LINEBELOW", (0, 0), (-1, -1), 1.2, ACCENT),
                               ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), self.s * 0.7),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), self.s * 0.2)]))
        return [t, Spacer(1, self.s * 0.3)]

    def para(self, text, color=None):
        st = self.p if color is None else ParagraphStyle("pc", parent=self.p, textColor=color)
        return [Paragraph(esc(text), st)]

    def bullets(self, items, mark="・"):
        out = []
        for i, it in enumerate(items, 1):
            m = f"{'①②③④⑤⑥⑦⑧⑨⑩'[i - 1]}" if mark == "num" else mark
            out.append(Paragraph(esc(f"{m}{it}"), self.li))
        return out

    def table(self, header, rows, ratios):
        widths = [WIDTH * r / sum(ratios) for r in ratios]
        data = [[Paragraph(esc(c), self.cellh) for c in header]]
        data += [[Paragraph(esc(c), self.cell) for c in r] for r in rows]
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT),
                               
            ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9aa8b8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 1.6 * mm), ("RIGHTPADDING", (0, 0), (-1, -1), 1.6 * mm),
            ("TOPPADDING", (0, 0), (-1, -1), self.s * 0.18), ("BOTTOMPADDING", (0, 0), (-1, -1), self.s * 0.3),
        ]))
        return [t]

    def code_box(self, lines, cols=2):
        """指示文の箱。長いので、真ん中に近い「#」の見出しで2段に分ける。"""
        def keep_indent(line):  # 先頭の空白は Paragraph で消えるので、字下げを残す
            body = line.lstrip(" ")
            return "&nbsp;" * (len(line) - len(body)) + esc(body)

        def cell(part):
            return [Paragraph(keep_indent(x) if x.strip() else "&nbsp;", self.code) for x in part]

        if cols == 2:
            heads = [n for n, x in enumerate(lines) if x.startswith("# ")]
            cut = min(heads, key=lambda n: abs(n - len(lines) / 2))
            data, widths = [[cell(lines[:cut]), cell(lines[cut:])]], [WIDTH / 2, WIDTH / 2]
        else:
            data, widths = [[cell(lines)]], [WIDTH]
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT),
                               ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
                               ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#b5b5b5")),
                               ("LINEAFTER", (0, 0), (0, -1), 0.4, colors.HexColor("#cfcfcf")),
                               ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
                               ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
                               ("TOPPADDING", (0, 0), (-1, -1), 1.5 * mm),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8 * mm)]))
        return [t]

    def gap(self, k=0.4):
        return [Spacer(1, self.s * k)]


# ---- セキュリティシート ------------------------------------------------------
def security(k):
    s = []
    s += k.title("shiftflow セキュリティシート",
                 f"使用するサービス・預ける情報・漏洩対策の一覧({UPDATED}時点。詳しくはリポジトリの SECURITY.md)")
    s += k.h("1. 使用するサービスと預ける情報・漏洩対策")
    s += k.table(
        ["サービス", "使い道", "預ける情報", "漏洩対策"],
        [
            ["Supabase", "データベース・ログイン・サーバーの処理・アプリ内のカレンダー(写真の保管を含む)",
             "社員番号・氏名・区所・PIN・勤務の行路番号とメモ・交番の休みの並び・マスタ・アプリ内のカレンダーの予定と写真・カレンダーID(Google連携の人のみ)",
             "本人のデータのみ読み書きできる(RLS)。PINは暗号化(ハッシュ)した値のみ保存。勤務の内容・カレンダーの予定と写真・カレンダーIDは管理者にも見えない"],
            ["Google カレンダー(連携・任意。Google Cloud のサービスアカウント)",
             "他のカレンダーアプリとの同期や家族との共有を希望する人のみ、勤務の予定を登録する",
             "勤務の予定(行路番号・時刻・泊地)",
             "初期設定は連携なし(Googleに何も送らない)。連携する人も、本人が共有したカレンダーにのみ登録する。メインのカレンダーには登録できない。共有はいつでも停止できる"],
            ["Google ログイン(簡単設定・連携する人のみ)", "カレンダーを自動で作成する", "保存しない",
             "権限はアプリが作成したカレンダーのみ(calendar.app.created)。許可は使用後すぐに取り消す"],
            ["GitHub Pages", "画面(Webページ)の公開", "なし(画面のプログラムのみ)",
             "パスワード・キー等の秘密の値はリポジトリに記載しない"],
            ["Claude(写真取込・任意)", "勤務指定表の画像の読み取り", "画像は本人の Claude アカウントへ送られる",
             "shiftflow のサーバーには画像を送らない。取り込むのは本人の行路番号のみ"],
            ["Discord", "管理者への通知(お問い合わせ・ロック)", "お問い合わせの内容",
             "通知先の URL は秘密の値として管理する。90日で削除"],
            ["Gmail・Google Apps Script", "お問い合わせのメール返信", "メールアドレス・内容・画像",
             "専用アカウントで取り扱う。送信元は合言葉(秘密の値)で確認する。画像の位置情報は削除する。90日で削除"],
            ["cron-job.org", "データベースの停止を防ぐ(6時間毎)", "なし",
             "公開用のキーのみ使用する。個人情報は取り扱わない"],
        ],
        [2.3, 2.3, 2.7, 4.2],
    )
    s += k.h("2. 漏洩対策のチェックリスト")
    s += k.bullets([
        "ログイン: 社員番号(7桁)+PIN(4桁)。5回失敗で15分ロック。PINを24時間に20回間違えると24時間ロックし、管理者に通知",
        "新規登録: 共通パスワードを知っている人のみ。共通パスワードは暗号化(ハッシュ)した値のみ保存し、管理画面から変更できる",
        "管理画面: 管理用パスワード(12文字以上)で入る。管理者にも PIN・勤務の内容・カレンダーの予定と写真・カレンダーIDは見えない",
        "外部に出さない: 初期設定はアプリ内のカレンダーのみで使用し、勤務は Google に送らない。Google連携は、他のカレンダーとの同期を希望する人のみ",
        "通信: 全て HTTPS(暗号化された通信)",
        "必要最小限: 預かるのは勤務の入力・カレンダーの表示に必要な情報のみ。広告・分析には使用せず、第三者に渡さない",
        "秘密の値: キー・パスワードは Supabase・GitHub の秘密の設定にのみ置く。漏洩の疑いがあれば作り直す",
    ], mark="✓ ")
    s += k.h("3. 保存期間(自動で削除)")
    s += k.table(
        ["情報", "削除のタイミング"],
        [
            ["勤務の記録", "毎日、13か月前の月の1日より前の分を削除(Google カレンダーに登録した予定は消えない)"],
            ["アプリ内のカレンダーの予定・スタンプ", "毎日、12か月前の月の1日より前の分を削除"],
            ["予定に付けた写真", "予定の終了から1か月で削除(「画像」に置いた画像は1人10枚まで。本人が削除する)"],
            ["ログイン失敗の記録", "30日以上更新が無い時に削除"],
            ["お問い合わせ(内容・メール・画像・通知)", "最後のやり取りから90日で削除"],
            ["古いマスタ(前のダイヤ)", "次のマスタの切替日が13か月前の月の1日以前になったら削除"],
            ["利用者", "退職・異動等で使用しなくなった時に、管理者が管理画面で削除(カレンダーの予定・写真も同時に削除される)"],
        ],
        [4, 7.5],
    )
    s += k.h("4. 事故発生時の対応")
    s += k.bullets([
        "止める: 漏洩したキー・パスワード・通知先の URL を無効にして作り直す",
        "範囲を調べる: ログインの記録・サーバーのログ・変更の履歴から、何が見えた可能性があるかを調べる",
        "知らせる: 影響のある利用者に、分かっていること・直したこと・お願い(PINの変更等)を伝える",
        "直して残す: 原因を直し、再発防止策を記録する",
    ], mark="num")
    return s


# ---- 管理者の手引き ----------------------------------------------------------
def admin(k):
    prompt = open(os.path.join(HERE, "master-prompt.txt"), encoding="utf-8").read().rstrip("\n").split("\n")
    s = []
    s += k.title("shiftflow 管理者の手引き",
                 f"管理者の役割・交代の仕方・ダイヤ改正/ダイヤ修正の時の作業({UPDATED}時点)")
    s += k.h("1. 管理者の役割(アプリの最初の画面 →「管理」タブ → 管理用パスワードで入る)")
    s += k.table(
        ["管理画面のタブ", "主な作業"],
        [
            ["概要", "登録人数・Google連携の人数(うち接続テスト済み)・アプリ内カレンダー(保存のみ)の人数・30日以内に登録・保存した人・最近の登録・無料枠の使用量等、利用状況を確認する"],
            ["利用者", "PINを忘れた人に仮のPINを発行する(本人確認の上)。退職・異動した人を削除する。"
                     "「カレンダー」の列は、Google連携 済=接続テスト済み・Google連携 未=接続テスト前・アプリ内=アプリ内カレンダーだけ(Googleを使わず保存のみ。初期設定)・—=未設定。「最終登録・保存」は、Googleへの登録も保存も含む"],
            ["マスタ", "ダイヤ改正(3月)・ダイヤ修正(10月)の度に、新しい出退勤時刻のCSVを取り込む(3章)"],
            ["お問い合わせ・お知らせ", "お問い合わせに返信する(メールは画面から送信できる)。お知らせを掲載する"],
            ["設定", "新規登録用の共通パスワード(8文字以上)を設定・変更する。カレンダーのホーム画面のアイコン(利用者が選べるもの)を、切り取る範囲を決めて足す・隠す・消す"],
        ],
        [2.6, 8.9],
    )
    s += k.para("管理者にも、利用者のPIN・勤務の内容・カレンダーの予定と写真・カレンダーIDは見えません。サーバーや GitHub の操作は不要です。")
    s += k.h("2. 管理者の交代時")
    s += k.bullets([
        "引き継ぐのは「管理用パスワード」のみ。新しい管理者は、アプリの「管理」タブからそのまま入れる",
        "交代後は、運営者(サーバーの設定を管理する人)に管理用パスワードを変更してもらう(前の管理者は入れなくなる)",
        "共通パスワードが広まり過ぎたと思った時は、新しい管理者が「設定」タブで変更する(登録済みの人には影響なし)",
        "パスワードは紙やチャットに残さず、口頭で直接伝える",
    ])
    s += k.h("3. ダイヤ改正・ダイヤ修正の時(AI で CSV を作成・無料プランで可)")
    s += k.bullets([
        "管理画面「マスタ」→「＋ 次のマスタ」で切替日と名前を入力して作成する(全区所分を1回で作成できる)",
        "出退勤時刻一覧表を撮影する(PDF がある時はそのまま使用する)。1ページずつ、真っ直ぐ明るく撮る",
        "Claude(claude.ai・無料プランで可)に画像を送る。Skill「kinmu-master-csv」が使える時は「マスタにして」と送るのみ。"
        "使えない時は下の指示文を貼り付ける(このPDFの指示文は、文字を選んでそのままコピーできる)",
        "返ってきたCSVを元の表と見比べる(1と7・3と8・5と6・0と9、平日と休日の取り違えに注意)",
        "管理画面で現在のマスタを「CSVで保存」してから、区所と新しいタブを選んでCSVを取り込む。"
        "表で確認して「この内容で入れ替える」(赤い行は修正するまで取り込めない)",
    ], mark="num")
    s += k.para("※CSVは泊地から勤務先が分かるため、関係者以外に渡さない。無料プランは使える量に上限があるため、"
                "ページが多い時は1ページずつ送る(上限に達した時は数時間空ける)。", WARN)
    s += k.gap(0.3)
    s += [KeepTogether(k.para("指示文(Claude のチャットに画像と一緒に貼り付ける)") + k.gap(0.2) + k.code_box(prompt))]
    return s


# ---- 使い方(利用者向け) ----------------------------------------------------
def user_guide(k):
    s = []
    s += k.title("shiftflow 使い方",
                 f"利用者向けの使い方の要点({UPDATED}時点。詳しくはアプリのメニュー「使い方」)")
    s += k.para("流れは「設定で区所を選んで保存」→「行路番号を入力して保存」→「メニューの『カレンダー』で確認」の3つのみ。"
                "Googleカレンダー連携(6章)は、他のカレンダーアプリとの同期や家族との共有を希望する人のみ必要です。")
    s += k.h("1. 最初の設定(初回のみ・1〜2分)")
    s += k.bullets([
        "ログイン: 社員番号(7桁)とPIN(4桁)。初めての人は「新規登録」から登録する(共通パスワードは管理者に確認)",
        "上のメニューの「設定」を開き、「1. 区所を選ぶ」で自分の区所を選ぶ(行路番号の一覧は区所毎に異なる)",
        "「カレンダーの表記」は好みでチェックを入れる(チェック無しでも使用可。下の表)",
        "「Googleカレンダーにも登録する」はチェック無しのまま、一番下の「保存」を押す。「保存済みです」と表示されれば完了",
    ], mark="num")
    s += k.gap(0.3)
    s += k.table(
        ["カレンダーの表記(後からいつでも変更可)", "アプリのカレンダーでの表示"],
        [
            ["出勤を2段で出す", "出勤の日が2段になる。上に行路番号、下に出勤時刻"],
            ["非番を2段で出す", "非番の日が2段になる。上に「〜」、下に退勤時刻"],
            ["出勤/非番の予定の名前に出勤時間/退勤時間を付ける", "「1(10:00)」「〜(9:00)」のように表示"],
            ["勤務を時間つきの予定で登録する", "タップすると出勤〜退勤の時刻を表示。泊は翌日の退勤までの1件"],
        ],
        [4.2, 7.3],
    )
    s += k.para("「2段」と「名前に時間」はどちらか一方を使用。「時間つき」がオンの時は、他の2つは使用されない。")
    s += k.h("2. 勤務を入力する")
    s += k.bullets([
        "メニューの「勤務入力」を開き、◀ ▶ で月を選ぶ(今月より前の月は不可)",
        "日付の行の「選択」を押し、行路番号を入力する(一覧に無いものは「手入力」、消す時は「クリア」)",
        "月の入力が終わったら「保存」を押す。アプリのカレンダーに表示される",
    ], mark="num")
    s += k.bullets([
        "行路番号を入力すると、時刻(メモ)が自動で入る。手で書き換えると青字になる",
        "「⚙」で交番の自分の休み(タップで特休・公休。一周の日数分、月をまたいでも入力)を1回入れると、「交番」で月毎に休みが入る(休みの日のみ上書き。予備の月は何もしないも選べる)",
        "泊の翌日は自動で「非番」になる。月末が泊の時は、翌月1日の非番も入る",
        "土日・祝日・年末年始(12/30〜1/3)は自動で「休」になる",
        "同じ月は何度でも保存し直せる。「リセット」でその月の入力を空にできる",
    ])
    s += k.h("3. 勤務指定表の画像から取り込む(写真取込・任意)")
    s += k.table(
        ["項目", "内容"],
        [
            ["準備", "「写真取込」を押すと Claude(AI)のページが開く。Claude のアプリとアカウントが必要(無料プラン可。"
                     "本人の Claude の使用量を使用)。画像は shiftflow のサーバーには送らない"],
            ["手順(全端末)", "氏名(勤務表の表記通り)・月を入れて「指示文をコピー」→ Claude アプリのチャットに画像と指示文を送る"
                            " → 答えの「コード」の枠をコピー → shiftflow の「貼り付けで取込」に貼り付けて「取り込む」"],
        ],
        [2.3, 9.2],
    )
    s += k.para("取り込んだ日は青、時刻が分からない日は黄色で表示。確認してから「保存」を押す(保存するまでカレンダーには表示されない)。")
    s += k.h("4. shiftflowカレンダー(アプリ内のカレンダー)")
    s += k.bullets([
        "メニューの「カレンダー」で月毎に表示する。勤務の修正は「勤務入力」で行う",
        "自分の予定は下の「＋」で追加する(繰り返し・「この回だけ」の変更も可)。写真は予定1つに3枚まで",
        "同じ予定を別の日にも入れるときは、追加の「＋ 別の日にもコピー」か、予定の詳細の「別の日にコピー」で日をタップして選ぶ",
        "よく入れる予定は、設定の「予定のテンプレート」に登録すると、予定の追加の上のボタン1つで入る(予定の詳細からも作れる)",
        "予定・重要メモで「アナウンスに出す」にすると、上の1行に1件ずつ出る(日付ありは「あと○日」)。「1/3」で一覧",
        "上のラベルのボタンで、そのラベルの予定を非表示/表示にする。スタンプ・TODO・重要メモも使用可",
        "カレンダーの下のメニューの「設定」→「画像を作る」で月のカレンダーを1枚の画像にし、「共有する」で LINE 等に送れる。見返せるのは過去1年まで",
        "「設定」の一番上に「お知らせ」「お問い合わせ」(意見・要望も可)。未読のお知らせ・返事がある時は、赤い点が付く",
    ])
    s += k.h("5. ホーム画面に追加(推奨)")
    s += k.bullets([
        "iPhone(Safari): 共有ボタン →「ホーム画面に追加」→「追加」。ホーム画面から初めて開いた時は、もう一度ログインする",
        "Android(Chrome): 右上の縦の3つの点(メニュー)→「ホーム画面に追加」→「インストール」",
    ])
    s += k.h("6. Googleカレンダー連携(同期を希望する人のみ・初回のみ10〜15分)")
    s += k.bullets([
        "設定で「Googleカレンダーにも登録する」にチェックを入れる",
        "「簡単設定」でカレンダー名と休日の扱いを選び、「Googleでカレンダーを作る」→ Google の画面で許可する(カレンダーIDは自動で入る)",
        "作成したカレンダーを全て、設定画面の「登録用アドレス」(「コピー」で取得)と共有する。"
        "Googleカレンダーアプリ:「≡」→「設定」→ カレンダー名 →「共有する相手」",
        "権限は上から4番目の「すべての予定の詳細を変更・表示可能」を選ぶ",
        "区所を確認して「保存して接続テスト」を押す。「接続できました」と表示されれば完了",
    ], mark="num")
    s += k.para("以後は勤務入力の「登録」で Google カレンダーにも登録される(手で入れた予定は消えない)。"
                "iPhone の標準カレンダーで見る時は、iPhone の「設定」→「カレンダー」→「アカウント」で Google を追加する。")
    s += k.h("7. 困った時")
    s += k.table(
        ["内容", "対応"],
        [
            ["ログインできない", "社員番号・PINを手で入力する。シークレットモードは不可。iPhone は「すべてのCookieをブロック」をオフにする。"
                               "LINE から開いた時は Safari・Chrome で開き直す"],
            ["PINを忘れた", "管理者に再設定を依頼する → 仮のPINで入り、設定画面の「PINを変える」で変更する"],
            ["行路番号が一覧に無い", "設定で自分の区所が選ばれているか確認する。一覧に無いものは「手入力」で入力できる"],
            ["「書き込めません」と表示", "共有の権限(上から4番目)・共有したアドレス・カレンダーIDの貼り間違い、全てのカレンダーを共有したかを確認する。"
                                    "共有の直後は数分空けて再度テストする"],
            ["その他・意見・要望", "メニューの「お問い合わせ」(カレンダーは「設定」の一番上)から管理者に連絡する(ログイン前も可。PINは書かない)。"
                                "返事が来ると「お問い合わせ」に赤い点が付く"],
        ],
        [2.8, 8.7],
    )
    return s


# ---- 費用対効果シート --------------------------------------------------------
def cost(k):
    s = []
    s += k.title("shiftflow 費用対効果シート",
                 f"何を作ったか・コードの量・外注した場合の目安({UPDATED}時点)")
    # 数字の箱(4つ)
    big = ParagraphStyle("big", fontName=FONT, fontSize=k.s * 2.1, leading=k.s * 2.5, textColor=ACCENT, alignment=1)
    cap = ParagraphStyle("cap", fontName=FONT, fontSize=k.s * 0.88, leading=k.s * 1.2, textColor=INK, alignment=1)
    boxes = [("約2.8万行", "コードの量(本体 約1.8万行+テスト 約1.0万行)"),
             ("約5週間", "開発期間(2026年9月末〜11月初め・担当者1人+AI)"),
             ("500万円〜", "外注した場合の目安(個人に依頼しても)"),
             ("0円", "月々のサーバー費用(すべて無料プランの範囲内)")]
    t = Table([[Paragraph(a, big) for a, _ in boxes], [Paragraph(esc(b), cap) for _, b in boxes]],
              colWidths=[WIDTH / 4] * 4)
    t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT),
                           ("BACKGROUND", (0, 0), (-1, -1), LIGHT),
                           ("LINEAFTER", (0, 0), (-2, -1), 0.8, colors.white),
                           ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                           ("TOPPADDING", (0, 0), (-1, 0), k.s * 0.5), ("BOTTOMPADDING", (0, 0), (-1, 0), 0),
                           ("TOPPADDING", (0, 1), (-1, 1), 0), ("BOTTOMPADDING", (0, 1), (-1, 1), k.s * 0.5),
                           ("LEFTPADDING", (0, 0), (-1, -1), 1.5 * mm), ("RIGHTPADDING", (0, 0), (-1, -1), 1.5 * mm)]))
    s += [t]
    s += k.h("1. できること(1つのアプリに入っている機能)")
    s += k.table(
        ["機能", "中身"],
        [
            ["ログイン・新規登録", "社員番号+PINでログイン。5回間違えると15分ロック。新規登録は共通パスワードを知っている人のみ。本人のデータは本人しか読み書きできない(RLS)"],
            ["勤務入力", "行路番号を入力するだけで、平日・休日を見分けて出勤・退勤時刻が自動で入る。ダイヤ改正・ダイヤ修正の切替日ごとにマスタを持つ。交番の休みを1回入れれば、月毎に休みを自動で入れられる。入力途中でも保存できる"],
            ["AIによる写真取込", "勤務指定表の画像をAI(Claude)が読み取り、本人の行のみを勤務入力に取り込む。本人が確認してから保存する(AIと人のダブルチェック)"],
            ["アプリ内カレンダー", "日付をタップすると出勤・退勤時刻を表示。自分の予定・ラベル・予定の画像・スタンプ・TODO・重要メモ・月のカレンダー画像・ホーム画面に追加(アイコンを選べる)。Googleの設定は不要"],
            ["Googleカレンダー連携(希望者のみ)", "好きなカレンダーアプリに同期。出勤を2件・非番を2件・名前に時間・時間つき予定など、見え方を選べる。手で入れた予定は消さない"],
            ["管理画面", "利用状況・PINの再設定・利用者の削除・マスタ(CSVの取込と書き出し)・お知らせ・お問い合わせへの返信・アイコンの追加・無料枠の使用量"],
            ["お問い合わせ・お知らせ", "ログイン前でも送れる。管理者にDiscordで通知し、専用Gmailから返信できる"],
            ["自動化・安全", "GitHubに保存すると、テスト→公開が自動で動く。古い記録は自動で削除。無料プランの一時停止を防ぐ仕組みつき"],
        ],
        [2.9, 8.6],
    )
    s += k.h("2. コードの量")
    s += k.table(
        ["区分", "行数", "中身"],
        [
            ["画面(JavaScript・HTML・CSS)", "約1.1万行", "10画面+アプリ内カレンダー。スマホ(iPhone・Android)で使える"],
            ["サーバーの処理(Edge Functions)", "約4,300行", "14本。ログイン・登録・Googleカレンダー操作・祝日・お問い合わせ等"],
            ["データベース(SQL)", "約3,100行", "32回分の変更。権限・本人のみ読み書き・自動削除・集計"],
            ["メール(GAS)", "約400行", "お問い合わせの返信メールの送受信"],
            ["自動テスト", "約9,900行", "サーバー225件+画面157項目+データベース・計算・GAS。全部通ってから公開される"],
            ["説明書・設計書", "約4,850行+A4資料4枚", "設計・使い方・管理者の手引き・セキュリティシート・改善提案書。33回のデバッグ記録つき"],
        ],
        [3.6, 2.2, 5.7],
    )
    s += k.h("3. 外注した場合の目安(作業量 約10〜15人月)")
    s += k.table(
        ["頼み先", "金額の目安", "期間の目安"],
        [
            ["フリーランス1人", "約500〜900万円", "6〜9か月"],
            ["小さな制作会社", "約800〜1,500万円", "6〜10か月"],
            ["大きめのSIer", "約1,500〜3,000万円", "8〜12か月"],
            ["shiftflow(実際)", "サーバー費0円(無料プランの範囲内)", "約5週間"],
        ],
        [3.6, 4.2, 3.7],
    )
    s += k.h("4. 費用対効果")
    s += k.bullets([
        "外注なら数百万円規模の機能一式を、サーバー費0円(無料プランの範囲内)で、勤務の入力から確認までを1つにまとめた",
        "手書き・手入力の入力ミスを減らし、出勤遅延の未然防止につなげる。新たな機器の導入は不要で、私物のスマホで使える",
        "利用者が増えても、管理者の作業は「PINの再設定」「ダイヤ改正時のマスタ更新」「お問い合わせへの返信」が中心",
        "本人しか読み書きできない設定で、AIの読み取りは本人の勤務のみ。Googleへの送信は希望者のみ",
        "仕組みは公開の設計書とテストで残してあり、担当者が代わっても引き継げる",
    ])
    s += k.gap(0.3)
    s += k.para("※外注の金額・期間は、日本の一般的な単価(フリーランス月60〜90万円・制作会社月100〜130万円・SIer月120〜160万円)から計算した目安で、見積もりではありません。"
                "要件の固まり具合や会社により変わります。公開後の保守は、年に開発費の10〜15%が目安です。"
                "無料プランには上限があり(利用者が大きく増えたときは見直し)、無料プランに自動バックアップはありません(マスタは管理画面から書き出す)。"
                "開発は担当者1人とAI(Claude Code)で行いました。", WARN)
    return s


def fit_and_build(name, story_fn, hi=11.0, lo=6.5):
    """1枚に収まるいちばん大きい文字で作る。"""
    size = hi
    while size >= lo:
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                                topMargin=MARGIN, bottomMargin=MARGIN, title=name.split(".")[0], author="",
                                initialFontName=FONT, initialFontSize=10)
        try:
            doc.build(story_fn(Kit(size)))
        except LayoutError:  # 1つの箱がページより高い。文字を小さくしてやり直す
            size -= 0.1
            continue
        if doc.page == 1:
            path = os.path.join(OUT_DIR, name)
            with open(path, "wb") as f:
                f.write(buf.getvalue())
            print(f"{path}  本文 {size:.2f}pt")
            return
        size -= 0.1
    raise SystemExit(f"{name}: {lo}pt でも1枚に収まらない")


if __name__ == "__main__":
    fit_and_build("security-sheet.pdf", security)
    fit_and_build("admin-guide.pdf", admin)
    fit_and_build("user-guide.pdf", user_guide)
    fit_and_build("cost-sheet.pdf", cost)
