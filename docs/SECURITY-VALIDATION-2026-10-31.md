# セキュリティ修正と検証 — 2026-10-31 / v0.5.1

この記録は、確認済みP2「MP4区間検査の計算量による作業画面の停止」、HLS検査のmetadata保持、解析取消と資源所有権、関連するブラウザ/実機QAを扱う。native項目は本人が「実装・自動検証を先に進め、実機確認は後で」を選択したため、後日の未確認事項として残す。

## 変更した境界

- MP4は検査用rangeだけをsortし、隣接rangeと物理順mdatを一度ずつ走査する。元trun/sample/時刻/offsetを保つ。過去全件を各runで検索する経路を除去した。
- HLS/DASHのtop-level binary検査は4種類の存在bitと共通box予算だけを保持する。init/segment/両track合計250,000 boxes、後段muxは別phaseでnested box合計250,000/sample合計4,000,000を制限する。入力/出力の既存256MiB制限を維持する。
- 製品の保存経路では検査/mux/TS remuxを同梱module Workerへ渡す。取得・許可・downloadは親workspaceに保持。Workerは同じ拡張contextであり、権限sandboxとは扱わない。
- operationがcontroller/processor/download IDを所有する。固定kind・要求ID・返却型/量を照合し、abort/error/messageerror/120秒timeout/pagehideで解放。起動失敗時の同期fallbackはない。完成済みretry Blobと受付済downloadの終端照合を維持する。
- 実Chrome116で、tabs APIが自拡張workspace URLを省略し、次のworkspace作成時に前sessionが消える問題を発見した。runtime.getContextsの自拡張TAB/mainframe/documentUrlへ照会し、状態保持と録画lockを判定する。lockは登録済みsessionと正確なworkspace URLにも結び付け、存在しないsessionの画面がlockを保持する問題も修正した。query失敗やdocument読込中は状態を消さず再試行を案内する。追加のtabs権限は要求しない。

## 自動検証

| 対象 | コマンド/入力 | 結果と範囲 |
| --- | --- | --- |
| 基準 | 修正前npm test/check | 199件PASS・SKIPなし、check PASS |
| 計算量/構造の局所修正 | PR #11のcommit内容だけの一時コピー | 208件PASS・SKIPなし、check PASS |
| Worker/取消 | PR #12のcommit内容だけの一時コピー | 227件PASS・SKIPなし、check PASS |
| 最終単体/静的確認 | npm test / npm run check / git diff --check | 241件PASS、失敗・SKIPなし。check/diff check PASS |
| 元のP2の大きい表現 | 120,000 trun＋120,000 empty mdat（既存予算内） | 正常受理、下記のprocess別実測では97.811ms。時間倍率をテストの合否にせず、range sortと一方向走査・同じsample/run出力を確認 |
| 範囲の代替表現 | 非物理順offset、暗黙offset、隣接、重複、内包、負値、header/padding/mdat境界越え | 合法な順序/bytesを維持し、不正を拒否 |
| HLS表現/予算 | size0、64bit extended size、unknown box、実250,001 boxes、初期化/区間/別trackの共有budget | 互換性を保ち、上限を超える次のboxをmetadata追加前に拒否 |
| Worker protocol | transfer/alias、旧id/誤kind、不正返却型/量、abort、timeout、error/messageerror、post失敗、同時要求 | 取消後の採用・次operation干渉・同期fallbackを防止 |
| MediaSaverの取消 | 検査/TS変換中、遅い結果、cleanup中、Chrome受付前/受付中、dispose | 保存前の取消は新規downloadなし。受付済は実終端を照合。再試行・前結果を保護 |
| 録画の境界 | 256MiB未満/一致/超過、32MiB pending未満/一致/解放/失敗、memory/fileのactive30分とpause除外 | 7件の単体回帰PASS。小Blobのreported-sizeと制御時計で実停止・最終chunk・flush・track/lock解放を確認し、大容量実allocationや実時間の代用とは扱わない |
| 実ブラウザ全経路 | npm run test:browser / test:embedded | Chrome156.0.8078.79とCfT116.0.5845.96で双方PASS。実MP4/TS/TS→MP4/fMP4/DASH/別音声HLS/blobの保存、映像・音声track/packet時刻/全編decode、frame/document、worker再起動後session復帰を確認 |
| 実module Worker | npm run test:worker | Chrome156/116とも3endpoint成功、H.264/AAC全編decode、buffer所有権、malformed3種、取消/timeout、10回反復後worker残0。各環境で起動18件/終了後0件 |
| 通信/認証/redirect | npm run test:security | Chrome116/156でPASS。下記の送信境界を実HTTP/HTTPSで確認 |
| 実時間30分/背景 | npm run test:endurance / Chrome156.0.8078.79 | PASS。active1,800,375ms、wall1,803,301ms、pause2,209msを除外して本番30分上限で自動停止。実WebM29,578,985 bytes、映像終端1,799.495秒、映像/音声あり・全編decode成功。全track停止・lock解放・結果破棄を確認。Chrome116の30分実時間試験は未実施 |

