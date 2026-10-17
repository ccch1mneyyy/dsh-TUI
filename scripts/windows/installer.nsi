; Build: makensis /DBUILD_DIR=<payload output> installer.nsi
Unicode true
RequestExecutionLevel user
; Favor installation/build speed over the smallest possible download.
SetCompressor zlib
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_DIR
  !define BUILD_DIR "..\..\dist-windows"
!endif
!include "${BUILD_DIR}\version.nsh"
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "${BUILD_DIR}\dsh-tui-setup-win-x64.exe"
!endif
Name "dsh-TUI ${TUI_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\dsh-tui"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${TUI_VERSION}.0"
VIAddVersionKey "ProductName" "dsh-TUI Windows Installer"
VIAddVersionKey "FileDescription" "Offline per-user dsh-TUI installer"
VIAddVersionKey "FileVersion" "${TUI_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT; dsh-TUI contributors"

; Brand assets derived from docs/assets/readme/logo.svg (see scripts/windows/assets).
!define MUI_ICON "assets\dsh-tui.ico"
!define MUI_UNICON "assets\dsh-tui.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\dsh-tui-header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\dsh-tui-welcome-zh-00.bmp"
BrandingText "dsh-TUI ${TUI_VERSION}"
!ifdef TEST_ROOT
  !define INSTALLER_MUTEX "Local\dsh-tui-installer-test"
!else
  !define INSTALLER_MUTEX "Local\dsh-tui-installer"
!endif

Var Prefix
Var UserHome
Var EngineArgs
Var EngineNode
Var Decisions
Var KernelAction
Var KernelInstalled
Var InstallNode
Var InstallPnpm
Var TuiInstalled
Var TuiDowngrade
Var ConfirmCheckbox
Var ConfirmSummary
Var ConfirmWarn
Var WhaleFrame
Var WhaleFrameFile
Var WhaleSet
Var WhaleTick
Var Running
Var Failure
Var OtherProfiles
Var FullRemoval
Var RemoveRadio
Var Mutex
!ifndef TEST_ROOT
Var Terminal
Var TerminalArgs
!endif

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTui
!define MUI_FINISHPAGE_RUN_TEXT "$(LaunchTui)"
; Animate the welcome-page whale by replaying the README logo timeline on a timer.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomePageShow
!define MUI_PAGE_CUSTOMFUNCTION_DESTROYED WelcomePageDestroyed
!insertmacro MUI_PAGE_WELCOME
Page custom ConfirmPageShow ConfirmPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
UninstPage custom un.ChooseScope un.ConfirmScope
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include /CHARSET=UTF8 "installer-strings.nsh"

!macro Bootstrap
  SetShellVarContext current
  StrCpy $Prefix "$APPDATA\npm"
  StrCpy $UserHome "$PROFILE"
  !ifdef TEST_ROOT
    StrCpy $Prefix "${TEST_ROOT}\npm"
    StrCpy $UserHome "${TEST_ROOT}\user"
    StrCpy $INSTDIR "${TEST_ROOT}\metadata"
  !endif
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\engine"
  ; makensis uses the script's directory unless /NOCD was explicitly requested.
  File "install-engine.mjs"
  File "policy.mjs"
  File "transaction.mjs"
  File "integrity.mjs"
  File "archive.mjs"
  File "cleanup.mjs"
  File "windows-system.ps1"
  File /oname=NODE-LICENSE.txt "${BUILD_DIR}\payload\node\LICENSE"
  File /oname=metadata.json "${BUILD_DIR}\metadata.json"
  SetOutPath "$PLUGINSDIR\engine\node_modules\semver"
  File /r "node_modules\semver\*"
  ; Reuse a compatible x64 runtime. A prefix runtime passing the same policy
  ; as inspect is retained, so the engine never replaces its own executable.
  StrCpy $EngineNode "$Prefix\node.exe"
  IfFileExists "$EngineNode" 0 probePathNode
  nsExec::ExecToStack /TIMEOUT=10000 '"$EngineNode" "$PLUGINSDIR\engine\install-engine.mjs" runtime --metadata "$PLUGINSDIR\engine\metadata.json"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Goto runtimeReady
  ${EndIf}
  probePathNode:
  SearchPath $EngineNode "node.exe"
  ${If} $EngineNode != ""
  ${AndIf} $EngineNode != "$Prefix\node.exe"
    nsExec::ExecToStack /TIMEOUT=10000 '"$EngineNode" "$PLUGINSDIR\engine\install-engine.mjs" runtime --metadata "$PLUGINSDIR\engine\metadata.json"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      Goto runtimeReady
    ${EndIf}
  ${EndIf}
  SetOutPath "$PLUGINSDIR\engine"
  File /oname=node.exe "${BUILD_DIR}\payload\node\node.exe"
  StrCpy $EngineNode "$PLUGINSDIR\engine\node.exe"
  runtimeReady:
  StrCpy $EngineArgs '--metadata "$PLUGINSDIR\engine\metadata.json" --result "$PLUGINSDIR\result.ini" --prefix "$Prefix" --home "$UserHome" --metadata-dir "$INSTDIR"'
  !ifdef TEST_ROOT
    StrCpy $EngineArgs '$EngineArgs --file-only'
  !endif
