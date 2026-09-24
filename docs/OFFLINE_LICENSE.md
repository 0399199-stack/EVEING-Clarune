# EVEING Clarune 离线激活

本实现是自有软件的离线许可证签发与验证，不是其他软件的破解工具。照片、硬件原始标识和激活状态不上传服务器。

## 使用流程

1. 软件在本机读取两个 Windows 标识，生成机器码。用户把机器码提供给开发者。
2. 开发者在**独立签发工具**中粘贴机器码，设定生效时间、永久或到期时间，使用自己保管的 Ed25519 私钥签发激活码。
3. 用户粘贴激活码。软件使用安装包内的公钥验证签名、产品、两个机器标识、生效/到期时间和续期序号。
4. 延期或更改生效时间时，使用相同 `license_id`、更大的 `sequence` 重新签发。不能在同一序号上更改内容；完全相同的许可证可以再次导入。

签发工具、私钥、私钥密码都不得放入用户安装包。正式公钥未配置时，软件保持 `unconfigured`，不能绕过激活。厂商首次生成自己的私钥后，才能构建与该签发工具配对的可销售安装包。

## 机器码与隐私

Windows 机器码要求两个真实有效的分量同时存在：

- `machine_guid`：通过系统 `reg.exe query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid /reg:64` 读取。
- `smbios_uuid`：通过系统 PowerShell 的 `Get-CimInstance Win32_ComputerSystemProduct` 读取。

两个查询均隐藏运行、不加载 PowerShell 配置、禁止交互并设置超时。缺失、全零/全 F、重复占位 UUID 和已知通用占位值会被拒绝；不退化成仅一个分量。WMI 损坏、OEM 固件提供占位值或不支持的环境会显示机器识别不可用，须修复环境或联系客服，不能随便生成一个随机标识替代。

UUID 规范化为小写连字符形式后，计算：

```text
SHA256(UTF8("eveing-clarune\0device-v1\0" + componentName + "\0" + normalizedUUID))
```

`\0` 表示一个空字节。只有两个经过产品/用途隔离的 SHA-256 哈希参与机器码、签发和持久化；原始 GUID/UUID 不暴露给界面、不落盘、不进入错误消息或日志。机器码仍是稳定设备指纹，应只在用户与开发者之间传递，不应作为公开匿名数据。

机器码格式：

```text
CLARUNE-DEVICE-1.<base64url(UTF8(JSON))>
```

```json
{
  "version": 1,
  "product_id": "eveing-clarune",
  "device_component_hashes": {
    "machine_guid": "64位小写十六进制哈希",
    "smbios_uuid": "64位小写十六进制哈希"
  }
}
```

更换主板、重装系统改变 MachineGuid 等情况可能改变机器码，需要开发者审核后重新签发。更换磁盘容量、图片目录或电脑名称不直接参与绑定。

## 签名协议

兼容已有 v1 JSON 信封；新签发工具可以输出便于粘贴的单行格式：

```text
CLARUNE-LICENSE-1.<base64url(UTF8(envelopeJSON))>
```

信封：

```json
{
  "version": 1,
  "alg": "Ed25519",
  "payload": "base64url编码的UTF8签名载荷",
  "signature": "base64url编码的64字节Ed25519签名"
}
```

载荷按以下顺序构造并以无额外空白的 JSON 签名。验签使用载荷的**原始字节**，不先解析并重排后验签。

```json
{
  "product_id": "eveing-clarune",
  "license_id": "LIC-2026-EXAMPLE",
  "not_before": "2026-09-17T00:00:00.000Z",
  "expires_at": "2027-09-17T00:00:00.000Z",
  "sequence": 1,
  "device_match_min": 2,
  "device_component_hashes": {
    "machine_guid": "64位小写十六进制哈希",
    "smbios_uuid": "64位小写十六进制哈希"
  }
}
```

永久许可证明确使用 `expires_at: null`，不是极远的伪到期时间。非永久时，到期时间必须晚于生效时间；在到期时间这一刻即失效。日期必须为 `Date.toISOString()` 对应的规范 UTC 格式，范围为 1970 至 9999 年。界面显示本地时间时仍应保留正确的时区转换。

`license_id` 限 1–128 个 ASCII 字母、数字、`.`、`_`、`:`、`-`；序号须为大于零的安全整数。激活文本至多 16,384 字符。生产服务强制只有 `machine_guid` 和 `smbios_uuid` 两个分量且 `device_match_min=2`。单独的底层验签器仍支持已有测试协议的 n-of-m 设备匹配，但不降低产品入口的限制。

