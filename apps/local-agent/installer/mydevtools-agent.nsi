; Per-user setup for MyDevTools Local Agent.
; A later run of this setup stops an open agent and replaces the copy in
; %LOCALAPPDATA%\MyDevTools\Agent. It does not install a Windows service and
; does not check for updates on its own.
;
; makensis -INPUTCHARSET UTF8 -DPRODUCT_VERSION=0.1.2 -DPRODUCT_VERSION_QUAD=0.1.2.0
;   -DPAYLOAD=...\mydevtools-local-agent.exe -DOUTFILE=...\setup.exe -DICON=...\mydevtools.ico
;   installer/mydevtools-agent.nsi

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is required"
!endif
!ifndef PRODUCT_VERSION_QUAD
  !error "PRODUCT_VERSION_QUAD is required"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD is required"
!endif
!ifndef OUTFILE
  !error "OUTFILE is required"
!endif
!ifndef ICON
  !error "ICON is required"
!endif

!define APP_NAME "MyDevTools Local Agent"
!define REG_APP "Software\MyDevTools\LocalAgent"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MyDevToolsLocalAgent"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define RUN_VALUE "MyDevToolsLocalAgent"

Name "${APP_NAME} ${PRODUCT_VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\MyDevTools\Agent"
InstallDirRegKey HKCU "${REG_APP}" "InstallDir"
ShowInstDetails show
SetOverwrite on
BrandingText "MyDevTools"

VIProductVersion "${PRODUCT_VERSION_QUAD}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} setup"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "CompanyName" "MyDevTools"
VIAddVersionKey "LegalCopyright" "MyDevTools"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\mydevtools-agent.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(FinishRun)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

LangString WelcomeTitle ${LANG_ENGLISH} "Install MyDevTools Local Agent"
LangString WelcomeTitle ${LANG_RUSSIAN} "Установка MyDevTools Local Agent"
LangString WelcomeText ${LANG_ENGLISH} "This setup installs the agent for the current Windows user in %LOCALAPPDATA%\MyDevTools\Agent. Running it again replaces that copy and stops an agent that is already open. Administrator rights are not required, and no Windows service is installed."
LangString WelcomeText ${LANG_RUSSIAN} "Установщик ставит агент для текущего пользователя Windows в %LOCALAPPDATA%\MyDevTools\Agent. Повторный запуск заменяет эту копию и останавливает уже открытый агент. Права администратора не нужны, служба Windows не устанавливается."
LangString FinishTitle ${LANG_ENGLISH} "MyDevTools Local Agent is installed"
LangString FinishTitle ${LANG_RUSSIAN} "MyDevTools Local Agent установлен"
LangString FinishText ${LANG_ENGLISH} "Open the agent to see the pairing code. A later download of this setup replaces this copy."
LangString FinishText ${LANG_RUSSIAN} "Откройте агент, чтобы увидеть код подключения. Следующий запуск этого установщика заменит эту копию."
LangString FinishRun ${LANG_ENGLISH} "Start MyDevTools Local Agent"
LangString FinishRun ${LANG_RUSSIAN} "Запустить MyDevTools Local Agent"

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "MyDevTools Local Agent requires 64-bit Windows 10 or later."
    Abort
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

; Image names cover the installed file, the older portable download, and the Cargo output name.
Function StopAgent
  ExecWait 'cmd.exe /c "taskkill /F /IM mydevtools-agent.exe & taskkill /F /IM mydevtools-agent-windows-x64.exe & taskkill /F /IM mydevtools-local-agent.exe"' $0
  Sleep 800
FunctionEnd

Function un.StopAgent
  ExecWait 'cmd.exe /c "taskkill /F /IM mydevtools-agent.exe & taskkill /F /IM mydevtools-local-agent.exe"' $0
  Sleep 800
FunctionEnd

; Keep an opt-in autostart entry pointed at the installed file. Leave it absent when the user has not enabled it.
Function UpdateAutostart
  ClearErrors
  ReadRegStr $0 HKCU "${RUN_KEY}" "${RUN_VALUE}"
  IfErrors autostart_done
  StrCmp $0 "" autostart_done
  WriteRegStr HKCU "${RUN_KEY}" "${RUN_VALUE}" '"$INSTDIR\mydevtools-agent.exe" --autostart'
  autostart_done:
FunctionEnd

Section "Install"
  Call StopAgent
  SetOutPath "$INSTDIR"
  File "/oname=mydevtools-agent.exe" "${PAYLOAD}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\MyDevTools"
  CreateShortcut "$SMPROGRAMS\MyDevTools\MyDevTools Local Agent.lnk" "$INSTDIR\mydevtools-agent.exe"
  CreateShortcut "$SMPROGRAMS\MyDevTools\Uninstall MyDevTools Local Agent.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${REG_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "MyDevTools"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
  Call UpdateAutostart
SectionEnd

Section "Uninstall"
  Call un.StopAgent
  Delete "$INSTDIR\mydevtools-agent.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\MyDevTools\MyDevTools Local Agent.lnk"
  Delete "$SMPROGRAMS\MyDevTools\Uninstall MyDevTools Local Agent.lnk"
  RMDir "$SMPROGRAMS\MyDevTools"
  DeleteRegValue HKCU "${RUN_KEY}" "${RUN_VALUE}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${REG_APP}"
SectionEnd
