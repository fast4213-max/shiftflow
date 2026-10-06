# 見本画像を作るスクリプト(Pillow)。docs/contact/ で python3 draw.py . / python3 v2.py / python3 v3.py
# (v2・v3 は出力先に v2/・v3/ のフォルダを作っておく)
from PIL import Image, ImageDraw, ImageFont
import sys, os
OUT = sys.argv[1]
FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf"
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
S = 2  # 2x like the manual screenshots
def F(px): return ImageFont.truetype(FONT, px * S)
_emoji = ImageFont.truetype(EMOJI, 109)
def emoji(img, ch, x, y, px):
    t = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
    ImageDraw.Draw(t).text((0, 0), ch, font=_emoji, embedded_color=True)
    t = t.crop(t.getbbox()).resize((px * S, px * S), Image.LANCZOS)
    img.paste(t, (x * S, y * S), t)

C = dict(text="#222222", muted="#666666", line="#dddddd", bg="#f5f5f5", card="#ffffff", accent="#1a73e8",
         danger="#c62828", ok="#2e7d32", tabbg="#eceff3", inp="#bbbbbb",
         nbg="#fff8e1", nline="#f2d27a", ibg="#fdecea", iline="#f1b0aa", red="#e53935")

class Page:
    def __init__(self, w, h, bg=C["bg"]):
        self.w, self.h = w, h
        self.img = Image.new("RGB", (w * S, h * S), bg)
        self.d = ImageDraw.Draw(self.img)
    def rect(self, x, y, w, h, fill=None, outline=None, r=0, width=1):
        self.d.rounded_rectangle([x*S, y*S, (x+w)*S, (y+h)*S], radius=r*S, fill=fill, outline=outline, width=width*S)
    def text(self, x, y, s, px=16, color=C["text"], bold=False, anchor="la"):
        self.d.text((x*S, y*S), s, font=F(px), fill=color, anchor=anchor, stroke_width=(1 if bold else 0), stroke_fill=color)
    def tw(self, s, px=16): return self.d.textlength(s, font=F(px)) / S
    def line(self, x1, y1, x2, y2, color=C["line"], width=1):
        self.d.line([x1*S, y1*S, x2*S, y2*S], fill=color, width=width*S)
    def wrap(self, x, y, s, maxw, px=14, color=C["text"], lh=1.6, bold=False):
        lines, cur = [], ""
        for para in s.split("\n"):
            cur = ""
            for ch in para:
                if self.tw(cur + ch, px) > maxw: lines.append(cur); cur = ch
                else: cur += ch
            lines.append(cur)
        for i, l in enumerate(lines):
            self.text(x, y + i * px * lh, l, px, color, bold)
        return y + len(lines) * px * lh
    def callout(self, x, y, n, label=None, left=False):
        self.d.ellipse([(x-13)*S, (y-13)*S, (x+13)*S, (y+13)*S], fill=C["red"])
        self.text(x, y, str(n), 15, "#fff", True, anchor="mm")
        if label:
            w = self.tw(label, 12) + 12
            lx = x - 16 - w if left else x + 16
            self.rect(lx, y - 11, w, 22, fill=C["red"], r=4)
            self.text(lx + 6, y, label, 12, "#fff", anchor="lm")
    def highlight(self, x, y, w, h):
        self.rect(x - 3, y - 3, w + 6, h + 6, outline=C["red"], r=8, width=3)
    def save(self, name): self.img.save(os.path.join(OUT, name))

def topbar(p, links, current, rows=1, px=14):
    h = 36 if rows == 1 else 60
    p.rect(0, 0, p.w, h, fill="#fff"); p.line(0, h, p.w, h)
    p.text(12, 18, "shiftflow", 15, bold=True, anchor="lm")
    x = p.w - 12; ly = 18 if rows == 1 else 44
    pos = {}
    for label in reversed(links):
        w = p.tw(label, px)
        p.text(x - w, ly, label, px, C["text"] if label == current else C["accent"], bold=(label == current), anchor="lm")
        pos[label] = (x - w, ly, w)
        x -= w + (14 if px == 14 else 10)
    return pos

