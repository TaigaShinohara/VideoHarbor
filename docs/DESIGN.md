# ImageCrate / VideoHarbor — initial design v1

## モバイル（iOS Safari / スマートフォン）体験の最適化 — 2026-11-02 / v0.7.0

スマートフォンの小さな画面や片手操作、OS固有の制約下でもデスクトップと同等の安全で快適なユーザー体験を落とさずに提供するためのモバイル設計を導入する。

- **セーフエリアとタッチターゲット**:
  - `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)` 等に追従し、ノッチ・Dynamic Island・ホームインジケータとの干渉を防ぐ。
  - すべての主要ボタン・タブ・セレクト要素で最小44px〜48pxのタップ領域を確保し、誤タップを防止。
- **Web Share APIフォールバックによる保存体験の維持**:
  - モバイル環境や `chrome.downloads` が利用できない環境では、Web Share API（`navigator.share({files})`）へ自動フォールバック。iOSの「写真（カメラロール）」や「ファイルに保存」へ直接保存できるようにする。非対応時は `<a>` download へフォールバック。
- **Screen Wake Lock API によるサスペンド防止**:
  - HLSやDASHの分割ストリーム取得・WorkerでのMP4結合中、端末の画面スリープを防止し、バックグラウンド移行による処理中断を防ぐ。完了または失敗・中止時に即座に解除。
- **録画API非対応時の安全なガイダンス**:
  - iOS Safari等で `captureStream` や `MediaRecorder` が制限・非対応の場合に、不明瞭なエラーで落とさず、「この環境ではブラウザ内録画が制限されています。iOS/Androidの標準画面収録をご利用いただくか、直接保存をお試しください」と明示してOS標準機能へ誘導する。
- 変換手順・iOS実機読み込みガイドは [SAFARI-MOBILE.md](SAFARI-MOBILE.md) に記録する。ビルドなしの拡張資産構成・完全ローカル処理の思想は厳格に維持する。

## Liquid Glassアプリアイコン — 2026-11-02

採用したガラスの再生マークと港を表す画像を、拡張管理・ツールバー・作業タブfavicon・ヘッダーロゴで共通使用する。原本は `assets/branding/` に保持し、16 / 24 / 32 / 48 / 128 pxのPNGを `extension/icons/` に同梱する。ヘッダーは既存の38 / 33 / 30 pxの寸法を保ち、隣の製品名との重複読み上げを避けるため画像のaltは空にする。権限・保存処理・ビルドなしの構成は維持する。

## 録画停止と元動画の一時停止を連動 — 2026-11-02 / v0.6.3

動画のみの録画が終了したら、録画していた元動画もその位置で一時停止する。MediaRecorderへ停止と最終データのflushを要求してから再生を止め、ファイルの確定・転送を妨げない。自動停止・録画済みセッションの終了処理も同じ扱いとする。録画の一時停止ボタンは従来どおり録画だけを一時停止する。

実際に録画を開始したセッションだけが元動画の再生を変更する。準備/位置/音声判断のキャンセルや、再生開始時の確認用streamの差替えでは停止しない。document・再生元URL・srcObject・src/source属性が変わった場合は別の再生として触らない。停止時の判断は、元動画がすでに一時停止/終了している場合も一度で完了し、保存確定中に本人が再開した再生を後処理で止めない。停止失敗時も最終データと後処理を保ち、元ページで止める案内を残す。元動画の入力trackは終了させず、再生位置を巻き戻さない。

停止後の再開で、Chromeが停止中のDOM再生位置と内部音声時計を約60ms再同期するケースを実測した。確認済みの途中位置だけは、シークイベントがない場合に100msの時計補正と実経過時間ぶんの進行を許容する。これは観測に基づく有限の互換処理であり、ブラウザが保証する上限ではない。先頭付近・逆方向の移動・playイベント後の録画準備は50msの基準を保ち、明示的なシークと大きなジャンプは拒否する。

## 録画開始時の再生と位置確認 — 2026-11-02 / v0.6.2

