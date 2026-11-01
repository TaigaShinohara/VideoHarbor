# 情報監査後の対応結果 — 2026-11-01 / v0.6.1

[対応計画](PRIVACY-REMEDIATION-PLAN-2026-11-01.md)を本人の実装依頼に基づいて適用した。計画時の基準は `455b09d` / v0.6.0。実装の対象は現行文書・今後のGit識別情報・URLの表示・新規保存名・閉鎖後session・ローカル再検査で、過去履歴や既存の保存物を消去する作業ではない。

## 実施内容

| 対象 | 結果 |
| --- | --- |
| 内部参照・連絡先 | 内部Notion URL/ページIDと個人所有者を含む固定PR URLを現行文書から除去。PR番号・基準commit・ローカル仕様/結果は維持。SECURITY.md/CONTRIBUTING.mdの連絡先を本人指定の `deeple+videoharborstaff@inkboxmail.com` に統一 |
| Git識別情報 | このリポジトリだけに `VideoHarbor Staff` と指定メールを設定。グローバル設定や他プロジェクトの設定は変更せず、GitHubのnoreply/サービス用committerは別に確認 |
| URL表示 | 保存元は候補番号・host・形式・寸法で表示。path/query/hash、URL basename、`data-url`、録画select内のdocument URLを通常DOMから除去。完全URLと実document参照はメモリに保持して同一性・取得・再試行へ使用 |
| 新規保存名 | 直接保存・組立保存・録画は製品folder/日付/時刻/連番の中立名。pickerは中立basenameを提案し、本人の指定名は維持。同形式の失敗再試行と録画再保存は確定名を保持し、実形式の拡張子・Chrome uniquifyを維持 |
| 閉鎖後session | 候補・元ページ題名/URL・JPEG・frame情報を除去。queued jobだけ取得用URL/確定名/形式を保持し、受付後はdownload ID/状態/形式だけへ縮小。全job終端でstorageのsessionを削除 |
| 競合処理 | Chromeの受付返答が遅れても閉鎖の情報除去を待たせない。storage書込順と閉鎖したsessionの同一state所有を保ち、遅延snapshotによる情報復元や同じ次jobの二重開始を防止 |
| 再検査 | `npm run audit:information` を追加。Node標準APIだけを使い、外部送信/実行時依存/クラウドCI/有料スキャンを追加しない。値を出さない所在・種別・件数のJSONを出力 |

## 検証

新しいURLのDOM漏洩回帰は旧rendererで失敗し、現行で成功することを確認した。閉鎖前の遅延受付・古いstorage cloneの競合も修正前の失敗と修正後の成功を確認し、独立レビューで再確認した。

隔離Chrome・localhost合成メディアによる `test:browser` / `test:embedded` / `test:video` / `test:security` / `test:worker` を実行した。直接保存・HLS/DASH/blob・TS変換の実ファイル、全編decode、録画の対象映像/音分離、実OPFS、Workerの取消/timeout/後片付け、Cookie/認証/Referer/redirectの境界を確認した。元の完全URLでの取得と、未知/大小混在query・opaque pathがDOMに出ないこと、query違いの形式選択・再スキャン保持も検証した。

全334 unitは成功、失敗・SKIPなし。`npm run check` と `git diff --check` も成功した。

現行Chromeの `test:privacy` は、API返答だけを遅延させた本物のdownload、閉鎖直後の最小化、対象Workerの強制終了とモジュール起動IDの変化、明示runtimeメッセージを使わないnative downloadイベントによる残り2本の保存、全session削除を検証した。3本の実ファイルはChromeのcomplete/exists・中立名・サイズ・SHA-256で確認した。debugger下の強制再起動であり、自然なidle停止だけの確認とは区別する。

Chrome116でも6つのブラウザ試験（browser/embedded/video/privacy/security/worker）がすべて成功した。公式Chrome for Testing 116.0.5845.96/mac-arm64のZIPは、既存QA記録のSHA-256 `5d1ed2c87a9fb47b20aa6ac3bff49e193ea3ddfbaba07b062c8d1782cf853e69` と照合し、タスク専用の一時プロファイルだけで使用した。試験helperのasync待機とChrome116の合成fixture生成を修正し、同じ検証条件を維持して通過させた。

実行環境・試験表は `QA.md` に記録する。実OS picker・実音声の聴取・本人の操作体験・任意の実サイト・30分の長時間試験は今回の自動検証から分ける。

## 情報点検の判定

検査は追跡/未追跡の現行ファイル、ignoredの一覧、到達不能を含む全ローカルGit blob、commit message、author/committer metadataを対象とする。実資格情報形式、固定認証値、内部文書リンク、個人home path、指定外のメール等を検査する。未走査の大きなfile・symlink・binary・秘密ファイル名等は成功扱いにせず、確認を必要とする結果を返す。

現行の検出と歴史的な残存を分ける。履歴の内部参照は既存2文書のpathと種別に限定した `legacy-reference`、Staff/noreply/GitHubサービスのmetadataは件数として報告する。実URL・ページID・個人メールを例外policyへ再埋込しない。実資格情報・未知の個人メールは履歴や到達不能blobでも失敗とする。

テスト全体を除外せず、予約domain・限定dummy値・合成pathを文脈付きで分類する。正しい資格情報形式の検出、現行/歴史の区別、出力への値の非漏出、未追跡/到達不能file・commit message・metadata・ignoredの確認を検査自体のテストで検証した。npm integrityと第三者の著作権表示は保持した。

`node_modules/`は一覧だけを確認し、再検査CLIでは内容を除外する。初回監査で分類済みの同じ開発依存であり、今回その内容を再監査したとは扱わない。32 MiBを超えるfile/object、未知・難読化された秘密、リモートだけの削除済みref、他clone・バックアップは無条件に安全と判断しない。検査結果の `coverage` / `limitations` も併せて確認する。

## 残る情報と未実施の範囲

- 非公開の開発履歴にある旧内部参照・GitHubアカウントとの結び付きは残る。通常の文書修正で過去objectや他cloneの情報は消えない。force push・ref削除・公開は行っていない。
- 保存/同一性/再試行に必要な完全URLはメモリ/sessionで扱う。queuedの直接保存は受付まで取得URLが必要。Chrome自身のdownload履歴と元URLは、拡張のsessionとは別に保持され得る。
- 選択に必要な動画題名・preview・配信元host、本人が付けたファイル名、保存済みメディアの顔/声/文字等は残る。画面やメディア全体の匿名化ではない。録画の再エンコードとmetadataの扱いは保存方式ごとの仕様に従う。
- 既存のファイル・Chrome履歴・第三者著作権表示は変更しない。指定メールの受信確認、メール送信、GitHubアカウントへの追加・primary設定変更は行っていない。
- 既存の本人実機QA待機を、自動試験の成功で完了へ変更しない。将来の一般公開は別の判断とする。