def field(p, x, y, w, label, value="", placeholder="", readonly=False, h=40):
    p.text(x, y, label, 15, bold=True)
    y += 26
    p.rect(x, y, w, h, fill=("#f1f3f4" if readonly else "#fff"), outline=C["inp"], r=6)
    if value: p.text(x + 10, y + h/2, value, 16, C["muted"] if readonly else C["text"], anchor="lm")
    elif placeholder: p.text(x + 10, y + h/2 if h == 40 else y + 18, placeholder, 15, "#9aa0a6", anchor="lm")
    return y + h + 10

def select(p, x, y, w, label, value):
    y2 = field(p, x, y, w, label, value)
    p.d.polygon([((x+w-22)*S, (y+26+17)*S), ((x+w-12)*S, (y+26+17)*S), ((x+w-17)*S, (y+26+24)*S)], fill=C["muted"])
    return y2

def button(p, x, y, w, label, h=46, primary=True):
    p.rect(x, y, w, h, fill=C["accent"] if primary else "#fff", outline=C["accent"] if primary else C["inp"], r=6)
    p.text(x + w/2, y + h/2, label, 17, "#fff" if primary else C["text"], anchor="mm")
    return y + h

def notice(p, x, y, w, items):
    """items: list of (level, date, title, body)"""
    top = y
    # 高さを先に計算するため一旦描く位置を決める
    h = 34
    rows = []
    for lv, date, title, body in items:
        rh = 22 + (len(body) and 20)
        rows.append(rh); h += rh + 8
    p.rect(x, y, w, h, fill=C["nbg"], outline=C["nline"], r=8)
    emoji(p.img, "📢", x + 10, y + 8, 18)
    p.text(x + 34, y + 17, "お知らせ", 15, "#8a6d00", bold=True, anchor="lm")
    y += 34
    for (lv, date, title, body), rh in zip(items, rows):
        p.line(x + 10, y, x + w - 10, y, C["nline"])
        y += 6
        tx = x + 12
        if lv == "重要":
            p.rect(tx, y + 1, 34, 18, fill=C["danger"], r=3)
            p.text(tx + 17, y + 10, "重要", 11, "#fff", anchor="mm"); tx += 40
        p.text(tx, y + 10, date, 12, C["muted"], anchor="lm"); tx += p.tw(date, 12) + 8
        p.text(tx, y + 10, title, 14, bold=True, anchor="lm")
        if body: p.text(x + 12, y + 30, body, 13, C["text"], anchor="lm")
        y += rh + 2
    return top + h