動画のみの録画は、停止中の元動画も開始操作に合わせて再生する。開始直前に実要素の再生位置を読み、先頭から50msを超えて進んでいれば現在位置を表示し、「この位置から録画」「中止」を選べる。終了済みは「先頭から録画」と明示して確認する。通常の途中位置を自動で先頭に戻さない。

位置確認は最初のcapture・再生・writer作成の前に行う。読み込み時にサイトが保存位置を復元する場合に備え、準備後にも位置を再確認する。確認前にメタデータや音声が未取得でも、元動画の音量・ミュートを変更しない。実際の開始クリックから同期的な読み取り専用の要素確認を送り、Chromeのユーザー操作を対象frameへ引き継ぐ。非同期の排他・参照検証と位置・音声確認を省略しない。動画の読み込み後、停止中の動画の実際のplayイベントで録画用trackを作り直し、再生時計が進む前に録画を開始する。これにより、動画終了後の再開でChromeの古い音声取得処理が競合するケースも扱う。音声を取得できなければ従来の確認を経る。再生拒否・読み込み失敗・対象消失は説明して後処理し、タブ全体録画へ移行しない。

## 録画する動画の選択肢の重複を解消 — 2026-11-02

録画対象selectも保存カードと同じグループの現行代表要素を表示し、同じ完全URLを持つ複製を別の動画として列挙しない。全videoElementsは内部の正確な参照照合のために保持する。画面外という理由だけでは除外せず、別URL・query違い・URLなしの実動画は独立した選択肢として残す。以下の旧版の「実動画の録画選択肢をすべて保持」は内部参照の保持と読み替える。

カードとselectで題名・無題動画の番号・URL伏字を共通化し、選択値は不透明IDを維持する。再スキャンで代表のIDが同じ場合だけ選択を保持し、代表が変われば未選択へ戻す。録画中は選択肢・選択状態・選択参照を再描画で差し替えず、実行中の録画が所有する参照を保つ。

## 情報の表示・保存名・保持範囲 — 2026-11-01 / v0.6.1

保存元の完全URLと録画の実document参照はメモリ上に保持し、通常画面・aria・DOM属性・select値は不透明IDと候補番号へ分ける。path/query/hashやURL basenameを表示しない。動画題名・ローカルpreview・具体的な許可host・元ページ確認は、動画を選ぶために維持する。新しい設定や確認操作は増やさない。

新規の直接/組立/録画保存は製品folder・日付・時刻・連番の中立名を使用する。pickerの候補名は中立basename、本人が選んだ名前は維持。同形式の失敗再試行では確定名を保ち、形式変更後は実拡張子を確認する。既存ファイル・Chrome履歴は自動変更しない。

閉鎖した作業タブの候補・題名・JPEG・frame情報を除去し、残りの直接保存だけを継続する。待機中は必要な完全URLと確定名、受付後はdownload ID等へ保持を縮小し、全job終端でsessionを消す。保存受付の返答が遅れても閉鎖時の情報除去を待たせず、古い非同期snapshotから情報を復元しない。

実装・検証・残存する情報は [PRIVACY-IMPLEMENTATION-2026-11-01.md](PRIVACY-IMPLEMENTATION-2026-11-01.md)。これらは画面やメディア全体の匿名化・既存履歴の除去を意味しない。以下の旧版の題名入り保存名や生URL詳細の記述にはこの方針が優先する。

## 同じ動画保存元のカード重複を解消 — 2026-10-31

表示中のvideo、非表示の複製、埋め込み、JSON設定が同じ完全URLを参照する場合、保存カードを1回だけ表示する。queryを含む完全URLの共有を根拠に出典グループを結び、同じ実video/configに属する別形式の保存元も重複なく保持する。同名・同host・同frameだけでは統合しない。