Worker取消の確定的なbusy状態には、一時copy内だけのpre-parse barrierを使う。実WorkerとUI heartbeat、abort/terminate発行、返答不採用、Worker終了を試すためのhookであり、製品parserの処理時間実測とは区別する。成功・不正入力の解析と実メディア出力は製品endpointを使う。Chrome116ではCDPのTarget.getTargetsがdedicated Workerを列挙しなかったため、Playwrightが捉える実Workerの存在と終了後0件を確認した。

30分試験の開始後、独立レビューでvisibilityのassert不足を見つけ、試験ソースへ開始時と各記録中snapshotのhidden必須判定を追加した。今回のrunは変更前のロード済み試験コードを使ったため、開始時・毎分・停止時のログを別に照合した。開始時とminute0〜30の31件がすべてhiddenで、sample間隔59〜60秒、最終backgroundVisibilityConfirmed=trueを確認してPASS。今回の背景状態の証拠はそのsampleであり、追加した毎秒assertを実行済みとは扱わない。製品の時計・停止上限・録画処理は変更していない。

実時間試験はJST13:24:06.209〜13:54:12.237。RecorderControllerがtrackを停止した後にfixtureの音源を閉じたことを確認し、cleanupで先にtrackを止めて成功とする試験ではない。capture入力とlockの取得/解放相手は合成で、native capture・実音声・実保存pickerの検証とは分ける。終了コード0で自身の隔離Chrome/profileと一時メディアを解放した。独立差分レビューの試験判定不足はソース上の解消を再確認済みで、追加の製品P1/P2は見つかっていない。

## parserの資源実測

各caseを新しいNode v26.10.0 / V8 14.6 / Darwin arm64のprocessで実行した。V8 old-spaceを256MiB、外側timeoutを12秒に制限し、小さいcaseを1回warmupした。次の時間はfixture生成とGCを除くparser呼出し、peak RSSはmodule読込・warmup・fixture生成を含むprocess全体である。

| 入力 | bytes | 解析時間 | peak RSS（KiB） | 結果 |
| --- | ---: | ---: | ---: | --- |
| 16,000 trun | 272,701 | 11.580ms | 66,816 | 同じbytes数のMP4 |
| 120,000 trun | 2,040,701 | 60.419ms | 114,096 | 同じbytes数のMP4 |
| 120,000 trun＋120,000 empty mdat | 3,000,701 | 97.811ms | 128,992 | 同じbytes数のMP4 |
| HLS 250,000 top-level boxes | 2,000,000 | 2.444ms | 55,968 | 受理 |
| HLS 250,001 top-level boxes | 2,000,008 | 2.398ms | 55,792 | budget250,000で拒否 |

解放と明示GC後のArrayBuffer計測値は各caseで入力前の143,759 bytesへ戻った。RSSはallocatorが保持するため元へ戻ることを要求しない。この単発計測だけでleak不存在とは主張しない。V8 old-space制限はArrayBufferや総RSSの上限ではない。旧版の16,000-run/632msは別scanでの観測であり、単純な速度倍率を合否に使わない。

## 通信と認証の結果

合成3host（same-host/same-site/cross-site）とHTTP/HTTPS、一時証明書、一時Chrome profileだけを使う。hostの信頼設定は変更しない。Cookie/Authorization/Refererは値を保存せず有無だけを記録する。

