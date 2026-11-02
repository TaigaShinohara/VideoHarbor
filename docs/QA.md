# QA — v0.1

## 録画開始時の自動再生と位置確認 — 2026-11-02 / v0.6.2

- `npm test`: 366件PASS、失敗・SKIPなし。`npm run check` / `git diff --check`: PASS。位置確認前のcapture/再生/writer禁止、確認後の音声判断、中止時の前結果・未使用保存先維持、読み込み/再生イベント中の位置復元、同期クリック伝達、再生拒否・タイムアウト・遅延処理、srcObject入力track保護を検証した。
- Chrome 156.0.8078.80 / Chrome for Testing 116.0.5845.96の両方で `npm run test:video` PASS。最新mainの録画候補重複修正も統合した最終runtimeと照合した。各12本の実WebMをffprobeとffmpegで全編decodeし、対象320×180映像・対象音の分離、背景/pause/seek/scroll、CORS、MSE映像、同別origin frame、srcObject、実OPFS writer/closeを確認した。
- 自動再生制限を無効にする起動フラグは使用しない。新しいoriginの未操作・未再生・preload=none動画で、元ページのuserActivationが発見後もfalseであることをCDPのuserGesture=falseで読み、実際の拡張Startクリックだけで再生・録画・保存できることを確認した。Playwright evaluate自身が操作権を与える影響を避けている。
- 一時停止した3秒位置の警告・中止・位置保持とロック解放、確認後の現在位置からの録画、合成したplay拒否の正しいエラー表示、拒否後に終了済み動画を先頭から再録画して映像・音声付きファイルができることを確認。試験fixtureにHTTP Range応答を追加し、実際に3秒へseekできたことも開始前に検証する。録画候補は8代表、query違いframeを追加すると9代表になる回帰も保持した。
- Chromeの終了後再開における音声取得競合を実際に再現し、実playイベント内の再取得で対処した。独立レビューは最終ガードとmain統合を含め修正必須の指摘なし。1280/360/320pxで横方向overflowなし、320pxの警告・続行/中止ボタンをAIの画像確認で確認した。
- 追加の情報監査では現行treeの検出0件。ローカルGitの既存test blobに4件の履歴パターン検出があり、コマンド全体は失敗扱い（合成テストの記述で、今回の現行変更の検出ではない）。履歴を書き換えたり監査規則を緩めたりしていない。
- 未確認: 本人の任意の実サイト、実OS picker、物理スピーカーでの聴取、人間の体験、30分実時間/OSスリープ。合成拒否試験を実サイトの拒否動作と同一視しない。追加権限・外部依存・解析送信はない。

## 録画対象selectの重複を解消 — 2026-11-02

- `npm test`: 336件PASS、失敗・SKIPなし。表示ラベルの回帰2件を追加し、カードとselectの無題番号・URL伏字・元参照の保持を検証。`npm run check` / `git diff --check`: PASS。
- `npm run test:browser`: 隔離Chrome・localhost合成ページでPASS。表示中video・非表示clone・JSON設定から録画選択肢が代表2件になること、同じ要素の再scanで不透明IDと選択を保持すること、代表が変わると未選択になりカードから新代表を選択・位置確認できること、URLがDOMへ出ないことを確認。
- `npm run test:video`: PASS。初期は保存カードと同じ8代表だけがselectに表示され、同URLの同origin埋め込みは重複しない。iframeだけquery違いへ変更・再生・再scanすると9代表となり、そのiframeを明示選択して録画できることを確認。既存の映像・音声・CORS/MSE/srcObject・OPFS等の検証も通過し、保存成果物をffprobe/ffmpegで検証した。
- 独立レビューで修正必須の指摘なし。内部videoElementsと録画のexact identity照合は保持し、録画中は選択肢・選択参照を更新しない。追加通信・権限・依存なし。
- 未確認: 利用者の元ページでの修正後追試、実OS picker・実音声の聴取・人間の操作体験。Chrome116専用の再試験は今回未実施。前回の保存カード重複は今回本人から解消報告があったが、録画selectの確認とは分ける。

## 情報表示・保存名・保持範囲の改善 — 2026-11-01 / v0.6.1

- 工程ごとに文書/連絡先（PR #22）、中立保存名（#23）、URL表示/不透明DOM ID（#24）、閉鎖session最小化（#25）を統合。最終工程でローカル監査コマンド、検証記録、バージョンをそろえた。結果・範囲・残る情報は [PRIVACY-IMPLEMENTATION-2026-11-01.md](PRIVACY-IMPLEMENTATION-2026-11-01.md)。
- `npm test`: 334件PASS、失敗・SKIPなし。`npm run check` / `git diff --check`: PASS。URL漏洩、遅延したChrome受付、古いstorage snapshotによる二重開始、遅いscanの試験helperは修正前FAIL→修正後PASSを確認し、閉鎖処理を独立再レビューした。

