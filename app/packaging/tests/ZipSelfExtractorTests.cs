using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

public static class ZipSelfExtractorTests
{
    private static int passed;
    private static int failed;
    private static string root;

    [STAThread]
    public static int Main(string[] arguments)
    {
        root = Path.GetFullPath(arguments[0]);
        Directory.CreateDirectory(root);
        Run("file contents, empty directories, and byte progress", TestExtraction);
        Run("empty files and directories", TestEmptyFiles);
        Run("existing file protection before copying", TestExistingFile);
        Run("archive path traversal", TestTraversal);
        Run("write failure leaves progress below 100 percent", TestWriteFailure);
        Application.EnableVisualStyles();
        Run("background extraction error reaches the caller", TestWorkerError);
        if (arguments.Length == 2)
        {
            Run("release archive extraction and responsive progress window", delegate
            {
                TestReleaseArchive(arguments[1]);
            });
        }
        Console.WriteLine("zip-extraction-tests: passed={0} failed={1}", passed, failed);
        return failed == 0 ? 0 : 1;
    }

    private static void Run(string name, Action test)
    {
        try
        {
            test();
            passed++;
            Console.WriteLine("PASS: " + name);
        }
        catch (Exception error)
        {
            failed++;
            Console.WriteLine("FAIL: " + name + "\n" + error);
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static void Expect<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new Exception("Expected " + typeof(T).Name);
    }

    private static void WithArchive(Dictionary<string, byte[]> files, Action<ZipArchive> test)
    {
        using (MemoryStream contents = new MemoryStream())
        {
            using (ZipArchive archive = new ZipArchive(contents, ZipArchiveMode.Create, true))
            {
                foreach (KeyValuePair<string, byte[]> file in files)
                {
                    using (Stream destination = archive.CreateEntry(file.Key).Open())
                    {
                        destination.Write(file.Value, 0, file.Value.Length);
                    }
                }
            }
            contents.Position = 0;
            using (ZipArchive archive = new ZipArchive(contents, ZipArchiveMode.Read)) test(archive);
        }
    }

    private static void TestExtraction()
    {
        string destination = Path.Combine(root, "contents");
        byte[] first = new byte[3 * 1024 * 1024];
        new Random(37).NextBytes(first);
        byte[] second = new byte[] { 10, 20, 30, 40 };
        List<ZipExtractionProgress> events = new List<ZipExtractionProgress>();
        WithArchive(new Dictionary<string, byte[]>
        {
            { "empty/", new byte[0] }, { "nested/first.bin", first }, { "second.bin", second }
        }, delegate(ZipArchive archive)
        {
            ZipSelfExtractor.ExtractArchive(archive, destination, delegate(ZipExtractionProgress value)
            {
                events.Add(value);
                if (value.ExtractedBytes == 0 && value.FileName == "nested/first.bin")
                {
                    Thread.Sleep(120);
                }
            });
        });
        Require(File.ReadAllBytes(Path.Combine(destination, "nested/first.bin")).SequenceEqual(first), "First file differs");
        Require(File.ReadAllBytes(Path.Combine(destination, "second.bin")).SequenceEqual(second), "Second file differs");
        Require(Directory.Exists(Path.Combine(destination, "empty")), "Empty directory missing");
        Require(events.First().Percent == 0 && events.Last().Percent == 100, "Progress endpoints differ");
        Require(events.All(value => value.TotalBytes == first.Length + second.Length), "Total byte count differs");
        Require(events.Last().ExtractedBytes == first.Length + second.Length, "Extracted byte count differs");
        Require(events.Any(value => value.ExtractedBytes > 0 && value.ExtractedBytes < first.Length && value.FileName == "nested/first.bin"), "Missing progress within a file");
        Require(events.Zip(events.Skip(1), (left, right) => left.ExtractedBytes <= right.ExtractedBytes).All(value => value), "Progress decreased");
    }

    private static void TestEmptyFiles()
    {
        string destination = Path.Combine(root, "empty");
        ZipExtractionProgress last = null;
        WithArchive(new Dictionary<string, byte[]> { { "folder/", new byte[0] }, { "empty.txt", new byte[0] } }, delegate(ZipArchive archive)
        {
            ZipSelfExtractor.ExtractArchive(archive, destination, value => last = value);
        });
        Require(File.Exists(Path.Combine(destination, "empty.txt")), "Empty file missing");
        Require(Directory.Exists(Path.Combine(destination, "folder")), "Empty directory missing");
        Require(last.TotalBytes == 0 && last.ExtractedBytes == 0 && last.Percent == 100, "Zero byte progress differs");
    }

    private static void TestExistingFile()
    {
        string destination = Path.Combine(root, "existing");
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(destination, "keep.txt"), "original");
        WithArchive(new Dictionary<string, byte[]> { { "new.txt", new byte[] { 1 } }, { "keep.txt", new byte[] { 2 } } }, delegate(ZipArchive archive)
        {
            Expect<IOException>(() => ZipSelfExtractor.ExtractArchive(archive, destination, null));
        });
        Require(File.ReadAllText(Path.Combine(destination, "keep.txt")) == "original", "Existing file changed");
        Require(!File.Exists(Path.Combine(destination, "new.txt")), "Copy started before conflict detection");
    }