- 未許可hostはpermissions.containsで止まり、通信が始まらない。
- Plain/Lax/Strict/None/Secure/HttpOnlyの6種類のCookieについて、HTTP/HTTPSとsame-site/cross-siteの組合せを確認。通常Web pageの対照も確認した。拡張のhost許可がある取得ではStrict Cookieも送られ得るChromeの扱いを、独自のCookie読出しと混同しない。
- fetchResourceはRefererなし、401/403をそのまま応答として受け、Range206の範囲と実bytesを確認。
- ダミーBasic認証は指定originで200とAuthorizationありを確認し、別originへ同じAuthorizationを送らない。
- 301/302/303/307/308 × same-host/same-site/cross-siteを試し、stream fetchはredirect先への通信がない。
- 同じ15通りのChrome直接downloadはredirectに追従して実保存された。転送先自身のCookieは送られ得るが、別originへのAuthorization転送はなかった。製品はChromeの直接保存に、stream fetchと同じredirect禁止を保証しない。
- nativeの追加許可/認証dialogや個人の実サイトログインは、この合成試験で実施済みとは扱わない。

## Chrome116の検証環境

Google公式[Chrome for Testing milestones](https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json)が指す116.0.5845.96/mac-arm64を一時領域だけで使用。公式ZIPのローカルSHA-256は `5d1ed2c87a9fb47b20aa6ac3bff49e193ea3ddfbaba07b062c8d1782cf853e69`。

この古い公式配布物はadhoc署名でCodeResourcesを含まず、codesign --verify --strictは失敗した。CRC、ZIP内mode/symlinkと展開結果の一致、公式配布元を確認して合成ローカル試験のみに使い、署名検証済みとは報告しない。再署名、Gatekeeper/Keychain/global設定の変更、個人profile、外部siteの閲覧は行っていない。

116の拡張読込はCLIとheadless=new、現行ChromeはCDPを使用する。116のextension binding起動待ちと旧CDPのdefault context差をtest helperで扱う。試験だけを通すために製品権限やdownload/codec処理を差し替えない。

## 後日の本人確認

自動検証の完了と、次のnative項目の完了を分ける。再開は `npm run qa:ux` で合成ページを作り、[本人確認手順](UX-MANUAL.md)に従う。進行中の録画や未保存データを先に保存してから、対象版の拡張を再読み込みする。

| ID | 対象 | 本人操作とAI準備 | 完了の証拠 |
| --- | --- | --- | --- |
| N1 | activeTabと追加site許可の実dialog | AIが合成埋込と期待結果を準備、本人が許可/拒否/再試行 | 許可先と画面説明の一致、拒否時の未取得 |
| N2 | native共有/OS権限 | 本人が合成tab/私的内容を映さないwindow/画面を選択、取消/共有停止 | 対象一致、前結果保持、全track停止 |
| N3 | 実tab/system音声 | AIが色/音/同期markerを準備、本人が聴取、AIがtrack/非無音/同期解析 | 対象別の音声有無と聴取結果。OS非対応は理由/UI/文書を一致 |
| N4 | 実保存picker/専用folder/Finder | 本人が新しい2ファイルを選択、取消と連続保存、AIがhash/再生を確認 | 前ファイル不変、保存先の再選択、実保存結果 |
| N5 | 実サイト認証/期限付きURL | 本人が対象と許諾済みメディアを指定して認証、AIが最小代表手順を準備 | 対象版での結果。秘密値/署名URL/private mediaを記録しない |
| N6 | 実captureの容量/遅い保存先/背景 | AIが測定を準備し本人が対象/保存先を選ぶ | 約256MiBの最終chunk超過量、32MiB書込待ち、停止・不完全file表示を実環境で確認 |

本人操作待ちの行は未確認のまま残す。実行不能やSKIPをPASSへ変えない。対応しないOS/音声の組合せは、実挙動と説明を一致させて判定する。

## Gitと修正確認

- PR #11: MP4/HLS計算量とmetadata、merge `44a35f23556837398186dfa3f0518db016267154`。
- PR #12: Workerとoperation取消、merge `e0f8d7216d490571f23d1654eecd0e483acb963f`。
- [PR #13](https://github.com/TaigaShinohara/VideoHarbor/pull/13): Chrome116の状態保持、追加QA・境界検証と文書。マージ結果と最終commitはPRの記録を参照する。
- 元P2は、同じ攻撃構造の受理/正しい拒否、合法入力、実Worker/実保存の再検証で確認する。文書を追加しただけで修正済みとは扱わない。

