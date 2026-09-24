# 仓库外的 AI 与发布资源

本源码仓库不包含模型权重、原生 EXE/DLL、Python/PyTorch/CUDA 环境、微软运行库安装器、客户授权文件、签发私钥或注册机。不得从用户电脑或其他软件安装目录直接复制一份到 Git。以下是现有候选构建的来源记录与恢复入口，**不是商用再分发许可证明**。

| 资源 | 候选来源与版本 | 校验/获取方法 |
|---|---|---|
| 通用与动漫 Real-ESRGAN 权重 | [Real-ESRGAN v0.2.5.0 发布页](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) | `MODEL_ALLOWLIST.json` 记录原始资源、每个模型文件大小与 SHA-256；先取得权利确认，再按清单重新获取和核验。 |
| Real-HAT GAN SR×4 权重 | [HAT 上游项目](https://github.com/XPixelGroup/HAT)，具体权重下载入口和 SHA-256 固定在 `tools/stage-ai-runtime.ps1` | 从上游指定入口获取后核对脚本中哈希；不得用来源不明的第三方镜像。 |
| NCNN/Vulkan 推理程序 | 上游代码与候选提交见 `PROVENANCE.md`；当前暂存程序的精确文件哈希固定在 `tools/stage-ai-runtime.ps1` | 从审计过的构建材料复建，核对源码、依赖、编译参数和哈希；旧上游便携包不应不经复核进入发行版。 |
| Real-HAT 运行环境 | CPython 3.13.14、PyTorch 2.13.0+cu130、Spandrel 0.4.2 等版本详见 `tools/stage-ai-runtime.ps1` | 在隔离目录按官方来源和固定版本重新准备，再用脚本清单校验；脚本当前包含本机目录假设，新电脑需先适配并审核，不能直接声称一键复现。 |
| 公钥与 VC++ 运行库 | 公钥由独立签发端导出；微软 VC++ x64 来源、签名与许可要求见 `INSTALLATION.md` | 公钥可安全备份但不含私钥；安装器只接受显式指定的公钥，微软运行库须从官方来源获取并验签。 |

发布前以最终构建产生的 `resources/ai/runtime-manifest.json`、原始许可文件、组件 SBOM 和实际安装包哈希为准。`MODEL_ALLOWLIST.json` 是早期 PoC 来源清单；当前完整暂存包的具体文件清单更广，不要把早期清单误当作完整依赖表。
