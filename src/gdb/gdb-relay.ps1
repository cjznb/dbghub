# dbghub GDB/MI relay (Windows sandbox fallback).
#
# Some Windows sandboxes deny named-pipe creation to the host process, so
# child_process.spawn(..., { stdio: ['pipe','pipe','pipe'] }) fails with EPERM.
# This script is started by src/gdb/gdb-spawner.mjs with stdio redirected to
# files ('ignore' for stdin) and a loopback TCP port:
#
#   pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass
#        -File gdb-relay.ps1 -Port <port>
#
# gdb path + argv arrive through DBGHUB_GDB_PATH / DBGHUB_GDB_ARGV (JSON array);
# the relay connects back to 127.0.0.1:<port> and speaks a base64 line protocol:
#
#   relay -> host : "o <b64>"  raw stdout bytes (MI stream)
#                   "e <b64>"  raw stderr bytes
#                   "x <code>" child exited
#                   "f <b64>"  fatal relay/start error message
#   host -> relay : "i <b64>"  write these bytes + "\n" to gdb stdin
#                   "x"        stop gdb and exit
#
# Stdout is streamed raw (not line-buffered) so an unterminated "(gdb) " prompt
# is delivered immediately; the host re-assembles records with MiStreamParser.
param([int]$Port = 0)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public class DbghubGdbRelay
{
    private static readonly object Gate = new object();
    private static StreamWriter _tcpOut;
    private static TcpClient _client;
    private static Process _proc;
    private static volatile bool _finished;

    private static void Send(string kind, string payload)
    {
        lock (Gate)
        {
            if (_tcpOut == null || _finished) return;
            try { _tcpOut.WriteLine(kind + " " + payload); _tcpOut.Flush(); } catch { }
        }
    }

    private static void SendFatal(string message)
    {
        Send("f", Convert.ToBase64String(Encoding.UTF8.GetBytes(message)));
    }

    private static void Pump(Stream stream, string kind)
    {
        byte[] buffer = new byte[8192];
        try
        {
            int n;
            while ((n = stream.Read(buffer, 0, buffer.Length)) > 0)
                Send(kind, Convert.ToBase64String(buffer, 0, n));
        }
        catch { }
    }

    private static void Finish(int code)
    {
        lock (Gate)
        {
            if (_finished) return;
            _finished = true;
            try { _tcpOut.WriteLine("x " + code); _tcpOut.Flush(); } catch { }
        }
        try { _client.Close(); } catch { }
    }

    public static int Run(int port, string exe, string[] args, string cwd)
    {
        _client = new TcpClient();
        _client.NoDelay = true;
        bool connected = false;
        for (int i = 0; i < 300; i++)
        {
            try { _client.Connect("127.0.0.1", port); connected = true; break; }
            catch { Thread.Sleep(50); }
        }
        if (!connected) return -2;
        NetworkStream net = _client.GetStream();
        _tcpOut = new StreamWriter(net, new UTF8Encoding(false));
        _tcpOut.AutoFlush = false;
        StreamReader tcpIn = new StreamReader(net, new UTF8Encoding(false));

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        foreach (string a in args) psi.ArgumentList.Add(a);
        if (!String.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        try { _proc = Process.Start(psi); }
        catch (Exception e)
        {
            SendFatal("gdb failed to start: " + e.Message);
            Finish(-3);
            return -3;
        }

        Thread tOut = new Thread(delegate() { Pump(_proc.StandardOutput.BaseStream, "o"); });
        Thread tErr = new Thread(delegate() { Pump(_proc.StandardError.BaseStream, "e"); });
        tOut.IsBackground = true; tErr.IsBackground = true;
        tOut.Start(); tErr.Start();

        Thread watcher = new Thread(delegate()
        {
            int code = 0;
            try { _proc.WaitForExit(); code = _proc.ExitCode; } catch { }
            try { tOut.Join(1500); } catch { }
            try { tErr.Join(1500); } catch { }
            Finish(code);
        });
        watcher.IsBackground = true;
        watcher.Start();

        string line;
        try
        {
            while ((line = tcpIn.ReadLine()) != null)
            {
                if (line.Length < 1) continue;
                string kind = line.Substring(0, 1);
                string body = line.Length > 2 && line[1] == ' ' ? line.Substring(2) : String.Empty;
                if (kind == "i")
                {
                    byte[] raw = Convert.FromBase64String(body);
                    string text = Encoding.UTF8.GetString(raw);
                    try { _proc.StandardInput.Write(text + "\n"); _proc.StandardInput.Flush(); }
                    catch { }
                }
                else if (kind == "x")
                {
                    break;
                }
            }
        }
        catch { }

        try { _proc.StandardInput.Close(); } catch { }
        // Give gdb a moment to exit on its own (-gdb-exit), then force it.
        try { if (!_proc.WaitForExit(2500)) { _proc.Kill(true); } } catch { }
        try { watcher.Join(5000); } catch { }
        Finish(0);
        return 0;
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp

$gdbPath = $env:DBGHUB_GDB_PATH
$argvJson = $env:DBGHUB_GDB_ARGV
if (-not $gdbPath) { throw 'DBGHUB_GDB_PATH is not set' }
if (-not $argvJson) { $argvJson = '[]' }
$argv = @([string[]]($argvJson | ConvertFrom-Json))
$cwd = $env:DBGHUB_GDB_CWD
[DbghubGdbRelay]::Run($Port, $gdbPath, $argv, $cwd) | Out-Null