# ---------- 1. ログイン画面 ----------
def login():
    W = 390; p = Page(W, 770)
    pos = topbar(p, ["ログイン", "お問い合わせ", "使い方"], "ログイン")
    # アイコン
    p.rect(W/2 - 32, 60, 64, 64, fill=C["accent"], r=14)
    p.rect(W/2 - 20, 76, 40, 36, fill="#fff", r=4); p.rect(W/2 - 20, 76, 40, 9, fill="#d2e3fc", r=4)
    p.d.line([((W/2-10)*S, 95*S), ((W/2-3)*S, 102*S), ((W/2+11)*S, 88*S)], fill=C["accent"], width=4*S)
    p.text(W/2, 150, "勤務登録", 24, bold=True, anchor="mm")
    p.text(W/2, 185, "勤務を入力して、Googleカレンダーに登録します。", 13, C["muted"], anchor="mm")
    # タブ
    x0, tw, y = 12, W - 24, 210
    p.rect(x0, y, tw, 520, fill="#fff", outline=C["line"], r=8)
    p.rect(x0 + tw/2, y, tw/2, 46, fill=C["tabbg"], outline=C["line"], r=8)
    p.rect(x0 + tw/2, y + 30, tw/2, 16, fill=C["tabbg"])
    p.line(x0 + tw/2, y + 46, x0 + tw, y + 46)
    p.text(x0 + tw/4, y + 23, "利用者", 16, bold=True, anchor="mm")
    p.text(x0 + tw*3/4, y + 23, "管理", 16, C["muted"], anchor="mm")
    # お知らせ(タブと入力の間)
    ix, iw = 26, W - 52
    ny = y + 60
    nb = notice(p, ix, ny, iw, [
        ("重要", "10/10", "システムメンテナンスのお知らせ", "10/12(日) 2:00〜4:00 は登録できません"),
        ("", "10/01", "11月のマスタを更新しました", ""),
    ])
    p.highlight(ix, ny, iw, nb - ny); p.callout(ix + 2, ny - 2, 1, "お知らせ(管理画面から出す)")
    yy = field(p, ix, nb + 14, iw, "社員番号(7桁)", "", "1234567")
    yy = field(p, ix, yy, iw, "PIN(4桁の数字)", "••••")
    yy = button(p, ix, yy + 6, iw, "ログイン")
    # リンク
    t1a, t1b, t1c, t1d = "はじめての方は ", "新規登録", " ・ ", "使い方"
    w1 = sum(p.tw(s, 14) for s in (t1a, t1b, t1c, t1d)); x = W/2 - w1/2; ly = yy + 30
    for s, c in ((t1a, C["muted"]), (t1b, C["accent"]), (t1c, C["muted"]), (t1d, C["accent"])):
        p.text(x, ly, s, 14, c, anchor="lm"); x += p.tw(s, 14)
    t2a, t2b = "ログインできないときは ", "お問い合わせ"
    w2 = p.tw(t2a, 14) + p.tw(t2b, 14); x = W/2 - w2/2; ly2 = ly + 28
    p.text(x, ly2, t2a, 14, C["muted"], anchor="lm"); p.text(x + p.tw(t2a, 14), ly2, t2b, 14, C["accent"], anchor="lm")
    p.highlight(x - 4, ly2 - 13, w2 + 8, 26); p.callout(x + w2 + 4, ly2 + 22, 2, "新しく追加", left=True)
    bx, by, bw = pos["お問い合わせ"]; p.highlight(bx - 2, by - 12, bw + 4, 24); p.callout(bx + bw/2, by + 30, 3, "上にも出す", left=True)
    p.save("1_login.png")

