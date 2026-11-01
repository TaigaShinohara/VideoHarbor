# Contributing

現在はローカル開発段階です。公開リポジトリ・Issue窓口はまだありません。

1. READMEとdocs/DESIGN.mdで対象と非対応を確認します。
2. 実行時の依存を追加せず、Manifest V3のローカルモジュールで実装します。
3. `npm test` と `npm run check` を実行し、必要な変更は `npm run test:browser` とdocs/QA.mdの該当場面で検証します。
4. 権限追加・保存規則・録画方式を変える場合は、必要性と初回・反復時への影響、失敗からの復帰を説明してください。

開発上の連絡先は **deeple+videoharborstaff@inkboxmail.com** です。セキュリティの報告方法はSECURITY.mdを参照してください。受信確認・応答時間は未検証です。

ログイン情報・署名付きURL・私的なメディア・ブラウザプロファイルはコミットや報告へ含めないでください。合成fixtureを使います。
