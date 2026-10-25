; Clean uninstall: remove what Island leaves outside its install folder.
; (Settings and chats in %APPDATA%\island-assistant are kept, so reinstalling keeps them.)
!macro customUnInstall
  ; "Start with Windows" entry written by app.setLoginItemSettings
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.island.assistant"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Island"
  ; helper scripts the app writes to the temp folder
  Delete "$TEMP\island-input-*.ps1"
  Delete "$TEMP\island-uia-*.ps1"
!macroend
