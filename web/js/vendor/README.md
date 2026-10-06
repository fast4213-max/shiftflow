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