| 隔離Chromeの合成試験 | 現行Chrome 156.0.8078.80 | Chrome for Testing 116.0.5845.96 |
| --- | --- | --- |
| `test:browser` | PASS | PASS |
| `test:embedded` | PASS | PASS |
| `test:video` | PASS | PASS |
| `test:privacy` | PASS | PASS |
| `test:security` | PASS | PASS |
| `test:worker` | PASS | PASS |

- Chrome116はGoogle公式ZIPをタスク専用一時領域へ取得し、既存QA記録のSHA-256と一致を確認して使用。個人Chromeプロファイルや他タスクのブラウザ資材は変更していない。
- `test:embedded`は署名query/opaque pathのDOM非露出と完全URLの実取得、query違いの形式選択/再scan保持、直接/HLS/DASH/blob/TS→MP4の実ファイルと全編decodeを確認。`test:video`は実captureStream/MediaRecorder、対象映像・音の分離、CORS/MSE/srcObject/同別origin frame・OPFS等を確認した。
- `test:privacy`はffmpeg/ffprobeで事前検証した合成WebMを使用。API返答のみ遅延させた実download、閉鎖直後の投影、受付後のURL/path除去、対象Workerの強制再起動とboot変更、native downloadイベントによる残り2本継続、全session削除、実ファイル3本の中立名/size/SHA-256一致を確認。自然なidle停止だけの保証とは区別する。
- 試験のasync predicate待機、Chrome116のcanvas fixture、CDP download override/Worker objectの再利用に関する前提を修正した。検証の閾値や情報非露出・実ファイル一致の条件は弱めていない。製品の不具合と試験側の互換修正を区別する。
- `npm run audit:information`: 現行82ファイル（うち実行用29）、ignored178ファイル（すべて開発依存）、ローカルGit533 object中317 blob・64 commitを全走査し、失敗0・設定した走査範囲完了。この件数は最終記録commit前のsnapshot。履歴の旧参照8件と既知の作者識別情報は残存として分類し、消去済みとは扱わない。実資格情報・指定外の個人メール・現行の内部URLは未検出。
- 未実施: 実OSの共有/保存picker、実音声の聴取、本人の操作体験、任意の実サイト、30分の長時間試験の再実行、指定メールの受信確認・GitHubアカウントへの追加。既存の本人実機QA待機は維持する。

## 未解決PR指摘と情報点検 — 2026-11-01

- 全19件の既存PRを確認。すべてマージ済みだったが、#5の未解決指摘2件が現行コードにも残っていたため修正した。実応答の `application/ogg` とMP4選択の不一致、AVC escapeの検査prefix境界を対象とする。
- 修正前の回帰2件は失敗し、修正後の対象37テストはPASS。正常escapeの境界前後12パターンと圧縮NALの完全保持、不正/実切断escape、MIMEの大小文字・空白と互換/非互換/不明応答を確認。
- `npm test`: 302件PASS、失敗・SKIPなし。`npm run check` / `git diff --check`: PASS。
- `npm run test:embedded`: 隔離Chromeとローカル合成fixtureでPASS。直接保存、TS保持/MP4変換、fMP4、DASH、別音声HLS、blobの実download、音声/映像の長さと全編decode、WebMをMP4としない実応答拒否等を確認。配布manifest・個人Chromeプロファイル・実サイトは使用/変更しない。
- `npm run test:security`: 隔離Chrome・合成HTTP/HTTPSでPASS。Cookie/Basic認証/Referer、fetchのredirect拒否、Chrome直接downloadのredirectと別originへの認証転送を検証。秘密値をログに出さず有無を照合した。
- 同梱27ファイル、追跡70ファイル、Git全object内の285 blobと51 commit message、ローカル除外178ファイルを点検。実秘密の混入は未発見。内部文書リンク・Git作者情報、利用者データの保持・画面表示は別途記録した。範囲・方法・発見と未確認は [INFORMATION-AUDIT-2026-11-01.md](INFORMATION-AUDIT-2026-11-01.md)。
- 実OS picker・実音声・人間の操作体験・長時間録画・実サイト互換性の追加確認は今回未実施。

## 同じ保存元の動画カード重複を解消 — 2026-10-31

- `npm test`: 300件PASS、失敗・SKIPなし。動画グループの回帰を8件追加し、完全URLの共有・複数frame/config・重なる代替保存元・同名/query違い・入力非破壊・代表出典の整合・現行録画対象の保持を確認。最初の期待変更で既存実装の重複を再現した。
- `npm run check` / `git diff --check`: PASS。
- `npm run test:browser`: 隔離Chrome・localhost合成ページでPASS。同じURLの表示中video・非表示clone・JSON設定から保存カードが1枚になること、元videoを削除してcloneを表示した再スキャン後も1枚で、更新されたタイトル・出典確認・代替保存元が使えることを検証。デスクトップと360pxの合成画面も確認。
- `npm run test:video`: PASS。共有URLの保存カード1枚・録画グループ8件・実録画対象9件を区別して検証し、統合された同origin埋め込みは録画対象selectから明示的に選択。既存のCORS/MSE/srcObject・別origin埋め込み・背景/pause/seek/scroll・OPFS・終了/置換/消失も通過し、保存メディアをffprobe/ffmpegで確認した。
- 独立レビューで見つかった旧sessionの出典URLとoccurrence IDの不一致を修正し、回帰テストで確認。録画参照は現行videoElementsだけから選ぶ境界を維持。追加の通信・権限・実行時依存なし。
- 未確認: 利用者の元ページでの修正後追試、実OS picker・人間による聴取と体験。異なる完全URLを同一内容と推測してまとめない。

