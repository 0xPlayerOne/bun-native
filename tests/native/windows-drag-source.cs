// Independent OLE drag source for the native drag and drop qualification. It
// owns a small window, receives a real SendInput mouse-down there, enters OLE
// DoDragDrop from that press and moves the real cursor with SendInput, so
// GPUI's own IDropTarget receives the drag from OLE. Nothing calls into the host.
//
// Compile with the .NET Framework compiler:
//   csc /nologo /target:exe /optimize /r:System.Windows.Forms.dll
//     /r:System.Drawing.dll /out:windows-drag-source.exe windows-drag-source.cs
//
// Commands, one per stdin line; each prints one JSON line (or {"error":...}):
//   find {"title","width","height","pid"}  locate the top-level window with
//                       this exact title; its client area must be width x height
//                       logical pixels at the window's DPI
//   offer files JSON    offer these absolute paths as CF_HDROP
//   offer text JSON     offer one Unicode string
//   enter X Y           press on the source, enter DoDragDrop, move to the
//                       window-relative logical point X,Y of the found window
//   move X Y            move to X,Y
//   drop                release the button; reports DoDragDrop's effect
//   leave               the source cancels from QueryContinueDrag, then the
//                       button is released over the source
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public MOUSEINPUT mi; }

    public const uint INPUT_MOUSE = 0;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    public const int VK_LBUTTON = 0x01;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowW(string className, string title);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int key);
}

sealed class SourceForm : Form
{
    public volatile object Payload;
    public volatile bool CancelRequested;
    public readonly AutoResetEvent Began = new AutoResetEvent(false);
    public readonly AutoResetEvent Ended = new AutoResetEvent(false);
    public DragDropEffects Effect;
    public readonly ManualResetEvent Shown_ = new ManualResetEvent(false);

    public SourceForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.DarkOrange;
        Bounds = new Rectangle(Program.SourceLeft, Program.SourceTop, Program.SourceSize, Program.SourceSize);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Shown_.Set();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        object payload = Payload;
        if (e.Button != MouseButtons.Left || payload == null) return;
        DataObject data = new DataObject();
        StringCollection files = payload as StringCollection;
        if (files != null) data.SetFileDropList(files);
        else data.SetText((string)payload, TextDataFormat.UnicodeText);
        CancelRequested = false;
        Began.Set();
        // OLE's modal loop tracks the held button until release or cancel.
        Effect = DoDragDrop(data, DragDropEffects.Copy);
        Ended.Set();
    }

    protected override void OnQueryContinueDrag(QueryContinueDragEventArgs e)
    {
        base.OnQueryContinueDrag(e);
        if (CancelRequested) e.Action = DragAction.Cancel;
    }
}

static class Program
{
    public const int SourceLeft = 16, SourceTop = 160, SourceSize = 48;
    static SourceForm form;
    static IntPtr target = IntPtr.Zero;
    static Native.POINT origin;
    static double scale = 1;
    static bool dragging;
    static Native.POINT current;

    [STAThread]
    static int Main()
    {
        // Physical pixels everywhere: GPUI is per-monitor DPI aware.
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        form = new SourceForm();
        Thread commands = new Thread(Commands);
        commands.IsBackground = true;
        int code = 0;
        form.Load += delegate { commands.Start(); };
        form.FormClosed += delegate { code = dragging ? 1 : 0; };
        Application.Run(form);
        return code;
    }

