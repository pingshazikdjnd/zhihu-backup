' Windows 计划任务静默启动器（不弹黑框，日志追加写入 logs/auto-sync.log）
' 使用 --type=all --fast：回答与收藏夹做增量同步（不浪费D1每日写入额度），赞同段在扫完新增后自动跳到 upvotes_cursor 断点继续补历史
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