!macroend

!macro RunEngine Action Extra
  nsExec::ExecToLog /TIMEOUT=600000 '"$EngineNode" "$PLUGINSDIR\engine\install-engine.mjs" ${Action} $EngineArgs ${Extra}'
  Pop $0
!macroend

!macro AcquireMutex
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALLER_MUTEX}") p.r0 ?e'
  Pop $1
  StrCpy $Mutex $0
  ${If} $1 = 183
    MessageBox MB_ICONSTOP "Another dsh-TUI installer is running." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro AcquireMutex
  !insertmacro Bootstrap
  ; Welcome-page animation frames, extracted beside MUI's own bitmap. The panel
  ; replays the README logo timeline: 16 step-end frames of 325 ms (5.2 s). Both
  ; README logos ship, and only the frame set the user can read is extracted.
  ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
    StrCpy $WhaleSet "zh"
  ${Else}
    StrCpy $WhaleSet "en"
  ${EndIf}
  SetOutPath "$PLUGINSDIR"
  ${If} $WhaleSet == "zh"
    File /oname=welcome-zh-00.bmp "assets\dsh-tui-welcome-zh-00.bmp"
    File /oname=welcome-zh-01.bmp "assets\dsh-tui-welcome-zh-01.bmp"
    File /oname=welcome-zh-02.bmp "assets\dsh-tui-welcome-zh-02.bmp"
    File /oname=welcome-zh-03.bmp "assets\dsh-tui-welcome-zh-03.bmp"
    File /oname=welcome-zh-04.bmp "assets\dsh-tui-welcome-zh-04.bmp"
    File /oname=welcome-zh-05.bmp "assets\dsh-tui-welcome-zh-05.bmp"
    File /oname=welcome-zh-06.bmp "assets\dsh-tui-welcome-zh-06.bmp"
    File /oname=welcome-zh-07.bmp "assets\dsh-tui-welcome-zh-07.bmp"
    File /oname=welcome-zh-08.bmp "assets\dsh-tui-welcome-zh-08.bmp"
    File /oname=welcome-zh-09.bmp "assets\dsh-tui-welcome-zh-09.bmp"
    File /oname=welcome-zh-10.bmp "assets\dsh-tui-welcome-zh-10.bmp"
    File /oname=welcome-zh-11.bmp "assets\dsh-tui-welcome-zh-11.bmp"
    File /oname=welcome-zh-12.bmp "assets\dsh-tui-welcome-zh-12.bmp"
    File /oname=welcome-zh-13.bmp "assets\dsh-tui-welcome-zh-13.bmp"
    File /oname=welcome-zh-14.bmp "assets\dsh-tui-welcome-zh-14.bmp"
    File /oname=welcome-zh-15.bmp "assets\dsh-tui-welcome-zh-15.bmp"
  ${Else}
    File /oname=welcome-en-00.bmp "assets\dsh-tui-welcome-en-00.bmp"
    File /oname=welcome-en-01.bmp "assets\dsh-tui-welcome-en-01.bmp"
    File /oname=welcome-en-02.bmp "assets\dsh-tui-welcome-en-02.bmp"
    File /oname=welcome-en-03.bmp "assets\dsh-tui-welcome-en-03.bmp"
    File /oname=welcome-en-04.bmp "assets\dsh-tui-welcome-en-04.bmp"
    File /oname=welcome-en-05.bmp "assets\dsh-tui-welcome-en-05.bmp"
    File /oname=welcome-en-06.bmp "assets\dsh-tui-welcome-en-06.bmp"
    File /oname=welcome-en-07.bmp "assets\dsh-tui-welcome-en-07.bmp"
    File /oname=welcome-en-08.bmp "assets\dsh-tui-welcome-en-08.bmp"
    File /oname=welcome-en-09.bmp "assets\dsh-tui-welcome-en-09.bmp"
    File /oname=welcome-en-10.bmp "assets\dsh-tui-welcome-en-10.bmp"
    File /oname=welcome-en-11.bmp "assets\dsh-tui-welcome-en-11.bmp"
    File /oname=welcome-en-12.bmp "assets\dsh-tui-welcome-en-12.bmp"
    File /oname=welcome-en-13.bmp "assets\dsh-tui-welcome-en-13.bmp"
    File /oname=welcome-en-14.bmp "assets\dsh-tui-welcome-en-14.bmp"
    File /oname=welcome-en-15.bmp "assets\dsh-tui-welcome-en-15.bmp"
  ${EndIf}
  StrCpy $Decisions ""
  inspect:
  !insertmacro RunEngine "inspect" ""
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadINIStr $Running "$PLUGINSDIR\result.ini" "result" "running"
  ${If} $Running != ""
    IfSilent reject
    MessageBox MB_RETRYCANCEL|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(CloseRunning)" IDRETRY inspect
    Goto reject
  ${EndIf}
  ReadINIStr $KernelAction "$PLUGINSDIR\result.ini" "result" "kernelAction"
  ReadINIStr $KernelInstalled "$PLUGINSDIR\result.ini" "result" "kernelInstalled"
  ReadINIStr $InstallNode "$PLUGINSDIR\result.ini" "result" "installNode"
  ReadINIStr $InstallPnpm "$PLUGINSDIR\result.ini" "result" "installPnpm"
  ReadINIStr $TuiDowngrade "$PLUGINSDIR\result.ini" "result" "tuiDowngrade"
  ReadINIStr $TuiInstalled "$PLUGINSDIR\result.ini" "result" "tuiInstalled"
  ; Silent installs skip the review page, so unsafe replacements stay blocked here.
  ; Interactive installs defer both double confirmations to ConfirmPageLeave.
  ${If} $KernelAction == "downgrade"
  ${OrIf} $KernelAction == "incompatible"
    IfSilent reject
  ${EndIf}
  ${If} $TuiDowngrade == "yes"
    IfSilent reject
  ${EndIf}
  Return
  reject:
    SetErrorLevel 2
    Quit
