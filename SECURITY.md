# Security

初期開発版で、まだ公開窓口はありません。公開時に非公開の報告経路を設定します。

ページから得たURL・文字列は信頼しません。UIはtextContentで表示し、画像・動画URLのschemeを制限します。拡張外からのメッセージ受信・remote script・eval・保護機構回避は実装しません。

不具合は合成URL・合成メディアで再現してください。署名付きURL、Cookie、トークン、ブラウザプロファイル、私的な録画を報告へ添付しないでください。公開Issueでの機密情報報告は避けてください。

Chromeのdownload完了は、ファイルの安全性やメディアとしての正しさの保証ではありません。

未信頼のメディアはbyte量に加えて構造数を制限し、範囲検査で過去全件の繰返し走査を行いません。重いbinary検査・mux/remuxは同梱Workerで行い、停止・失敗・timeoutで終了します。Workerは同じ拡張の権限主体であり、独立した権限sandboxではありません。

回帰確認は `npm test`、`npm run check`、隔離Chromeの `test:browser` / `test:embedded` / `test:security` / `test:worker` と、実時間30分の `test:endurance` を使います。native picker・実OS権限・実音声は別に確認します。実測と残件は `docs/SECURITY-VALIDATION-2026-10-31.md` を参照してください。
