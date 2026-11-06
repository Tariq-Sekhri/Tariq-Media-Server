Option Explicit
Dim shell, command, i, argument
Set shell = CreateObject("WScript.Shell")
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") & """ -NoLogo -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "
For i = 0 To WScript.Arguments.Count - 1
    argument = WScript.Arguments(i)
    command = command & " """ & Replace(argument, """", """""") & """"
Next
WScript.Quit shell.Run(command, 0, True)
