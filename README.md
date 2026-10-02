# QRFile PWA

面向“电脑屏幕 → iPhone/iPad 摄像头”的离线文件传输接收端。发送端继续使用现有 `qrfile.py pack-video` 生成单大二维码视频；iOS 端不需要 Apple Developer 账号，通过 Safari / PWA 直接实时扫描、保存中间结果、FEC 补帧并恢复原文件。

## 当前功能

- iOS Safari / 添加到主屏幕运行，不需要原生签名。
- 使用 `zxing-wasm`（ZXing-C++ WebAssembly）识别 QR Code。
- 1～4 个 Web Worker 并行解码，默认按 CPU 核心数选择 2～4 个。
- 直接打开后置摄像头扫描电脑屏幕。
- 可导入手机已录制的视频继续扫描。
- 可多选导入补拍二维码照片；照片由 Safari 先解码成像素，因此 JPG/PNG/HEIC 等浏览器能够显示的格式都可进入扫码流程。
- 完整兼容当前 `qrfile.py` 的 `QRF1` 数据帧、`QRP1` 跨二维码 FEC、`QRFS1` 文件流格式。
- Base45、CRC32、GF(256) FEC、zlib 解压、SHA-256 完整校验均在浏览器本地完成。
- IndexedDB 自动保存已接收数据帧和 FEC 帧，退出 PWA 后可继续。
- 自动统计缺帧和当前可由 FEC 恢复的帧数。
- 可导出 `missing-frames.txt`，直接给发送端：

```bash
python qrfile.py pack-video file.zip \
  --export-frames @qrfile-xxxxxxxx.missing-frames.txt \
  --frames-out repair_qr
```

然后在 iPhone 上“导入照片”扫描 `repair_qr` 中补传的二维码。

- 完整后恢复原始文件名，并通过 iOS Share Sheet 保存到“文件”或分享给其他 App。
- Service Worker 缓存页面、JS/CSS、ZXing WASM；完成一次在线加载后可离线运行。

## 部署到 GitHub Pages

仓库包含 `.github/workflows/pages.yml`。推送到 `main` 后会自动构建并部署。

如果第一次部署提示 Pages 未启用：进入仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**，然后重新运行 `Deploy PWA to GitHub Pages` workflow。

本仓库名为 `qrfile`，Vite base 已配置为 `/qrfile/`。部署后地址通常为：

```text
https://wqhot.github.io/qrfile/
```

在 iPhone 上用 Safari 打开一次，然后：

```text
分享 → 添加到主屏幕
```

以后可以从桌面直接启动。

## 推荐使用流程

发送端：

```bash
python qrfile.py pack-video file.zip -o file.qr.avi
```

建议沿用目前针对手机拍屏的默认参数：单帧一个二维码、Version 35 / ECC M、10 QR/s、16+2 FEC。

接收端：

1. 打开 QRFile PWA。
2. 点“启动摄像头”。
3. 手机尽量正对显示器，减少透视；二维码尽量落在中央方框内。
4. PC 播放二维码视频。
5. “已收到数据帧”会持续增长；重复扫码不会重复保存。
6. 播放结束后点“执行 FEC”。
7. 如果仍有缺失，点“导出缺帧列表”。
8. PC 用 `pack-video --export-frames @...` 只生成缺失帧 PNG。
9. iPhone 点“导入照片”选中补帧照片。
10. 点“恢复文件”，通过“保存 / 分享文件”写入 iOS Files。

中途退出 PWA 不会丢掉已经写入 IndexedDB 的帧。

## iPhone 拍屏建议

- 优先让手机与显示器接近平行，避免大透视角。
- 不要让二维码占画面太小。默认扫描宽度 1280 px，V35 二维码在缩放后仍应保留足够的模块像素。
- 如果实时解码率低，先降低 PC 播放速度或把手机靠近屏幕，不要先把二维码密度推到 Version 40。
- 显示器出现强摩尔纹时，轻微改变手机距离/角度通常比继续提高数字锐化更有效。
- 默认 2～4 个 Worker；设备明显发热时可降到 2 个。
- 导入手机录像时建议先用 1×，确认识别率后再尝试 1.5×/2×。

## 本地开发

需要 Node.js 22：

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

`npm run build` 会把与 `zxing-wasm@3.1.4` 匹配的 `zxing_reader.wasm` 从 `node_modules` 拷贝到 `public/`，确保运行时和离线缓存不依赖 CDN。

## 协议兼容性

PWA 当前按本项目 Python 工具的以下格式实现：

- `QRF1`：数据 QR；8 字节 `file_id`、16 位帧序号/总数、payload 长度、CRC32。
- `QRP1`：FEC QR；group start / total / group count / parity index / payload / CRC32。
- `QRFS1`：最终文件流；原始长度、压缩后长度、SHA-256、UTF-8 文件名和数据。
- Base45 字符表与 RFC 9285/QR alphanumeric 字符集一致。
- FEC 使用 GF(256/0x11D)，与 `qrfile.py` 的 Vandermonde 系数实现一致。

详见 [docs/protocol.md](docs/protocol.md)。

## 安全与隐私

摄像头画面、导入照片/视频、二维码 payload 和恢复文件都在浏览器本地处理，不上传到服务器。GitHub Pages 仅用于分发静态 PWA 文件。

## 第三方组件

- `zxing-wasm` / ZXing-C++：二维码识别（MIT / Apache-2.0 等上游许可）。
- `fflate`：zlib 解压（MIT）。
- Vite：构建工具（MIT）。