FunctionEnd

Section "Install"
  ${If} $KernelAction == "keep"
    DetailPrint "$(KeepKernel)"
  ${Else}
    DetailPrint "$(InstallKernel)"
  ${EndIf}
  !insertmacro RunEngine "prepare" ""
  ${If} $0 != 0
    Goto failed
  ${EndIf}
  SetOutPath "$Prefix\_stage_tui"
  ClearErrors
  File "${BUILD_DIR}\common.bin"
  File "${BUILD_DIR}\tui.bin"
  ${If} $KernelAction != "keep"
    File "${BUILD_DIR}\dsh.bin"
  ${EndIf}
  ${If} $InstallNode == "yes"
    File "${BUILD_DIR}\node.bin"
  ${EndIf}
  ${If} $InstallPnpm == "yes"
    File "${BUILD_DIR}\pnpm.bin"
  ${EndIf}
  IfErrors extractFailed
  ; The engine installs the uninstaller in the same transaction as the packages.
  ; Leave the staging directory so Windows permits the engine to clean it up.
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  WriteUninstaller "$PLUGINSDIR\unins000.exe"
  IfErrors extractFailed
  !insertmacro RunEngine "install" '--payload "$Prefix\_stage_tui\payload" --extract --uninstaller "$PLUGINSDIR\unins000.exe" $Decisions'
  ${If} $0 != 0
    Goto failed
  ${EndIf}
  SetOutPath "$INSTDIR"
  !ifndef TEST_ROOT
    SetOutPath "$PROFILE"
    Call SelectTerminal
    CreateShortCut "$DESKTOP\dsh-TUI.lnk" "$Terminal" '$TerminalArgs'
    CreateDirectory "$SMPROGRAMS\dsh-TUI"
    CreateShortCut "$SMPROGRAMS\dsh-TUI\dsh-TUI.lnk" "$Terminal" '$TerminalArgs'
    CreateShortCut "$SMPROGRAMS\dsh-TUI\Uninstall.lnk" "$INSTDIR\unins000.exe"
  !endif
  Goto done
  extractFailed:
    SetOutPath "$PLUGINSDIR"
    StrCpy $Failure "Unable to extract the offline payload."
    !insertmacro RunEngine "discard" ""
    Goto showFailed
  failed:
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    SetOutPath "$PLUGINSDIR"
    ; Retry rollback and discard a rejected payload. Failed recovery keeps its
    ; journal intact so the next run can recover it instead of deleting backups.
    !insertmacro RunEngine "discard" ""
  showFailed:
    MessageBox MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    SetErrorLevel 1
    Abort
  done:
SectionEnd

Function WelcomePageShow
  ; This runs before the page is shown, so loading the first frame here both
  ; selects the language of the panel and leaves MUI's own placeholder invisible.
  ; LoadAndSetImage deletes the bitmap it replaces, so the handle it returns is
  ; the only live one — MUI's own handle dies with this first swap.
  StrCpy $WhaleTick 0
  StrCpy $WhaleFrame ""
  StrCpy $WhaleFrameFile "$PLUGINSDIR\welcome-$WhaleSet-00.bmp"
  LoadAndSetImage /STRINGID /RESIZETOFIT $mui.WelcomePage.Image ${IMAGE_BITMAP} ${LR_LOADFROMFILE} "$WhaleFrameFile" $WhaleFrame
  StrCpy $mui.WelcomePage.Image.Bitmap 0
  ${NSD_CreateTimer} WelcomeWhaleTick 325
FunctionEnd

Function WelcomePageDestroyed
  ${NSD_KillTimer} WelcomeWhaleTick
  ${If} $WhaleFrame != ""
    ${NSD_FreeImage} $WhaleFrame
  ${EndIf}
FunctionEnd

Function WelcomeWhaleTick
  IntOp $WhaleTick $WhaleTick + 1
  ${If} $WhaleTick > 15
    StrCpy $WhaleTick 0
  ${EndIf}
  ${If} $WhaleTick < 10
    StrCpy $WhaleFrameFile "$PLUGINSDIR\welcome-$WhaleSet-0$WhaleTick.bmp"
  ${Else}
    StrCpy $WhaleFrameFile "$PLUGINSDIR\welcome-$WhaleSet-$WhaleTick.bmp"
  ${EndIf}
  LoadAndSetImage /STRINGID /RESIZETOFIT $mui.WelcomePage.Image ${IMAGE_BITMAP} ${LR_LOADFROMFILE} "$WhaleFrameFile" $WhaleFrame
  ; The built-in deleted MUI's bitmap, so MUI must not free that stale handle.
  StrCpy $mui.WelcomePage.Image.Bitmap 0
FunctionEnd

Function ConfirmPageShow
  !insertmacro MUI_HEADER_TEXT "$(ConfirmTitle)" "$(ConfirmNote)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  StrCpy $ConfirmSummary "$(ConfirmTui): ${TUI_VERSION}$\r$\n"
  ${If} $KernelAction == "keep"
    StrCpy $ConfirmSummary "$ConfirmSummary$(ConfirmKernel): $(ConfirmKernelKeep) $KernelInstalled$\r$\n"
  ${Else}
    StrCpy $ConfirmSummary "$ConfirmSummary$(ConfirmKernel): $(ConfirmKernelReplace) ${KERNEL_VERSION}$\r$\n"
  ${EndIf}
  StrCpy $ConfirmSummary "$ConfirmSummary$(ConfirmCommands): $Prefix$\r$\n$(ConfirmMeta): $INSTDIR$\r$\n$(ConfirmProfile): $UserHome\.dsh\profiles\dsh-tui$\r$\n"
  ${If} $InstallNode == "yes"
    StrCpy $ConfirmSummary "$ConfirmSummary$(ConfirmRuntime): $(ConfirmRuntimeInstall)"
  ${Else}
    StrCpy $ConfirmSummary "$ConfirmSummary$(ConfirmRuntime): $(ConfirmRuntimeReuse)"
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 66u "$ConfirmSummary"
  Pop $0
  StrCpy $ConfirmWarn ""
  ${If} $KernelAction == "downgrade"
  ${OrIf} $KernelAction == "incompatible"
    StrCpy $ConfirmWarn "$(ConfirmWarnKernel)"
  ${EndIf}
  ${If} $TuiDowngrade == "yes"
    ${If} $ConfirmWarn == ""
      StrCpy $ConfirmWarn "$(ConfirmWarnTui)"
    ${Else}
      StrCpy $ConfirmWarn "$ConfirmWarn$\r$\n$(ConfirmWarnTui)"
    ${EndIf}
  ${EndIf}
  ${If} $ConfirmWarn != ""
    ${NSD_CreateLabel} 0 68u 100% 30u "$ConfirmWarn"
    Pop $0
    SetCtlColors $0 0xB00020 transparent
  ${EndIf}
  ${NSD_CreateCheckbox} 0 102u 100% 12u "$(ConfirmAccept)"
  Pop $ConfirmCheckbox
  nsDialogs::Show
