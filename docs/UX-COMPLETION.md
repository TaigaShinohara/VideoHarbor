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

### C — 動画を選ぶ・許可する

実出典の名前・長さ・再生中の印・取得できたローカル画像を見出しにし、確証のある保存元だけをまとめた。複数の保存元は明示的に展開できる。未知の対応は未確認と示す。実layoutで確認できる出典だけに元ページ確認を出し、埋め込み許可は対象名とサイト単位の範囲を同じカードへ示す。保存形式は同URLの表示間で同期し、再スキャンでも保持する。

- 独立UX審査で、別occurrenceの代表title流用、不可視metadataへの偽の確認、許可後のfocus消失、前回候補の過剰断定を指摘。出典title限定、locatable判定、disabled解除後のfocus回復、観測に合う文言へ修正し、再審査で全件解消。
- 表示groupの単体5件とcollectorを含む集中24件PASS、静的確認PASS。
- 隔離Chromeのbrowser smoke PASS。同名/同配信元の青・赤の動画を別groupとし、青の複数保存元だけをまとめること、折り畳みを開いた実保存、元ページの一時強調を連打しても元styleへ復旧すること、再スキャン後の名前/保存形式を確認。1280/360のUTF-8画面をAIが確認。
- embedded browser PASS。許可拒否後は同操作へfocus、合成許可後のscan再描画では見出しへfocus。別の実host付与済みprofileで実allFrames収集も確認した。権限のネイティブ確認UIと、人間の理解・スクリーンリーダーは未確認。
- 早期比較に使える同名fixtureはbrowser smokeに保存。本人への誘導なし比較は未実施であり、人間への改善効果の採用判定は保留。

### D — 結果を確認して終える

停止後は実ファイル名・未保存/保存済み・明示再生を結果領域へまとめた。結果保持中は保存済みでも結果→次設定のDOM順とし、狭幅のキーボード順も一致させた。再生URLはdownload URLと別管理で、新録画の開始成功/明示破棄/画面終了で解放し、取消では前結果を保持する。ファイルの全量コピーは追加しない。Chrome保存は当拡張IDだけでフォルダへ、順次保存はclose済みreadHandleで再生する。

- 独立UX/技術審査で、古いgetFile/playのreject/finallyが新結果を更新する競合、保存後の狭幅で設定が結果を押し下げる問題を指摘。viewの操作世代と実DOM順の変更で修正。別担当が遅延拒否・成功の4回帰を追加し、URL寿命3件と合わせ7件PASS、独立再実行もPASS。
- DOM移動で停止後focusが失われるケースは実ブラウザで検出。移動前の有効なfocusを復元し、既存のhidden/disabled時移管も維持した。修正後browser smokeとembedded browserがPASS。
- 未保存再生の高さは固定パネルの実高さを除いて調整し、明示再生で映像をスクロール。360pxで再生要素の下端が固定保存パネルの上端以下となる実座標を確認した。
- 保存後の結果は、隔離Chromeの実tab zoom 200%でも横overflowがなく、DOM先頭に結果があることを確認した。
- 隔離Chromeの実MediaRecorder録画を保存前と保存後に再生。実download IDのフォルダAPI呼出しを確認した。OSのフォルダ表示境界のみ合成し、Finder実表示とは区別する。
- 同じ隔離profileのorigin-private filesystemで、本物のFileSystemFileHandleへ2本を順次保存した。AのサイズとSHA-256が共有取消・Bの実書込後も一致し、Bは別の実ファイルへ保存された。AのgetFile再生も成功。ネイティブ保存pickerは差し替えており、実ユーザーフォルダでの本人操作は未確認。

## 統合結果と次の確認

- v0.5.0: `npm test` 197件PASS、SKIPなし。`npm run check`・`git diff --check` PASS。
- 隔離Chromeのbrowser smoke/embedded browser PASS。既存v0.4の出力形式・TS→MP4を含め、直接/HLS/DASH/別音声/blob保存を回帰。通常・別origin許可済み・srcdoc iframeの実allFrames収集も確認。
- dev用の `npm run qa:ux` と [UX-MANUAL.md](UX-MANUAL.md) を用意した。合成動画はMac上で生成し、localhostだけに配信。別担当が実起動・UTF-8・動画差異・range・固定route/メソッド・終了時の自分のtemp消去まで確認した。
- 実OS picker/権限・実音声の聴取・実ユーザーフォルダ/Finder・30分/容量/背景の長時間実測・Chrome116本体・実スクリーンリーダー・本人の理解は未確認。本人の誘導なし比較が残るため、全体の体験確認は完了扱いにしない。コード実装と自動/AI確認の完了を別に記録する。