代表の出典は再生中、表示中、実video、config、位置確認可能の順で優先し、タイトル・長さ・プレビューを同じ出典から表示する。録画可能な現行videoがある場合はその集合から代表を選び、古い出典を録画対象に使わない。全occurrenceと実動画の録画選択肢を保持し、URLを持たない実videoはそれぞれ独立した録画対象として残す。今回の表示統合は、以下の旧版の出典ごとのカード分割に優先する。

## 動画だけの録画 — 2026-10-31 / v0.6.0

利用者が選んだ実動画要素の映像と音声だけを、現在の再生位置からWebMで残す。録画画面の初期対象を「選んだ動画のみ」とし、実動画の一覧・カードの「この動画を録画」から選べる。動画未選択では開始せず、既存のタブ全体/画面録画は明示選択する。配信条件による失敗時に全体録画へ自動移行しない。

方式比較、先行試作、状態と転送予算、独立審査・検証結果は [VIDEO-ONLY-RECORDING.md](VIDEO-ONLY-RECORDING.md)。以下の旧版の「録画は表示全体」「動画だけの録画は未実装」はこの方針で更新する。

## 動画候補へのサムネイル画像混入の修正 — 2026-10-31

動画要素が読み込んだposter画像もResource Timingではvideo由来になるため、読み込み元だけを根拠に直接保存候補へ昇格させない。画像MIMEまたはURLのpathname末尾で判別できる画像拡張子を収集時に除外し、snapshot作成・session読込・前回候補にも同じ判定を適用する。画像は候補上限を消費させず、既存の保存job/historyは保持する。queryや途中のディレクトリに画像名があるだけでは除外せず、拡張子のない動画URL・動画blobは保持する。画像判別のための追加通信は行わない。

動画カードのローカルプレビュー画像は動画識別のために維持する。同一動画が複数の再生要素から検出された場合のカード分割は今回変更しない。

## 一覧の表示整理 — 2026-10-31

候補の形式・配信元・寸法は既存の「詳細」へ移し、初期状態では折り畳む。ファイル名・保存状態・保存形式・保存操作は一覧に残す。ページ上部とカードの余白、サムネイルを少し縮め、ファイル名見出しのブラウザ既定余白を除去する。文字サイズと操作ボタンの高さ、録画への強調した案内は維持する。この表示方針は、以下の旧版の「形式・配信元・寸法を一覧に残す」に優先する。

## セキュリティ強化 — 2026-10-31 / v0.5.1

未信頼のMP4で各runから過去range/mdatを全走査していた処理を、検査用rangeだけのsort・隣接検査と物理順mdatの一方向走査へ変更する。元のtrun・圧縮bytes・sample順・時刻・offsetは変更しない。HLS top-level検査は全type配列を保持せず4種類の存在bitだけを持ち、init/segment/両trackで250,000 boxesの共通予算を適用する。muxのnested box250,000/sample4,000,000予算とは別の検査phaseとして数える。

workspaceは許可・fetch・UI・Chrome downloadを所有し、同梱module Workerへ固定kindのbinary検査/mux/remuxだけを渡す。Workerは同じ拡張のcontextであり、権限隔離という説明はしない。ArrayBufferをtransferし、検査後に所有権が戻ったbytesを次の処理で使う。URL/許可/file handle/downloadはWorker protocolへ渡さない。

1保存operationがcontroller/processor/download IDを所有する。要求IDとkindが一致した返答だけ採用し、abort・Worker error/messageerror・120秒timeout・pagehideでWorkerとlistenerを解放する。起動失敗時に重い同期処理へfallbackしない。取消後も後片付けが終わるまで次の保存は排他し、受付済downloadは実終端を照合する。完成した同形式retry Blobの再利用と、取消・失敗で不完全な解析結果を保存しない契約を保つ。

検証の合否とnative未確認は [SECURITY-VALIDATION-2026-10-31.md](SECURITY-VALIDATION-2026-10-31.md) に記録する。既知の脆弱な処理へ戻すrollbackは採用しない。

## UX 6件の対応 — 2026-10-31 / v0.5.0

以下は旧版の累積候補・URL主体一覧・保存先再利用・結果図形だけの説明に優先する。