## 動画だけの録画 — 2026-10-31 / v0.6.0

- `npm test`: 292件PASS、失敗・SKIPなし。`npm run check`、`git diff --check`: PASS。Chrome116+/MV3・権限・ビルド不要の構成を維持。
- 既存の隔離Chrome `npm run test:browser` と `npm run test:embedded`: PASS。直接保存/HLS/DASH/blob、形式選択、録画結果保護などの回帰を確認。
- `npm run test:video`: Chrome156とChrome for Testing116で実動画要素→実captureStream→source録画→Chrome messaging→WebM保存・結果再生を試験。対象色・対象音の分離、背景、pause/seek/scroll/resize、音声判断/CORS/MSE/同別origin iframe/srcObject、入力track維持、自然終了/差替え/元タブ消失、実OPFS順次保存を確認。各Chrome8本の成果物を全編decode。
- source/転送/所有権の独立レビューで見つかった問題を修正し再レビューPASS。初期track通知とsrcObject入力共有は実ブラウザ試験で検出・修正。画像候補除外修正を取り込み、既存契約を保持して統合差分を独立確認。
- 準備・録画中・結果の1280/360/320pxを撮影し、横overflowと停止/保存の可視性を確認。理解・音の聴取品質は未確認。

方式・試作・指摘処理・実試験の境界と本人確認手順は [VIDEO-ONLY-RECORDING.md](VIDEO-ONLY-RECORDING.md)。実OS picker、個人の実サイト、実スピーカーでの聴取、動画だけの30分実時間/OSスリープ、MSE音声付き構成、人間の操作理解は今回未確認。以下の旧版の「録画は表示全体」は過去の仕様として扱う。

## サムネイル画像の動画候補混入修正 — 2026-10-31

- `npm test`: 248件PASS、SKIPなし。追加7件で、video由来の画像リソース、既知画像14形式・大文字・query/hash・URL escape、画像MIME、JSON/OG、画像501件による候補上限の占有、過去sessionと前回候補の除外を検証。最初の追加6件は修正前の失敗も確認。動画URLのquery・ディレクトリ内の画像名、拡張子なし動画、動画blob、既存job/historyは保持する。
- `npm run check` / `git diff --check`: PASS。
- `npm run test:browser`: 隔離Chrome・localhost合成ページでPASS。実際のvideo.poster画像がResource Timingで`initiatorType: video`になることと、画像が動画保存候補へ出ないことを確認。既存の保存・録画の合成回帰試験もPASS。
- 独立コードレビューで修正必須の指摘なし。追加の実行時通信・権限・外部依存なし。
- 未確認: 利用者の元ページでの修正後追試。画像MIMEも画像拡張子もないURLを、読み込み履歴だけから画像と特定することは保証しない。実OS picker・音声・人間の体験は今回の試験対象外。

## 一覧の表示整理 — 2026-10-31

- 候補の形式・配信元・寸法は「詳細」内で初期非表示。既存のブラウザ試験を更新し、開くと情報が見え、再び閉じられることを確認した。保存状態・保存形式・操作は詳細外に残す。
- 上部・カードの余白とサムネイルを縮め、ファイル名の既定見出し余白を除去。文字サイズとボタン・selectの操作高さは維持し、デスクトップと360pxのスクリーンショットを確認した。
- `npm test`: 241件PASS、失敗・SKIPなし。`npm run check`、`git diff --check`: PASS。`npm run test:browser`: 隔離Chrome・localhost合成ページでPASS（保存・録画・worker復帰・320/360px・reduced-motion等の既存回帰を含む）。独立静的レビューで修正必須の指摘なし。
- 通常Chromeでの本人確認、実OS picker・実音声の追加確認は未実施。今回、埋め込み・セキュリティ・実Worker・長時間の専用試験は再実行していない。以下の旧版の「形式・配信元・寸法を常時表示」は過去の検証記録として扱う。

## セキュリティ修正 — 2026-10-31 / v0.5.1

MP4の計算量、HLS構造metadata、同梱Worker、operation取消とChrome116の状態保持を修正した。検証の対象・実環境・合否・未確認は [SECURITY-VALIDATION-2026-10-31.md](SECURITY-VALIDATION-2026-10-31.md) を正本とする。

現行ChromeとChrome116のbrowser smoke/embedded/実Worker/合成HTTP/HTTPS認証・redirect試験はPASS。現行Chromeでの実時間30分の背景合成録画は本番上限による自動停止、全編decode、track/lock解放までPASS。Chrome116での30分実時間試験は未実施。実OSの許可/共有/保存picker・実音声・個人の実サイト認証は本人の選択により後日であり、今回の自動PASSとは分ける。

