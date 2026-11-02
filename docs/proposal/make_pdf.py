"""改善提案書(shiftflow)の PDF を作る。

使い方:
  python3 docs/proposal/make_pdf.py                     # 共通パスワードの欄は空けたまま(リポジトリに置く版)
  SF_COMMON_PASSWORD=xxxx python3 docs/proposal/make_pdf.py out.pdf   # 印刷用(パスワード入り。コミットしない)

個人情報(氏名・社員コード)は載せない。ヘッダーの欄は手書きで埋める。
共通パスワードは公開リポジトリに置かないので、環境変数で渡したときだけ印字する。
"""
import os
import sys

import qrcode
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

FONT_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf"
FONT = "IPAPGothic"
pdfmetrics.registerFont(TTFont(FONT, FONT_PATH))

APP_URL = os.environ.get("SF_APP_URL", "https://fast4213-max.github.io/shiftflow/")
PASSWORD = os.environ.get("SF_COMMON_PASSWORD", "")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "kaizen-teian.pdf")

INK = colors.HexColor("#1a1a1a")
ACCENT = colors.HexColor("#1f4e79")
HEAD_BG = colors.HexColor("#e8eef5")

# ---- 本文 ------------------------------------------------------------------
# 用語の統一:
#   入力ミス … 書き間違い・書き漏れ・転記ミスをまとめた言い方
#   見落とし … 確認する側が気づかないこと
#   入力     … 人がアプリに行路番号を入れること
#   登録     … アプリが Google カレンダーに予定を書き込むこと
#   確認     … 動詞・名詞とも「確認」。AI と人の組み合わせだけ「ダブルチェック」
#   次勤務確認 / 終了点呼 / 行路番号 / 画像 / 当直 / PIN / 共通パスワード
# 各項目は「○結論(見出し)→ 説明」の形にそろえる。
B = "○"  # ○

SECTIONS = {
    "genjo": ("現状・問題点", [
        ("sub", "〔現状〕"),
        ("h", "勤務管理方法が統一されていない"),
        ("p", "乗務員手帳は希望者に支給している。手帳に書き込む人、私物のスマホのカレンダーアプリに入力する人など、勤務管理方法が統一されていない。"),
        ("h", "終了点呼での次勤務確認"),
        ("p", "終了点呼で、次の勤務を当直と確認している。当直が乗務員の手帳やスマホの画面を確認する仕組みにはなっていない。"),
        ("sub", "〔問題点〕"),
        ("h", "手書き・手入力による入力ミス"),
        ("p", "手書き・手入力のため、入力ミス(書き間違い・書き漏れ)が起き、出勤遅延が発生している。"),
        ("h", "書き方が人によって異なる"),
        ("p", "手帳への書き方が人によって異なるため、入力ミスを見落とす恐れがある。"),
        ("h", "確認が本人だけ"),
        ("p", "入力ミスに気づく機会が本人の確認だけで、見落としを防げていない。"),
    ]),
    "sokui": ("創意と工夫", [
        ("h", "AIによる読み取りと人のダブルチェック"),
        ("p", "勤務指定表の画像をAIが読み取り、自分の行路番号を取り込むため、入力ミスが減少します。AIの読み取り結果は本人が確認してから登録するため、AIと人によるダブルチェックになります。"),
        ("h", "行路番号から時刻を自動で登録"),
        ("p", "行路番号を入力するだけで、ダイヤ改正・ダイヤ修正ごとに設定した出勤・退勤時刻が、カレンダーへ自動で登録されます。"),
        ("h", "使い慣れたカレンダーで確認"),
        ("p", "登録先は普段使っているGoogleカレンダーのため、新たな機器の導入や操作方法の習得は不要で、私物のスマホ等でいつでも確認できます。"),
    ]),
    "kaizen": ("改善・実施", [
        ("h", "勤務入力アプリ「shiftflow」の作成"),
        ("p", "使い方は次の3段階です。"),
        ("step", "①", "社員番号とPINでログインする"),
        ("step", "②", "行路番号を入力する(勤務指定表の画像から取り込むこともできます)"),
        ("step", "③", "勤務用・休日用のGoogleカレンダーへ、予定が自動で登録される(終日、または出勤・退勤時刻つき)"),
        ("h", "点呼確認への活用"),
        ("p", "終了点呼での次勤務確認に、shiftflowで登録したカレンダーを使用します。現行からの負担増はなく、手帳を使用する人は従来どおり手帳で確認できます。"),
        ("h", "個人情報への配慮"),
        ("p", "勤務記録は本人しか読み書きできない設定とし、必要最小限の情報だけを取り扱っています。勤務指定表からの行路番号の取り込みは、本人の勤務情報だけを取り込む設定とし、他の乗務員の情報漏洩を防止しています。"),
    ]),
    "koka": ("効果", [
        ("h", "他職場への水平展開"),
        ("p", "天王寺車掌区で利用が広がっており、天王寺電車区でも数人がモニターとして試行中です。"),
        ("row", "利用開始", "＿＿＿＿年＿＿月"),
        ("row", "利用者数", "約40人(＿＿月＿＿日現在)"),
        ("row", "エラー件数", "＿＿＿件"),
        ("h", "入力ミスに起因する出勤遅延の防止"),
        ("p", "時刻が自動でカレンダーへ登録されるため入力ミスが減少し、出勤遅延の未然防止につながっています。"),
        ("h", "AIと人によるダブルチェック"),
        ("p", "AIの読み取り結果を本人が登録の時点で確認するため、入力ミスに早い段階で気づくことができ、安全・安定輸送に寄与しています。"),
    ]),
}