    private static void TestTraversal()
    {
        string destination = Path.Combine(root, "traversal");
        WithArchive(new Dictionary<string, byte[]> { { "../outside.txt", new byte[] { 1 } } }, delegate(ZipArchive archive)
        {
            Expect<InvalidDataException>(() => ZipSelfExtractor.ExtractArchive(archive, destination, null));
        });
        Require(!File.Exists(Path.Combine(root, "outside.txt")), "File written outside extraction directory");
    }

    private static void TestWriteFailure()
    {
        string destination = Path.Combine(root, "write-failure");
        Directory.CreateDirectory(Path.Combine(destination, "file.bin"));
        List<ZipExtractionProgress> events = new List<ZipExtractionProgress>();
        WithArchive(new Dictionary<string, byte[]> { { "file.bin", new byte[1024] } }, delegate(ZipArchive archive)
        {
            Expect<UnauthorizedAccessException>(() => ZipSelfExtractor.ExtractArchive(archive, destination, events.Add));
        });
        Require(events.Count > 0 && events.All(value => value.Percent < 100), "Failed extraction reported completion");
    }

    private static void TestWorkerError()
    {
        using (ZipExtractionProgressForm form = new ZipExtractionProgressForm(
            Path.Combine(root, "missing.exe"), Path.Combine(root, "worker-error")))
        {
            Application.Run(form);
            Require(form.Error is FileNotFoundException, "Worker error was not returned");
        }
    }

    private static void TestReleaseArchive(string archivePath)
    {
        string destination = Path.Combine(root, "release");
        int ticks = 0;
        int finalPercent = -1;
        bool checkedClose = false;
        bool closedDuringExtraction = false;
        HashSet<int> percentages = new HashSet<int>();
        using (ZipExtractionProgressForm form = new ZipExtractionProgressForm(archivePath, destination))
        using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
        {
            ProgressBar progress = form.Controls.OfType<ProgressBar>().Single();
            timer.Interval = 20;
            timer.Tick += delegate
            {
                ticks++;
                if (progress.Style == ProgressBarStyle.Continuous)
                {
                    percentages.Add(progress.Value);
                    if (!checkedClose && progress.Value > 0 && progress.Value < 100)
                    {
                        checkedClose = true;
                        form.Close();
                        closedDuringExtraction = form.IsDisposed;
                    }
                }
            };
            form.Shown += delegate { timer.Start(); };
            form.FormClosed += delegate { finalPercent = progress.Value; };
            Application.Run(form);
            timer.Stop();
            if (form.Error != null) throw form.Error;
        }
        Require(ticks > 2 && percentages.Any(value => value > 0 && value < 100), "Progress window did not respond during extraction");
        Require(!closedDuringExtraction, "Progress window closed during extraction");
        Require(finalPercent == 100, "Final progress is not 100 percent");
        Require(Directory.GetFiles(destination, "EarCopyAssist.exe", SearchOption.AllDirectories).Length == 1, "Application executable missing");
        Console.WriteLine("release-extraction: timer_ticks={0} distinct_percentages={1} final_percent={2}", ticks, percentages.Count, finalPercent);
    }
}
