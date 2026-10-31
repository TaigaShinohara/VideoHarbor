# 動画だけの録画 — v0.6.0

## 目的と範囲

2026-10-31の本人依頼「ページ全体ではなくその動画のみ録画したい」に対し、計画を比較・独立審査した後、「その方針で完璧に対応して」の指示で試作・実装へ進めた。対象は選んだ動画要素の映像と、その要素が持つ音声。ページの文字・別動画・重なるHTML UIは含めない。HTMLの字幕は含めず、映像に焼き込まれた字幕は残す。

既存の直接保存、タブ全体、画面・ウィンドウ録画も残す。Chrome116+/MV3、ビルド不要、実行時の外部依存・解析送信なし、既存の最小権限を維持する。DRM回避、任意矩形crop、音声経路の書換え、公開・ストア配布は対象外。

## 比較と採用ゲート

| 方式 | 判断 |
| --- | --- |
| HTMLVideoElement.captureStream | 対象の映像・音声を分離できるため第一候補。CORS/保護/音声経路に制約がある。 |
| tabCaptureの映像をcanvasでcrop | 重なり・タブ内の他の音・座標追従が課題。今回の標準にしない。 |
| Region/Element Capture | Chrome版・別タブ経路との成立性が必要。Chrome116を含む標準処理に依存しない。 |

許可された先行試作で、実動画captureStream→source MediaRecorder→JSON/base64分割→保存→全編decodeを確認して採用を決めた。現行Chrome156とChrome for Testing116で、WebM/VP8+Opus、背景タブ、pause/resume、選択映像・音声のみの収録が成立した。Chrome116のこの実行環境はH.264/AAC MP4を再生できなかったため、116の録画試験にはWebMを使用した。

Chrome116では元動画がmutedまたはvolume=0の場合、liveなaudio trackがあっても出力音声がなかった。現行Chromeとの版差を隠さず、全版で元動画がミュート/音量0なら音声なしと判定し、取得したaudio trackも外す。初期状態でmuted/endedのcaptured audio trackも外し、音声なしの選択後に復帰して混入しないようにする。音声要求時は録画・writer開始前に「音声なしで続行/対象を選び直す/中止」を選べる。元ページの設定を変更せず、音声あり録画中にミュート/音量0になった場合は停止する。