def styles(size):
    lead = size * 1.4
    return {
        "h": ParagraphStyle("h", fontName=FONT, fontSize=size * 1.08, leading=lead * 1.05,
                            textColor=ACCENT, spaceBefore=size * 0.45, spaceAfter=size * 0.05),
        "p": ParagraphStyle("p", fontName=FONT, fontSize=size, leading=lead, textColor=INK,
                            wordWrap="CJK"),
        "sub": ParagraphStyle("sub", fontName=FONT, fontSize=size * 1.0, leading=lead,
                              textColor=INK, spaceBefore=size * 0.4),
        "row": ParagraphStyle("row", fontName=FONT, fontSize=size, leading=size * 1.35,
                              textColor=INK, leftIndent=size * 0.9),
        "step": ParagraphStyle("step", fontName=FONT, fontSize=size, leading=lead, textColor=INK,
                               wordWrap="CJK", leftIndent=size * 1.3, firstLineIndent=-size * 1.3,
                               spaceBefore=size * 0.15),
    }


def build(items, size):
    st = styles(size)
    out = []
    for it in items:
        kind = it[0]
        if kind == "h":
            out.append(Paragraph(B + it[1], st["h"]))
        elif kind == "step":
            out.append(Paragraph(f"{it[1]} {it[2]}", st["step"]))
        elif kind == "row":
            out.append(Paragraph(f"・{it[1]}:{it[2]}", st["row"]))
        else:
            s = st[kind]
            if kind == "p":
                s = ParagraphStyle("pi", parent=s, leftIndent=size * 0.5)
            out.append(Paragraph(it[1], s))
    return out


def flow_height(paras, width):
    h = 0
    for i, p in enumerate(paras):
        _, ph = p.wrap(width, 10_000)
        h += ph + (p.style.spaceBefore if i else 0) + p.style.spaceAfter
    return h


def fit_size(items, width, height, hi=12.0, lo=6.0):
    size = hi
    while size > lo:
        if flow_height(build(items, size), width) <= height:
            return size
        size -= 0.1
    return lo


