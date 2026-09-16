# 来源与 clean-room 记录

审计日期：2026-09-16。当前状态：**内部 Phase 0 PoC，未获付费发行批准**。本文件是工程审计记录，不是法律意见。

## 允许的上游候选

| 用途 | 固定来源 | 许可判断 | 当前决策 |
|---|---|---|---|
| 推理 worker | [Real-ESRGAN-ncnn-vulkan `v0.2.0` / `37026f4`](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/tree/37026f49824c5cf84062e7c6a5dd71445dcf610f) | [MIT](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/LICENSE)，包含其借用的 `realsr-ncnn-vulkan` MIT 声明 | 可作独立实现的源码基线；需自行构建、保留声明、记录修改 |
| 模型来源项目 | [Real-ESRGAN `v0.2.5.0` / `685d429`](https://github.com/xinntao/Real-ESRGAN/tree/685d429c81888252bdb10f56c7754baededc3823) | [项目代码 BSD-3-Clause](https://github.com/xinntao/Real-ESRGAN/blob/685d429c81888252bdb10f56c7754baededc3823/LICENSE)；[官方模型目录](https://github.com/xinntao/Real-ESRGAN/blob/685d429c81888252bdb10f56c7754baededc3823/docs/model_zoo.md) | 官方权重仅允许内部 PoC；付费再分发需单独放行 |
| 推理库 | [ncnn `20260526` / `e54f7b1`](https://github.com/Tencent/ncnn/tree/e54f7b1f88434e1d844ea0551b880a1cfb079ce1) | [BSD-3-Clause 与内含第三方声明](https://github.com/Tencent/ncnn/blob/e54f7b1f88434e1d844ea0551b880a1cfb079ce1/LICENSE.txt) | 商业构建候选版本，兼容性未验证 |
| 着色器编译库 | ncnn 上述版本锁定的 [`nihui/glslang` / `fe88f42`](https://github.com/nihui/glslang/tree/fe88f421038e1bb0a25cd5c1b2dfe505db82d08f) | [复合许可文件](https://github.com/nihui/glslang/blob/fe88f421038e1bb0a25cd5c1b2dfe505db82d08f/LICENSE.txt)，不能只保留第一段 BSD 声明 | 可作候选；完整声明必须随发行包提供 |
| WebP 编解码 | [libwebp `v1.6.0` / `4fa2191`](https://github.com/webmproject/libwebp/tree/4fa21912338357f89e4fd51cf2368325b59e9bd9) | [`COPYING`](https://github.com/webmproject/libwebp/blob/4fa21912338357f89e4fd51cf2368325b59e9bd9/COPYING) BSD-3-Clause；另有 [`PATENTS`](https://github.com/webmproject/libwebp/blob/4fa21912338357f89e4fd51cf2368325b59e9bd9/PATENTS) | 商业构建候选版本，兼容性和安全测试未验证 |

固定提交是**候选版本**，不是声称这些版本已经与 worker 编译通过。最终二进制必须单独记录其源码提交、构建环境、编译选项、SHA-256、SBOM 和签名。

## 为什么不能原样打包上游便携包

Real-ESRGAN 官方 `v0.2.5.0` Windows 包可作为内部模型完整性和推理 PoC 参考，但不可直接作为本产品发行包：

- worker `v0.2.0` 源码锁定的 libwebp 提交 `8ea8156` 标记为 **1.2.1**，早于 libwebp 官方修复 [`BuildHuffmanTable` 越界写入](https://github.com/webmproject/libwebp/commit/902bc9190331343b2017211debcec8d2ab87e17a) 的提交。尚未对便携包二进制做静态依赖取证，因此不能把源码版本直接等同于该二进制的已证实内部版本；发行时无论如何都必须换成可追溯的新构建。
- 官方 ZIP 含 `vcomp140d.dll`。微软的[再分发规则](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)禁止分发 `debug_nonredist` 内容；调试 DLL 不得进入付费安装包。
- ZIP 未附 worker MIT 和 Real-ESRGAN BSD-3-Clause 许可全文。其 worker EXE 在本次 Windows Authenticode 检查中无数字签名。

## 模型边界

`MODEL_ALLOWLIST.json` 记录的 3 个模型族全部来自 [Real-ESRGAN 官方 `v0.2.5.0` Windows 发布资源](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0)，不是 Upscayl。逐文件大小和 SHA-256 已复核。其状态仅为**内部 PoC 白名单**。

项目 BSD 文件没有逐个点名权重或机械转换后的 ncnn `.bin/.param` 的付费再分发授权。[官方训练说明](https://github.com/xinntao/Real-ESRGAN/blob/685d429c81888252bdb10f56c7754baededc3823/Training.md)提到 DF2K（DIV2K、Flickr2K）和 OST，但未整合这些数据集的商业权利担保；动漫模型的完整训练数据来源亦未在所审计官方页面明确列出。上述不足**不是禁止商用的证据**，而是不能无条件批准付费发行的证据。放行须取得上游对指定权重和 ncnn 转换文件的书面确认，或有记录的法律风险签核。

## Upscayl 隔离规则

[Upscayl 桌面端](https://github.com/upscayl/upscayl/blob/a00d55fee90e0f9435d5eaa86e76700df8199af8/LICENSE)和 [`upscayl-ncnn`](https://github.com/upscayl/upscayl-ncnn/blob/0beb39028a0ddd83250e845b4c3333c0675e3b97/LICENSE)均为 AGPL-3.0。商业闭源产品不得复制其源码、补丁、IPC 协议、UI 层级或尺寸、文案、翻译、商标、图标、截图、比较样图、安装包、`upscayl-bin`，也不得从其仓库或安装包提取模型文件。

Upscayl 自身[英文模型文案](https://github.com/upscayl/upscayl/blob/a00d55fee90e0f9435d5eaa86e76700df8199af8/renderer/locales/en.json)将 Remacri、Ultramix Balanced、Ultrasharp 标为 “Non-Commercial”，明确拒绝进入本产品。Upscayl Standard/Lite、Digital Art、High Fidelity 同样不从 Upscayl 提取；如未来使用，须从原作者取得独立来源和许可。通用的批处理、前后对比、平铺推理等产品概念可以原创实现。

研究副本须留在 `work/`，不得整体复制进产品树。每次引入依赖、模型或二进制都要记录官方 URL、不可变版本、文件 SHA-256、许可全文、引入人和审核结论。