未来生效的正确签名许可证可以保存，状态为 `not-yet-valid`，到指定时间后才授权功能。到期许可证保持可见但不授权。签名、产品、设备或序号错误的导入不会覆盖已有许可证。

## 本机受保护状态

- 固定公钥路径：正式包 `process.resourcesPath/license-public-key.pem`；开发模式 `<app.getAppPath()>/resources/license-public-key.pem`。
- 只接受 Ed25519 公钥，资源缺失、格式错误或包含私钥时保持未配置。没有环境变量、命令行参数或 renderer 参数可以关闭验签或选择别的公钥。
- 固定激活状态：`<app.getPath("userData")>/activation-state.bin`。
- 使用 Electron `safeStorage` 加密（Windows DPAPI），**没有明文回退**。先写独立临时密文文件，再原子替换正式文件；保存失败不发布新激活状态。
- 串行处理同一应用进程内的检查与导入。应用主进程应使用单实例锁，避免同一用户目录被多个产品进程同时更新。
- 保存最大的已见系统时间。系统回拨超过 5 分钟则锁定为 `clock-rollback`；容差内也按“当前时间与历史最大时间中的较大值”检查生效和到期，不能把刚到期的许可恢复为有效。
- 每个许可证 ID 保留已接受的最大序号和规范内容哈希。较低序号，或相同序号的不同内容，均拒绝。最多保存 128 个许可证 ID；不静默删除旧记录。

受保护状态解密失败、文件损坏、磁盘写入失败会拒绝授权，不会悄悄重建一个空白且已激活的状态。更换 Windows 用户、重装系统或迁移整个配置目录后应重新导入适配当前机器的许可证。

## 主进程接口

```ts
const service = createProductionLicenseService(); // app.ready 之后，同步工厂
await service.getStatus();
await service.activate(text);
await service.requireActive(); // 非 active：LicenseError，code = LICENSE_REQUIRED
await service.whenIdle(); // 关闭前等待已入队的状态操作
```

主进程须在真正执行 AI、输出/导出前调用 `requireActive()`，不能只禁用界面按钮。长任务和批量处理还应在每个任务开始及输出发布前重新检查，避免运行期间到期仍继续发布新文件。未经授权的 renderer 不能调用许可证 IPC；激活码输入类型和长度仍需在 IPC 边界检查。

测试可注入 `publicKeyPem`、`store`、`getDevice` 和 `now`，不需要生产私钥；生产工厂不暴露这些绕过参数给应用界面。

## 离线方案的真实边界

Ed25519 能防止没有私钥的人自行修改激活内容；它不能让完全由用户控制的客户端变成不可破解的软件。离线方案不能可靠防止：修改程序跳过检查、管理员伪造硬件标识、恢复旧系统/配置快照、删除本机状态再激活旧许可证、长期离线时间欺骗；也无法远程撤销许可证或统计实际激活台数。

DPAPI 和时间/序号记录是针对普通误用和简单回拨的保护，不是服务器可信时钟或硬件安全模块。需要可靠撤销、可信到期时间与激活台数控制时，须另行设计联网授权服务，并明确用户隐私和离线宽限策略。

## 验证覆盖

`tests/license-verifier.test.ts`、`license-service.test.ts`、`license-device.test.ts`、`license-store.test.ts` 覆盖签名篡改、错误产品/设备、公钥缺失、永久和未来生效、精确到期边界、重启后时间回拨、同序号修改、旧序号重放、并发导入、加密不可用/失败、密文损坏、原子替换和原始硬件信息不外泄。

`license-gate.test.ts` 验证真正的主进程 IPC 无授权不启动 AI、不弹出保存窗口、不生成文件，免费预览移除 AI 参数，以及授权等待期间的取消和关闭竞态。`license-issuer-interop.test.ts` 直接导入同级 `EVEING_License_Desk/license-issuer.mjs`，使用仅驻内存的临时测试密钥，完成机器码、有限期、永久续期、重启拒旧码和错误机器的互通测试；运行此跨项目测试时必须保留两个源码目录的相邻关系。

真实打包程序还须额外完成机器码获取、Windows safeStorage 重启读取、真实界面激活、锁定功能和续期验证。单元测试中的加密替身不能代替 Windows DPAPI 运行验证。