## UX 6件の対応 — 2026-10-31 / v0.5.0

旧版の結果は以下に履歴として残す。今回の実装・検証の詳細と独立審査は [UX-COMPLETION.md](UX-COMPLETION.md)、本人が触れる合成ページと操作条件は [UX-MANUAL.md](UX-MANUAL.md)。

- `npm test`: 199件PASS、失敗・SKIPなし。`npm run check`、`git diff --check`: PASS。隔離Chromeのbrowser smoke/embedded browser: PASS。

- 録画: 順次保存の保存先を1試行で消費し、次回の新規選択が必要。音声ONでtrackなしは共有中・未録画の状態で利用者の判断を待ち、録画/書込を開始しない。開始取消・遅延capture/writer・共有終了・排他競合を単体試験し、独立審査した。
- 候補: 実document出典を分離し、同名別動画を誤統合しない。旧500候補に新対象が押し出されないこと、同URL再読込の古いscanを拒否すること、実frame/documentでblob取得すること、相対予定名と実絶対pathを分離し再試行を保つことを試験した。
- 画面: 同名/同hostの青・赤の動画と複数保存元、元ページの一時強調の連打と復旧、折り畳んだ保存元からの実download、出力形式の再スキャン保持、許可拒否/合成許可後のfocusを隔離Chromeで確認。
- 結果: 停止後の実MediaRecorderデータを画面内で再生し、保存キャンセル/次のcaptureキャンセルで再生URLを保持。順次保存のclose済みhandleでも再生する。当拡張の実download IDを確認してフォルダ表示APIへ渡す（OSフォルダ表示の境界だけは合成）。古いgetFile/playのreject/finallyが次の結果を変更しない競合試験を追加した。
- 実ファイルの保護: 隔離profileのorigin-private filesystemへ本物のFileSystemFileHandleで2本を書き込み、共有取消・2本目保存の後も1本目のサイズ/SHA-256が不変であることを確認。ネイティブ保存pickerと実ユーザーフォルダへの書込は別の未確認事項。
- 結果再生中に「動画を保存」へ移ると非表示の再生を止め、録画画面へ戻っても結果URLを保持することをブラウザ試験で確認。読込中の画面切替も再生操作を無効化し、遅いgetFileの成功・失敗で非表示再生や古いエラーが発生しない回帰2件を追加した。
- 狭幅: 未保存時の固定保存操作、再生コントロールを固定パネルより上へ収める実座標、保存後も結果→次設定となるDOM順、並べ替え後のfocusをブラウザで確認。1280/360の画面をAIが確認し、320pxのoverflow・reduced-motion・forced-colorsも回帰試験の対象とした。
- Chromeの実tab zoom 200%で保存後の結果が横overflowせず、結果→次設定のDOM順が維持されることを確認。
- 保存方式: 既存の直接MP4、HLS（TS/fMP4/別音声）、DASH、blob、TS→MP4を実取得・実Chrome download・ffprobe/ffmpeg全編decodeで回帰確認。通常iframe、許可済み別origin iframe、srcdoc iframeも実allFramesで収集できた。

### 残る実機・本人確認

ネイティブ保存/共有pickerとOS画面収録権限、通常Chromeの追加サイト許可、実タブ/システム音声の聴取、実ユーザーフォルダへの順次保存・Finder表示、30分/容量閾値/背景での長時間実測、Chrome116本体、実スクリーンリーダー、本人が説明なしで対象を選び結果を理解できるかは今回未確認。自動試験・AIの画面確認をこの確認の代わりにしない。実装済みと案件全体の体験確認完了を区別する。

## 保存形式の選択 — 2026-10-31 / v0.4.0