- 目的は、ページ上の目的の動画を見分け、安全に残し、実ファイルと中身を確認して終えること。2目的画面・明示開始・固定停止・未保存保護・最小権限は維持する。
- resourceの完全URLと、実document/video/config由来のoccurrenceを分離。同名・同host・同frameだけで動画を統合しない。実測タイトル/長さ/再生中/上限付きローカル画像を使い、未知は未知と表示。見える出典だけを元ページで確認できる。複数保存元は展開でき、保存形式をURL単位で同期する。
- 成功したscanで今回の500件を原子的更新し、過去候補100件・保存job/historyは別保持。読み込み履歴由来も区別。top documentの同一性をcommit前に検証。埋め込み許可は対象とサイト範囲を同じカードで示し、再描画/拒否後のfocusを移管する。
- 順次保存は未使用選択→1回の書込試行→結果読取handleへ所有を移管。音声要求と実trackが一致しなければ、共有中・録画前の判断状態を設ける。cancel/ended/遅延処理で前結果と資源を保護する。
- 結果保持中はDOM順でも結果→次の設定。録画のBlob/close済みhandleを明示再生し、実ファイル名・未保存/保存済みを示す。Chrome downloadだけに当拡張IDを確認したフォルダ表示を提供。順次保存のフルパス/フォルダ操作は捏造しない。再生URLとdownload URLは別の寿命とし、古い非同期処理は新結果を変更しない。

計画、独立審査と指摘の処理、動作確認と人間未確認の区別は [UX-COMPLETION.md](UX-COMPLETION.md)。本人が触れる場面と起動手順は [UX-MANUAL.md](UX-MANUAL.md)。

## 保存形式の選択 — 2026-10-31 / v0.4.0

「どの拡張子でダウンロードするか選べるようにして」、追加回答「MP4を中心に選びたい」に対応。動画候補ごとのnative selectに「MP4（.mp4）」と元形式/配信の標準を表示し、HLS/DASH・既知MP4はMP4を初期選択とする。未知blobとMP4非対応の元動画は元形式を初期選択にする。

- MP4指定時は、HLSの対応するmuxed TS（H.264/AAC）をローカルでMP4へまとめ直す。DASH/fMP4と実MP4 blobは元データのMP4を使用。直接保存のMP4/M4V系は.mp4名で保存する。WebM等を拡張子だけMP4へ変える選択は無効にし、理由をselectに関連付けて表示する。
- 形式は保存クリック時に確定し、処理中はselectを無効化する。再スキャンで同じ候補の選択を保持するが、新情報で非対応と判明した選択は安全な初期値へ戻す。直接保存のjobにも選択とファイル名を記録し、footerの再試行はそのjobの形式を保持する。
- HLS/blob等の同じ形式での再保存は保持bufferを使う。異なる形式を新しく選んだ保存では以前のbufferを解放して再取得し、元形式と変換後データを混同しない。未知blobのMP4指定はsnapshotの実MIMEと動画署名の検証を通した場合だけ保存する。
- TS→MP4は圧縮済み映像/音声と時計を保つローカル処理。取得・出力の容量上限を保ち、未知codec・暗号化・不正な構造は明示失敗とする。録画形式・権限・外部依存は変更しない。

合成動画で選択した拡張子、実コンテナ、映像・音声の全編を検証する。実サイトやネイティブの権限確認、人間の体験は別確認とする。

## DASH・別音声MP4の保存拡張 — 2026-10-31 / v0.3.0

「もっとwebに埋め込まれた動画を幅広くダウンロード」の継続依頼。以下はv0.2.0の未対応表記に優先する。必要な配信元だけ利用者が許可し、実行時の外部ライブラリ・通信監視・広い必須権限を追加しない。

