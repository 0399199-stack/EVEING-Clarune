# 新电脑接手开发

1. 本人在新电脑安装 Git、Windows x64 Node.js 24（项目要求至少 24）及 pnpm 11.19.0；在 GitHub 官方登录页面或 GitHub CLI 交互流程自行完成登录、验证码和双重验证。不要把令牌或私钥贴到聊天、命令日志或仓库。确认目标仓库所有者与可见性后，再克隆 **EVEING-Clarune 源码仓库本身**，不要克隆或上传整个 Codex 工作目录。
2. 在克隆的项目根目录运行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm build` 和 `pnpm dev`。源码、锁文件、配置、测试与原创品牌资源应来自 Git；`node_modules`、`out` 和本地截图应重新生成。
3. 不附带 AI 环境时，界面与普通源码构建仍可恢复，但 AI 推理会显示运行环境缺失；许可受限操作也需要本人的有效授权和与签发私钥匹配的**公钥**。不要把发行私钥搬进开发仓库。
4. 如需恢复 AI，按 `EXTERNAL_ASSETS.md`、`PROVENANCE.md` 和 `tools/stage-ai-runtime.ps1` 找到经许可审核的来源、固定版本与哈希。开发模式当前默认查找工作区 `work/engine-baseline/runtime-full` 和 `work/realhat-face-test`，也可从软件设置选择受校验的本地运行环境。路径是假设，不保证任意克隆位置即插即用。
5. 如需重建**完整安装包**，另备模型、Python/PyTorch、微软 VC++ 运行库、公钥及 Inno 工具，并逐项按 `INSTALLATION.md` 和 `RELEASE_GATES.md` 校验。`tools/stage-ai-runtime.ps1` 当前读取原电脑的特定 ComfyUI 路径，新电脑必须先调整和重新审计；不要为了让脚本跑通而跳过哈希/许可检查。
6. 在目标电脑重新测试：中英界面、普通图片工具、激活、三类 AI、单张大图、批量、保存、取消与关窗。不要把旧电脑的本地测试结果当作新电脑验收。

若 `pnpm` 在原电脑离线环境尝试修复依赖，先确认本机依赖状态；新电脑应以锁文件正常安装，不复制旧机器 `node_modules`。历史 UI 端到端脚本还可能依赖 Playwright、Poppler 或固定本机目录，失败时请记录原因，不要误判为核心构建失败。