- `npm test`: 152件PASS、失敗・SKIPなし。`npm run check`・`git diff --check`もPASS。必要なruntime依存・必須権限は追加していない。
- `npm run test:browser`: 既存の隔離Chrome直接保存・録画・キーボード・狭幅・worker再起動等の回帰試験PASS。
- 出力ポリシー10件：MP4/M4V、HLS/DASH、既知非MP4、未知blob/直接URL、MIMEとURLの矛盾、無効値を確認。元形式ラベル・ファイル名は既知MIMEに合わせ、互換な別名の元suffixを保持する。既知WebM等のMP4単純リネームを許可しない。
- TS→MP4専用9件：単一番組のAVC 8bit 4:2:0 progressive・1画像/PESとAAC-LC ADTS、映像のみの入力、PAT/PMT CRC、暗号化・欠落・codec/設定変更・時刻異常・上限の拒否。実HLSの複数TSをMP4へ変換し、B-frameと44.1kHz AACを含む全packetのPTS/DTSが元TSの基準時刻を除いた値と40µs以内で一致、24映像frame、両track全編デコード終了0を確認。125001サンプルの合成TSでもJS引数数上限に当たらず変換できた。
- 保存controllerでは形式の同期検証、実blob MIMEが非MP4ならchunk取得/保存前に拒否、保存開始後の指定固定、同形式のretrybuffer再利用、形式変更時の古いbuffer解放と再取得を確認。背景では直接保存の指定/filename固定とretry保持、非対応指定を含むbatchの原子的拒否、Chrome実応答がWebM/QuickTimeならMP4完了にしないことを確認。既に保存された異形式の応答ファイルがある場合は、その事実を表示して自動削除しない。
- `npm run test:embedded`: 隔離Chrome・localhost合成fixtureでPASS。HLS/既知MP4の初期MP4、未知blob/既知WebMの初期元形式、WebMのMP4無効と理由、HLSの元TS保存と同じソースから選択MP4の実保存、直接MP4の実filenameを確認。各成果物の拡張子と実コンテナを照合し、両trackのpacket長3.8〜4.5秒・開始差100ms未満と全編デコードを確認。保存中の全selector無効化とscripted changeでも開始時の形式保持、実WebM blobのMP4拒否、既存DASH/別音声HLS/blobの保存もPASS。
- 最初のfilename試験では、CDPで保存先を強制するとBlob保存の実filenameがUUIDとなり拡張子判定に失敗した。製品の指定filenameを変えず、テスト専用の新規profile内だけで既定保存先を一時ディレクトリへ設定し、Chrome標準の命名動作で再検証した。個人profileは読み書きせず、実保存がテストの一時ディレクトリ内に収まることも確認した。

録画形式は既存のWebMを維持。WebM/MOV/Ogg等のMP4への再エンコード、HEVC等のTS変換は未対応。MP4指定で非対応なら理由を表示して中断し、元形式へ勝手に切り替えない。実サイトごとの互換性、本人の理解・操作、実OS picker・音声・長時間/最大容量の測定は未確認。

## DASH・別音声MP4の保存拡張 — 2026-10-31 / v0.3.0

- `npm test`: 120件PASS、失敗・SKIPなし。このMacではffmpeg/ffprobeが利用可能なため、実MP4合成試験も実行した。`npm run check`と`git diff --check`もPASS。
- DASH計画19件：静的単一Period、BaseURL/区間設定の継承、Number/Time/RepresentationID/Bandwidthの展開、有限Timelineと負のrepeat、SegmentListのrange、最高対応画質・標準音声、未対応画質からの選択、合計5000区間を確認。DRM/live/WebM/開始補正/未知XML機能/危険URL/不正range/上限/停止は明示失敗。
- HLS30件：既存機能に加え、fMP4別音声とDEFAULT選択、ネストした音声参照、未対応構造から対応する下位画質への選択、許可/HTTP/network/キャンセル時は下位候補へ迂回しないこと、5階層・64配信リストの上限を確認。
- MP4合成12件：track IDの衝突回避、trex/tfhd/mfhd、異なるtimescale、編集情報、B-frame composition offsetを含む時刻、sample byte保持、古いsidx/mfra除去、暗号化/外部参照/絶対offset/破損/逆行/容量の拒否。実ffmpeg製の分離HLSとDASHを合成し、両trackと全編デコード成功も確認。
- 共通assembler3件：映像・音声の合計容量上限、トラック間の停止、従来TSのbyte保持。保存controller15件にはDASHの段階的なサイト許可、MPD取得中停止、初期化データのstream停止、32サイト上限を追加。collector12件では既知初期化設定の厳密JSONとJSON文字列、HTML escape、videojs単独設定、文字列/コメント/正規表現内の偽設定、iframeの動画/ページ分離を確認。
- `npm run test:embedded`: 最終状態で隔離Chrome・localhost合成試験PASS。従来TS/fMP4/blobに加え、静的DASHと別音声HLSを本物のcollector→fetch→合成→Chromeダウンロードで保存。実downloadのcomplete/exists/filenameを照合し、ffprobeで映像・音声の両track、両方の実packet長3.8〜4.5秒、開始時刻差100ms未満を確認。ffmpegで両trackを全編デコードし終了コード0。既知player JSONと動画iframeの実注入、許可拒否/再試行、360px固定停止、部分ファイルを保存しない停止も維持。
- 最初の追加追試では旧TSのaudio stream推定durationが3.733秒となり、4秒の判定に失敗した。配信元から保存した実packet列の時刻・長さを測る方法へ試験を修正した。閾値を緩めず、その方法で旧TSを含め全保存ケースがPASSした。
- 保存計画のURL文字列増幅も制限。HLSのマスター候補群・各media playlist、DASHの候補BaseURL群・各trackのURL文字数を追加時に4 MiBで制限し、選択2trackは最大8 MiB。DASHの単一URL展開も生成前に長さを制限する。上限超過で別候補を繰り返し探索しないことを回帰試験で確認。

追加の必須権限・実行時依存・解析送信なし。必要サイトのoptional許可だけを使用。Nativeのサイト権限確認境界は従来同様模擬し、それ以外の取得・合成・保存は実処理。個人Chromeプロファイルと実サイトのメディアは使わず、実サイトへの個別取得も行っていない。