- 静的で未暗号化のMP4 DASHを保存対象へ追加。単一Period・開始時刻0・SegmentTemplate/Timeline/Listを処理し、BaseURLと区間設定の継承、初期化データ、URL変数、byte rangeを扱う。最高の対応画質と標準音声を選択し、未対応音声を黙って省かない。
- HLSマスターの別音声をDEFAULT→AUTOSELECT→記載順で選択。映像・音声ともfMP4で、長さが対応範囲に収まる場合に合成する。TS/AACの別音声、暗号化、不連続、別映像/字幕は引き続き拒否する。子リスト単独の音声未確認表示は保持する。
- MP4は圧縮済みpacketと時刻を保ち、トラックIDを衝突しないよう再配置し、映像・音声のfragmentを時間順にまとめる。絶対offset等の未対応構成、壊れたbox、暗号化、外部参照は失敗させ、変換や外部サービスへ迂回しない。
- 共通assemblerが映像と音声を一つずつ取得し、合計256 MiB・5000区間を制限。停止・再試行・Chromeの実完了確認と、作業タブ内の単一buffer方針を維持する。配信元の許可は実際に必要な最大32サイトまで。
- 取得候補は既知プレーヤー設定の厳密JSON・JSON文字列へ拡張する。文字列/コメント/正規表現内の見せかけの設定、実行式、任意のJavaScriptは評価しない。JSON-LD embedUrlは埋め込み先、動画を直接指すiframe.srcは動画候補として扱う。

検証は合成したDASH・HLSとMP4成果物で行う。実サイトごとの互換性、聴取品質、ネイティブの権限確認、人間の体験を自動試験から保証しない。

## 埋め込み動画の保存拡張 — 2026-10-31 / v0.2.0

利用者の「webに埋め込まれた動画を幅広くダウンロード」の依頼に対応し、以下は旧版の未実装表記に優先する。二つの目的別画面と既存録画処理は維持する。

- 取得元を動画の遅延属性、型付きリンク、object/embed、動画メタデータ、JSON-LD VideoObject、実行しないJSON設定へ拡張。元ファイル、HLS、blob、DASH、不明を区別。再スキャンで強い型情報・寸法・取得元を保持する。
- activeTabで許可された範囲を起点にallFramesで探索。別サイトの埋め込みは具体的なサイトを画面に表示し、クリックからoptional host permissionを要求して再探索。常時全サイトアクセス、cookies、webRequest、debugger権限は追加しない。
- HLSは未暗号化・終了済み・映像音声が一体の配信を対象に、マスター候補の最高帯域を選択。TSの連結、fMP4の初期化データ＋区間、厳密な範囲取得をサポートする。マスターで別音声等が判明した構成は理由を示して中断する。子リストが単独で検出された場合は別音声を判別できないため、取得中と保存完了に音声が未確認であることを表示する。
- 配信リストと区間のサイト権限は取得前に確認。権限不足なら具体的なサイト名と「配信元を許可して保存」を表示し、クリックで必要なサイトだけ要求。拒否後も再試行可能。リダイレクトの自動追跡・任意のスクリプト実行・外部解析サービスは使用しない。
- Blobは元フレームのisolated worldで一度だけ上限付き取得し、操作トークンで分離したsnapshotを256 KiBずつ転送。終了時の明示解放と60秒の期限で残留を制限する。MSE用blobはファイルとして成功扱いにしない。
- HLS/blobの保存は一つずつ行い、準備・権限待ち・取得中・Chrome保存中・完了・中断を分ける。停止は取得をabortし、開始済みdownloadはcancelして実際の終端を照合。再試行用Blobは一つだけ保持し、別の保存開始時に以前のbufferを解放する。
- HLS/blobは256 MiB、配信リスト1 MiB、5000区間、5階層で制限。作業タブを閉じる前に警告するがクラッシュ復旧は保証しない。ダウンロード受理では完了としない。

実サイトやネイティブ権限確認での互換性は、隔離Chrome合成試験と分けて記録する。HLS暗号化・ライブ・別音声、DASH、DRM回避、変換は範囲外。

## VideoHarbor UX整理 — 2026-10-31（以下の表示設計を更新）

