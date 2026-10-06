import sys
sys.path.insert(0, ".")
sys.argv = [sys.argv[0], "."]
from draw import *
from v2 import radio, warn
ADDR = "shiftflow.kinmu@gmail.com"

def dash_tabs(p, W, active):
    p.rect(0, 0, W, 44, fill="#fff"); p.line(0, 44, W, 44)
    x = 16
    for t in ("概要", "利用者", "マスタ表", "マスタ登録", "お問い合わせ", "お知らせ", "設定"):
        w = p.tw(t, 15) + 24; act = t == active
        if act: p.line(x, 43, x + w, 43, C["accent"], 3)
        if t == "お問い合わせ":
            p.d.ellipse([(x+w-12)*S, 6*S, (x+w+6)*S, 24*S], fill=C["danger"]); p.text(x+w-3, 15, "3", 11, "#fff", anchor="mm")
        p.text(x + w/2, 22, t, 15, C["accent"] if act else C["muted"], bold=act, anchor="mm"); x += w + 4

def bubble(p, x, y, w, who, when, via, body, mine):
    lines = []
    cur = ""
    for para in body.split("\n"):
        cur = ""
        for ch in para:
            if p.tw(cur + ch, 14) > w - 28: lines.append(cur); cur = ch
            else: cur += ch
        lines.append(cur)
    h = 40 + len(lines) * 22
    bx = x + (60 if mine else 0); bw = w - 60
    p.rect(bx, y, bw, h, fill="#e8f0fe" if mine else "#f1f3f4", r=10)
    p.text(bx + 12, y + 16, f"{who} ・ {when}", 12, C["accent"] if mine else C["text"], bold=True, anchor="lm")
    vw = p.tw(via, 11) + 14
    col = {"画面": "#5f6368", "メール受信": "#e37400", "メール送信": C["ok"]}[via]
    p.rect(bx + bw - vw - 10, y + 7, vw, 18, fill=col, r=9); p.text(bx + bw - 10 - vw/2, y + 16, via, 11, "#fff", anchor="mm")
    for i, l in enumerate(lines):
        p.text(bx + 12, y + 40 + i * 22, l, 14, anchor="lm")
    return y + h + 12

def admin_thread():
    W = 1000; p = Page(W, 820)
    dash_tabs(p, W, "お問い合わせ")
    # left list
    p.rect(16, 64, 330, 740, fill="#fff", outline=C["line"], r=8)
    p.text(30, 88, "お問い合わせ", 16, bold=True, anchor="lm")
    fx = 30
    for f, a in (("要対応", True), ("返信済み", False), ("すべて", False), ("受信メール", False)):
        fw = p.tw(f, 12) + 16
        p.rect(fx, 106, fw, 22, fill=C["accent"] if a else "#fff", outline=C["accent"] if a else C["inp"], r=11)
        p.text(fx + fw/2, 117, f, 12, "#fff" if a else C["text"], anchor="mm"); fx += fw + 6
    p.callout(fx - 30, 104, 4, "どの問い合わせにも当てはまらないメール", left=False) if False else None
    rows = [("新着メール", "#e37400", "#0012 ・ ログインできない", "1234567 山田 太郎", "メールで返信が来ました", True),
            ("未対応", C["danger"], "#0013 ・ 不具合", "7654321 佐藤 花子", "画面で見る", False),
            ("未対応", C["danger"], "#0014 ・ 使い方・質問", "1111111 鈴木 一郎", "メール", False)]
    y = 140
    for st, col, title, who, sub, sel in rows:
        p.rect(24, y, 314, 78, fill="#e8f0fe" if sel else "#fff", outline=C["line"], r=6)
        sw = p.tw(st, 11) + 14
        p.rect(34, y + 10, sw, 18, fill=col, r=3); p.text(34 + sw/2, y + 19, st, 11, "#fff", anchor="mm")
        p.text(40 + sw, y + 19, title, 13, bold=True, anchor="lm")
        p.text(34, y + 42, who, 13, anchor="lm"); p.text(34, y + 62, sub, 11, C["muted"], anchor="lm")
        y += 86
    p.callout(330, 232, 1, "メールが来たら一番上に", left=True)
    # right thread
    X = 362; Wd = W - X - 16
    p.rect(X, 64, Wd, 740, fill="#fff", outline=C["line"], r=8)
    p.text(X + 16, 88, "#0012 ログインできない", 17, bold=True, anchor="lm")
    p.text(X + 16, 114, "1234567 山田 太郎 ・ 〇〇区所 ・ ログイン前 ・ 返事: メール(taro.yamada@gmail.com)", 12, C["muted"], anchor="lm")
    y = 136
    y = bubble(p, X + 16, y, Wd - 32, "山田 太郎", "10/06 08:12", "画面", "PINを忘れてしまいました。再設定をお願いします。", False)
    y = bubble(p, X + 16, y, Wd - 32, "管理者", "10/06 09:30", "メール送信", "PINを仮のものに変えました。仮のPINは職場で直接お伝えします。", True)
    top = y
    y = bubble(p, X + 16, y, Wd - 32, "taro.yamada@gmail.com", "10/06 12:05", "メール受信", "ありがとうございます。明日の朝、事務所に行きます。\n(引用部分は自動で省いて表示。全文を見るボタンあり)", False)
    p.highlight(X + 16, top, Wd - 92, y - top - 12); p.callout(X + Wd - 92, y - 12, 2, "メールの返信がここに入る", left=True)
    p.text(X + 16, y + 6, "返事", 15, bold=True, anchor="lm")
    p.rect(X + 16, y + 22, Wd - 32, 90, fill="#fff", outline=C["inp"], r=6)
    p.text(X + 26, y + 40, "お待ちしています。", 14, anchor="lm")
    p.text(X + 16, y + 128, f"送り方: ● メール(同じスレッドに返信)  ○ 画面だけ   送信元: shiftflow 勤務登録 <{ADDR}>", 12, C["muted"], anchor="lm")
    bx = X + 16; by = y + 146
    for lab, prim in (("返事を送る", True), ("対応済みにする", False), ("Gmailで開く", False)):
        bw = p.tw(lab, 14) + 28
        p.rect(bx, by, bw, 38, fill=C["accent"] if prim else "#fff", outline=C["accent"] if prim else C["inp"], r=6)
        p.text(bx + bw/2, by + 19, lab, 14, "#fff" if prim else C["text"], anchor="mm"); bx += bw + 8
    p.callout(X + 470, by + 19, 3, "最悪ここから返信できる")
    p.save("v3/4_admin_thread.png")

