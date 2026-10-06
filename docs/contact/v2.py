import sys
import sys
sys.path.insert(0, ".")
sys.argv = [sys.argv[0], sys.argv[1]]
from draw import *

def radio(p, x, y, label, on, sub=None):
    p.d.ellipse([(x)*S, (y)*S, (x+18)*S, (y+18)*S], outline=C["accent"] if on else C["inp"], width=2*S)
    if on: p.d.ellipse([(x+5)*S, (y+5)*S, (x+13)*S, (y+13)*S], fill=C["accent"])
    p.text(x + 26, y + 9, label, 15, bold=on, anchor="lm")
    if sub: p.text(x + 26, y + 30, sub, 12, C["muted"], anchor="lm")

def warn(p, x, y, w, lines):
    h = 16 + len(lines) * 21
    p.rect(x, y, w, h, fill=C["nbg"], outline=C["nline"], r=6)
    emoji(p.img, "⚠️", x + 8, y + 8, 14)
    for i, l in enumerate(lines):
        p.text(x + 28 if i == 0 else x + 28, y + 16 + i * 21, l, 12, "#6b5200", anchor="lm")
    return y + h

# ---- 2. 問い合わせ(ログイン前) 返事の受け取り方を選ぶ ----
def guest():
    W = 390; p = Page(W, 1170)
    topbar(p, ["ログイン", "お問い合わせ", "使い方"], "お問い合わせ")
    p.text(12, 66, "お問い合わせ", 21, bold=True)
    p.wrap(12, 100, "ログインできない・使い方がわからないときは、ここから送ってください。管理者に届きます。", W - 24, 13, C["muted"])
    x, w = 12, W - 24; cy = 150
    p.rect(x, cy, w, 990, fill="#fff", outline=C["line"], r=8)
    ix, iw = 26, W - 52
    y = field(p, ix, cy + 14, iw, "社員番号(7桁)", "1234567")
    y = field(p, ix, y, iw, "名前", "山田 太郎")
    y = select(p, ix, y, iw, "所属(区所)", "〇〇区所")
    y = select(p, ix, y, iw, "種類", "ログインできない")
    p.text(ix, y, "内容", 15, bold=True)
    p.rect(ix, y + 26, iw, 90, fill="#fff", outline=C["inp"], r=6)
    p.wrap(ix + 10, y + 34, "PINを忘れてしまいました。\n再設定をお願いします。", iw - 20, 15)
    y += 26 + 90 + 18
    # 返事の受け取り方
    top = y
    p.text(ix, y, "返事の受け取り方", 15, bold=True)
    y += 30
    radio(p, ix + 4, y, "この画面で見る", False, "受付番号と確認コードで見ます")
    y += 52
    radio(p, ix + 4, y, "メールで受け取る", True)
    y += 30
    p.rect(ix + 26, y, iw - 26, 1, fill=C["line"])
    y = field(p, ix + 26, y + 6, iw - 26, "メールアドレス", "taro.yamada@gmail.com")
    y = field(p, ix + 26, y - 4, iw - 26, "もう一度(確認)", "taro.yamada@gmail.com")
    y = warn(p, ix + 26, y, iw - 26, [
        "迷惑メールに入ることがあります。",
        "届かないときは迷惑メールフォルダを見てください。",
        "携帯会社のメール(docomo・au・SoftBank)は",
        "届かないことがあるので、Gmailなどがおすすめ。"])
    p.highlight(ix - 2, top - 4, iw + 4, y - top + 8)
    p.callout(ix + iw - 4, top - 2, 1, "選べる", left=True)
    p.callout(ix + iw - 4, y + 2, 2, "迷惑メールの注意", left=True)
    y = button(p, ix, y + 18, iw, "送信する")
    p.save("v2/2_contact_guest.png")