# ---------- 2. お問い合わせ(ログイン前) ----------
def contact_guest():
    W = 390; p = Page(W, 900)
    topbar(p, ["ログイン", "お問い合わせ", "使い方"], "お問い合わせ")
    p.text(12, 66, "お問い合わせ", 21, bold=True)
    p.wrap(12, 100, "ログインできない・使い方がわからないときは、ここから送ってください。管理者に届きます。", W - 24, 13, C["muted"])
    x, w = 12, W - 24; cy = 150
    p.rect(x, cy, w, 640, fill="#fff", outline=C["line"], r=8)
    ix, iw = 26, W - 52
    y = field(p, ix, cy + 14, iw, "社員番号(7桁)", "", "1234567")
    y = field(p, ix, y, iw, "名前", "", "山田 太郎")
    y = select(p, ix, y, iw, "所属(区所)", "選んでください")
    p.highlight(ix, cy + 14, iw, y - cy - 24); p.callout(ix + iw - 4, cy + 12, 1, "ログイン前は手で入力", left=True)
    y = select(p, ix, y, iw, "種類", "ログインできない")
    p.text(ix, y, "内容", 15, bold=True)
    p.rect(ix, y + 26, iw, 120, fill="#fff", outline=C["inp"], r=6)
    p.wrap(ix + 10, y + 34, "PINを忘れてしまいました。\n再設定をお願いします。", iw - 20, 15)
    p.text(ix + iw - 8, y + 26 + 120 - 14, "28 / 1000", 12, "#9aa0a6", anchor="rm")
    y += 26 + 120 + 10
    p.wrap(ix, y, "※ PINはここには書かないでください。", iw, 13, C["danger"])
    y = button(p, ix, y + 26, iw, "送信する")
    p.save("2_contact_guest.png")
    # 送信後
    p = Page(W, 520)
    topbar(p, ["ログイン", "お問い合わせ", "使い方"], "お問い合わせ")
    p.text(12, 66, "お問い合わせ", 21, bold=True)
    p.rect(12, 105, W - 24, 330, fill="#e6f4ea", outline="#b7dfc2", r=8)
    p.text(W/2, 140, "送信しました", 18, C["ok"], bold=True, anchor="mm")
    p.wrap(28, 170, "返事は「返事を見る」から、下の番号で確認できます。この画面をスクリーンショットしておいてください。", W - 56, 14)
    p.text(W/2, 250, "受付番号", 13, C["muted"], anchor="mm")
    p.text(W/2, 278, "#0012", 26, bold=True, anchor="mm")
    p.text(W/2, 318, "確認コード", 13, C["muted"], anchor="mm")
    p.text(W/2, 346, "K7QM-4XPA", 26, bold=True, anchor="mm")
    p.highlight(40, 236, W - 80, 128); p.callout(44, 234, 1, "返事を見るための番号")
    p.text(W/2, 400, "返事を見る →", 15, C["accent"], anchor="mm")
    p.save("2b_contact_sent.png")

# ---------- 3. お問い合わせ(ログイン後) ----------
def contact_member():
    W = 390; p = Page(W, 990)
    pos = topbar(p, ["勤務入力", "設定", "お問い合わせ", "使い方", "ログアウト"], "お問い合わせ", rows=2)
    bx, by, bw = pos["お問い合わせ"]; p.highlight(bx - 2, by - 12, bw + 4, 24); p.callout(bx - 6, by - 26, 1, "上のタブに追加", left=False)
    p.text(12, 92, "お問い合わせ", 21, bold=True)
    x, w = 12, W - 24; cy = 126
    p.rect(x, cy, w, 420, fill="#fff", outline=C["line"], r=8)
    ix, iw = 26, W - 52
    # 自動で入る欄(読み取り専用の表示)
    p.rect(ix, cy + 14, iw, 92, fill="#f1f3f4", r=6)
    for i, (k, v) in enumerate((("社員番号", "1234567"), ("名前", "山田 太郎"), ("所属", "〇〇区所"))):
        p.text(ix + 12, cy + 32 + i * 26, k, 13, C["muted"], anchor="lm")
        p.text(ix + 90, cy + 32 + i * 26, v, 15, anchor="lm")
    p.highlight(ix, cy + 14, iw, 92); p.callout(ix + iw - 4, cy + 12, 2, "ログイン情報から自動", left=True)
    y = select(p, ix, cy + 118, iw, "種類", "使い方・質問")
    p.text(ix, y, "内容", 15, bold=True)
    p.rect(ix, y + 26, iw, 110, fill="#fff", outline=C["inp"], r=6)
    p.text(ix + 10, y + 44, "内容を入力してください", 15, "#9aa0a6", anchor="lm")
    y = button(p, ix, y + 26 + 110 + 14, iw, "送信する")
    # 履歴
    y = cy + 420 + 30
    p.text(12, y, "これまでのお問い合わせ", 17, bold=True)
    y += 30
    p.rect(x, y, w, 196, fill="#fff", outline=C["line"], r=8)
    p.rect(x + 14, y + 14, 58, 20, fill=C["ok"], r=4); p.text(x + 43, y + 24, "返信あり", 11, "#fff", anchor="mm")
    p.text(x + 80, y + 24, "#0009 ・ 10/03 ・ 使い方・質問", 12, C["muted"], anchor="lm")
    p.wrap(x + 14, y + 44, "休日用カレンダーは必須ですか？", w - 28, 14)
    p.rect(x + 14, y + 74, w - 28, 86, fill="#e8f0fe", r=6)
    p.text(x + 24, y + 90, "管理者からの返事 ・ 10/04", 12, C["accent"], bold=True, anchor="lm")
    p.wrap(x + 24, y + 104, "休日用は空欄でも使えます。空欄のときは休日も勤務用カレンダーに入ります。", w - 48, 14)
    p.callout(x + w - 14, y + 74, 3, "返事はここに出る", left=True)
    p.save("3_contact_member.png")