FunctionEnd

Function ConfirmPageLeave
  ${NSD_GetState} $ConfirmCheckbox $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION "$(ConfirmRequired)"
    Abort
  ${EndIf}
  ; Replacing an out-of-contract kernel or downgrading TUI needs two consents.
  ${If} $KernelAction == "downgrade"
  ${OrIf} $KernelAction == "incompatible"
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(KernelAhead)" IDYES +2
    Abort
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(KernelConfirm)" IDYES +2
    Abort
    StrCpy $Decisions "$Decisions --kernel-downgrade"
  ${EndIf}
  ${If} $TuiDowngrade == "yes"
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(TuiAhead)" IDYES +2
    Abort
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(TuiConfirm)" IDYES +2
    Abort
    StrCpy $Decisions "$Decisions --tui-downgrade"
  ${EndIf}
FunctionEnd

Function LaunchTui
  !ifndef TEST_ROOT
    SetOutPath "$PROFILE"
    ReadEnvStr $0 PATH
    System::Call 'kernel32::SetEnvironmentVariableW(w "PATH", w "$Prefix;$0")'
    Call SelectTerminal
    ExecShell "open" "$Terminal" '$TerminalArgs'
  !endif
FunctionEnd

!ifndef TEST_ROOT
Function SelectTerminal
  ; A normal console launch uses Windows' configured default terminal host.
  StrCpy $Terminal "$SYSDIR\cmd.exe"
  StrCpy $TerminalArgs '/D /K ""$Prefix\dsh-tui.cmd""'
  SearchPath $0 "wt.exe"
  ${If} $0 == ""
    IfFileExists "$LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" 0 terminalDone
    StrCpy $0 "$LOCALAPPDATA\Microsoft\WindowsApps\wt.exe"
  ${EndIf}
  StrCpy $Terminal "$0"
  StrCpy $TerminalArgs '-d "$PROFILE" "$SYSDIR\cmd.exe" /D /K "$Prefix\dsh-tui.cmd"'
  terminalDone:
FunctionEnd
!endif

Function un.onInit
  !insertmacro AcquireMutex
  !insertmacro Bootstrap
  StrCpy $FullRemoval ""
  StrCpy $Decisions ""
FunctionEnd

Function un.ChooseScope
  !insertmacro MUI_HEADER_TEXT "$(RemoveTitle)" "$(RemoveNote)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 15u 100% 25u "$(RemoveTui)"
  Pop $1
  ${NSD_Check} $1
  ${NSD_CreateRadioButton} 0 50u 100% 25u "$(RemoveBoth)"
  Pop $RemoveRadio
  nsDialogs::Show
FunctionEnd

Function un.ConfirmScope
  ${NSD_GetState} $RemoveRadio $0
  StrCpy $FullRemoval ""
  StrCpy $Decisions ""
  ${If} $0 == ${BST_CHECKED}
    StrCpy $FullRemoval "--full"
  ${EndIf}
  !insertmacro RunEngine "inspect" ""
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$Failure"
    Abort
  ${EndIf}
  ReadINIStr $Running "$PLUGINSDIR\result.ini" "result" "running"
  ${If} $Running != ""
    MessageBox MB_ICONEXCLAMATION "$(CloseRunning)"
    Abort
  ${EndIf}
  ReadINIStr $OtherProfiles "$PLUGINSDIR\result.ini" "result" "otherProfiles"
  ${If} $FullRemoval != ""
  ${AndIf} $OtherProfiles != ""
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(SharedWarning)" IDYES +2
    Abort
    StrCpy $Decisions "--confirm-shared"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  !insertmacro RunEngine "uninstall" '$FullRemoval $Decisions'
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$Failure" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !ifndef TEST_ROOT
    Delete "$DESKTOP\dsh-TUI.lnk"
    Delete "$SMPROGRAMS\dsh-TUI\dsh-TUI.lnk"
    Delete "$SMPROGRAMS\dsh-TUI\Uninstall.lnk"
    RMDir "$SMPROGRAMS\dsh-TUI"
  !endif
  Delete "$INSTDIR\installation.json"
  Delete "$INSTDIR\unins000.exe"
  RMDir "$INSTDIR"
SectionEnd