def sent():
    W = 390
    for kind in ("code", "mail"):
        p = Page(W, 470)
        topbar(p, ["ログイン", "お問い合わせ", "使い方"], "お問い合わせ")
        p.text(12, 66, "お問い合わせ", 21, bold=True)
        p.rect(12, 100, W - 24, 340, fill="#e6f4ea", outline="#b7dfc2", r=8)
        p.text(W/2, 130, "送信しました(受付番号 #0012)", 17, C["ok"], bold=True, anchor="mm")
        if kind == "code":
            p.wrap(28, 158, "返事は「返事を見る」から、下の番号で確認できます。この画面をスクリーンショットしておいてください。", W - 56, 14)
            p.text(W/2, 240, "受付番号", 13, C["muted"], anchor="mm"); p.text(W/2, 266, "#0012", 26, bold=True, anchor="mm")
            p.text(W/2, 304, "確認コード", 13, C["muted"], anchor="mm"); p.text(W/2, 330, "K7QM-4XPA", 26, bold=True, anchor="mm")
            p.text(W/2, 400, "返事を見る →", 15, C["accent"], anchor="mm")
            p.save("v2/2b_sent_code.png")
        else:
            p.wrap(28, 158, "返事は下のアドレスにメールで届きます。", W - 56, 14)
            p.rect(28, 186, W - 56, 40, fill="#fff", r=6)
            p.text(W/2, 206, "taro.yamada@gmail.com", 16, bold=True, anchor="mm")
            y = warn(p, 28, 238, W - 56, [
                "迷惑メールに入ることがあります。",
                "差出人「shiftflow 管理者」",
                "(xxxx@gmail.com)を受け取れるように",
                "しておいてください。",
                "数日たっても届かないときは、もう一度送ってください。"])
            p.highlight(28, 238, W - 56, y - 238); p.callout(W - 34, 236, 1, "ここにも注意", left=True)
            p.save("v2/2c_sent_mail.png")

# ---- 3. ログイン後: 上のタブにお知らせ ----
def member_nav():
    W = 390; p = Page(W, 560)
    pos = topbar(p, ["勤務入力", "設定", "お知らせ", "お問い合わせ", "使い方", "ログアウト"], "お知らせ", rows=2, px=13)
    bx, by, bw = pos["お知らせ"]
    p.d.ellipse([(bx+bw-1)*S, (by-12)*S, (bx+bw+7)*S, (by-4)*S], fill=C["danger"])
    p.highlight(bx - 2, by - 12, bw + 4, 24); p.callout(bx + 10, by - 30, 1, "上のタブに追加(新着は赤い点)")
    p.text(12, 92, "お知らせ", 21, bold=True)
    y = 126
    for lv, date, title, body, new in (
        ("重要", "10/10", "システムメンテナンスのお知らせ", "10/12(日) 2:00〜4:00 は登録できません。\n終わったあとは、いつもどおり使えます。", True),
        ("", "10/01", "11月のマスタを更新しました", "11月分から新しい時刻で登録されます。", False)):
        h = 106
        p.rect(12, y, W - 24, h, fill="#fff", outline=C["line"], r=8)
        tx = 26
        if lv:
            p.rect(tx, y + 14, 34, 18, fill=C["danger"], r=3); p.text(tx + 17, y + 23, lv, 11, "#fff", anchor="mm"); tx += 40
        p.text(tx, y + 23, date, 12, C["muted"], anchor="lm")
        if new: p.text(W - 26, y + 23, "NEW", 11, C["danger"], bold=True, anchor="rm")
        p.text(26, y + 46, title, 15, bold=True, anchor="lm")
        p.wrap(26, y + 60, body, W - 52, 13)
        y += h + 10
    p.wrap(12, y + 4, "勤務入力の画面には出しません(この画面で見られます)。", W - 24, 12, C["muted"])
    p.callout(W - 20, 126, 2, "表示中のお知らせを全部", left=True)
    p.save("v2/3_member_notices.png")

