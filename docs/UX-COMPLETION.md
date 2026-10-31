# UX 6件の実装と検証 — 2026-10-31

基準: `918727f` / v0.3.0。計画: https://app.notion.com/p/40ad6edf2c7781cf9f40fbd4a98b3aa1

目的は、目的の動画を見分け、安全に残し、中身と保存結果を確認して次の作業へ進めること。

## 実装開始判断

計画v1の独立UX・技術審査と、本人の「完璧に対応して」という実装依頼に基づき、主担当ディレクターはA〜Dの実装開始を承認した。専用worktreeで作業し、元の作業ツリーにある保存形式・TS→MP4の変更は保持する。実装・動作確認・人間の体験確認は別々に判定する。

- A: 順次保存の上書き防止と、音声欠落時の録画前確認。
- B: 正確な動画・フレーム出典、今回の候補と過去の記録の分離。
- C: 動画を識別するカード、対象と結び付いたサイト許可。
- D: 録画結果の再生、実ファイル名、保存場所を確認する操作。

維持するもの: 目的別の2画面、明示開始、固定停止、未保存保護、実保存完了待ち、必要なサイトだけの権限。新しい実行時外部依存や解析送信、広い必須権限は追加しない。

参照マニュアルは2026-10-02保存版sequence 4と関連運用資料。正本Page取得手段がないため最新版の差分は未確認。

## 検証記録

### A — 録画の安全性

未使用保存先をwriter作成直前に消費し、完成結果の読取handleとは分離した。音声を要求したのにlive trackがない場合は、共有中・録画未開始の判断状態に止める。続行・選び直し・中止を用意し、取消・共有終了・遅延capture/writer・lock競合では所有資源だけを解放する。新しい録画が開始に成功するまで前の結果を保持する。

- 録画単体試験23件PASS。別担当が独立再実行し23件PASS、今回の録画controller/UI範囲に必須修正なし。
- `npm run check` PASS。
- 基準版とAだけを適用した一時コピーの両方で、隔離Chrome/localhostの既存browser smokeがPASS。音声欠落時の判断前に未録画である表示、明示続行、pause/stop、未保存保護、実download完了、順次保存の次回再選択、失敗後も保存先を再利用しないことを確認。
- captureとfile pickerは合成の境界を使用し、MediaRecorderとChrome downloadは実処理。実OS picker・実音声・長時間・人間の理解は未確認。

### B — 候補の出典と鮮度

各実documentの出典token、動画/config単位のoccurrence、完全URLのresourceを分離した。現在の候補500件と過去100件を別枠にし、成功したscanだけを原子的に置換する。再生中・frame内可視・DOM由来を優先する。読み込み履歴は現在の動画との対応未確認として区別する。旧sessionの結果とjobを保持し、blobは実documentIdへ問い合わせる。

- collector/discovery/background/utils集中試験43件PASS、独立再実行でも43件PASS。その後、metadataの埋め込み先と実iframeを区別する追加試験を実施。
- 独立審査で、実絶対pathをretryの予定filenameへ流用する問題、同URL再読込で古いscanが採用される問題、一時outlineのCSSOM正規化と連打時復旧を指摘。actualFilename分離、commit前の実document検査、所有timerによる復旧へ修正し、再審査で解消。
- inspect/showは当拡張の既知downloadIdまたはbyExtensionIdを単一IDで確認する。別のダウンロード履歴全体は取得しない。
- 実allFrames、about:blank/srcdoc、元ページの一時強調の見た目はCのブラウザ統合で確認する。
- B最終の集中試験44件PASS。並行作業のv0.4.0（保存形式選択・TS→MP4）を統合し、保存形式関連を含む集中61件PASS。Bまでを含む専用コピーでbrowser smokeとembedded browserの両方がPASSし、実allFrames、直接/HLS/DASH/別音声/blob保存・MP4再構成・全編decodeを回帰確認した。元ページの一時強調の実表示はCで追加確認する。

C〜Dの検証は実装後に追記する。
