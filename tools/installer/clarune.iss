#ifndef StageRoot
  #error StageRoot is required. Use tools/package-release.ps1.
#endif
#ifndef ProjectRoot
  #error ProjectRoot is required.
#endif
#ifndef InstallerOutput
  #error InstallerOutput is required.
#endif
#ifndef ChineseMessages
  #error ChineseMessages is required.
#endif
#ifndef CandidateNoticeFile
  #error CandidateNoticeFile is required.
#endif
#ifndef VCRedistSource
  #error VCRedistSource is required.
#endif
#ifndef ReleaseVersion
  #define ReleaseVersion "1.0.0-rc.1"
#endif
#ifndef InstallerName
  #define InstallerName "EVEING-Clarune-1.0.0-rc.1-Full-x64-Setup-fix1"
#endif
#ifndef InstallerBuildNumber
  #define InstallerBuildNumber "2"
#endif
#ifndef InstallerAppId
  #define InstallerAppId "com.eveing.clarune.desktop"
#endif
#ifndef DirectoryName
  #define DirectoryName "EVEING Clarune"
#endif
#ifndef TestOnly
  #define TestOnly "0"
#endif
#ifndef VCMinMajor
  #define VCMinMajor "14"
#endif
#ifndef VCMinMinor
  #define VCMinMinor "0"
#endif
#ifndef VCMinBuild
  #define VCMinBuild "0"
#endif