目的別の二つの画面と既存の保存・録画処理を維持し、情報の優先順位と状態表示を整理する。英語の装飾見出し、通常取得の注意色表示、常設の長文を減らす。候補の形式・配信元・寸法・保存状態は一覧に残し、URLを詳細へ。録画はアイコン付き対象カード、音声switch、開閉する保存方法と補足、待機時の図形、録画中の実プレビューと固定操作パネルを使う。短い動きは状態変化にだけ対応し、reduced-motionで無効。

詳細な比較案、独立審査、状態・focusの契約、実装開始判断は [UX-2026-10-31.md](UX-2026-10-31.md)。既存の権限・controller・保存プロトコルは変更しない。以下の「常設設定」「装飾アニメーション不要」は、このUX整理の表示方針を優先する。人間の理解・好み・テンポは自動試験とは別の確認とする。

## v2 amendments (supersede v1 wording below)

- PL-01 / ART-02: Video workspace has two clearly labeled views, default '動画を保存', second '画面を録画'. Direct file saves are '元のファイルを保存'. Stream/blob candidates grouped separately as '直接保存に未対応。録画を試せます' with only a link to recording settings, never automatic start. Empty results also link to settings. Recording explains '選んだタブ・画面全体をWebMで実時間録画。音声の可否は共有対象・OSによる。保護された映像は保存できない場合があります'. Active capture and result show actual track audio presence, method and format.
- PL-02 / ART-01: Freeze each download batch when Save is clicked. Disable duplicate save and re-scan until its jobs reach terminal status. Filtering may change view only, never the batch. Show visible/total counts, selected/hidden counts and batch completed/interrupted/in-progress counts separately. Successful image download automatically deselects only that image. Failures retain selection; retry queues failed jobs only. Deliberate reselection permits re-saving. Re-scan merges state by URL and adds new images unselected. Empty scan and empty filter have different recovery instructions.
- ART-03 / PL-03: Recording controls order target → audio → output mode → output choice → start. File-choice cancel preserves previous chosen output/result and is never treated as new ready/saved. Display picker cancel preserves previous recording result. Previous unsaved memory recording blocks a new start until explicitly saved or discarded; beforeunload warns. During starting/recording/paused/finalizing disable scan/target/audio/output/new starts. Always-visible panel shows method, target, actual audio, elapsed, bytes, pause/resume and Stop. '保存を確定中', 'ファイル保存完了', '録画できました・保存してください' and failure are distinct. Write failure leaves a possibly incomplete file and explicit recovery guidance; never 'saved'. No claim of guaranteed screen recording.
- TECH constraints: recording lock persisted in storage.session with owner workspace tab; clear on tab close and verify owner exists before acquisition. tabCapture.getCapturedTabs supplements lock. For display capture invoke getDisplayMedia immediately in the click handler before any await, acquire lock after capture resolves and stop tracks on lock denial. Tab capture acquires lock in worker, returns stream ID to the consumer tab and consumes immediately. File handle is chosen beforehand; createWritable only after capture consent; writes serialized with promise chain. Finalize after recorder stop/final dataavailable → writes → close. Bound application buffering at 256 MiB (stop threshold, not a strict process-memory cap); 30-minute active recording limit including disk mode. Disk writes have queued-byte limit. onChanged tracks terminal states, active search polling supplies download progress and recovers missed events. Never alter regular Chrome profile. Extension workspace messages accepted only from own workspace page and associated tab/session. Scan rejects a source tab with changed URL/origin, tells user to invoke extension again on that page. Cap source scans and session count with visible notices/controlled error.
- ART details: Header source title/domain and source-tab button, quiet rescan; image toolbar (query/min width/min height/type), visible-count row, native-checkbox grid, sticky action footer. Video direct/record navigation switches focus to selected view heading; active recorder remains primary. Thumbnails use contain, lazy loading, per-card error placeholder. All labels/focus rings visible, status aria-live only aggregates, no high-frequency progress announcements. Width responsive down to 360px. No decorative animation necessary.

Independent reviews requested from planner, artist and programmer; v2 was reviewed before director implementation approval. Human experience remains unverified; this is initial functional implementation, not a public release.

