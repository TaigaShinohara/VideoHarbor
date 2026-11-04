# VideoHarbor

[![CI](https://github.com/TaigaShinohara/VideoHarbor/actions/workflows/ci.yml/badge.svg)](https://github.com/TaigaShinohara/VideoHarbor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](extension/manifest.json)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20116%2B%20%7C%20iOS%20Safari%2015%2B-orange.svg)](docs/SAFARI-MOBILE.md)

English | [日本語](README.md)

**VideoHarbor** is a privacy-first, open-source browser extension (Chrome & Safari Web Extension) designed for direct video saving and selective recording (specific video element, entire tab, screen, or window).

Zero build steps, zero external runtime dependencies, 100% local processing.

---

## Key Features

- **Direct Video Saving**:
  - Automatically identifies video sources from `<video>`, `<source>`, lazy-load attributes, direct links, Open Graph / Twitter cards, JSON-LD `VideoObject`, and player configurations without executing arbitrary scripts.
  - Choose between original format or remuxed **MP4 (`.mp4`)**.
  - Local MP4 packaging for non-encrypted **HLS** (TS/fMP4 with H.264/AAC without re-encoding) and static **DASH** streams.
  - Direct download support for video blobs.
- **Selective Video & Screen Recording**:
  - **Video Element Recording (`captureStream`)**: Records only the chosen video element (video + audio) in WebM format without capturing page UI, overlays, or unrelated background sounds.
  - Automatically pauses the source video when recording finishes; synchronizes playback state upon start.
  - **Tab & Display Recording**: Supports tab capture (`tabCapture`) and full screen / window recording via standard picker (`getDisplayMedia`).
  - Sequential streaming file write support via File System Access API (OPFS).
- **Mobile & Safari Web Extension Support**:
  - Safari Web Extension conversion for iOS / iPadOS / macOS. API availability and verified environments vary; see [docs/SAFARI-MOBILE.md](docs/SAFARI-MOBILE.md).
  - Responsive layout with `env(safe-area-inset-*)` adherence and touch-friendly 44px+ tap targets.
  - Without `chrome.downloads`, direct MP4 files can also be fetched and inspected within a 256 MiB budget, then handed to a destination through **Web Share API**. A successful share means handoff, not confirmed persistence in Photos or Files.
  - One prepared file is retained per workspace until confirmed download completion or explicit discard. Retry sharing uses the retained bytes, including after rescanning. Another source or format cannot silently replace them. Closing/reloading the workspace or stopping the browser loses in-memory data. See the [stability validation record](docs/STABILITY-2026-11-04.md).
  - Requests **Screen Wake Lock** during acquisition when available and permitted. Keep the workspace visible; this cannot guarantee continued execution during OS sleep or background suspension.
- **Privacy & Security by Design**:
  - **No external telemetry, analytics, or cloud relay**: All parsing, remuxing, and recording occur inside your local browser.
  - **Least Privilege (`activeTab`)**: Does not require broad `<all_urls>` host permissions. External HLS origins are prompted on-demand with user consent.
  - Sanitized UI prevents XSS; sensitive signed query parameters and URLs are isolated in-memory/session and never printed to DOM attributes or logs.

---

## Installation & Getting Started

### Google Chrome (Chrome 116+)
1. Clone or download this repository:
   ```sh
   git clone https://github.com/TaigaShinohara/VideoHarbor.git
   ```
2. Navigate to `chrome://extensions` in Chrome and toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`extension/`** folder in this repository.
4. Open any webpage and click the VideoHarbor icon in the toolbar.

### Safari (iOS 15+ / iPadOS / macOS)
See the detailed guide in [docs/SAFARI-MOBILE.md](docs/SAFARI-MOBILE.md) for converter commands, building with Xcode, and testing in simulator or on device.

---

## Development & Testing

Requires **Node.js 22+**:

```sh
# Install development dependencies (Playwright for browser testing)
npm ci

# Run unit tests and regression tests (390+ tests)
npm test

# Verify Manifest V3 integrity, permissions, PNG icons, and JavaScript syntax
npm run check

# Audit for accidental credential or personal information leaks
npm run audit:information

# Run browser tests with isolated Chrome profile (requires Chrome)
npm run test:browser
npm run test:video
```

---

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — Architecture and design specifications
- [docs/QA.md](docs/QA.md) — Verification matrix, test results, and known boundaries
- [docs/SAFARI-MOBILE.md](docs/SAFARI-MOBILE.md) — Safari Web Extension setup & mobile notes
- [docs/SECURITY-VALIDATION-2026-10-31.md](docs/SECURITY-VALIDATION-2026-10-31.md) — Security validation record

---

## Contributing & Code of Conduct

Contributions, bug reports, and suggestions are welcome!
Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before submitting an issue or pull request.

For security concerns, please refer to [SECURITY.md](SECURITY.md).

---

## License

This project is licensed under the [MIT License](LICENSE).
Please use responsibly in compliance with copyright and terms of service of respective media owners.
