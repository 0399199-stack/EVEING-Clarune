# EVEING Clarune 图标

默认使用 A。它保留现有蓝紫到青色圆角底板和白色交叠光环，所有轮廓重新绘制为独立矢量。

| 方案 | 设计 | 文件 |
| --- | --- | --- |
| A | 交叠光环：延续当前界面图标，作为默认 | `resources/branding/clarune-a.svg` |
| B | 聚焦透镜：圆形透镜与清晰高光 | `resources/branding/clarune-b.svg` |
| C | 层叠棱镜：表现分辨率与细节层次 | `resources/branding/clarune-c.svg` |
| D | 极简光圈：更接近影像工具的视觉语言 | `resources/branding/clarune-d.svg` |

四款均为本项目原创 SVG；不使用 Electron、Upscayl 或第三方商标图形。SVG 可直接编辑，PNG 仅为导出预览。

`resources/branding/icon-options.png` 是选图预览。`clarune.png` 为当前原生窗口的 256 px 图标；`clarune.ico` 包含 16、24、32、48、64、128、256 px 七档。

## 生成

脚本依赖构建时的 `sharp`，不属于应用运行依赖。可以通过 `NODE_PATH` 指向包含 sharp 的目录，或通过 `CLARUNE_SHARP_MODULE` 指定 sharp 包路径。

```text
node tools/build-icons.mjs a
```

切换方案时传入 `b`、`c` 或 `d`，并同步更改 `BrandMark.tsx` 的 SVG 导入。界面与原生图标必须始终选用同一方案。

## Windows 集成

界面使用 `src/renderer/src/components/BrandMark.tsx`。主进程 `BrowserWindow` 的 `icon` 指向 `resources/branding/clarune.ico`；开发/普通构建可用 `join(app.getAppPath(), "resources/branding/clarune.ico")`。安装包必须包含该资源，并将 EXE/安装器的图标也设置为这份 ICO。

在 Windows 下、创建窗口之前调用 `app.setAppUserModelId("com.eveing.clarune")`，安装后的快捷方式应使用同一 AppUserModelID。窗口图标与 EXE 图标是两处配置：开发阶段指定窗口图标可统一正在运行的应用窗口；正式打包仍需写入 EXE 图标，已固定的旧 Electron 快捷方式可能需要重新固定。

图标没有字母和小字，以保证任务栏小尺寸可辨认。

## 本地预览副本

项目构建后，在项目目录运行：

```powershell
pwsh -NoProfile -File tools/package-preview.ps1
```

脚本把现有 Electron 运行时复制到项目旁的 `EVEINGClarune_Preview`，将构建产物和图标放入 `resources/app`，生成 `EVEING Clarune.exe`。脚本通过官方 `electron/rcedit` v2.0.0 给这个副本嵌入当前 ICO 和 EVEING 品牌信息。它不修改 `node_modules` 中的 Electron、不创建快捷方式，也不注册系统。若该预览正在运行，先关闭它再重跑脚本。

首次运行需联网下载官方工具到工作区 `work/preview-packaging`；后续使用缓存。下载 URL 与固定 SHA-256 都在脚本中；每次运行均校验工具哈希。依赖 Windows、PowerShell、已安装的项目 Electron 运行时和已完成的 `pnpm build`。该本地预览没有签名或安装器。

脚本从生成的 EXE 中通过 Windows 提取图标，与源 ICO 同尺寸图像逐像素比较，并检查 EXE 品牌信息及原始 Electron SHA-256 未改变。验证记录为 `work/preview-packaging/packaging-evidence.json`，提取图标为同目录的 `preview-exe-icon.png`。
