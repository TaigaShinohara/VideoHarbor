# VideoHarbor — iOS Safari Web Extension 運用ガイド

VideoHarborをスマートフォン（iOS 15+ / iPadOS / macOS）の Safari 上で動かし、デスクトップと同等の安全な動画保存体験を提供するための仕様および導入手順です。

---

## 1. モバイルSafariにおけるユーザー体験

- **起動方法**:
  - Safariのアドレスバー左端（または右端）の「ぁあ / aA」メニュー、または「共有」シート内の「拡張機能」から「VideoHarborを開く」をタップします。
  - 閲覧中ページのログイン状態やCookieを維持したまま、別タブ（作業画面）で動画候補の探索結果が表示されます。
- **UI・片手操作の最適化**:
  - ノッチやDynamic Island、ホームバーのセーフエリア（`env(safe-area-inset-*)`）に自動追従します。
  - すべてのボタンやタップ領域は最低44px〜48pxを確保しており、親指で快適に操作できます。
- **動画の保存先**:
  - Web Share API（`navigator.share`）と連携し、保存完了時にiOSの共有シートが開きます。
  - 「写真（カメラロール）に追加」または「"ファイル"に保存」をタップして、端末ストレージに保存できます。
- **長時間処理のスリープ防止**:
  - HLSやDASHの分割ストリーム取得・MP4結合中は、Screen Wake Lock APIにより画面の自動スリープ（消灯）を防止します。

---

## 2. Safari Web Extension への変換・ビルド手順

Appleの標準ツール `safari-web-extension-converter` を利用して、VideoHarborの `extension/` ディレクトリからXcodeプロジェクトを生成します。

### 必要な環境
- macOS 13 (Ventura) 以上
- Xcode 14 以上（iOS 15以上のターゲットをサポート）

### コマンド実行

ターミナルで以下のコマンドを実行します：

```sh
# XcodeツールでSafari拡張アプリプロジェクトを生成
xcrun safari-web-extension-converter extension/ \
  --project-location ./safari-build \
  --app-name "VideoHarbor" \
  --bundle-identifier "com.example.videoharbor" \
  --swift
```

### Xcodeでのビルドと実機転送
1. 生成された `safari-build/VideoHarbor/VideoHarbor.xcodeproj` をXcodeで開きます。
2. ターゲットを **「iOS」**（iPhone実機またはシミュレータ）に設定します。
3. **Signing & Capabilities** でご自身のApple Developerアカウント（またはPersonal Team）の署名を選択します。
4. 実行（Build & Run）すると、コンパニオンアプリが端末にインストールされます。

---

## 3. iOS 実機での拡張機能の有効化

1. iPhoneの **「設定」>「Safari」>「機能拡張」** を開きます。
2. 一覧から **「VideoHarbor」** を選択し、**「機能拡張を許可」** をONにします。
3. 「アクセス権」で「確認」または「許可」を選択します。
4. Safariを開き、アドレスバーの拡張機能アイコン（パズルアイコンまたは共有メニュー）からVideoHarborを起動します。

> [!NOTE]
> 未署名の開発版拡張機能を読み込む場合は、iPhoneの「設定」>「Safari」>「詳細」>「Webインスペクタ」をONにし、MacのSafari開発メニューから「未署名の機能拡張を許可」を有効にします。

---

## 4. モバイル環境での機能差異と安全な制限

| 機能 | デスクトップ Chrome | iOS Safari (拡張) | 理由・代替策 |
| :--- | :---: | :---: | :--- |
| **動画検出（DOM/JSON-LD/リンク）** | ○ 完全対応 | ○ 完全対応 | 同一の検出エンジン（`collector.js`）で動作 |
| **MP4直接保存** | ○ Chrome DL | ○ Web Share / DL | 写真・ファイルアプリへ直接保存可能 |
| **HLS / DASH の MP4結合保存** | ○ Worker結合 | ○ Worker結合 | Screen Wake Lock APIでスリープを防止 |
| **動画要素のみの録画** | ○ captureStream | × API非対応 | WebKitの仕様制約。OS標準画面収録を案内 |
| **タブ / 画面全体の録画** | ○ getDisplayMedia | × API非対応 | WebKitの仕様制約。コントロールセンターの画面収録を案内 |

---

## 5. バックグラウンド動作とメモリ制限に関する注意点

- **フォアグラウンド処理**:
  iOS WebKitは、作業タブがバックグラウンドに回ると短時間でJS実行をサスペンド（停止）します。HLS等の結合処理中はタブを切り替えずに完了をお待ちください。
- **メモリ上限**:
  モバイル端末のメモリ制限に配慮し、動画結合の上限はデスクトップ同様256 MiBに制限されています。
