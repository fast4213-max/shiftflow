# vendor/

外部ライブラリを、CDN から借りずにここに置いています。

## supabase-js.2.117.2.min.js

`@supabase/supabase-js@2.117.2`(MIT)を、esbuild で 1 ファイルにまとめたものです。
`web/js/app.js` が読み込みます。

作り直す(版を上げる)手順:

```sh
mkdir build && cd build && npm init -y
npm i @supabase/supabase-js@<新しい版> esbuild
echo 'export { createClient } from "@supabase/supabase-js";' > entry.js
npx esbuild entry.js --bundle --format=esm --minify --platform=browser --target=es2020 --legal-comments=none --outfile=supabase-js.<新しい版>.min.js
```

できたファイルをここに置き、`app.js` の import を新しいファイル名に書き換え、古いファイルを消します。
Edge Functions(`supabase/functions`)の `npm:@supabase/supabase-js@…` も同じ版にそろえます。

## LICENSES.txt

上のファイルは、作るときにライセンスのコメントを消している(`--legal-comments=none`)ので、中に入っているライブラリのライセンスの原文(MIT・0BSD)を `LICENSES.txt` にまとめて一緒に配っています(MIT は「複製に著作権表示を含める」のが条件のため)。
版を上げたときは、作り直しと同じフォルダで、入っているパッケージを確かめて作り直します。

```sh
npx esbuild entry.js --bundle --format=esm --minify --platform=browser --target=es2020 --legal-comments=none --metafile=meta.json --outfile=/dev/null
node -e 'const m=require("./meta.json");const s=new Set();for(const k of Object.keys(m.inputs)){const x=k.match(/node_modules\/((@[^/]+\/)?[^/]+)/);if(x)s.add(x[1])}console.log([...s].join("\n"))'
```

出てきたパッケージごとに、`node_modules/<パッケージ>/LICENSE`(`LICENSE.md`・`LICENSE.txt` のこともある)の中身を、名前と版の見出しを付けて並べます。
