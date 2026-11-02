using System;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

internal sealed class ZipExtractionProgress
{
    internal readonly long ExtractedBytes;
    internal readonly long TotalBytes;
    internal readonly string FileName;

    internal ZipExtractionProgress(long extractedBytes, long totalBytes, string fileName)
    {
        ExtractedBytes = extractedBytes;
        TotalBytes = totalBytes;
        FileName = fileName;
    }

    internal int Percent
    {
        get
        {
            return TotalBytes == 0 ? 100 : (int)(ExtractedBytes * 100m / TotalBytes);
        }
    }
}

internal sealed class ZipExtractionProgressForm : Form
{
    private readonly BackgroundWorker worker = new BackgroundWorker();
    private readonly Label status = new Label();
    private readonly Label fileName = new Label();
    private readonly Label size = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private bool completed;

    internal Exception Error { get; private set; }

    internal ZipExtractionProgressForm(string executablePath, string extractionRoot)
    {
        Text = "EarCopy Assist - 展開";
        Font = SystemFonts.MessageBoxFont;
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(560, 156);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        ControlBox = false;
        MaximizeBox = false;

        status.SetBounds(16, 16, 528, 24);
        status.Text = "ZIPを確認しています…";
        progress.SetBounds(16, 46, 528, 22);
        progress.Style = ProgressBarStyle.Marquee;
        progress.AccessibleName = "展開率";
        size.SetBounds(16, 78, 528, 24);
        fileName.SetBounds(16, 112, 528, 24);
        fileName.AutoEllipsis = true;
        Controls.AddRange(new Control[] { status, progress, size, fileName });

        worker.WorkerReportsProgress = true;
        worker.DoWork += delegate
        {
            ZipSelfExtractor.Extract(executablePath, extractionRoot, delegate(ZipExtractionProgress value)
            {
                worker.ReportProgress(value.Percent, value);
            });
        };
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs arguments)
        {
            ZipExtractionProgress value = (ZipExtractionProgress)arguments.UserState;
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = value.Percent;
            status.Text = "展開中… " + value.Percent.ToString(CultureInfo.CurrentCulture) + "%";
            size.Text = String.Format(
                CultureInfo.CurrentCulture, "{0:N0} / {1:N0} bytes",
                value.ExtractedBytes, value.TotalBytes);
            fileName.Text = value.FileName;
        };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs arguments)
        {
            Error = arguments.Error;
            completed = true;
            Close();
        };
        Shown += delegate { worker.RunWorkerAsync(); };
        FormClosing += delegate(object sender, FormClosingEventArgs arguments)
        {
            arguments.Cancel = !completed;
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            worker.Dispose();
        }
        base.Dispose(disposing);
    }
}
