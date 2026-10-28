' Windows Scheduled Task Silent Launcher for Zhihu Sync
' Runs node scripts/local-sync.mjs --type=all --fast silently and appends logs to logs/auto-sync.log
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logDir = rootDir & "\logs"
If Not fso.FolderExists(logDir) Then
  fso.CreateFolder(logDir)
End If
shell.CurrentDirectory = rootDir
cmd = "cmd.exe /d /s /c ""chcp 65001 >nul && node scripts\local-sync.mjs --type=all --fast >> """ & logDir & "\auto-sync.log"" 2>&1"""
shell.Run cmd, 0, True