# ---------- 4. 管理画面 ----------
def admin():
    W = 960; p = Page(W, 720)
    # dash tabs
    p.rect(0, 0, W, 44, fill="#fff"); p.line(0, 44, W, 44)
    x = 16
    for t in ("概要", "利用者", "マスタ表", "マスタ登録", "お問い合わせ", "お知らせ", "設定"):
        w = p.tw(t, 15) + 24
        act = t == "お問い合わせ"
        if act: p.line(x, 43, x + w, 43, C["accent"], 3)
        p.text(x + w/2, 22, t, 15, C["accent"] if act else C["muted"], bold=act, anchor="mm")
        if t == "お問い合わせ":
            p.d.ellipse([(x+w-12)*S, 6*S, (x+w+6)*S, 24*S], fill=C["danger"]); p.text(x+w-3, 15, "2", 11, "#fff", anchor="mm")
            p.callout(x + w/2 - 60, 60, 1, "未対応の件数", left=True)
        if t == "お知らせ": p.callout(x + w/2, 60, 4, "新しいタブ")
        x += w + 4
    # 左: 一覧
    p.rect(16, 80, 400, 620, fill="#fff", outline=C["line"], r=8)
    p.text(30, 104, "お問い合わせ", 16, bold=True, anchor="lm")
    fx = 150
    for f, a in (("未対応", True), ("返信済み", False), ("すべて", False)):
        fw = p.tw(f, 12) + 16
        p.rect(fx, 94, fw, 22, fill=C["accent"] if a else "#fff", outline=C["accent"] if a else C["inp"], r=11)
        p.text(fx + fw/2, 105, f, 12, "#fff" if a else C["text"], anchor="mm"); fx += fw + 6
    rows = [("#0012", "未対応", "ログインできない", "1234567 山田 太郎", "ログイン前", "10/06 08:12", True),
            ("#0011", "未対応", "不具合", "7654321 佐藤 花子", "ログイン済み", "10/05 21:40", False),
            ("#0010", "返信済み", "使い方・質問", "1111111 鈴木 一郎", "ログイン済み", "10/04 12:03", False)]
    y = 126
    for no, st, kind, who, how, at, sel in rows:
        p.rect(24, y, 384, 82, fill="#e8f0fe" if sel else "#fff", outline=C["line"], r=6)
        col = C["danger"] if st == "未対応" else C["ok"]
        p.rect(34, y + 10, 52, 18, fill=col, r=3); p.text(60, y + 19, st, 11, "#fff", anchor="mm")
        p.text(94, y + 19, f"{no} ・ {kind}", 13, bold=True, anchor="lm")
        p.text(398, y + 19, at, 11, C["muted"], anchor="rm")
        p.text(34, y + 44, who, 13, anchor="lm")
        p.text(34, y + 66, how, 11, C["muted"], anchor="lm")
        y += 90
    # 右: 詳細
    X = 432; Wd = W - X - 16
    p.rect(X, 80, Wd, 620, fill="#fff", outline=C["line"], r=8)
    p.text(X + 16, 104, "#0012 ログインできない", 17, bold=True, anchor="lm")
    p.rect(X + 16, 120, Wd - 32, 34, fill=C["ibg"], outline=C["iline"], r=6)
    p.text(X + 26, 137, "ログイン前の問い合わせ(本人か未確認)。仮のPINは返事に書かず、直接伝えてください。", 11, C["danger"], anchor="lm")
    p.callout(X + Wd - 20, 120, 2, "注意書き", left=True)
    for i, (k, v) in enumerate((("社員番号", "1234567(登録あり:山田 太郎 / 〇〇区所)"), ("入力された名前", "山田 太郎"), ("入力された所属", "〇〇区所"), ("受付", "10/06 08:12 ・ Discordに通知済み"))):
        p.text(X + 16, 176 + i * 24, k, 12, C["muted"], anchor="lm"); p.text(X + 130, 176 + i * 24, v, 13, anchor="lm")
    p.rect(X + 16, 278, Wd - 32, 80, fill="#f8f9fa", r=6)
    p.wrap(X + 28, 288, "PINを忘れてしまいました。\n再設定をお願いします。", Wd - 56, 14)
    p.text(X + 16, 380, "返事", 15, bold=True, anchor="lm")
    p.rect(X + 16, 394, Wd - 32, 130, fill="#fff", outline=C["inp"], r=6)
    p.wrap(X + 26, 404, "PINを仮のものに変えました。仮のPINは職場で直接お伝えします。", Wd - 52, 14)
    p.callout(X + Wd - 20, 394, 3, "管理画面から返事", left=True)
    bx = X + 16
    for lab, prim in (("返事を送る", True), ("対応済みにする", False), ("利用者タブでPIN再設定 →", False)):
        bw = p.tw(lab, 14) + 28
        p.rect(bx, 540, bw, 38, fill=C["accent"] if prim else "#fff", outline=C["accent"] if prim else C["inp"], r=6)
        p.text(bx + bw/2, 559, lab, 14, "#fff" if prim else C["text"], anchor="mm"); bx += bw + 8
    p.save("4_admin_contact.png")

    # お知らせタブ
    p = Page(W, 560)
    p.rect(0, 0, W, 44, fill="#fff"); p.line(0, 44, W, 44)
    x = 16
    for t in ("概要", "利用者", "マスタ表", "マスタ登録", "お問い合わせ", "お知らせ", "設定"):
        w = p.tw(t, 15) + 24; act = t == "お知らせ"
        if act: p.line(x, 43, x + w, 43, C["accent"], 3)
        p.text(x + w/2, 22, t, 15, C["accent"] if act else C["muted"], bold=act, anchor="mm"); x += w + 4
    p.rect(16, 64, 460, 470, fill="#fff", outline=C["line"], r=8)
    p.text(30, 86, "お知らせを出す", 16, bold=True, anchor="lm")
    y = field(p, 30, 104, 432, "タイトル", "システムメンテナンスのお知らせ")
    p.text(30, y, "本文(1行〜数行)", 15, bold=True)
    p.rect(30, y + 26, 432, 70, fill="#fff", outline=C["inp"], r=6)
    p.wrap(40, y + 34, "10/12(日) 2:00〜4:00 は登録できません", 412, 14)
    y += 108
    p.text(30, y, "重要度", 15, bold=True); p.text(200, y, "表示する期間", 15, bold=True)
    for i, (lab, on) in enumerate((("ふつう", False), ("重要(赤)", True))):
        cx = 36 + i * 76
        p.d.ellipse([(cx-7)*S, (y+38)*S, (cx+7)*S, (y+52)*S], outline=C["accent"], width=2*S)
        if on: p.d.ellipse([(cx-3)*S, (y+42)*S, (cx+3)*S, (y+48)*S], fill=C["accent"])
        p.text(cx + 12, y + 45, lab, 13, anchor="lm")
    p.rect(200, y + 30, 120, 30, fill="#fff", outline=C["inp"], r=6); p.text(210, y + 45, "2026/10/10", 13, anchor="lm")
    p.text(330, y + 45, "〜", 13, anchor="lm")
    p.rect(346, y + 30, 116, 30, fill="#fff", outline=C["inp"], r=6); p.text(356, y + 45, "2026/10/12", 13, anchor="lm")
    button(p, 30, y + 80, 432, "保存して公開", h=40)
    # 右: 一覧
    X = 492; Wd = W - X - 16
    p.rect(X, 64, Wd, 470, fill="#fff", outline=C["line"], r=8)
    p.text(X + 14, 86, "出ているお知らせ", 16, bold=True, anchor="lm")
    yy = 110
    for st, lv, title, period in (("表示中", "重要", "システムメンテナンスのお知らせ", "10/10〜10/12"),
                                  ("表示中", "", "11月のマスタを更新しました", "10/01〜10/31"),
                                  ("終了", "", "使い方ページを新しくしました", "09/20〜09/30")):
        p.rect(X + 12, yy, Wd - 24, 62, fill="#fff", outline=C["line"], r=6)
        col = C["ok"] if st == "表示中" else C["muted"]
        p.rect(X + 22, yy + 10, 46, 18, fill=col, r=3); p.text(X + 45, yy + 19, st, 11, "#fff", anchor="mm")
        if lv: p.rect(X + 74, yy + 10, 34, 18, fill=C["danger"], r=3); p.text(X + 91, yy + 19, lv, 11, "#fff", anchor="mm")
        p.text(X + (114 if lv else 76), yy + 19, title, 13, bold=True, anchor="lm")
        p.text(X + 22, yy + 44, period, 12, C["muted"], anchor="lm")
        p.text(X + Wd - 24, yy + 44, "編集 ・ 削除", 12, C["accent"], anchor="rm")
        yy += 70
    p.wrap(X + 14, yy + 6, "ログイン画面には「表示中」のものが新しい順に最大3件出ます。", Wd - 28, 12, C["muted"])
    p.save("5_admin_notice.png")

