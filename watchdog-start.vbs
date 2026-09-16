Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps = base & "\watchdog.ps1"
q = Chr(34)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & ps & q, 0, False