未確認：実サイトごとの互換性、本人による追加サイト許可、聴取品質と人間のAV同期評価、実OS picker・実音声・最大容量/長時間の実測。未対応：暗号化・DRM・ライブ、TS/AACの別音声、HLS不連続/別映像/字幕、DASH SegmentBase/複数Period/開始補正/WebM、未対応MP4トラック構成。合成成功と任意サイトでの保存成功・権利許諾は別とする。

## 埋め込み動画の保存拡張 — 2026-10-31 / v0.2.0

- `npm test`: 67件PASS、失敗・SKIPなし。動画タグ・遅延属性・メタデータ・構造化データ・型付きJSON設定、危険URL排除、候補上限、再スキャンの型保持を確認。
- HLSの単体試験20件：マスターの対応画質選択、相対URL、TS/fMP4、初期化データ、明示/暗黙byte rangeと厳密な206応答、暗号化・ライブ・別音声・不連続・循環・過大データ・HTML応答等の拒否、AbortSignal、未読応答の解放を確認。
- 保存controllerとページ内blobの単体試験18件：クリック内の同期permission request、拒否/再試行、配信元限定、実download完了待ち、準備/取得/保存中停止と完了競合、単一の再試行buffer、snapshotの再利用・操作token・期限・解放、サイズ/形式/署名検査を確認。
- `npm run check`: MV3、必須権限、サイト許可がoptionalであること、ローカル参照、構文PASS。`git diff --check`: PASS。
- `npm run test:browser`: 既存の隔離Chrome合成試験PASS。直接保存、録画、未保存/保存済み、キャンセル、worker再起動、キーボード、狭幅の既存動作を確認。
- `npm run test:embedded`: 追加の隔離Chrome／localhost合成試験PASS。動画遅延属性・OGメタデータ・JSON-LD・同サイトiframeを取得。別サイトのiframeは未許可時に取得せず、テストコピーにそのホストだけ付与した別profileでは実allFrames注入で取得できた。
- 同追加試験で、ローカルffmpegが生成した4秒の映像＋音声付きHLSを、本物の拡張fetch→HLS組立→ChromeダウンロードでTSとfMP4へ実保存。実Chrome downloadのcomplete/exists/filenameを確認後、ffprobeで形式・両track・長さを確認し、ffmpegの`-xerror -err_detect explode`で両trackを全編デコードして終了コード0。元ページで生成したMP4 Blobも同経路で転送・実保存・全編デコード成功。MSE用blobは理由を表示しダウンロードを開始しない。
- 同追加試験でHLS区間の応答を遅延させ、360×800で候補一覧を別位置へスクロールしても固定の停止ボタンがviewport内にあること、停止後は中断表示になり新しいdownloadや部分ファイルを保存しないことを確認。
- サイト許可の拒否/再試行とrequest時userActivationは、permissions APIの確認境界だけを差し替えて確認。fetch・collector・HLS組立・blob転送・実downloadは差し替えていない。配布manifestは必須host権限なし。テストコピーだけに必要なlocalhostホストを付与し、ワイルドカードhostを実付与していない。個人プロファイルや通常Chromeには触れていない。
- マスターから取得したHLSと単独の子リストを区別し、単独リストの取得中・保存結果では別音声を判別できないことを表示する。子リストだけでは音声なしが意図的か外部音声の取りこぼしかを区別できない。マスターで別配信が判明した場合の拒否とは分ける。
- 最初の追加試験は、拡張起点downloadとPlaywrightのartifactコピーが競合してENOENT。Chrome自身のdownload ID・実状態・ファイル名で確認する方式へ試験を修正し、再実行でPASS。製品の保存失敗とは区別する。

未確認：ネイティブの追加サイト権限ダイアログの本人操作、実サイトでの改修後追試・サイト別の認証/Referer/期限付きURL/リダイレクト互換性、最大容量や長時間の実測、本人の新しい保存操作の理解、実OS picker/音声/スクリーンリーダー。DASH、暗号化・ライブ・映像音声別配信HLS、任意のMSE分割配信、DRM回避、変換は未対応。合成試験を全サイト対応・人間の体験・Chrome116実機確認と混同しない。

本人確認手順：`chrome://extensions`でVideoHarborを再読み込みし、元ページで動画を再生→拡張を開く→「動画を保存」→必要なら具体的な埋め込み/配信元サイトだけ許可→保存。HLS/blob処理中は作業タブを閉じず、TSは対応プレーヤーで確認する。

以下の実施結果と、未実施の手順を区別します。

## UX整理の実施結果 — 2026-10-31

