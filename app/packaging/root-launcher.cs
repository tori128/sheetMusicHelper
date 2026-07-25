using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("EarCopy Assist")]
[assembly: AssemblyDescription("EarCopy Assist")]
[assembly: AssemblyProduct("EarCopy Assist")]
[assembly: AssemblyCompany("SheetMusicHelper Contributors")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        string repositoryRoot = AppDomain.CurrentDomain.BaseDirectory;
        string executable = Path.Combine(
            repositoryRoot,
            "app",
            "release",
            "win-unpacked",
            "EarCopyAssist.exe"
        );
        if (!File.Exists(executable))
        {
            MessageBox.Show(
                "EarCopy Assist application files were not found.",
                "EarCopy Assist",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }

        try
        {
            Environment.SetEnvironmentVariable(
                "EARCOPY_LAUNCHER_ROOT",
                repositoryRoot.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar
                ),
                EnvironmentVariableTarget.Process
            );
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = Path.GetDirectoryName(executable),
                UseShellExecute = true,
            };
            Process process = Process.Start(startInfo);
            if (process == null)
            {
                return 1;
            }
            if (Environment.GetEnvironmentVariable("EARCOPY_SMOKE_TEST") == "1")
            {
                process.WaitForExit();
                return process.ExitCode;
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                error.Message,
                "EarCopy Assist",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }
}
