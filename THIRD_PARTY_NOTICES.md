# Third-party notices / 第三方许可声明

状态：**1.0 发布候选，尚未宣称商业审核完成**。完整候选包通过 `tools/stage-ai-runtime.ps1` 整理独立 AI 环境，排除调试库及不需要的模型架构。实际第三方许可原文、来源和文件哈希随 `resources/ai` 清单与声明保存；本文件仅为说明索引，不代替完整许可。

## 当前应用依赖

当前 `package.json` 固定 Electron、React、React DOM、i18next、react-i18next；Vite、electron-vite、TypeScript、Vitest 与类型包用于开发或构建。这些包的许可证及转依赖必须以最终锁文件和安装包生成 SBOM 后复核，不能仅靠此清单推定最终分发内容。

2026-09-17 本地工具修订新增 `sharp@0.35.4` 与 `pdf-lib@1.17.1`。预览打包时生成实际生产依赖索引 `resources/app/THIRD_PARTY_NOTICES.md`，并保留每个包的原始声明；详见 `docs/LOCAL_IMAGE_ENGINE.md`。Sharp Windows 原生包含 LGPL 组件，不将所有转依赖视作 MIT；收费发行前仍需按最终分发方式完成许可门禁。

## 候选推理链

`tools/stage-ai-runtime.ps1` 内含从 Spandrel 0.4.2 改编的 HAT 注册代码；源码分发时保留其 [MIT 原文](licenses/spandrel/LICENSE) 和修改标识，安装包另保留运行时的原始声明。

v6 预览采用外部环境；1.0 候选改为完整离线运行目录。Spandrel 仅保留 HAT 及所需公共模块，不分发与本软件无关的非商业架构。各依赖和权重仍需按最终清单复核；本地运行成功不等同于许可放行。最新核查见项目同级 `EVEINGClarune_Release_Review/DEPENDENCY_AUDIT.md`，下表保留早期候选来源，实际包中版本以 staging manifest 为准。

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