# ---- 4. 管理: メールで返事 ----
def admin_mail():
    W = 960; p = Page(W, 640)
    p.rect(0, 0, W, 44, fill="#fff"); p.line(0, 44, W, 44)
    x = 16
    for t in ("概要", "利用者", "マスタ表", "マスタ登録", "お問い合わせ", "お知らせ", "設定"):
        w = p.tw(t, 15) + 24; act = t == "お問い合わせ"
        if act:
            p.line(x, 43, x + w, 43, C["accent"], 3)
            p.d.ellipse([(x+w-12)*S, 6*S, (x+w+6)*S, 24*S], fill=C["danger"]); p.text(x+w-3, 15, "2", 11, "#fff", anchor="mm")
        p.text(x + w/2, 22, t, 15, C["accent"] if act else C["muted"], bold=act, anchor="mm"); x += w + 4
    X = 16; Wd = W - 32
    p.rect(X, 64, Wd, 560, fill="#fff", outline=C["line"], r=8)
    p.text(X + 16, 88, "#0012 ログインできない", 17, bold=True, anchor="lm")
    p.rect(X + 230, 78, 120, 20, fill=C["accent"], r=10); p.text(X + 290, 88, "返事: メール", 11, "#fff", anchor="mm")
    p.callout(X + 372, 88, 1, "本人が選んだ受け取り方")
    p.rect(X + 16, 108, Wd - 32, 30, fill=C["ibg"], outline=C["iline"], r=6)
    p.text(X + 26, 123, "ログイン前の問い合わせ(本人か未確認)。仮のPINは返事に書かず、直接伝えてください。", 12, C["danger"], anchor="lm")
    for i, (k, v) in enumerate((("社員番号", "1234567(登録あり:山田 太郎 / 〇〇区所)"), ("返事の送り先", "taro.yamada@gmail.com"), ("受付", "10/06 08:12 ・ Discordに通知済み"))):
        p.text(X + 16, 158 + i * 24, k, 12, C["muted"], anchor="lm"); p.text(X + 130, 158 + i * 24, v, 13, anchor="lm")
    p.rect(X + 16, 222, Wd - 32, 56, fill="#f8f9fa", r=6)
    p.wrap(X + 28, 230, "PINを忘れてしまいました。再設定をお願いします。", Wd - 56, 14)
    p.text(X + 16, 300, "返事", 15, bold=True, anchor="lm")
    p.rect(X + 16, 314, Wd - 32, 110, fill="#fff", outline=C["inp"], r=6)
    p.wrap(X + 26, 324, "PINを仮のものに変えました。仮のPINは職場で直接お伝えします。", Wd - 52, 14)
    p.text(X + 16, 444, "送信元: shiftflow 管理者 <xxxx@gmail.com>(管理者のGmailから送ります)", 12, C["muted"], anchor="lm")
    bx = X + 16
    for lab, prim in (("メールで返事を送る", True), ("送る前に見本を見る", False), ("対応済みにする", False)):
        bw = p.tw(lab, 14) + 28
        p.rect(bx, 462, bw, 38, fill=C["accent"] if prim else "#fff", outline=C["accent"] if prim else C["inp"], r=6)
        p.text(bx + bw/2, 481, lab, 14, "#fff" if prim else C["text"], anchor="mm"); bx += bw + 8
    p.callout(X + 26, 462, 2)
    p.text(X + 16, 530, "送信の記録", 13, bold=True, anchor="lm")
    p.text(X + 16, 554, "10/06 09:30  taro.yamada@gmail.com に送りました", 12, C["ok"], anchor="lm")
    p.text(X + 16, 576, "(送れなかったときは赤で理由を出し、もう一度押せるようにする)", 12, C["muted"], anchor="lm")
    p.callout(X + 330, 554, 3, "送れたかどうかを残す")
    p.save("v2/4_admin_mail.png")

# ---- 7. 届くメールの見本 ----
def mail():
    W = 390; p = Page(W, 640, bg="#ffffff")
    p.rect(0, 0, W, 48, fill="#f6f8fc"); p.line(0, 48, W, 48)
    p.text(12, 24, "← 受信トレイ", 14, C["muted"], anchor="lm")
    p.wrap(16, 64, "【shiftflow】お問い合わせ #0012 への返事", W - 32, 18, bold=True)
    p.d.ellipse([16*S, 120*S, 52*S, 156*S], fill="#1a73e8"); p.text(34, 138, "S", 16, "#fff", True, anchor="mm")
    p.text(62, 128, "shiftflow 管理者", 14, bold=True, anchor="lm")
    p.text(62, 148, "To 自分 ・ 10/06 09:30", 12, C["muted"], anchor="lm")
    body = ("山田 太郎 様\n\nお問い合わせありがとうございます。\n\n"
            "PINを仮のものに変えました。仮のPINは職場で直接お伝えします。\n\n"
            "――――――\nお問い合わせ #0012(10/06 08:12)\n種類: ログインできない\n> PINを忘れてしまいました。\n> 再設定をお願いします。\n――――――\n"
            "続けて聞きたいことは、shiftflow の「お問い合わせ」から送ってください。\n※このメールは送信専用です。")
    p.wrap(16, 176, body, W - 32, 14, lh=1.55)
    p.save("v2/7_mail.png")

guest(); sent(); member_nav(); admin_mail(); mail()
