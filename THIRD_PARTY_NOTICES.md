# Third-party notices / 第三方许可声明

状态：**Phase 0 审计草案，仅供内部 PoC**。当前产品未随附任何推理 worker 或模型。本文件不是最终可发行的许可全文；公开或付费发行前必须根据最终安装包重新生成，并在安装目录和“关于 → 第三方许可”中提供每份所需的完整原文。

## 当前应用依赖

当前 `package.json` 固定 Electron、React、React DOM、i18next、react-i18next；Vite、electron-vite、TypeScript、Vitest 与类型包用于开发或构建。这些包的许可证及转依赖必须以最终锁文件和安装包生成 SBOM 后复核，不能仅靠此清单推定最终分发内容。

## 候选推理链，尚未打包

| 组件 | 版本与官方许可入口 | 发行时要保留的声明 |
|---|---|---|
| Real-ESRGAN-ncnn-vulkan | [`v0.2.0` / MIT](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/LICENSE) | 完整 `LICENSE`，含 `realsr-ncnn-vulkan` 的 MIT 文字 |
| Real-ESRGAN | [`v0.2.5.0` / BSD-3-Clause](https://github.com/xinntao/Real-ESRGAN/blob/685d429c81888252bdb10f56c7754baededc3823/LICENSE) | 完整 BSD 原文；不得暗示上游背书。模型权利仍待单独放行 |
| ncnn | [`20260526` / BSD-3-Clause 及内含第三方声明](https://github.com/Tencent/ncnn/blob/e54f7b1f88434e1d844ea0551b880a1cfb079ce1/LICENSE.txt) | 完整 `LICENSE.txt`，不能只截取主许可证 |
| glslang | [ncnn 锁定提交 `fe88f42` / 复合许可](https://github.com/nihui/glslang/blob/fe88f421038e1bb0a25cd5c1b2dfe505db82d08f/LICENSE.txt) | 完整 `LICENSE.txt`，包括 BSD、MIT、Apache、Bison 例外与 NVIDIA 条款 |
| libwebp | [`v1.6.0` / BSD-3-Clause](https://github.com/webmproject/libwebp/blob/4fa21912338357f89e4fd51cf2368325b59e9bd9/COPYING) | 完整 `COPYING` 与 [`PATENTS`](https://github.com/webmproject/libwebp/blob/4fa21912338357f89e4fd51cf2368325b59e9bd9/PATENTS) |
| stb_image、stb_image_write | worker 源码内两个头文件；均可选 MIT | 选择 MIT，保留各文件末尾的版权和 MIT 原文 |
| win32-dirent | worker 源码内头文件；MIT | 保留 Toni Ronkko 版权及 MIT 原文 |

最终第三方清单应直接由实际构建内容核对，确保没有额外的 Vulkan SDK、Microsoft 运行库或其他转依赖被遗漏。Microsoft 运行库须遵守[微软再分发规则](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)；绝不能打包 `vcomp140d.dll`。

模型 PoC 来源及 SHA-256 见 [`docs/MODEL_ALLOWLIST.json`](docs/MODEL_ALLOWLIST.json)。没有模型权利放行记录，不得把“项目代码是 BSD”宣传为“全部权重已可商用”。

Upscayl、`upscayl-ncnn`、其图标/翻译/截图/二进制/模型文件及上游演示图片或视频均**未纳入**本产品，也不由此文件授予任何使用许可。
