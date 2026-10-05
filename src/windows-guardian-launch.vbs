Option Explicit

Dim arguments, logPath, shell, command, exitCode, launchError, launchFailed, retryDelay
Set arguments = WScript.Arguments
If arguments.Count <> 4 Then WScript.Quit 64

logPath = arguments(3)
If Not appendEvent("launcher-start") Then WScript.Quit 1

command = quoted(arguments(0)) & " " & quoted(arguments(1)) & " " & quoted(arguments(2))
On Error Resume Next
Set shell = CreateObject("WScript.Shell")
If Err.Number <> 0 Then
  launchError = Err.Description
  Err.Clear
  appendEvent "launcher-error " & launchError
  WScript.Quit 1
End If
On Error GoTo 0

retryDelay = 1000
Do
  On Error Resume Next
  exitCode = shell.Run(command, 0, True)
  launchFailed = Err.Number <> 0
  launchError = Err.Description
  Err.Clear
  On Error GoTo 0

  If launchFailed Then
    If Not appendEvent("launcher-error " & launchError) Then WScript.Quit 1
  Else
    If Not appendEvent("launcher-exit code=" & exitCode) Then WScript.Quit 1
    If exitCode = 0 Then WScript.Quit 0
  End If

  If Not appendEvent("launcher-restart delay-ms=" & retryDelay) Then WScript.Quit 1
  WScript.Sleep retryDelay
  If retryDelay < 60000 Then
    retryDelay = retryDelay * 2
    If retryDelay > 60000 Then retryDelay = 60000
  End If
Loop

Function quoted(value)
  quoted = Chr(34) & value & Chr(34)
End Function

Function appendEvent(message)
  On Error Resume Next
  Dim stream
  Set stream = CreateObject("Scripting.FileSystemObject").OpenTextFile(logPath, 8, True)
  If Err.Number <> 0 Then
    Err.Clear
    appendEvent = False
    Exit Function
  End If
  stream.WriteLine stamp() & " " & message
  stream.Close
  appendEvent = Err.Number = 0
  Err.Clear
  On Error GoTo 0
End Function

Function stamp()
  Dim current
  current = Now()
  stamp = Year(current) & "-" & pad(Month(current)) & "-" & pad(Day(current)) & "T" & _
    pad(Hour(current)) & ":" & pad(Minute(current)) & ":" & pad(Second(current))
End Function

Function pad(value)
  pad = Right("0" & CStr(value), 2)
End Function
