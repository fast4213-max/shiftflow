"""A4 1枚のまとめを2つ作る。

  security-sheet.pdf … 使うサービスと預ける情報、漏洩対策の一覧
  admin-guide.pdf    … 管理者の役割・交代のしかた・ダイヤ改正/修正のマスタ更新(AI で CSV 化する指示文つき)

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
                 f"使うサービス・預かる情報・漏洩対策の一覧({UPDATED}時点。くわしくはリポジトリの SECURITY.md)")
    s += k.h("1. 使うサービスと、預ける情報・守り方")
    s += k.table(
        ["サービス", "使い道", "預ける情報", "漏洩対策"],
        [
            ["Supabase", "データベース・ログイン・サーバーの処理",
             "社員番号・名前・区所・PIN・カレンダーID・勤務の番号とメモ・マスタ",
             "本人の行しか読み書きできない(RLS)。PINは暗号化(ハッシュ)だけ保存。勤務の中身とカレンダーIDは管理者にも見えない"],
            ["Google カレンダー(Google Cloud のサービスアカウント)", "勤務の予定を書き込む",
             "勤務の予定(番号・時刻・泊地)",
             "利用者が自分で共有したカレンダーにだけ書く。メインのカレンダーは使えない。共有はいつでも止められる"],
            ["Google ログイン(かんたん設定・任意)", "カレンダーを自動で作る", "保存しない",
             "権限はアプリが作ったカレンダーだけ(calendar.app.created)。許可は使い終わりにすぐ取り消す"],
            ["GitHub Pages", "画面(Webページ)の公開", "なし(画面のプログラムだけ)",
             "パスワード・キーなどの秘密の値はリポジトリに書かない"],
            ["Claude(写真取込・任意)", "勤務指定表の画像の読み取り", "画像は本人の Claude アカウントへ送られる",
             "shiftflow のサーバーには画像を送らない。取り込むのは本人の行(行路番号)だけ"],
            ["Discord", "管理者への通知(お問い合わせ・ロック)", "お問い合わせの内容",
             "通知先の URL は秘密の値として管理。90日で削除"],
            ["Gmail・Google Apps Script", "お問い合わせのメール返信", "メールアドレス・内容・画像",
             "専用アカウントで扱う。合言葉で確かめる。画像は位置情報を消す。90日で削除"],
            ["cron-job.org", "データベースの停止を防ぐ(6時間ごと)", "なし",
             "公開用のキーだけ使う。個人情報は扱わない"],
        ],
        [2.3, 2.3, 2.7, 4.2],
    )
    s += k.h("2. 漏洩対策のチェックリスト")
    s += k.bullets([
        "ログイン: 社員番号(7桁)+PIN(4桁)。5回失敗で15分ロック。PINを24時間に20回間違えると24時間ロックし、管理者に通知",
        "新規登録: 共通パスワードを知っている人だけ。共通パスワードは暗号化(ハッシュ)だけ保存し、管理画面から変えられる",
        "管理画面: 管理用パスワード(12文字以上)で入る。管理者にも PIN・勤務の中身・カレンダーIDは見えない",
        "通信: すべて HTTPS(暗号化された通信)",
        "必要最小限: 預かるのは勤務の登録に要る情報だけ。広告・分析には使わず、第三者に渡さない",
        "秘密の値: 鍵・パスワードは Supabase・GitHub の秘密の設定にだけ置く。漏れた疑いがあれば作り直す",
    ], mark="✓ ")
    s += k.h("3. 保存期間(自動で削除)")
    s += k.table(
        ["情報", "削除のタイミング"],
        [
            ["勤務の記録", "毎日、前月1日より前のぶんを削除(Google カレンダーの予定は消えない)"],
            ["ログイン失敗の記録", "30日以上更新がないと削除"],
            ["お問い合わせ(内容・メール・画像・通知)", "最後のやり取りから90日で削除"],
            ["古いマスタ(前のダイヤ)", "次のマスタが入り、前月1日を過ぎたら削除"],
            ["利用者", "退職・異動などで使わなくなったら、管理者が管理画面で削除"],
        ],
        [4, 7.5],
    )
    s += k.h("4. 事故が起きたとき")
    s += k.bullets([
        "止める: 漏れた鍵・パスワード・通知先の URL を無効にして作り直す",
        "範囲を調べる: ログインの記録・サーバーのログ・変更の履歴で、何が見えた可能性があるかを調べる",
        "知らせる: 影響のある利用者に、分かっていること・直したこと・お願い(PINの変更など)を伝える",
        "直して残す: 原因を直し、再発防止の手当てを記録する",
    ], mark="num")
    s += k.gap(0.5)
    s += k.para("※shiftflow の勤務は会社の正式な記録ではありません。勤務は会社の勤務表で確認してください。"
                "問題を見つけたときは、アプリの「お問い合わせ」から「セキュリティの件」と書いて連絡してください。", WARN)
    return s


# ---- 管理者の手引き ----------------------------------------------------------
def admin(k):
    prompt = open(os.path.join(HERE, "master-prompt.txt"), encoding="utf-8").read().rstrip("\n").split("\n")
    s = []
    s += k.title("shiftflow 管理者の手引き",
                 f"管理者の役割・交代のしかた・ダイヤ改正/ダイヤ修正のときの作業({UPDATED}時点)")
    s += k.h("1. 管理者の役割(アプリの最初の画面 →「管理」タブ → 管理用パスワードで入る)")
    s += k.table(
        ["管理画面のタブ", "やること"],
        [
            ["概要", "登録人数・接続テスト済みの人数・最近の登録など、利用状況を見る"],
            ["利用者", "PINを忘れた人に仮のPINを発行する(本人確認のうえ)。退職・異動した人を削除する"],
            ["マスタ", "ダイヤ改正(3月)・ダイヤ修正(10月)のたびに、新しい出退勤時刻のCSVを取り込む(3章)"],
            ["お知らせ・お問い合わせ", "お知らせを出す。お問い合わせに返事をする(メールは画面から送れる)"],
            ["設定", "新規登録用の共通パスワード(8文字以上)を決める・変える"],
        ],
        [2.6, 8.9],
    )
    s += k.para("管理者にも、利用者のPIN・勤務の中身・カレンダーIDは見えません。サーバーや GitHub の操作は要りません。")
    s += k.h("2. 管理者が交代するとき")
    s += k.bullets([
        "引き継ぐのは「管理用パスワード」だけ。新しい管理者は、アプリの「管理」タブからそのまま入れる",
        "交代したら、運営者(サーバーの設定を持つ人)に管理用パスワードを変えてもらう(前の管理者が入れなくなる)",
        "共通パスワードが広まりすぎたと思ったら、新しい管理者が「設定」タブで変える(登録済みの人には影響なし)",
        "パスワードは紙やチャットに残さず、口頭か手渡しで伝える",
    ])
    s += k.h("3. ダイヤ改正・ダイヤ修正が来たら(AI で CSV にする・無料プランでできる)")
    s += k.bullets([
        "管理画面「マスタ」→「＋ 次のマスタ」で切替日と名前を入れて作る(全部の区所に1回でできる)",
        "出退勤時刻一覧表を撮影する(PDF があればそのまま使う)。1ページずつ、まっすぐ明るく撮る",
        "Claude(claude.ai・無料プランで可)に画像を送る。Skill「kinmu-master-csv」が使えるなら「マスタにして」だけ。"
        "使えなければ下の指示文を貼る(このPDFの指示文は、文字を選んでそのままコピーできる)",
        "返ってきたCSVを元の表と見比べる(1と7・3と8・5と6・0と9、平日と休日の取り違え)",
        "管理画面で今のマスタを「CSVで保存」してから、区所と新しいタブを選んでCSVを取り込む。"
        "表で確かめて「この内容で入れ替える」(赤い行は直すまで取り込めない)",
    ], mark="num")
    s += k.para("※CSVは泊地から勤務先が分かるので、関係者以外に渡さない。無料プランは使える量に上限があるので、"
                "ページが多いときは1ページずつ送る(上限に達したら数時間おく)。", WARN)
    s += k.gap(0.3)
    s += [KeepTogether(k.para("指示文(Claude のチャットに画像と一緒に貼る)") + k.gap(0.2) + k.code_box(prompt))]
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