- `npm test`: 20件PASS、SKIPなし。`npm run check`: manifest・権限・ローカル参照・構文PASS。`git diff --check`: PASS。ビルド不要の構成を維持。
- `npm run test:browser`: 隔離Chrome／localhost合成fixtureでPASS。変更前にも旧試験を実行し、変更後は以下のUI境界を追加して再実行した。個人プロファイルと配布manifestを変更していない。
- 保存：同名2候補でも形式・配信元・既知寸法が詳細を開かず見える。元ファイルの実download完了、候補なしの再スキャンと録画導線、worker実再起動後の結果復帰を確認。
- 操作：native radio、左右の連続操作・Home/Endとtab focus、クリックから見出しfocus、録画開始・停止・保存で隠れる操作からのfocus移管、timer更新でfocusが動かないことを確認。
- 録画：合成共有stream→実MediaRecorder→一時停止/再開→停止→未保存→実ファイル保存。実trackなし音声の表示、未保存の置換防止、保存キャンセル後の再保存、次の共有キャンセルで前結果保持を確認。再開始の準備中は前録画の時間・音声等を隠すことを確認。
- 保存方式：detailsを閉じてもfile選択が見え、保存先未選択では開始不可。合成file pickerキャンセルで前選択保持。遅延close中は確定中、書込拒否は不完全ファイルの説明、recorder errorで救済blobがある場合はerror表示と保存操作を両立。
- 画面：320/360pxの横overflowなし。360×800で録画中の停止と未保存時の保存がviewport内にあることを確認。reduced-motionでanimation・transitionが無効。forced-colorsを適用して試験は継続できたが、スクリーンリーダーや人間の見分けやすさの確認ではない。
- 合成ページの変更前後スクリーンショットをAIが目視。初版で未保存時の設定が保存操作を下へ押したため、結果優先へ修正して再確認した。通常取得の注意色、英語装飾、長文の常設、待機中の空の黒いプレビューを減らした。アイコンはローカルSVGで、実行時の外部依存・通信・権限を追加していない。

今回の未確認：新UIを本人が使ったときの理解・好み・動きのテンポ、スクリーンリーダーと200% zoom、実OS picker・実音声・長時間動作・実サイトでの改修後追試。2026-10-30の実サイト結果は下記の旧版の検証であり、新UIの本人確認と混同しない。

本人確認の場面：①説明を追加せず元ファイル保存と録画を選べるか、②録画停止後に未保存とわかり保存を終えられるか、③反復利用で補足の開閉と短い動きが負担にならないか。拡張管理画面で再読み込みし、既存の録画・未保存データがない状態から確認する。

## 自動確認

- Node単体テスト: ファイル名、URL制限、配信形式分類、寸法フィルター、再スキャン統合、download状態の集計。
- 静的確認: MV3 manifest、権限、参照ファイル、全モジュールの構文。
- 隔離Chrome: localhost合成ページのみ。テストコピーに限定host権限を付与。配布manifestと個人プロファイルは変更しない。
- 画像: DOM・背景・srcset・open shadow・同origin frame、未選択開始、非表示選択込み保存、完了後選択解除、再スキャン、新規画像、中断と再試行。
- 動画: 直接ファイル/配信候補区別、実download、合成capture入力→実MediaRecorder→pause/resume/stop→全track停止→Blob保存、pickerキャンセル相当、360px横overflow。

## Chromeで実際に触る

1. extension/を読み込み、通常ページで拡張アイコンを押す。設定ページやWeb Storeで失敗理由が表示されることも確認。
2. 初回: 対象と次の操作が説明なしでわかるか。画像の選択3件のうち1件をフィルターで隠し、3件保存されることと件数表示を確認。
3. 反復: 成功分が選択解除され、中断分だけ再試行されること。再スキャンで追加分が未選択なこと。
4. 元ページを別originへ移動/閉じて再取得し、既存候補は残り再操作の案内が出ること。
5. 動画の元タブ録画を開始し、音声あり/なし、ブラウザ共有停止、元タブ終了、一時停止/再開を確認。完成WebMを再生する。
6. 画面/ウィンドウ/タブの共有picker、保存先pickerの各キャンセルで前回結果が残ること。OSの権限拒否から復帰する。
7. 順次保存を選び短い録画を保存。停止後の書込確定、遅い保存先、書込失敗で不完全ファイルの案内が出ること。
8. 複数作業タブ/worker再起動/作業タブ更新で録画排他と古いlock回収を確認。録画中の閉鎖警告を確認。
9. 30分・容量閾値、背景タブ、メモリ/ディスク使用量、OS音声を実環境で確認。
10. keyboard、スクリーンリーダー、360px、zoom200%、読みやすさ、初回と反復の判断の負担を人間が確認。

ブラウザ自動試験が通っても、実機OS picker・実音声・長時間動作・人間の理解は未確認として残します。


## 実施結果 — 2026-10-30