## Director approval — 2026-10-30

v1 independent reviews: planner L1/L2 pass, PL-01/02 must-fix; artist ART-01/02/03 hold; programmer TD-01–06 must-reflect. v2 re-reviewed by the same independent specialists with concrete revised flows: planner L1–L3 pass, artist L1–L3 pass (real L4 pending), programmer pass for bounded v0.1 implementation. All fixed-ID design items resolved in v2. Technical clarification: scanner injects only top document and recursively accesses same-origin frame DOM; capture lock mutation uses one worker queue and per-page owner token, cleans stale reload ownership. Main agent director approves implementation of v2 as a local initial functional version. No public release, real macOS picker/audio claim or human-experience approval. Artist→planner→director integration checked against v2; no conflicting requirements remain. Reviewer input and original verdicts retained in this chat; project DESIGN.md records findings and amendments.

User: create two separate Chrome extensions under separate repository folders; image bulk save with selection before saving, and video save with several methods including screen recording. Future OSS release, no publication now. New empty repositories, no existing source/dirty work, no GitHub remote. Buildless JavaScript ES modules, MV3, Chrome 116+, no runtime third-party dependencies or server. Japanese UI, keyboard usable, local processing, no analytics.

Concept: people browsing a page can inspect what can be saved and deliberately keep the items or scene they need, with an honest result and a recovery path.

ImageCrate: action click opens a persistent full-page gallery for that source tab. Temporary activeTab + scripting access; no permanent all-sites host permissions. Scan img/currentSrc/src/srcset/lazy src, picture sources, CSS background images, open shadow roots and accessible frames. Dedupe by full URL (preserve query). Scan only already-present DOM; no automatic scrolling or network sniffing. Explain inaccessible cross-origin frames and lazy loading. HTTP(S) and image data URLs only in v0.1; page blob URLs explicitly unsupported. Show thumbnail, dimensions when known, source filename. Nothing selected initially. Filter by text, minimum dimensions, image type; select visible/clear selection; hidden selected count and total count remain explicit. Save selection includes all selected; no silent inclusion. Chrome downloads to ImageCrate/<sanitized source title>, unique conflict names, sequential queue. Per-item queued/in-progress/completed/interrupted status, no false 'saved' on request acceptance, retry failed. Preserve selection and completed states on re-scan by URL; do not lose in-flight results. Empty/error/retry states and source-tab navigation/closure handled with visible error; action click on source grants again. Preview requests are limited to shown thumbnails with no referrer. Scan size bounded with visible truncation notice.

VideoHarbor: same persistent workspace with two primary sections, found videos and recording. Scan video/src/source, direct links ending in known video or m3u8/mpd suffixes, performance resource entries with known media suffix (no webRequest). List direct HTTP(S) media files vs streaming manifests/blob/MSE needing recording. Direct save through Chrome downloads, sanitized name, progress/failure/retry. Do not claim all sites supported. DRM/protected content unsupported; no protection bypass. Do not play remote preview automatically or load video URLs merely by listing. No broad host permissions.

Recording: (1) current source-tab capture via tabCapture.getMediaStreamId({targetTabId, consumerTabId: managerTabId}) in service worker, consumed promptly by extension manager using getUserMedia; (2) getDisplayMedia from a direct button click, browser picker chooses tab/window/screen. Explicit start, audio checkbox (system/tab, no microphone), stop/pause/resume. Inline muted preview, recording elapsed time and bytes, audible tab playback restored by AudioContext only for tabCapture. Before start choose output using showSaveFilePicker, but separate 'choose output' and 'start' actions preserve user activation for display picker. Stream chunks via writable file when supported (no large memory growth); fallback in-memory capped at 256 MiB and 30 minutes with visible limit, auto-stop then retain a Blob to save manually. Detect supported WebM MIME; audio track presence shown. User browser stop and source-tab close trigger orderly finalization. Close/reload warns while recording/unsaved Blob; cannot guarantee crash recovery. File output is finalized before reporting ready, on write failure stop recording and show partial-file limitation; no false success. Disable second start/scan conflicts during state transition, prevent overlapping capture across managers using live getCapturedTabs for tab mode and a lightweight worker lock cleared when manager closes. Stop all tracks, close AudioContext after finalize; Blob URL alive through download completion. Keep completed recording available for retry until explicit replacement. No offscreen recording v0.1: workspace must stay open; background-tab throttling/platform behavior to test.