    static void Commands()
    {
        form.Shown_.WaitOne(5000);
        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        StreamReader reader = new StreamReader(stdin, new UTF8Encoding(false));
        StreamWriter writer = new StreamWriter(stdout, new UTF8Encoding(false));
        writer.NewLine = "\n";
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            string reply;
            try { reply = Command(line); }
            catch (Exception error) { reply = "{\"error\":" + Json.Quote(error.Message) + "}"; }
            writer.WriteLine(reply);
            writer.Flush();
        }
        form.BeginInvoke(new MethodInvoker(delegate { form.Close(); }));
    }

    static string Command(string line)
    {
        int space = line.IndexOf(' ');
        string verb = space < 0 ? line : line.Substring(0, space);
        string rest = space < 0 ? "" : line.Substring(space + 1);
        switch (verb)
        {
            case "find": return Find(Json.Parse(rest) as Dictionary<string, object>);
            case "offer":
            {
                int kind = rest.IndexOf(' ');
                if (kind < 0) throw new InvalidOperationException("offer TYPE JSON");
                string type = rest.Substring(0, kind);
                object value = Json.Parse(rest.Substring(kind + 1));
                if (type == "files" && value is List<object>)
                {
                    StringCollection files = new StringCollection();
                    foreach (object path in (List<object>)value)
                    {
                        string text = path as string;
                        if (text == null || !Path.IsPathRooted(text)) throw new InvalidOperationException("Offered files must be absolute paths");
                        files.Add(text);
                    }
                    if (files.Count == 0 || files.Count > 256) throw new InvalidOperationException("Offer 1-256 files");
                    form.Payload = files;
                    return "{\"offered\":" + files.Count + "}";
                }
                if (type == "text" && value is string)
                {
                    form.Payload = value;
                    return "{\"offered\":1}";
                }
                throw new InvalidOperationException("offer files [paths] or offer text \"string\"");
            }
            case "enter":
            {
                Native.POINT point = TargetPoint(rest);
                if (dragging) throw new InvalidOperationException("A drag is already active");
                if ((Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0)
                    throw new InvalidOperationException("An external pointer button is held");
                Native.POINT start = SourceCenter();
                Move(start);
                Thread.Sleep(60);
                Mouse(Native.MOUSEEVENTF_LEFTDOWN);
                if (!form.Began.WaitOne(3000))
                {
                    Mouse(Native.MOUSEEVENTF_LEFTUP);
                    throw new InvalidOperationException("The source window did not receive the press or enter DoDragDrop");
                }
                dragging = true;
                for (int step = 1; step <= 3; step++)
                {
                    Native.POINT nudge = start;
                    nudge.X += 4 * step;
                    Move(nudge);
                    Thread.Sleep(20);
                }
                DragTo(point);
                return "{\"entered\":true,\"screenPoint\":[" + point.X + "," + point.Y + "],\"scale\":" + scale.ToString(CultureInfo.InvariantCulture) + "}";
            }
            case "move":
            {
                Native.POINT point = TargetPoint(rest);
                if (!dragging) throw new InvalidOperationException("No drag is active");
                DragTo(point);
                return "{\"moved\":true}";
            }
            case "drop":
            {
                if (!dragging) throw new InvalidOperationException("No drag is active");
                Mouse(Native.MOUSEEVENTF_LEFTUP);
                if (!form.Ended.WaitOne(3000)) throw new InvalidOperationException("DoDragDrop did not return after the release");
                dragging = false;
                return Ended("release");
            }
            case "leave":
            {
                if (!dragging) throw new InvalidOperationException("No drag is active");
                form.CancelRequested = true;
                // OLE asks QueryContinueDrag again on the next input.
                Move(current);
                if (!form.Ended.WaitOne(3000)) throw new InvalidOperationException("DoDragDrop did not return after the source cancelled");
                dragging = false;
                // Release the injected button over the source, not the target.
                Move(SourceCenter());
                Thread.Sleep(40);
                Mouse(Native.MOUSEEVENTF_LEFTUP);
                Thread.Sleep(40);
                return Ended("QueryContinueDrag cancel");
            }
        }
        throw new InvalidOperationException("Unknown command");
    }

    static string Ended(string how)
    {
        string effect = form.Effect == DragDropEffects.None ? "none"
            : form.Effect == DragDropEffects.Copy ? "copy"
            : ((int)form.Effect).ToString(CultureInfo.InvariantCulture);
        return "{\"ended\":true,\"operation\":" + Json.Quote(effect) + ",\"cancel\":" + Json.Quote(how) + "}";
    }

    static string Find(Dictionary<string, object> request)
    {
        if (request == null || !(request.ContainsKey("title")) || !(request["title"] is string)
            || !(request.ContainsKey("width")) || !(request["width"] is double)
            || !(request.ContainsKey("height")) || !(request["height"] is double))
            throw new InvalidOperationException("find needs title, width and height");
        string title = (string)request["title"];
        double width = (double)request["width"], height = (double)request["height"];
        DateTime deadline = DateTime.UtcNow.AddSeconds(3);
        for (;;)
        {
            IntPtr window = Native.FindWindowW(null, title);
            if (window != IntPtr.Zero && Native.IsWindowVisible(window))
            {
                uint dpi = Native.GetDpiForWindow(window);
                double windowScale = dpi == 0 ? 1 : dpi / 96.0;
                Native.RECT client;
                if (!Native.GetClientRect(window, out client)) throw new Win32Exception();
                double clientWidth = client.Right / windowScale, clientHeight = client.Bottom / windowScale;
                if (Math.Abs(clientWidth - width) <= 2 && Math.Abs(clientHeight - height) <= 2)
                {
                    Native.POINT point = new Native.POINT();
                    if (!Native.ClientToScreen(window, ref point)) throw new Win32Exception();
                    target = window;
                    origin = point;
                    scale = windowScale;
                    uint process;
                    Native.GetWindowThreadProcessId(window, out process);
                    return "{\"found\":true,\"process\":" + process + ",\"origin\":[" + point.X + "," + point.Y + "],\"scale\":"
                        + windowScale.ToString(CultureInfo.InvariantCulture) + "}";
                }
            }
            if (DateTime.UtcNow > deadline) return "{\"found\":false}";
            Thread.Sleep(25);
        }
    }

    static Native.POINT TargetPoint(string rest)
    {
        if (target == IntPtr.Zero) throw new InvalidOperationException("No target window was found");
        string[] parts = rest.Split(' ');
        double x, y;
        if (parts.Length != 2
            || !double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out x)
            || !double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out y)
            || x < 0 || y < 0 || x > 4096 || y > 4096)
            throw new InvalidOperationException("Expected window-relative X Y");
        Native.POINT point = new Native.POINT();
        point.X = origin.X + (int)Math.Round(x * scale);
        point.Y = origin.Y + (int)Math.Round(y * scale);
        return point;
    }

    static Native.POINT SourceCenter()
    {
        Native.POINT point = new Native.POINT();
        point.X = SourceLeft + SourceSize / 2;
        point.Y = SourceTop + SourceSize / 2;
        return point;
    }

    /// One jump, then a still update, so the target sees one position only.
    static void DragTo(Native.POINT point)
    {
        Move(point);
        Thread.Sleep(40);
        Move(point);
        Thread.Sleep(80);
        current = point;
    }

    static void Move(Native.POINT point)
    {
        int left = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        int top = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        int width = Math.Max(2, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
        int height = Math.Max(2, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
        Native.INPUT input = new Native.INPUT();
        input.type = Native.INPUT_MOUSE;
        // Normalized to the center of the intended pixel.
        input.mi.dx = (int)Math.Round(((point.X - left) * 65536.0 + 32768.0) / width);
        input.mi.dy = (int)Math.Round(((point.Y - top) * 65536.0 + 32768.0) / height);
        input.mi.dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK;
        Send(input);
    }

    static void Mouse(uint flags)
    {
        Native.INPUT input = new Native.INPUT();
        input.type = Native.INPUT_MOUSE;
        input.mi.dwFlags = flags;
        Send(input);
    }

    static void Send(Native.INPUT input)
    {
        Native.INPUT[] inputs = new Native.INPUT[] { input };
        if (Native.SendInput(1, inputs, Marshal.SizeOf(typeof(Native.INPUT))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput was blocked");
    }
}

/// A minimal JSON reader for the command arguments: objects, arrays, strings,
/// numbers, booleans and null.
static class Json
{
    public static object Parse(string text)
    {
        int index = 0;
        object value = Value(text, ref index);
        Space(text, ref index);
        if (index != text.Length) throw new FormatException("Trailing JSON");
        return value;
    }

    public static string Quote(string text)
    {
        StringBuilder builder = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else builder.Append(c);
        }
        return builder.Append('"').ToString();
    }

    static void Space(string text, ref int index)
    {
        while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
    }

    static object Value(string text, ref int index)
    {
        Space(text, ref index);
        if (index >= text.Length) throw new FormatException("Truncated JSON");
        char c = text[index];
        if (c == '{')
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            index++;
            Space(text, ref index);
            if (index < text.Length && text[index] == '}') { index++; return result; }
            for (;;)
            {
                Space(text, ref index);
                string key = ReadString(text, ref index);
                Space(text, ref index);
                Expect(text, ref index, ':');
                result[key] = Value(text, ref index);
                Space(text, ref index);
                if (index < text.Length && text[index] == ',') { index++; continue; }
                Expect(text, ref index, '}');
                return result;
            }
        }
        if (c == '[')
        {
            List<object> result = new List<object>();
            index++;
            Space(text, ref index);
            if (index < text.Length && text[index] == ']') { index++; return result; }
            for (;;)
            {
                result.Add(Value(text, ref index));
                Space(text, ref index);
                if (index < text.Length && text[index] == ',') { index++; continue; }
                Expect(text, ref index, ']');
                return result;
            }
        }
        if (c == '"') return ReadString(text, ref index);
        if (text.Substring(index).StartsWith("true")) { index += 4; return true; }
        if (text.Substring(index).StartsWith("false")) { index += 5; return false; }
        if (text.Substring(index).StartsWith("null")) { index += 4; return null; }
        int start = index;
        while (index < text.Length && "+-0123456789.eE".IndexOf(text[index]) >= 0) index++;
        if (start == index) throw new FormatException("Invalid JSON value");
        return double.Parse(text.Substring(start, index - start), NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    static void Expect(string text, ref int index, char c)
    {
        if (index >= text.Length || text[index] != c) throw new FormatException("Expected " + c);
        index++;
    }

    static string ReadString(string text, ref int index)
    {
        Expect(text, ref index, '"');
        StringBuilder builder = new StringBuilder();
        while (index < text.Length && text[index] != '"')
        {
            char c = text[index++];
            if (c != '\\') { builder.Append(c); continue; }
            if (index >= text.Length) throw new FormatException("Truncated escape");
            char e = text[index++];
            switch (e)
            {
                case '"': case '\\': case '/': builder.Append(e); break;
                case 'b': builder.Append('\b'); break;
                case 'f': builder.Append('\f'); break;
                case 'n': builder.Append('\n'); break;
                case 'r': builder.Append('\r'); break;
                case 't': builder.Append('\t'); break;
                case 'u':
                    if (index + 4 > text.Length) throw new FormatException("Truncated escape");
                    builder.Append((char)int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                    index += 4;
                    break;
                default: throw new FormatException("Invalid escape");
            }
        }
        Expect(text, ref index, '"');
        return builder.ToString();
    }
}