def member_form():
    W = 390; p = Page(W, 900)
    topbar(p, ["勤務入力", "設定", "お知らせ", "お問い合わせ", "使い方", "ログアウト"], "お問い合わせ", rows=2, px=13)
    p.text(12, 92, "お問い合わせ", 21, bold=True)
    x, w = 12, W - 24; cy = 126
    p.rect(x, cy, w, 750, fill="#fff", outline=C["line"], r=8)
    ix, iw = 26, W - 52
    p.rect(ix, cy + 14, iw, 92, fill="#f1f3f4", r=6)
    for i, (k, v) in enumerate((("社員番号", "1234567"), ("名前", "山田 太郎"), ("所属", "〇〇区所"))):
        p.text(ix + 12, cy + 32 + i * 26, k, 13, C["muted"], anchor="lm"); p.text(ix + 90, cy + 32 + i * 26, v, 15, anchor="lm")
    y = select(p, ix, cy + 118, iw, "種類", "使い方・質問")
    p.text(ix, y, "内容", 15, bold=True)
    p.rect(ix, y + 26, iw, 80, fill="#fff", outline=C["inp"], r=6)
    y += 26 + 80 + 18
    top = y
    p.text(ix, y, "返事の受け取り方", 15, bold=True); y += 30
    radio(p, ix + 4, y, "この画面で見る", False, "下の「これまでのお問い合わせ」に出ます"); y += 52
    radio(p, ix + 4, y, "メールでも受け取る", True, "画面にも残ります"); y += 46
    y = field(p, ix + 26, y, iw - 26, "メールアドレス", "taro.yamada@gmail.com")
    y = field(p, ix + 26, y - 4, iw - 26, "もう一度(確認)", "taro.yamada@gmail.com")
    y = warn(p, ix + 26, y, iw - 26, ["迷惑メールに入ることがあります。", f"{ADDR}", "から届きます。受け取れるようにしてください。"])
    p.highlight(ix - 2, top - 4, iw + 4, y - top + 8); p.callout(ix + iw - 4, top - 2, 1, "ログイン後も選べる", left=True)
    button(p, ix, y + 18, iw, "送信する")
    p.save("v3/3_member_form.png")

def mail():
    W = 390; p = Page(W, 640, bg="#ffffff")
    p.rect(0, 0, W, 48, fill="#f6f8fc"); p.line(0, 48, W, 48)
    p.text(12, 24, "← 受信トレイ", 14, C["muted"], anchor="lm")
    p.wrap(16, 62, "【shiftflow 勤務登録】お問い合わせ #0012 への返事", W - 32, 17, bold=True)
    p.d.ellipse([16*S, 128*S, 52*S, 164*S], fill="#1a73e8"); p.text(34, 146, "S", 16, "#fff", True, anchor="mm")
    p.text(62, 136, "shiftflow 勤務登録", 14, bold=True, anchor="lm")
    p.text(62, 156, ADDR, 12, C["muted"], anchor="lm")
    body = ("山田 太郎 様\n\nshiftflow(勤務登録アプリ)の管理者です。\nお問い合わせありがとうございます。\n\n"
            "PINを仮のものに変えました。仮のPINは職場で直接お伝えします。\n\n"
            "――――――\nお問い合わせ #0012(10/06 08:12)\n種類: ログインできない\n> PINを忘れてしまいました。\n――――――\n"
            "このメールに返信していただいても届きます。\n心当たりがないときは、このメールは消してください。")
    p.wrap(16, 184, body, W - 32, 14, lh=1.55)
    p.save("v3/7_mail.png")

admin_thread(); member_form(); mail()
