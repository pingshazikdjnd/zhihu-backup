' Windows 计划任务静默启动器（不弹黑框，日志写入 logs/auto-sync.log）
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logDir = rootDir & "\logs"
If Not fso.FolderExists(logDir) Then
  fso.CreateFolder(logDir)
End If
cmd = "cmd.exe /c cd /d """ & rootDir & """ && node scripts\local-sync.mjs --type=all >> """ & logDir & "\auto-sync.log"" 2>&1"
shell.Run cmd, 0, True
