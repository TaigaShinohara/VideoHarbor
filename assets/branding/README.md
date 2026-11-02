# VideoHarbor — Liquid Glass icon v1

2026-11-02に「アイコン画像を作ろう / liquidglassデザインで。」の依頼で制作した画像素材。

![Liquid Glass icon](videoharbor-liquid-glass-v1.png)

- 原本: `videoharbor-liquid-glass-v1.png`
- 形式・寸法: PNG / 1254 × 1254 px / 正方形 / 背景あり
- モチーフ: 動画の再生マークを、港・保存先を表すU字のガラスが受け止める。
- 色: 既存UIの `#147568` を起点に、深いティールと淡いミントを使用。
- 生成方法: Codex内蔵 `image_gen`。出力原本を加工せず保存。
- 確認: 生成画像の構図・文字なし・ガラスの表現を目視確認し、PNG形式と寸法を確認。
- 状態: 2026-11-02の追加依頼で拡張アイコン・ツールバー・作業タブfavicon・画面内ロゴへ組み込み。通常利用中のChromeへの再読み込みと本人による見え方の確認は未実施。

## アプリ用PNG

原本を保持し、macOSの `sips` で必要な寸法へ縮小したPNGを `extension/icons/` に同梱する。実行時の生成・外部取得・追加依存はない。

- `icon-16.png` / `icon-32.png` / `icon-48.png` / `icon-128.png`: manifestの拡張アイコン。
- `icon-16.png` / `icon-24.png` / `icon-32.png`: ツールバー用。
- `icon-32.png`: 作業タブのfavicon。
- `icon-128.png`: ヘッダーロゴ。画面幅に応じ38 / 33 / 30 pxで表示する。

再書き出しはリポジトリのルートで実行する。

```sh
for icon_size in 16 24 32 48 128; do
  sips -z "$icon_size" "$icon_size" assets/branding/videoharbor-liquid-glass-v1.png --out "extension/icons/icon-$icon_size.png" || exit 1
done
```

## 生成プロンプト

```text
Use case: logo-brand
Asset type: a finished square application icon image for VideoHarbor, a local video-saving and recording Chrome extension.
Primary request: Design one beautiful premium Liquid Glass icon. A bold simple right-facing play triangle is gently cradled by one broad upward-open U-shaped harbor / receiving tray below it, expressing a video brought safely into harbor. The play triangle and harbor must read as a single clean emblem.
Style/medium: exceptionally polished dimensional optical glass, contemporary Liquid Glass app-icon design, soft sculpted contours, physically convincing translucency, thick rounded glass edges, subtle refraction and delicate white specular highlights. Restrained and elegant.
Color palette: build on the existing product's deep sea green #147568. Rich dark teal and emerald background, seafoam and nearly clear pale mint glass emblem, subtle cyan along refracted edges. Carefully controlled contrast.
Composition/framing: exactly one centered icon, square 1:1 image. Full-bleed square deep-teal gradient backdrop with softly illuminated rounded-square glass surface filling the image. Straight-on front view, no tilt or perspective. The emblem occupies about 65% of the width, large enough to recognize at small sizes. Broad simple forms, generous breathing room around the emblem.
Lighting/mood: soft upper-left studio illumination, crisp luminous rim highlights, quiet premium finish. Subtle depth, no dramatic cast shadow outside the icon.
Materials/textures: truly glass-like optical thickness, smooth immaculate surfaces, gentle internal distortion and soft reflected light, not metal or opaque plastic.
Text: none.
Constraints: a single finished icon asset only; no mockup, no presentation sheet, no typography, no letters, no watermark, no badges, no extra icons, no filmstrip, no anchor, no camera, no tiny ornaments, no busy scene. Maintain a strong readable silhouette.
```