[Setup]
AppId={#InstallerAppId}
AppName={#DirectoryName}
AppVersion={#ReleaseVersion}
AppVerName={#DirectoryName} {#ReleaseVersion} (Release Candidate)
AppPublisher=EVEING
AppCopyright=Copyright EVEING. All rights reserved.
DefaultDirName={localappdata}\Programs\{#DirectoryName}
DefaultGroupName={#DirectoryName}
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
OutputDir={#InstallerOutput}
OutputBaseFilename={#InstallerName}
SetupIconFile={#ProjectRoot}\resources\branding\clarune.ico
UninstallDisplayIcon={app}\EVEING Clarune.exe
VersionInfoVersion=1.0.0.{#InstallerBuildNumber}
VersionInfoProductVersion=1.0.0.{#InstallerBuildNumber}
Compression=lzma2/fast
SolidCompression=yes
DiskSpanning=no
UseSetupLdr=yes
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
AlwaysRestart=no
AllowCancelDuringInstall=yes
Uninstallable=yes
UninstallLogMode=append
UsePreviousAppDir=yes
UsePreviousTasks=yes
WizardStyle=modern
InfoBeforeFile={#CandidateNoticeFile}

[Languages]
Name: "chinesesimplified"; MessagesFile: "{#ChineseMessages}"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.DesktopShortcut=创建桌面快捷方式
english.DesktopShortcut=Create a desktop shortcut
chinesesimplified.BadDirectory=请选择默认用户安装目录，或当前用户可写的 EVEING Clarune / EVEINGClarune 专用子文件夹。不能安装到磁盘根目录、用户资料根目录、Windows / Program Files 目录及其子目录，或其他非空目录。
english.BadDirectory=Choose the default per-user location or a dedicated writable EVEING Clarune / EVEINGClarune subfolder. Drive roots, user profile roots, Windows / Program Files trees and unrelated non-empty folders are not allowed.
chinesesimplified.Running=此安装目录中的 EVEING Clarune 仍在运行。请先保存结果并自行关闭软件，再重试。本安装器不会强制关闭程序。
english.Running=EVEING Clarune is running from this installation directory. Save your work and close it, then retry. Setup will not force-close applications.
chinesesimplified.ProcessCheckFailed=无法安全检查程序运行状态。请确认 Windows Management Instrumentation 服务可用后重试，安装未继续。
english.ProcessCheckFailed=Setup cannot safely check whether the app is running. Make Windows Management Instrumentation available and retry; installation has not continued.
chinesesimplified.VCPrompt=Microsoft Visual C++ x64 运行库缺失、不完整或低于本包要求的 {#VCMinMajor}.{#VCMinMinor}.{#VCMinBuild} 版本。是否现在打开随包附带的微软运行库安装程序？它将显示正常的 UAC 权限确认和微软安装条款。拒绝或取消将停止本次 Clarune 安装，不会强制更改系统。
english.VCPrompt=The Microsoft Visual C++ x64 runtime is missing, incomplete, or older than this package's required {#VCMinMajor}.{#VCMinMinor}.{#VCMinBuild}. Open the bundled Microsoft installer now? It will show its normal UAC request and Microsoft installation terms. Declining or cancelling stops this Clarune installation without forced system changes.
chinesesimplified.VCRequired=需要先完成 Microsoft Visual C++ x64 运行库安装，再重试。Clarune 尚未继续安装。
english.VCRequired=Complete installation of the Microsoft Visual C++ x64 runtime, then retry. Clarune installation has not continued.
chinesesimplified.VCRestart=微软运行库要求重启 Windows。请自行重启后重新运行 Clarune 安装程序；本安装器不会自动重启。
english.VCRestart=The Microsoft runtime requires a Windows restart. Restart when ready and run Clarune Setup again. This installer will not restart the computer automatically.

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopShortcut}"; Flags: unchecked

[Files]
Source: "{#StageRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; An additional dontcopy entry permits explicit prerequisite extraction before app install.
Source: "{#VCRedistSource}"; DestName: "vc_redist.x64.exe"; Flags: dontcopy

[Icons]
Name: "{userprograms}\{#DirectoryName}\{#DirectoryName}"; Filename: "{app}\EVEING Clarune.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#DirectoryName}"; Filename: "{app}\EVEING Clarune.exe"; WorkingDir: "{app}"; Tasks: desktopicon

; No Run, Registry, InstallDelete or UninstallDelete sections: no autostart,
; file associations, forced app closure, recursive deletion or userdata removal.
[Code]
function ClaruneGetFileAttributes(FileName: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function NormalPath(const Value: String): String;
begin
  Result := Lowercase(RemoveBackslashUnlessRoot(ExpandFileName(Value)));
end;

function PathHasNoReparsePoints(const Value: String): Boolean;
var
  Current, Parent: String;
  Attributes, ErrorCode: Cardinal;
begin
  Result := False;
  Current := RemoveBackslashUnlessRoot(ExpandFileName(Value));
  Parent := RemoveBackslashUnlessRoot(ExtractFileDir(Current));
  { Check ancestors first, so no child lookup traverses an unchecked link. }
  if (Parent <> '') and (CompareText(Parent, Current) <> 0) then
    if not PathHasNoReparsePoints(Parent) then Exit;
  Attributes := ClaruneGetFileAttributes(PathConvertNormalToSuper(Current));
  if Attributes = $FFFFFFFF then
  begin
    ErrorCode := DLLGetLastError;
    { New subdirectories may not exist; inaccessible or invalid paths fail closed. }
    Result := (Parent <> '') and (CompareText(Parent, Current) <> 0) and
      ((ErrorCode = 2) or (ErrorCode = 3));
    Exit;
  end;
  Result := ((Attributes and $400) = 0) and ((Attributes and $10) <> 0);
end;

function DirectoryIsEmpty(const Path: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Path) + '*', Entry) then
  begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then
        begin
          Result := False;
          Break;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

function SafeInstallDirectory(const Value: String): Boolean;
var
  Target, Leaf, Profile: String;
begin
  Target := NormalPath(Value);
  Leaf := Lowercase(ExtractFileName(Target));
  Result := False;
  if (Leaf <> Lowercase('{#DirectoryName}')) then
  begin
    #if TestOnly == "0"
      if Leaf <> 'eveingclarune' then Exit;
    #else
      Exit;
    #endif
  end;
  if (Length(Target) < 6) or (Copy(Target, 1, 2) = '\\') then Exit;
  { USERPROFILE is an environment variable, not an Inno directory constant. }
  Profile := GetEnv('USERPROFILE');
  if Profile = '' then Exit;
  if (Target = NormalPath(Profile)) or
     (Target = NormalPath(ExpandConstant('{localappdata}'))) or
     (Target = NormalPath(ExpandConstant('{userappdata}'))) or
     (Target = NormalPath(ExpandConstant('{userdocs}'))) or
     (Target = NormalPath(ExpandConstant('{userdesktop}'))) or
     (Target = NormalPath(ExpandConstant('{win}'))) or
     (Target = NormalPath(ExpandConstant('{sys}'))) then Exit;
  { Per-user setup must not write into protected system installation trees. }
  if (Pos(AddBackslash(NormalPath(ExpandConstant('{win}'))), AddBackslash(Target)) = 1) or
     (Pos(AddBackslash(NormalPath(ExpandConstant('{commonpf32}'))), AddBackslash(Target)) = 1) or
     (Pos(AddBackslash(NormalPath(ExpandConstant('{commonpf64}'))), AddBackslash(Target)) = 1) then Exit;
  if not PathHasNoReparsePoints(Target) then Exit;
  if not DirExists(Target) then
  begin
    Result := True;
    Exit;
  end;
  Result := DirectoryIsEmpty(Target) or
    ((GetIniString('Installation', 'AppId', '', AddBackslash(Target) + 'clarune-installation.ini') = '{#InstallerAppId}') and
     FileExists(AddBackslash(Target) + 'EVEING Clarune.exe'));
end;

function RunningCheck(const Directory: String): String;
var
  Locator, Service, Processes, Process: Variant;
  Index: Integer;
  Path, Expected: String;
begin
  Result := '';
  Expected := NormalPath(AddBackslash(Directory) + 'EVEING Clarune.exe');
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Processes := Service.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name=''EVEING Clarune.exe''');
    for Index := 0 to Processes.Count - 1 do
    begin
      Process := Processes.ItemIndex(Index);
      if VarIsNull(Process.ExecutablePath) then
      begin
        Result := CustomMessage('ProcessCheckFailed');
        Exit;
      end;
      Path := Process.ExecutablePath;
      if NormalPath(Path) = Expected then
      begin
        Result := CustomMessage('Running');
        Exit;
      end;
    end;
  except
    Result := CustomMessage('ProcessCheckFailed');
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and not SafeInstallDirectory(WizardDirValue) then
  begin
    MsgBox(CustomMessage('BadDirectory'), mbError, MB_OK);
    Result := False;
  end;
end;

function VCRuntimeInstalled(): Boolean;
var
  Installed, Major, Minor, Build: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and
    (Installed = 1) and FileExists(ExpandConstant('{sys}\msvcp140.dll')) and
    FileExists(ExpandConstant('{sys}\vcruntime140.dll')) and FileExists(ExpandConstant('{sys}\vcruntime140_1.dll'));
  if not Result then Exit;
  Result := RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Major', Major) and
    RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Minor', Minor) and
    RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Bld', Build);
  if not Result then Exit;
  Result := (Major > {#VCMinMajor}) or ((Major = {#VCMinMajor}) and
    ((Minor > {#VCMinMinor}) or ((Minor = {#VCMinMinor}) and (Build >= {#VCMinBuild}))));
end;

function EnsureVCRuntime(): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if VCRuntimeInstalled() then Exit;
  Result := CustomMessage('VCRequired');
  if SuppressibleMsgBox(CustomMessage('VCPrompt'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then Exit;
  ExtractTemporaryFile('vc_redist.x64.exe');
  if not ShellExec('runas', ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /norestart', '', SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode) then Exit;
  if (ExitCode = 3010) or (ExitCode = 1641) then
  begin
    Result := CustomMessage('VCRestart');
    Exit;
  end;
  if (ExitCode = 0) and VCRuntimeInstalled() then Result := '';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not SafeInstallDirectory(WizardDirValue) then
  begin
    Result := CustomMessage('BadDirectory');
    Exit;
  end;
  Result := RunningCheck(WizardDirValue);
  if Result = '' then Result := EnsureVCRuntime();
end;

function InitializeUninstall(): Boolean;
var
  Problem: String;
begin
  if not PathHasNoReparsePoints(ExpandConstant('{app}')) then
  begin
    SuppressibleMsgBox(CustomMessage('BadDirectory'), mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  Problem := RunningCheck(ExpandConstant('{app}'));
  Result := Problem = '';
  if not Result then SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
end;