# ---------- 6. Discord 通知 ----------
def discord():
    W = 520; p = Page(W, 300, bg="#313338")
    p.d.ellipse([16*S, 16*S, 56*S, 56*S], fill="#5865f2"); emoji(p.img, "📩", 26, 26, 20)
    p.text(68, 26, "shiftflow お問い合わせ", 15, "#f2f3f5", bold=True, anchor="lm")
    p.rect(232, 18, 34, 16, fill="#5865f2", r=3); p.text(249, 26, "BOT", 10, "#fff", anchor="mm")
    p.text(274, 26, "今日 08:12", 11, "#949ba4", anchor="lm")
    p.rect(68, 44, 430, 236, fill="#2b2d31", r=4); p.rect(68, 44, 4, 236, fill="#f23f43")
    p.text(106, 64, "新しいお問い合わせ #0012", 15, "#00a8fc", bold=True, anchor="lm")
    emoji(p.img, "📩", 84, 55, 17)
    fields = (("種類", "ログインできない"), ("ログイン", "ログイン前(本人未確認)"), ("社員番号", "1234567"), ("名前", "山田 太郎"), ("所属", "〇〇区所"))
    for i, (k, v) in enumerate(fields):
        cx = 84 + (i % 3) * 140; cy = 92 + (i // 3) * 48
        p.text(cx, cy, k, 12, "#dbdee1", bold=True, anchor="lm"); p.text(cx, cy + 20, v, 13, "#dbdee1", anchor="lm")
    p.text(84, 196, "内容", 12, "#dbdee1", bold=True, anchor="lm")
    p.wrap(84, 208, "PINを忘れてしまいました。再設定をお願いします。", 400, 13, "#dbdee1")
    p.text(84, 260, "管理画面で返事をしてください ・ shiftflow", 11, "#949ba4", anchor="lm")
    p.save("6_discord.png")

if __name__ == "__main__":
    login(); contact_guest(); contact_member(); admin(); discord()
