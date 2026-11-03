# VideoHarbor 貢献ガイドライン (Contributing Guide)

VideoHarbor への貢献をご検討いただきありがとうございます！
バグ報告、新機能の提案、ドキュメントの改善、プルリクエストなど、あらゆる貢献を歓迎します。

---

## 開発の基本原則

VideoHarbor は以下のコア設計原則を厳格に維持しています。変更を行う前に必ずご確認ください。

1. **Manifest V3 ＆ 完全ローカル処理**:
   - ビルドステップ（トランスパイルやバンドラー）を介さず、`extension/` 配下のネイティブESモジュールを直接読み込む構成を保ちます。
   - 実行時の外部依存ライブラリ（CDNや外部npmパッケージ）や外部サーバー通信は一切追加しません。すべてのメディア結合・処理は同梱のWeb Workerやブラウザ標準APIで完結させます。
2. **最小限の権限（Least Privilege）**:
   - 一時的な `activeTab` 権限を優先します。全サイトへの常時ホスト権限、Cookie、debugger、webRequest等の強い権限を無断で要求・追加しないでください。
3. **プライバシーと機密性の保護**:
   - ログイン情報、アクセストークン、署名付きURL、私的な録画メディア、ブラウザプロファイルをコード・コミット・Issueに含めないでください。
   - テストや不具合報告には必ず合成データ（合成fixture・ダミーURL等）を使用してください。
4. **ドキュメントの整合性**:
   - 設計上の判断や変更は [docs/DESIGN.md](docs/DESIGN.md)、検証結果や未確認の境界は [docs/QA.md](docs/QA.md) に記録します。

---

## 開発環境のセットアップ

### 必要要件
- Node.js 22 以上
- Google Chrome（Chrome 116 以上推奨）または Safari（iOS 15+ / macOS）
- （任意）ローカル検証用の `ffmpeg` / `ffprobe`

### セットアップ手順
```sh
# リポジトリのクローン
git clone https://github.com/TaigaShinohara/VideoHarbor.git
cd VideoHarbor

# 開発用依存関係（テスト用Playwright等）のインストール
npm ci
```

### ブラウザへの読み込み（開発・デバッグ）
1. Chromeで `chrome://extensions` を開き、右上の「デベロッパーモード」を有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」をクリックし、リポジトリ内の `extension/` フォルダを選択します。
3. 任意のWebページで拡張アイコンをクリックして動作を確認できます。

---

## テストと検証

変更を加えた際は、提出前に以下のテストとチェックを実行してください。

```sh
# 単体テスト・回帰テストの実行（390件以上のテスト）
npm test

# Manifest V3仕様・権限・構文・アイコン検証
npm run check

# 機密情報・個人情報パターンのローカル監査
npm run audit:information

# （任意）ブラウザ統合試験（Chromeの一時プロファイルで起動）
npm run test:browser
npm run test:video
```

---

## プルリクエスト（PR）の流れ

1. `main` ブランチから作業用ブランチを作成します（例: `feature/my-new-feature` や `fix/issue-description`）。
2. コーディングとローカル検証を行い、テストがすべてパスすることを確認します。
3. コミットメッセージは変更内容が明確にわかるように記述してください。
4. プルリクエストを作成し、PRテンプレートに従って概要・変更点・チェックリストを記入してください。
5. CI（GitHub Actions）のチェックがすべてパスすることを確認してください。

---

## セキュリティ・行動規範

- 脆弱性の報告については [SECURITY.md](SECURITY.md) を参照してください。
- コミュニティでの活動においては [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) の遵守をお願いいたします。
- 開発上の連絡先: **deeple+videoharborstaff@inkboxmail.com**