- `npm test`: 20件PASS / SKIPなし。
- `npm run check`: manifest・権限・ローカル参照・全JavaScript構文PASS。ビルド不要の構成のためbundle buildはありません。
- `npm run test:browser`: macOS上の隔離Chrome 156.0.8078.79 / Playwright 1.64.1 / localhost合成fixtureでPASS。
- 画像版: 画像・CSS背景・srcset・open shadow・同origin frameの取得、最初は未選択、非表示選択を含む一括保存、完了時の選択解除、再スキャン、新規画像追加、403応答による中断・中断分だけ再試行、360pxの横overflowなしを確認。
- 動画版: 元WebMの直接保存と配信候補の区別、合成display streamを実MediaRecorderで録画、pause/resume、stop、全track停止、未保存録画の置換防止、実download完了、完成WebMの再生、共有キャンセル相当で前回結果保持を確認。360×800で固定Stop操作がviewport内にあることを確認。
- 実際の拡張Service Workerを停止し、異なる起動IDで再起動したことと、作業ページ再読込後の候補・download結果復帰を両製品で確認。
- Chrome API mockで作業タブ閉鎖後batch継続・cancel直前complete保持、動画版ではnavigate済ownerからのlock回収を確認。
- 録画の集中テストでactivation順、失敗時の全track停止、順次write→最後のchunk→close、書込失敗、ブラウザ共有停止、pause時間、download中断後の再試行、出力pickerキャンセルを確認。

上記の他製品に関する記述は同日に別リポジトリで行った関連検証です。このリポジトリの実機能として混同しません。

初回自動検証時点の未実施（下記追試で一部確認）: 通常Chromeへのインストール/toolbar activeTab許可操作、実サイトでの互換性、実macOS picker/画面収録許可、実タブ・システム音声、30分・容量閾値・背景長時間の実測、スクリーンリーダー、利用者による体験評価。これらを公開前の確認として残します。


## 通常Chromeでの実サイト追試 — 2026-10-30

初回自動検証の後、本人の明示依頼で通常利用中のChromeに、正本のextension/を「パッケージ化されていない拡張機能」として読み込んだ。広いhost権限を足したテストコピーではない。デベロッパーモードは既にONだった。

ブラウザー操作ツールは拡張専用のchrome-extension:// URLへのアクセスを拒否し、他の操作経路での迂回も禁止した。このため拡張内の選択・録画・停止・保存操作は本人が行い、Codexが保存後の明示されたローカル成果物を解析した。AIが拡張内を自律操作できたという結果にはしない。


- 対象: W3C公式 https://www.w3.org/2010/05/video/mediaevents.html 、Sintel trailer (https://media.w3.org/2010/05/sintel/trailer.mp4)。Blender Foundationの公開デモ映像。
- 本人操作: VideoHarborを開く→「画面を録画」→元のタブ・音声ON→開始→元サイトで動画再生→停止→WebM保存。専用アイコンがなく場所を見つけにくいという本人の質問があり、拡張機能メニューの名前から案内した。アイコン追加は今回未実施。
- 録画成果: 9,730,711 bytes、WebM/VP9、2940×1912、video packet終端21.371秒。コンテナdurationは未格納のためpacket時刻から算出。
- 映像: ffmpegでデコード成功。1fpsの21標本がすべて異なり、3秒・12秒の抽出画像も目視で別の動画場面だった。W3Cページ内の映像が実際に記録されている。
- 音声: Opus、48kHz、stereo。音声packetの長さ21.360秒、videoとaudioの終端差は約53ms。実際の発声・音楽の聴取品質や厳密なAV同期の検証とは区別する。
- 音声デコード成功、2,050,560 samples（2ch合計）、平均 -13.9 dBFS、最大 0.0 dBFS。音声trackがあるだけでなく、実音声データが非無音であることを確認。音割れがないという聴取判定はしていない。
- この1件について、通常Chromeの実activeTab導線・元タブ録画・実タブ音声・停止後保存が成立した。画面/ウィンドウ選択録画や全サイト対応を確認したという結果ではない。
- 残件: 実サイトでの元ファイル直接保存、Chrome共有pickerによる画面/ウィンドウ/別タブ録画、システム音声、実File System Access pickerでの順次保存、実長時間/容量上限、他サイト、聴取品質。


## 実サイトでの元動画ファイル直接保存 — 2026-10-30

- 本人がVideoHarborの直接保存操作を行い、拡張のページ別downloadフォルダに保存された `001_trailer.mp4` をCodexが解析。
- 実体はMP4、4,372,373 bytes、52.208333秒。H.264/AVC、854×480、24fps。
- 音声はAAC、48kHz、stereo。30秒分の解析で場面変化・非無音を確認。独立検証でffmpeg -xerror -err_detect explodeを用い、映像・音声の全編を終端までデコードし終了コード0・エラーログ0 bytes。HTML等のエラー応答ではない。
- W3C公式ページのSintel trailerについて、通常Chromeでの元動画直接保存が成立した。録画WebMとは別の成果物として確認した。
- これにより今回の代表試験（両拡張の通常Chrome読み込み、実サイト画像2件保存、実動画の直接保存、元タブ録画と非無音の実タブ音声）は確認済み。
- 残件は、他サイト互換性、Chrome共有pickerでの画面/ウィンドウ/別タブ録画、システム音声、順次保存の実picker、長時間・容量上限、聴取品質等。公開品質や全機能の網羅確認を完了としない。元ファイルを移動・変更していない。
