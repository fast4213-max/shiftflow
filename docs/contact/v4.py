import sys
sys.path.insert(0, ".")
sys.argv = [sys.argv[0], "."]
from draw import *

def thumb(p, x, y, s, label, color):
    p.rect(x, y, s, s, fill=color, r=6)
    p.rect(x + 8, y + 10, s - 16, 10, fill="#ffffff", r=2)
    p.rect(x + 8, y + 26, s - 30, 8, fill="#ffffff", r=2)
    p.rect(x + 8, y + 40, s - 22, 8, fill="#ffffff", r=2)
    p.text(x + s/2, y + s - 12, label, 10, "#fff", anchor="mm")
    p.d.ellipse([(x+s-20)*S, (y-6)*S, (x+s+6)*S, (y+20)*S], fill="#5f6368")
    p.text(x + s - 7, y + 7, "×", 13, "#fff", True, anchor="mm")

def form():
    W = 390; p = Page(W, 560)
    topbar(p, ["ログイン", "お問い合わせ", "使い方"], "お問い合わせ")
    p.text(12, 66, "(社員番号・名前・所属・種類 は省略)", 12, C["muted"])
    x, w = 12, W - 24; cy = 86
    p.rect(x, cy, w, 450, fill="#fff", outline=C["line"], r=8)
    ix, iw = 26, W - 52
    p.text(ix, cy + 14, "内容", 15, bold=True)
    p.rect(ix, cy + 40, iw, 80, fill="#fff", outline=C["inp"], r=6)
    p.wrap(ix + 10, cy + 48, "ログインすると真っ白になります。\n画面の写真を付けます。", iw - 20, 14)
    y = cy + 136
    top = y
    p.text(ix, y, "画像(3枚まで・任意)", 15, bold=True)
    y += 30
    thumb(p, ix, y, 76, "1.2MB→0.3MB", "#7aa7e8")
    thumb(p, ix + 92, y, 76, "0.9MB→0.2MB", "#8cc59a")
    p.rect(ix + 184, y, 76, 76, fill="#fff", outline=C["inp"], r=6)
    p.text(ix + 222, y + 30, "＋", 24, C["accent"], anchor="mm"); p.text(ix + 222, y + 58, "追加", 12, C["accent"], anchor="mm")
    y += 92
    p.wrap(ix, y, "写真・スクリーンショット(JPEG・PNG)。送る前に小さくし、撮った場所などの情報は消します。", iw, 12, C["muted"])
    y += 44
    p.rect(ix, y, iw, 52, fill=C["ibg"], outline=C["iline"], r=6)
    p.wrap(ix + 10, y + 8, "PINや、ほかの人の名前・勤務が写った画像は送らないでください。", iw - 20, 12, C["danger"])
    y += 52
    p.highlight(ix - 2, top - 4, iw + 4, y - top + 8); p.callout(ix + iw - 4, top - 2, 1, "画像を付けられる", left=True)
    button(p, ix, y + 18, iw, "送信する")
    p.save("v4/8_contact_images.png")

def gmail():
    W = 520; p = Page(W, 430, bg="#ffffff")
    p.rect(0, 0, W, 44, fill="#f6f8fc"); p.line(0, 44, W, 44)
    p.text(14, 22, "受信トレイ  /  ラベル: shiftflow/受付", 13, C["muted"], anchor="lm")
    p.wrap(16, 58, "【shiftflow 受付】#0012 ログインできない(画像2枚)", W - 32, 16, bold=True)
    p.text(16, 100, "勤務登録shiftflow → 自分", 12, C["muted"], anchor="lm")
    body = "受付番号: #0012(10/06 08:12)\n社員番号: 1234567  名前: 山田 太郎  所属: 〇〇区所\nログイン前(本人か未確認) / 返事: メール\n\nログインすると真っ白になります。画面の写真を付けます。"
    p.wrap(16, 122, body, W - 32, 13, lh=1.55)
    y = 250
    for i, c in enumerate(("#7aa7e8", "#8cc59a")):
        x = 16 + i * 150
        p.rect(x, y, 136, 110, fill="#fff", outline=C["line"], r=8)
        p.rect(x + 1, y + 1, 134, 76, fill=c, r=8)
        p.text(x + 10, y + 94, f"0012-{i+1}.jpg", 12, anchor="lm")
    p.callout(W - 30, 250, 1, "画像はGmailで見る", left=True)
    p.save("v4/9_gmail_images.png")

form(); gmail()