根拠：[Chrome captureStream](https://developer.chrome.com/blog/capture-stream)、[W3C Media Capture from DOM Elements](https://w3c.github.io/mediacapture-fromelement/)、[Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Region Capture](https://developer.chrome.com/docs/web-platform/region-capture)、[Element Capture](https://developer.chrome.com/docs/web-platform/element-capture)。Regionの別タブ対応にはChromiumの実装進展があり、公式解説だけから絶対不可とは断定しない。

## 対象選択と状態

保存元URLと実動画要素を別に収集する。URLのないsrcObject動画も実在確認できれば選択可能。metadata・読み込み履歴だけの候補は動画単体録画の対象にしない。元のframe/document/要素tokenを保持し、開始直前に同一性、再生元、再生準備・paused/ended・保護・実trackを確認する。未再生なら元ページでの再生を案内し、先頭戻し・自動playは行わない。

動画カード「この動画を録画」→対象名/取得済みサムネイル/元ページで確認→音声/保存方法→明示開始→一時停止・再開・停止→実結果の再生・保存。ライブ映像を別タブへ複製しないため、録画中は対象名と状態を表示し、停止後に実録画を再生する。サムネイルをライブプレビューとして表示しない。

元動画の再生位置・速度・seekに従う。元動画自体のpauseは再生内容に反映され、拡張の一時停止は録画のみを止める。通常終了は自動停止、loopは手動停止/上限停止。再生元・要素・track構成の変更は別動画へ追従せず停止する。音声/映像の取得不能は失敗として表示する。

## 所有・転送・後片付け

- 拡張workspaceが排他、保存先、writer、受信済みBlob、保存結果を所有する。sourceフレームは実stream/MediaRecorderと転送待ちデータのみを所有する。Service Workerは状態と参照を検証し、録画データを長期保持しない。
- captureStreamがsrcObjectの入力trackを共有する場合があるため、録画には専用cloneを使う。元ページが所有する新旧入力trackは停止・除去せず、拡張が所有するcloneとfile/MSE用raw capture trackだけを終了時に解放する。元動画の再生を録画停止へ巻き込まない。
- workspaceのsession/instance、保存済み実VIDEO参照、captureLock、録画token、frame/documentを照合し、正確なフレームへself-contained関数を注入する。ページ起点の外部接続や広いhost権限は追加しない。
- sourceの圧縮データは最大192KiBずつbase64へ変換し、連番とACKで一度ずつ渡す。最終dataavailable後の全データ受領を待ってstopを通知し、その後writer.closeの成功を確認して保存完了にする。
- pollは実行待ちから受領処理完了まで一つに限定する。1要求の応答はworkspace側6秒/source注入側5秒、終了データ待ちは120秒で打ち切り、受信済みデータの未確認救済へ移る。永久に保存確定中にしない。
- sourceの単chunk最大4MiB、待ちBlob最大8MiB。base64は1block最大256KiB、変換用配列・文字列とChrome側のJSONコピーも発生する。ブラウザ全体の厳密なメモリ上限とは説明しない。workspaceの既存受信約256MiB/書込待ち32MiBの停止も維持する。
- 最大30分の実録画時間をsourceとworkspaceで監視する。sourceは15秒のleaseを持ち、workspace応答が失われると録画・track・listener・queueを解放する。正常終了/取消でも明示解放する。
- 元ページ/フレーム消失・転送失敗時は受信済みメモリデータの救済を試す。完全なファイルや再生可能性を保証せず、エラーと未確認を示す。writer失敗は不完全ファイルの可能性を示す。クラッシュ復旧は今回も未実装。

## 検証記録

2026-10-31：`npm test` 275件PASS、失敗・SKIPなし。`npm run check`、`git diff --check` PASS。既存の隔離Chrome `npm run test:browser` PASS。実動画録画の製品経路QAは以下へ追記する。

独立レビューの指摘と処理：

| ID | 指摘 | 修正と再確認 |
| --- | --- | --- |
| RV01/P1 | 遅い停止中にpollが二重化し、同じACKの再送で最終データを打ち切る | poll全体single-flightと遅延予約。同じ350ms停止/100ms pollの独立Node再現でエラーなし。複数sliceの順序と全データ受領を単体試験。 |
| RV02/P1 | 準備後の接続消失が音声判断待ちへ届かない | prepared後もerror/stopを通知。実adapter＋controllerで音声判断中の接続消失とlock解除を試験。 |
| RV03/P2 | 開始前track終了を無視する | prepare中のtrack終了も停止し、available=false/done=trueと再開始拒否を試験。 |
| RV04/P2 | 初期mutedのaudio trackが音声なし選択後に復帰して混入 | 利用不能なaudio trackをprepare時に除去。元動画のmute/volume0監視もvolumechangeと状態確認の両方に実装。 |
| QA01 | captureStreamの遅い初期track通知で開始前に構成変更と誤認 | 初期の実track集合を保持し、イベント名だけでなく実集合の差分で停止を判定。初期通知後の開始と実追加・削除の停止を試験。 |
| QA02 | srcObjectの入力共有trackを停止し、元動画の再生も止める | 専用cloneで録画し、入力trackを保護。file/MSE用の専有rawは解放し、正常・例外・lease・source差替えを試験。 |
| RV05/P2 | 自然終了と同時のraw ended/mutedを取得失敗と誤認 | video.endedの正常終了を先に判定し、停止処理開始後の遅い監視イベントを無視。自然終了とraw muteの同時状態を試験。 |

独立再レビューは上記の解消と、確認範囲に追加P1/P2の阻害要因がないことを確認した。根拠は静的レビュー・限定Node再現であり、ブラウザQAや人間の確認の代用にはしない。

実OS picker、実音声の聴取品質、個人の実サイト、通常Chromeでの本人の操作理解は隔離自動試験とは別確認とする。動画だけの30分実時間・OSスリープを含む長時間動作は今回未確認。