UI: warm off-white canvas, dark ink, indigo selection for images / teal recording for video, clear text labels. Header product + source title; primary action sticky footer; explanatory detail collapsed. Save/record state visible without color dependence, aria-live status and native form labels/focus rings. Initial flow open→inspect→select/start→save result. Repeat use re-scan without onboarding. Compare: popup-only loses state/recordings on close (reject), all-site sniffing adds unnecessary access (defer), combined product creates competing modes (user explicitly requires separate), tab + display capture complement direct download. HLS/DASH assembly, network interception, FFmpeg remux, ZIP image export, region crop and scheduled automation are roadmap items, never dead buttons.

Verification: Node unit tests for URL/filename/filter/merge/media classification/queue states; isolated Chromium with both unpacked extensions and synthetic local fixture for selection/rescan/download completion and recording/cancel/track teardown/save. No existing user Chrome profile or real private page used. Actual macOS display-picker/audio behavior and human experience remain explicitly unverified if isolated automation cannot cover them. README install (chrome://extensions Load unpacked extension/), permissions/privacy/limits, CONTRIBUTING, SECURITY, provisional MIT LICENSE, manual QA matrix and roadmap. Local commits; no GitHub creation/publication because future release only. Director will record implementation-start approval after independent design review resolves requirements.


## v0.1 implementation review and verification — 2026-10-30

- Planner PLI-01 was withdrawn after checking the complete HTML (the download footer existed). PLI-02/03 resolved: per-URL download history is separate from the current batch, recording cannot switch away from its controls while active. Independent planner re-review passed for those code paths.
- Programmer BG-01/02/03 resolved: accepted download batches continue after the workspace closes, capture ownership checks the owner's extension URL, cancellation reconciles Chrome's actual state to avoid marking completed downloads as failures. Independent requirement-based Chrome API mock tests pass.
- Programmer BG-04 resolved: srcset tokenization preserves commas within CDN URL tokens. Dedicated regression tests pass.
- Artist ART-03-UI01 resolved: capture state, actual audio, elapsed time and pause/stop live in a fixed control panel during starting/recording/paused/finalizing. A 360×800 browser check confirms Stop remains in the viewport after scrolling. Independent visual re-review passed with no remaining must-fix findings in that scope.
- Root independently reviewed RecorderController cleanup, final chunk/write ordering, saved-result retention, browser errors and output-handle presentation. The chosen output filename is distinct from the previous result filename; capture-control errors retain safe actionable local explanations.
- Automatic browser tests use a temporary Chrome profile and localhost fixtures. Test-only host access and a test entry point are added only to the temporary copy, never to extension/manifest.json. Image collection/selection/save/retry/rescan and video direct save plus synthetic capture → actual MediaRecorder → pause/resume/stop → saved WebM playback passed. Browser worker stop/restart is verified by a changed boot ID, followed by session result recovery. Tests remove only their own temporary profiles afterward.
- Human first/repeat experience, real toolbar activeTab invocation, native macOS screen/file pickers, actual tab/system audio, protection-dependent output and long background sessions remain unverified. Automatic tests do not claim public-release readiness. No measurement of subjective ease, confidence or timing was performed.

### Scope and priorities after v0.1

Initial functional implementation is delivered locally. Before public release, validate the manual QA matrix and supported-site behavior, choose the final product names/license/attribution, and prepare distribution materials. HLS/DASH assembly, ZIP, remux and other roadmap items remain unimplemented. Future improvements should follow observed demand; no monitoring or publication was enabled.
