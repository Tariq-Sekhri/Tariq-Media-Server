Option Explicit

Dim shell, fso, scriptDir, powerShell, trayScript, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
trayScript = scriptDir & "\tms-tray.ps1"
command = """" & powerShell & """ -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & trayScript & """"
shell.Run command, 0, False
