using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Windows.Forms;

internal static class ZipSelfExtractor
{
    private static readonly byte[] FooterMagic = new byte[]
    {
        0x45, 0x41, 0x43, 0x5F, 0x5A, 0x49, 0x50, 0x5F,
        0x53, 0x46, 0x58, 0x5F, 0x30, 0x30, 0x30, 0x31
    };
    private const int FooterLength = 24;
    private const uint CentralDirectoryHeaderSignature = 0x02014b50;
    private const uint EndOfCentralDirectorySignature = 0x06054b50;
    private const uint Zip64EndOfCentralDirectorySignature = 0x06064b50;
    private const uint Zip64LocatorSignature = 0x07064b50;
    private const ushort Zip64ExtraFieldId = 0x0001;
    private const uint UInt32MaxValue = 0xffffffff;
    private const ushort UInt16MaxValue = 0xffff;

    [STAThread]
    private static int Main(string[] arguments)
    {
        try
        {
            string executablePath = Path.GetFullPath(Environment.GetCommandLineArgs()[0]);
            using (SplitZipStream splitArchive = SplitZipStream.Open(executablePath, FooterMagic))
            using (Stream archiveStream = BuildNormalizedArchive(splitArchive))
            using (ZipArchive archive = new ZipArchive(
                archiveStream,
                ZipArchiveMode.Read,
                false))
            {
                if (arguments.Length == 1 && arguments[0] == "--verify")
                {
                    ValidateArchiveEntries(archive);
                    return 0;
                }
                if (arguments.Length == 2 && arguments[0] == "--extract")
                {
                    string commandExtractionRoot = Path.GetFullPath(arguments[1]);
                    Directory.CreateDirectory(commandExtractionRoot);
                    ExtractArchive(archive, commandExtractionRoot);
                    return 0;
                }
                if (arguments.Length != 0)
                {
                    throw new InvalidOperationException("Unsupported command-line argument.");
                }

                string extractionRoot = SelectExtractionRoot(executablePath);
                if (extractionRoot == null)
                {
                    return 0;
                }
                ExtractArchive(archive, extractionRoot);
                MessageBox.Show(
                    "展開が完了しました。",
                    "EarCopy Assist",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return 0;
            }
        }
        catch (Exception exception)
        {
            if (arguments.Length != 0)
            {
                Console.Error.WriteLine(exception.Message);
                return 1;
            }
            MessageBox.Show(
                "展開できませんでした。\r\n" + exception.Message,
                "EarCopy Assist",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string SelectExtractionRoot(string executablePath)
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "展開先フォルダーを選択してください。";
            dialog.SelectedPath = Path.GetDirectoryName(executablePath);
            if (dialog.ShowDialog() != DialogResult.OK)
            {
                return null;
            }
            return Path.GetFullPath(dialog.SelectedPath);
        }
    }

    private static void ExtractArchive(ZipArchive archive, string extractionRoot)
    {
        List<ExtractionEntry> entries = ValidateArchiveEntries(archive, extractionRoot);
        foreach (ExtractionEntry entry in entries)
        {
            if (entry.IsDirectory)
            {
                Directory.CreateDirectory(entry.DestinationPath);
                continue;
            }
            if (File.Exists(entry.DestinationPath))
            {
                throw new IOException("展開先に同名のファイルがあります: " + entry.DestinationPath);
            }
        }
        foreach (ExtractionEntry entry in entries)
        {
            if (entry.IsDirectory)
            {
                continue;
            }
            string parent = Path.GetDirectoryName(entry.DestinationPath);
            if (!String.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }
            using (Stream source = entry.Entry.Open())
            using (FileStream destination = new FileStream(
                entry.DestinationPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None))
            {
                source.CopyTo(destination);
            }
        }
    }

    private static List<ExtractionEntry> ValidateArchiveEntries(ZipArchive archive)
    {
        return ValidateArchiveEntries(archive, null);
    }

    private static List<ExtractionEntry> ValidateArchiveEntries(
        ZipArchive archive,
        string extractionRoot)
    {
        if (archive.Entries.Count == 0)
        {
            throw new InvalidDataException("ZIPアーカイブにファイルがありません。");
        }

        List<ExtractionEntry> result = new List<ExtractionEntry>();
        string normalizedRoot = null;
        if (extractionRoot != null)
        {
            normalizedRoot = Path.GetFullPath(extractionRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) +
                Path.DirectorySeparatorChar;
        }
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            if (String.IsNullOrEmpty(entry.FullName))
            {
                throw new InvalidDataException("ZIPアーカイブに空のパスがあります。");
            }
            if (Path.IsPathRooted(entry.FullName))
            {
                throw new InvalidDataException("ZIPアーカイブに絶対パスがあります: " + entry.FullName);
            }
            string destination = null;
            if (normalizedRoot != null)
            {
                destination = Path.GetFullPath(Path.Combine(
                    normalizedRoot,
                    entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!destination.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("ZIPアーカイブに展開先外のパスがあります: " + entry.FullName);
                }
            }
            result.Add(new ExtractionEntry(
                entry,
                destination,
                entry.FullName.EndsWith("/", StringComparison.Ordinal)));
        }
        return result;
    }

    private static Stream BuildNormalizedArchive(SplitZipStream source)
    {
        long endOfCentralDirectory = FindEndOfCentralDirectory(source);
        ushort diskNumber = ReadUInt16(source, endOfCentralDirectory + 4);
        ushort centralDirectoryDisk = ReadUInt16(source, endOfCentralDirectory + 6);
        ushort totalEntries16 = ReadUInt16(source, endOfCentralDirectory + 10);
        uint centralDirectorySize32 = ReadUInt32(source, endOfCentralDirectory + 12);
        uint centralDirectoryOffset32 = ReadUInt32(source, endOfCentralDirectory + 16);

        ulong totalEntries = totalEntries16;
        ulong centralDirectorySize = centralDirectorySize32;
        ulong centralDirectoryOffset = centralDirectoryOffset32;
        ulong centralDirectoryStartDisk = centralDirectoryDisk;
        bool hasZip64 = diskNumber == UInt16MaxValue ||
            centralDirectoryDisk == UInt16MaxValue ||
            totalEntries16 == UInt16MaxValue ||
            centralDirectorySize32 == UInt32MaxValue ||
            centralDirectoryOffset32 == UInt32MaxValue;

        if (hasZip64)
        {
            if (endOfCentralDirectory < 20 ||
                ReadUInt32(source, endOfCentralDirectory - 20) != Zip64LocatorSignature)
            {
                throw new InvalidDataException("ZIP64 locator is missing.");
            }
            uint zip64Disk = ReadUInt32(source, endOfCentralDirectory - 16);
            ulong zip64Offset = ReadUInt64(source, endOfCentralDirectory - 12);
            long zip64RecordOffset = source.GetLocalOffset(zip64Disk, zip64Offset);
            if (ReadUInt32(source, zip64RecordOffset) != Zip64EndOfCentralDirectorySignature)
            {
                throw new InvalidDataException("ZIP64 end record is missing.");
            }
            centralDirectoryStartDisk = ReadUInt32(source, zip64RecordOffset + 20);
            totalEntries = ReadUInt64(source, zip64RecordOffset + 32);
            centralDirectorySize = ReadUInt64(source, zip64RecordOffset + 40);
            centralDirectoryOffset = ReadUInt64(source, zip64RecordOffset + 48);
        }

        long centralDirectoryStart = source.GetLocalOffset(
            centralDirectoryStartDisk,
            centralDirectoryOffset);
        if (centralDirectoryStart < 0 || centralDirectorySize > (ulong)(source.Length - centralDirectoryStart))
        {
            throw new InvalidDataException("ZIP central directory is outside the archive.");
        }

        byte[] normalizedCentralDirectory;
        using (MemoryStream centralDirectory = new MemoryStream())
        {
            long sourcePosition = centralDirectoryStart;
            for (ulong entryIndex = 0; entryIndex < totalEntries; entryIndex++)
            {
                byte[] header = ReadBytes(source, sourcePosition, 46);
                if (ReadUInt32(header, 0) != CentralDirectoryHeaderSignature)
                {
                    throw new InvalidDataException("ZIP central directory header is invalid.");
                }
                ushort nameLength = ReadUInt16(header, 28);
                ushort extraLength = ReadUInt16(header, 30);
                ushort commentLength = ReadUInt16(header, 32);
                long entryLength = 46L + nameLength + extraLength + commentLength;
                if (entryLength > centralDirectoryStart + (long)centralDirectorySize - sourcePosition)
                {
                    throw new InvalidDataException("ZIP central directory entry is truncated.");
                }
                byte[] name = ReadBytes(source, sourcePosition + 46, nameLength);
                byte[] extra = ReadBytes(source, sourcePosition + 46 + nameLength, extraLength);
                byte[] comment = ReadBytes(
                    source,
                    sourcePosition + 46 + nameLength + extraLength,
                    commentLength);

                ulong compressedSize = ReadUInt32(header, 20);
                ulong uncompressedSize = ReadUInt32(header, 24);
                ulong relativeOffset = ReadUInt32(header, 42);
                ulong startDisk = ReadUInt16(header, 34);
                ParseZip64Extra(
                    extra,
                    ReadUInt32(header, 24) == UInt32MaxValue,
                    ReadUInt32(header, 20) == UInt32MaxValue,
                    ReadUInt32(header, 42) == UInt32MaxValue,
                    ReadUInt16(header, 34) == UInt16MaxValue,
                    ref uncompressedSize,
                    ref compressedSize,
                    ref relativeOffset,
                    ref startDisk);

                long absoluteLocalOffset = source.GetLocalOffset(startDisk, relativeOffset);
                bool needsZip64Offset = absoluteLocalOffset > UInt32MaxValue;
                if (needsZip64Offset)
                {
                    WriteUInt32(header, 42, UInt32MaxValue);
                    ushort versionNeeded = ReadUInt16(header, 6);
                    if (versionNeeded < 45)
                    {
                        WriteUInt16(header, 6, 45);
                    }
                }
                else
                {
                    WriteUInt32(header, 42, (uint)absoluteLocalOffset);
                }
                WriteUInt16(header, 34, 0);

                bool needsZip64Uncompressed = ReadUInt32(header, 24) == UInt32MaxValue;
                bool needsZip64Compressed = ReadUInt32(header, 20) == UInt32MaxValue;
                byte[] normalizedExtra = BuildNormalizedExtra(
                    extra,
                    needsZip64Uncompressed,
                    needsZip64Compressed,
                    needsZip64Offset,
                    uncompressedSize,
                    compressedSize,
                    (ulong)absoluteLocalOffset);
                if (normalizedExtra.Length > UInt16MaxValue)
                {
                    throw new InvalidDataException("ZIP extra field is too long.");
                }
                WriteUInt16(header, 30, (ushort)normalizedExtra.Length);
                centralDirectory.Write(header, 0, header.Length);
                centralDirectory.Write(name, 0, name.Length);
                centralDirectory.Write(normalizedExtra, 0, normalizedExtra.Length);
                centralDirectory.Write(comment, 0, comment.Length);
                sourcePosition += entryLength;
            }

            long sourceCentralDirectoryEnd = centralDirectoryStart + (long)centralDirectorySize;
            if (sourcePosition < sourceCentralDirectoryEnd)
            {
                byte[] trailingBytes = ReadBytes(
                    source,
                    sourcePosition,
                    checked((int)(sourceCentralDirectoryEnd - sourcePosition)));
                centralDirectory.Write(trailingBytes, 0, trailingBytes.Length);
            }
            normalizedCentralDirectory = centralDirectory.ToArray();
        }

        byte[] normalizedTail = BuildZip64Tail(
            totalEntries,
            (ulong)normalizedCentralDirectory.Length,
            (ulong)centralDirectoryStart);
        byte[] trailingData = new byte[normalizedCentralDirectory.Length + normalizedTail.Length];
        Buffer.BlockCopy(normalizedCentralDirectory, 0, trailingData, 0, normalizedCentralDirectory.Length);
        Buffer.BlockCopy(normalizedTail, 0, trailingData, normalizedCentralDirectory.Length, normalizedTail.Length);
        return new NormalizedZipStream(source, centralDirectoryStart, trailingData);
    }

    private static long FindEndOfCentralDirectory(SplitZipStream source)
    {
        int tailLength = checked((int)Math.Min(source.Length, 65557L));
        long tailStart = source.Length - tailLength;
        byte[] tail = ReadBytes(source, tailStart, tailLength);
        for (int index = tail.Length - 22; index >= 0; index--)
        {
            if (ReadUInt32(tail, index) != EndOfCentralDirectorySignature)
            {
                continue;
            }
            ushort commentLength = ReadUInt16(tail, index + 20);
            if (index + 22 + commentLength == tail.Length)
            {
                return tailStart + index;
            }
        }
        throw new InvalidDataException("ZIP end record is missing.");
    }

    private static void ParseZip64Extra(
        byte[] extra,
        bool needsUncompressedSize,
        bool needsCompressedSize,
        bool needsRelativeOffset,
        bool needsStartDisk,
        ref ulong uncompressedSize,
        ref ulong compressedSize,
        ref ulong relativeOffset,
        ref ulong startDisk)
    {
        if (!needsUncompressedSize && !needsCompressedSize &&
            !needsRelativeOffset && !needsStartDisk)
        {
            return;
        }
        int position = 0;
        while (position + 4 <= extra.Length)
        {
            ushort fieldId = ReadUInt16(extra, position);
            ushort fieldLength = ReadUInt16(extra, position + 2);
            position += 4;
            if (position + fieldLength > extra.Length)
            {
                throw new InvalidDataException("ZIP extra field is truncated.");
            }
            if (fieldId != Zip64ExtraFieldId)
            {
                position += fieldLength;
                continue;
            }
            int valuePosition = position;
            if (needsUncompressedSize)
            {
                uncompressedSize = ReadUInt64(extra, valuePosition);
                valuePosition += 8;
            }
            if (needsCompressedSize)
            {
                compressedSize = ReadUInt64(extra, valuePosition);
                valuePosition += 8;
            }
            if (needsRelativeOffset)
            {
                relativeOffset = ReadUInt64(extra, valuePosition);
                valuePosition += 8;
            }
            if (needsStartDisk)
            {
                startDisk = ReadUInt32(extra, valuePosition);
            }
            return;
        }
        throw new InvalidDataException("ZIP64 extra field is missing.");
    }

    private static byte[] BuildNormalizedExtra(
        byte[] sourceExtra,
        bool needsUncompressedSize,
        bool needsCompressedSize,
        bool needsRelativeOffset,
        ulong uncompressedSize,
        ulong compressedSize,
        ulong relativeOffset)
    {
        using (MemoryStream output = new MemoryStream())
        {
            int position = 0;
            while (position + 4 <= sourceExtra.Length)
            {
                ushort fieldId = ReadUInt16(sourceExtra, position);
                ushort fieldLength = ReadUInt16(sourceExtra, position + 2);
                int fieldEnd = position + 4 + fieldLength;
                if (fieldEnd > sourceExtra.Length)
                {
                    throw new InvalidDataException("ZIP extra field is truncated.");
                }
                if (fieldId != Zip64ExtraFieldId)
                {
                    output.Write(sourceExtra, position, fieldEnd - position);
                }
                position = fieldEnd;
            }
            if (position != sourceExtra.Length)
            {
                throw new InvalidDataException("ZIP extra field is invalid.");
            }
            if (!needsUncompressedSize && !needsCompressedSize && !needsRelativeOffset)
            {
                return output.ToArray();
            }
            using (MemoryStream zip64Values = new MemoryStream())
            {
                if (needsUncompressedSize)
                {
                    WriteUInt64(zip64Values, uncompressedSize);
                }
                if (needsCompressedSize)
                {
                    WriteUInt64(zip64Values, compressedSize);
                }
                if (needsRelativeOffset)
                {
                    WriteUInt64(zip64Values, relativeOffset);
                }
                if (zip64Values.Length > UInt16MaxValue)
                {
                    throw new InvalidDataException("ZIP64 extra field is too long.");
                }
                WriteUInt16(output, Zip64ExtraFieldId);
                WriteUInt16(output, (ushort)zip64Values.Length);
                zip64Values.Position = 0;
                zip64Values.CopyTo(output);
            }
            return output.ToArray();
        }
    }

    private static byte[] BuildZip64Tail(
        ulong entryCount,
        ulong centralDirectorySize,
        ulong centralDirectoryOffset)
    {
        using (MemoryStream output = new MemoryStream())
        {
            ulong zip64RecordOffset = centralDirectoryOffset + centralDirectorySize;
            WriteUInt32(output, Zip64EndOfCentralDirectorySignature);
            WriteUInt64(output, 44);
            WriteUInt16(output, 45);
            WriteUInt16(output, 45);
            WriteUInt32(output, 0);
            WriteUInt32(output, 0);
            WriteUInt64(output, entryCount);
            WriteUInt64(output, entryCount);
            WriteUInt64(output, centralDirectorySize);
            WriteUInt64(output, centralDirectoryOffset);
            WriteUInt32(output, Zip64LocatorSignature);
            WriteUInt32(output, 0);
            WriteUInt64(output, zip64RecordOffset);
            WriteUInt32(output, 1);
            WriteUInt32(output, EndOfCentralDirectorySignature);
            WriteUInt16(output, 0);
            WriteUInt16(output, 0);
            WriteUInt16(output, UInt16MaxValue);
            WriteUInt16(output, UInt16MaxValue);
            WriteUInt32(output, UInt32MaxValue);
            WriteUInt32(output, UInt32MaxValue);
            WriteUInt16(output, 0);
            return output.ToArray();
        }
    }

    private static byte[] ReadBytes(Stream stream, long offset, int count)
    {
        byte[] result = new byte[count];
        stream.Position = offset;
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = stream.Read(result, totalRead, count - totalRead);
            if (read == 0)
            {
                throw new EndOfStreamException("ZIPアーカイブが途中で終了しています。");
            }
            totalRead += read;
        }
        return result;
    }

    private static ushort ReadUInt16(Stream stream, long offset)
    {
        return ReadUInt16(ReadBytes(stream, offset, 2), 0);
    }

    private static uint ReadUInt32(Stream stream, long offset)
    {
        return ReadUInt32(ReadBytes(stream, offset, 4), 0);
    }

    private static ulong ReadUInt64(Stream stream, long offset)
    {
        return ReadUInt64(ReadBytes(stream, offset, 8), 0);
    }

    private static ushort ReadUInt16(byte[] bytes, int offset)
    {
        return (ushort)(bytes[offset] | (bytes[offset + 1] << 8));
    }

    private static uint ReadUInt32(byte[] bytes, int offset)
    {
        return (uint)(bytes[offset] |
            (bytes[offset + 1] << 8) |
            (bytes[offset + 2] << 16) |
            (bytes[offset + 3] << 24));
    }

    private static ulong ReadUInt64(byte[] bytes, int offset)
    {
        return ReadUInt32(bytes, offset) | ((ulong)ReadUInt32(bytes, offset + 4) << 32);
    }

    private static void WriteUInt16(byte[] bytes, int offset, ushort value)
    {
        bytes[offset] = (byte)value;
        bytes[offset + 1] = (byte)(value >> 8);
    }

    private static void WriteUInt32(byte[] bytes, int offset, uint value)
    {
        bytes[offset] = (byte)value;
        bytes[offset + 1] = (byte)(value >> 8);
        bytes[offset + 2] = (byte)(value >> 16);
        bytes[offset + 3] = (byte)(value >> 24);
    }

    private static void WriteUInt16(Stream stream, ushort value)
    {
        stream.WriteByte((byte)value);
        stream.WriteByte((byte)(value >> 8));
    }

    private static void WriteUInt32(Stream stream, uint value)
    {
        WriteUInt16(stream, (ushort)value);
        WriteUInt16(stream, (ushort)(value >> 16));
    }

    private static void WriteUInt64(Stream stream, ulong value)
    {
        WriteUInt32(stream, (uint)value);
        WriteUInt32(stream, (uint)(value >> 32));
    }

    private sealed class ExtractionEntry
    {
        public ExtractionEntry(ZipArchiveEntry entry, string destinationPath, bool isDirectory)
        {
            Entry = entry;
            DestinationPath = destinationPath;
            IsDirectory = isDirectory;
        }

        public ZipArchiveEntry Entry { get; private set; }
        public string DestinationPath { get; private set; }
        public bool IsDirectory { get; private set; }
    }

    private sealed class SplitZipStream : Stream
    {
        private readonly List<Volume> volumes;
        private readonly List<long> volumeOffsets;
        private readonly long length;
        private long position;

        private SplitZipStream(List<Volume> volumes, List<long> volumeOffsets, long length)
        {
            this.volumes = volumes;
            this.volumeOffsets = volumeOffsets;
            this.length = length;
        }

        public static SplitZipStream Open(string executablePath, byte[] footerMagic)
        {
            string directory = Path.GetDirectoryName(executablePath);
            string baseName = Path.GetFileNameWithoutExtension(executablePath);
            List<string> partPaths = new List<string>();
            foreach (string path in Directory.GetFiles(directory, baseName + ".z*"))
            {
                string suffix = Path.GetFileName(path).Substring((baseName + ".z").Length);
                int partNumber;
                if (suffix.Length > 0 && Int32.TryParse(suffix, out partNumber) && partNumber > 0)
                {
                    partPaths.Add(path);
                }
            }
            partPaths.Sort(delegate(string left, string right)
            {
                string leftSuffix = Path.GetFileName(left).Substring((baseName + ".z").Length);
                string rightSuffix = Path.GetFileName(right).Substring((baseName + ".z").Length);
                return Int32.Parse(leftSuffix).CompareTo(Int32.Parse(rightSuffix));
            });
            for (int index = 0; index < partPaths.Count; index++)
            {
                string suffix = Path.GetFileName(partPaths[index]).Substring((baseName + ".z").Length);
                if (Int32.Parse(suffix) != index + 1)
                {
                    throw new InvalidDataException("分割ZIPのボリューム番号が連続していません。");
                }
            }

            long executableLength = new FileInfo(executablePath).Length;
            if (executableLength < FooterLength)
            {
                throw new InvalidDataException("自己解凍ZIPのフッターがありません。");
            }
            byte[] footer = ReadFileBytes(executablePath, executableLength - FooterLength, FooterLength);
            for (int index = 0; index < footerMagic.Length; index++)
            {
                if (footer[index] != footerMagic[index])
                {
                    throw new InvalidDataException("自己解凍ZIPのフッターが不正です。");
                }
            }
            long payloadLength = checked((long)ReadUInt64(footer, footerMagic.Length));
            long payloadOffset = executableLength - FooterLength - payloadLength;
            if (payloadOffset < 0 || payloadLength == 0)
            {
                throw new InvalidDataException("自己解凍ZIPのデータ長が不正です。");
            }

            List<Volume> volumes = new List<Volume>();
            foreach (string path in partPaths)
            {
                long partLength = new FileInfo(path).Length;
                volumes.Add(new Volume(path, 0, partLength));
            }
            if (volumes.Count > 0)
            {
                if (volumes[0].Length < 4 ||
                    !HasSplitMarker(volumes[0].Path))
                {
                    throw new InvalidDataException("最初の分割ZIPボリュームが不正です。");
                }
                volumes[0] = new Volume(volumes[0].Path, 4, volumes[0].Length - 4);
            }
            volumes.Add(new Volume(executablePath, payloadOffset, payloadLength));

            List<long> volumeOffsets = new List<long>();
            long totalLength = 0;
            foreach (Volume volume in volumes)
            {
                volumeOffsets.Add(totalLength);
                totalLength = checked(totalLength + volume.Length);
            }
            return new SplitZipStream(volumes, volumeOffsets, totalLength);
        }

        public long GetLocalOffset(ulong volumeNumber, ulong relativeOffset)
        {
            if (volumeNumber != 0)
            {
                throw new InvalidDataException("ZIPの中央ディレクトリが複数ボリュームを参照しています。");
            }
            long archiveOffset = checked((long)relativeOffset);
            if (archiveOffset < 0 || archiveOffset > length)
            {
                throw new InvalidDataException("ZIPローカルヘッダーの位置が範囲外です。");
            }
            return archiveOffset;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position
        {
            get { return position; }
            set
            {
                if (value < 0 || value > length)
                {
                    throw new ArgumentOutOfRangeException("value");
                }
                position = value;
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (count == 0 || position == length)
            {
                return 0;
            }
            int remaining = (int)Math.Min(count, length - position);
            int totalRead = 0;
            while (remaining > 0)
            {
                int volumeIndex = FindVolumeIndex(position);
                Volume volume = volumes[volumeIndex];
                long offsetInVolume = position - volumeOffsets[volumeIndex];
                int readLength = (int)Math.Min(remaining, volume.Length - offsetInVolume);
                using (FileStream stream = new FileStream(
                    volume.Path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read))
                {
                    stream.Position = volume.SourceOffset + offsetInVolume;
                    int read = stream.Read(buffer, offset + totalRead, readLength);
                    if (read != readLength)
                    {
                        throw new EndOfStreamException("ZIPボリュームが途中で終了しています。");
                    }
                }
                position += readLength;
                totalRead += readLength;
                remaining -= readLength;
            }
            return totalRead;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            if (origin == SeekOrigin.Begin)
            {
                target = offset;
            }
            else if (origin == SeekOrigin.Current)
            {
                target = checked(position + offset);
            }
            else
            {
                target = checked(length + offset);
            }
            Position = target;
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

        private int FindVolumeIndex(long archiveOffset)
        {
            for (int index = volumeOffsets.Count - 1; index >= 0; index--)
            {
                if (archiveOffset >= volumeOffsets[index])
                {
                    return index;
                }
            }
            throw new InvalidDataException("ZIPボリュームの位置が不正です。");
        }

        private static bool HasSplitMarker(string path)
        {
            byte[] marker = ReadFileBytes(path, 0, 4);
            return marker[0] == 0x50 && marker[1] == 0x4b &&
                marker[2] == 0x07 && marker[3] == 0x08;
        }

        private static byte[] ReadFileBytes(string path, long offset, int count)
        {
            byte[] result = new byte[count];
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                stream.Position = offset;
                int totalRead = 0;
                while (totalRead < count)
                {
                    int read = stream.Read(result, totalRead, count - totalRead);
                    if (read == 0)
                    {
                        throw new EndOfStreamException("ZIPボリュームが途中で終了しています。");
                    }
                    totalRead += read;
                }
            }
            return result;
        }

        private sealed class Volume
        {
            public Volume(string path, long sourceOffset, long length)
            {
                Path = path;
                SourceOffset = sourceOffset;
                Length = length;
            }

            public string Path { get; private set; }
            public long SourceOffset { get; private set; }
            public long Length { get; private set; }
        }
    }

    private sealed class NormalizedZipStream : Stream
    {
        private readonly SplitZipStream source;
        private readonly long sourceLength;
        private readonly byte[] trailingData;
        private long position;

        public NormalizedZipStream(SplitZipStream source, long sourceLength, byte[] trailingData)
        {
            this.source = source;
            this.sourceLength = sourceLength;
            this.trailingData = trailingData;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return sourceLength + trailingData.Length; } }
        public override long Position
        {
            get { return position; }
            set
            {
                if (value < 0 || value > Length)
                {
                    throw new ArgumentOutOfRangeException("value");
                }
                position = value;
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (count == 0 || position == Length)
            {
                return 0;
            }
            int available = (int)Math.Min(count, Length - position);
            int totalRead = 0;
            if (position < sourceLength)
            {
                int sourceCount = (int)Math.Min(available, sourceLength - position);
                source.Position = position;
                int read = source.Read(buffer, offset, sourceCount);
                if (read != sourceCount)
                {
                    throw new EndOfStreamException("ZIPデータが途中で終了しています。");
                }
                position += read;
                totalRead += read;
                available -= read;
            }
            if (available > 0)
            {
                int trailingOffset = checked((int)(position - sourceLength));
                Buffer.BlockCopy(trailingData, trailingOffset, buffer, offset + totalRead, available);
                position += available;
                totalRead += available;
            }
            return totalRead;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            if (origin == SeekOrigin.Begin)
            {
                target = offset;
            }
            else if (origin == SeekOrigin.Current)
            {
                target = checked(position + offset);
            }
            else
            {
                target = checked(Length + offset);
            }
            Position = target;
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}
