Option Explicit

Dim shell, fso, scriptDir, projectRoot, powerShell, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
launcher = projectRoot & "\start_tms.ps1"
command = """" & powerShell & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & launcher & """"
shell.Run command, 0, False
