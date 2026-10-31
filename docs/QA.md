# QA — v0.1

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