def draw_flow(c, paras, x, y_top, width):
    y = y_top
    for i, p in enumerate(paras):
        if i:
            y -= p.style.spaceBefore
        _, ph = p.wrap(width, 10_000)
        p.drawOn(c, x, y - ph)
        y -= ph + p.style.spaceAfter
    return y


def title_bar(c, x, y, w, text, size):
    h = size * 1.75
    c.setFillColor(ACCENT)
    c.roundRect(x, y - h, w, h, 3 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont(FONT, size)
    c.drawString(x + 4 * mm, y - h + (h - size) / 2 + size * 0.12, f"【{text}】")
    return h


def arrow(c, x, y, direction, s=5 * mm):
    c.setFillColor(INK)
    p = c.beginPath()
    if direction == "right":
        p.moveTo(x - s, y + s * 0.35); p.lineTo(x, y + s * 0.35); p.lineTo(x, y + s * 0.8)
        p.lineTo(x + s, y); p.lineTo(x, y - s * 0.8); p.lineTo(x, y - s * 0.35); p.lineTo(x - s, y - s * 0.35)
    elif direction == "left":
        p.moveTo(x + s, y + s * 0.35); p.lineTo(x, y + s * 0.35); p.lineTo(x, y + s * 0.8)
        p.lineTo(x - s, y); p.lineTo(x, y - s * 0.8); p.lineTo(x, y - s * 0.35); p.lineTo(x + s, y - s * 0.35)
    else:  # down
        p.moveTo(x - s * 0.35, y + s); p.lineTo(x - s * 0.35, y); p.lineTo(x - s * 0.8, y)
        p.lineTo(x, y - s); p.lineTo(x + s * 0.8, y); p.lineTo(x + s * 0.35, y); p.lineTo(x + s * 0.35, y + s)
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def header(c, x, y, w):
    """手書きで埋めるヘッダー。氏名・社員コードなどの個人情報は印字しない。"""
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    rows = [8 * mm, 8 * mm, 8 * mm]
    total = sum(rows)
    c.rect(x, y - total, w, total)
    lab_w = 38 * mm
    col2 = x + lab_w + (w - lab_w) * 0.5
    yy = y
    for r in rows[:-1]:
        yy -= r
        c.line(x, yy, x + w, yy)
    c.line(x + lab_w, y, x + lab_w, y - total)
    c.line(col2, y - rows[0], col2, y - total)
    c.setFillColor(HEAD_BG)
    c.rect(x, y - total, lab_w, total, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont(FONT, 10)
    labels = ["テーマ", "勤務箇所", "参加者氏名・社員コード"]
    yy = y
    for lab, r in zip(labels, rows):
        c.drawString(x + 2.5 * mm, yy - r / 2 - 3.5, lab)
        yy -= r
    c.rect(x, y - total, w, total)
    c.line(x + lab_w, y, x + lab_w, y - total)
    c.setFont(FONT, 11)
    c.drawString(x + lab_w + 3 * mm, y - rows[0] / 2 - 4, "勤務入力アプリ「shiftflow」による勤務管理の統一と入力ミスの防止")
    c.setFont(FONT, 10)
    r2 = y - rows[0] - rows[1] / 2 - 3.5
    c.drawString(x + lab_w + 3 * mm, r2, "(")
    c.drawString(col2 - 6 * mm, r2, ")")
    c.drawString(col2 + 3 * mm, r2, "参加人数(")
    c.drawString(x + w - 12 * mm, r2, "人)")
    r3 = y - rows[0] - rows[1] - rows[2] / 2 - 3.5
    c.drawString(x + lab_w + 3 * mm, r3, "氏名:")
    c.drawString(col2 + 3 * mm, r3, "社員コード:")
    c.setFont(FONT, 7.5)
    c.drawRightString(x + w, y - total - 3.6 * mm,
                      "※参加者多数の場合は適宜枠の追加、又は別紙等添付してください。")
    return total + 4.5 * mm


def qr_block(c, x, y, w, h):
    """効果の箱の下に置く、新規登録の案内。"""
    q = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_M)
    q.add_data(APP_URL)
    q.make(fit=True)
    img = q.make_image(fill_color="black", back_color="white").get_image()
    side = h
    c.drawImage(ImageReader(img), x, y - side, side, side)
    tx = x + side + 4 * mm
    c.setFillColor(INK)
    c.setFont(FONT, 12)
    c.drawString(tx, y - 6 * mm, "新規登録用 共通パスワード")
    if PASSWORD:
        c.setFont(FONT, 20)
        c.drawString(tx, y - 15 * mm, PASSWORD)
    else:
        c.setStrokeColor(INK)
        c.setLineWidth(0.6)
        c.rect(tx, y - 17 * mm, w - side - 6 * mm, 9 * mm)
    c.setFont(FONT, 7.8)
    st = ParagraphStyle("n", fontName=FONT, fontSize=7.8, leading=10.5, textColor=INK, wordWrap="CJK")
    note = Paragraph("※PINはログインのたびに使う、各自が決める4桁の番号です。共通パスワードは新規登録のときだけ使います。", st)
    _, nh = note.wrap(w - side - 4 * mm, 100)
    note.drawOn(c, tx, y - 19 * mm - nh)


def main():
    c = canvas.Canvas(OUT, pagesize=A4, initialFontName=FONT, initialFontSize=10)
    c.setTitle("改善提案書 shiftflow")
    c.setAuthor("")
    c.setSubject("勤務入力アプリ shiftflow")
    PW, PH = A4
    m = 9 * mm
    x0, w = m, PW - 2 * m
    y = PH - m

    y -= header(c, x0, y, w) + 2 * mm

    gap_x, gap_y = 8 * mm, 8 * mm
    bw = (w - gap_x) / 2
    qr_h = 27 * mm
    bh = (y - m - gap_y) / 2
    pad = 2.8 * mm
    tsize = 13

    boxes = {
        "genjo": (x0, y),
        "sokui": (x0 + bw + gap_x, y),
        "koka": (x0, y - bh - gap_y),
        "kaizen": (x0 + bw + gap_x, y - bh - gap_y),
    }
    # 4つの箱で同じ文字の大きさにする(いちばん窮屈な箱に合わせる)
    inner_w = bw - 2 * pad
    title_h = tsize * 1.75
    sizes = []
    for key, (bx, by) in boxes.items():
        avail = bh - 2 * pad - title_h - 2 * mm
        if key == "koka":
            avail -= qr_h + 3 * mm
        sizes.append(fit_size(SECTIONS[key][1], inner_w, avail))
    size = min(sizes)

    for key, (bx, by) in boxes.items():
        title, items = SECTIONS[key]
        c.setStrokeColor(INK)
        c.setLineWidth(1.4)
        c.roundRect(bx, by - bh, bw, bh, 5 * mm, stroke=1, fill=0)
        th = title_bar(c, bx + pad, by - pad, bw - 2 * pad, title, tsize)
        draw_flow(c, build(items, size), bx + pad, by - pad - th - 1 * mm, inner_w)
        if key == "koka":
            qr_block(c, bx + pad + 1 * mm, by - bh + pad + qr_h, inner_w - 2 * mm, qr_h)

    # 矢印: 現状 → 創意 ↓ 改善 → 効果(左向き)
    mid_x = x0 + bw + gap_x / 2
    arrow(c, mid_x, y - bh / 2, "right", 4 * mm)
    arrow(c, x0 + bw + gap_x + bw / 2, y - bh - gap_y / 2, "down", 4 * mm)
    arrow(c, mid_x, y - bh - gap_y - bh / 2, "left", 4 * mm)

    c.showPage()
    c.save()
    print(f"{OUT}  本文 {size:.1f}pt")


if __name__ == "__main__":
    main()
