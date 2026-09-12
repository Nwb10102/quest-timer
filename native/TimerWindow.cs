using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace QuestTimer
{
    internal sealed partial class TimerWindow : Form
    {
        private const string Origin = "https://quest-timer.local";
        private readonly StateStore store;
        private readonly Updater updater;
        private readonly bool testing;
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(16, 17, 19) };
        private readonly Timer saveTimer = new Timer { Interval = 400 };
        private readonly Timer clockTimer = new Timer { Interval = 250 };
        private readonly NotifyIcon tray = new NotifyIcon();
        private string pendingState;
        private double? deadline;
        private string timerTitle;
        private bool ready;
        private bool smokeStarted;
        private bool updateStarted;
        // 첫 확인은 창이 뜬 뒤로 조금 미룬다. 이후 6시간마다.
        private readonly Timer updateTimer = new Timer { Interval = 4000 };
        private int notifications;
        internal int ExitCode { get; private set; }
        private static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);
        [StructLayout(LayoutKind.Sequential)] private struct FlashInfo { public uint Size; public IntPtr Window; public uint Flags; public uint Count; public uint Timeout; }

        internal TimerWindow(StateStore stateStore, bool smoke)
        {
            store = stateStore;
            testing = smoke;
            updater = new Updater(store.Json, store.DirectoryPath, s => PostUpdate(s));
            Text = "Quest Timer";
            BackColor = Color.FromArgb(16, 17, 19);
            ClientSize = new Size(1000, 680);
            MinimumSize = new Size(860, 640);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico"));
            SetCurrentProcessExplicitAppUserModelID("com.questtimer.webview2");
            Controls.Add(web);
            tray.Icon = Icon;
            tray.Text = "Quest Timer";
            tray.Visible = true;
            tray.BalloonTipClicked += (s, e) => RestoreWindow();
            tray.DoubleClick += (s, e) => RestoreWindow();
            tray.ContextMenuStrip = new ContextMenuStrip();
            tray.ContextMenuStrip.Items.Add("타이머 열기", null, (s, e) => RestoreWindow());
            tray.ContextMenuStrip.Items.Add("종료", null, (s, e) => Close());
            saveTimer.Tick += (s, e) => FlushSave();
            clockTimer.Tick += (s, e) => CheckDeadline();
            updateTimer.Tick += (s, e) => { updateTimer.Interval = 6 * 3600 * 1000; _ = updater.CheckAsync(); };
            SystemEvents.PowerModeChanged += OnPowerChanged;
            SystemEvents.SessionSwitch += OnSessionSwitch;
            Activated += (s, e) => Flash(false);
            Shown += async (s, e) => await Initialize();
            FormClosing += (s, e) => { if (!FlushSave()) e.Cancel = true; };
            FormClosed += (s, e) =>
            {
                SystemEvents.PowerModeChanged -= OnPowerChanged;
                SystemEvents.SessionSwitch -= OnSessionSwitch;
                updateTimer.Dispose(); clockTimer.Dispose(); saveTimer.Dispose(); tray.Dispose(); web.Dispose();
            };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            var dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }

        private async Task Initialize()
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(store.DirectoryPath, "WebView2"));
                await web.EnsureCoreWebView2Async(environment);
                var core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = testing;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.SetVirtualHostNameToFolderMapping("quest-timer.local", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "www"), CoreWebView2HostResourceAccessKind.DenyCors);
                core.NavigationStarting += (s, e) =>
                {
                    if (e.Uri != Origin + "/index.html") e.Cancel = true;
                    else ready = false;
                };
                core.NewWindowRequested += (s, e) => e.Handled = true;
                core.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
                core.DownloadStarting += (s, e) => e.Cancel = true;
                core.WebMessageReceived += OnMessage;
                core.ProcessFailed += (s, e) => Fail(new InvalidOperationException("화면 실행기가 종료되었습니다. 앱을 다시 열어 주세요. 저장된 기록은 유지됩니다."));
                core.Navigate(Origin + "/index.html");
            }
            catch (WebView2RuntimeNotFoundException)
            {
                if (testing) { Fail(new InvalidOperationException("WebView2 runtime missing")); return; }
                if (MessageBox.Show("Microsoft Edge WebView2가 필요합니다. 공식 다운로드 페이지를 열까요? 설치 후 앱을 다시 실행해 주세요.", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
                ExitCode = 1; Close();
            }
            catch (Exception ex) { Fail(ex); }
        }

        private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (e.Source != Origin + "/index.html") return;
            object id = null;
            try
            {
                var message = store.Json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;
                if (message == null) return;
                message.TryGetValue("id", out id);
                var method = message["method"] as string;
                var args = message["args"] as Dictionary<string, object> ?? new Dictionary<string, object>();
                object result = null;
                switch (method)
                {
                    case "state:load": result = store.Load(); break;
                    case "state:save":
                        var nextState = store.Json.Serialize(args["state"]);
                        store.ParseState(nextState);
                        pendingState = nextState;
                        saveTimer.Stop(); saveTimer.Start(); break;
                    case "window:always-on-top": TopMost = Convert.ToBoolean(args["on"]); result = TopMost; break;
                    case "timer:arm":
                        var endsAt = Convert.ToDouble(args["endsAt"]);
                        if (double.IsNaN(endsAt) || double.IsInfinity(endsAt) || endsAt > Now + 601 * 60000) throw new ArgumentException("타이머 시간이 올바르지 않습니다.");
                        deadline = endsAt;
                        timerTitle = args.ContainsKey("title") ? Convert.ToString(args["title"]) : "";
                        clockTimer.Start(); CheckDeadline(); break;
                    case "timer:disarm":
                        // Renderer and native clocks can reach zero in either order.
                        // Deliver the OS notification even if renderer finalizes first.
                        CheckDeadline(); deadline = null; clockTimer.Stop(); break;
                    case "update:get":
                        result = new
                        {
                            version = Updater.CurrentVersion,
                            packaged = true,
                            update = updater.Snapshot(),
                        };
                        break;
                    case "update:auto":
                        updater.AutoDownload = Convert.ToBoolean(args["on"]);
                        result = updater.AutoDownload;
                        break;
                    case "update:check": if (!testing) _ = updater.CheckAsync(); break;
                    case "update:download": if (!testing) _ = updater.DownloadAsync(); break;
                    case "update:install":
                        // 기록을 먼저 디스크에 내린 뒤에 앱을 닫는다
                        if (!testing && FlushSave() && updater.Install()) Close();
                        break;
                    case "renderer:ready":
                        ready = true;
                        if (testing && !smokeStarted) { smokeStarted = true; _ = RunSmoke(); }
                        else if (!testing && !updateStarted) { updateStarted = true; updateTimer.Start(); }
                        break;
                    default: throw new ArgumentException("지원하지 않는 요청입니다.");
                }
                if (id != null) web.CoreWebView2.PostWebMessageAsJson(store.Json.Serialize(new { id, result }));
            }
            catch (Exception ex)
            {
                if (id != null) web.CoreWebView2.PostWebMessageAsJson(store.Json.Serialize(new { id, error = ex.Message }));
                Fail(ex);
            }
        }

        private void Post(string name)
        {
            if (web.CoreWebView2 != null && !IsDisposed)
                web.CoreWebView2.PostWebMessageAsJson(store.Json.Serialize(new { @event = name }));
        }

        private void Post(string name, object payload)
        {
            if (web.CoreWebView2 != null && !IsDisposed)
                web.CoreWebView2.PostWebMessageAsJson(store.Json.Serialize(new { @event = name, payload }));
        }

        /// <summary>업데이터는 다른 스레드에서 알려오므로 UI 스레드로 넘긴다.</summary>
        private void PostUpdate(object snapshot)
        {
            if (!IsHandleCreated || IsDisposed) return;
            try { BeginInvoke(new Action(() => Post("update:state", snapshot))); }
            catch (InvalidOperationException) { }
        }

        private bool FlushSave()
        {
            saveTimer.Stop();
            if (pendingState == null) return true;
            try { store.Save(pendingState); pendingState = null; return true; }
            catch (Exception ex)
            {
                ExitCode = 1;
                if (testing) File.WriteAllText(Path.Combine(store.DirectoryPath, "failure.txt"), ex.ToString());
                else MessageBox.Show("기록을 저장하지 못했습니다. 디스크 공간과 폴더 권한을 확인한 뒤 다시 종료해 주세요.\r\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
        }

        private void CheckDeadline()
        {
            if (deadline == null || Now < deadline.Value) return;
            deadline = null; clockTimer.Stop();
            Post("timer:elapsed");
            var title = string.IsNullOrWhiteSpace(timerTitle) ? "한 구간 완주" : timerTitle + " 완주";
            tray.ShowBalloonTip(10000, title.Length > 63 ? title.Substring(0, 60) + "…" : title, "기록에 한 획을 더했습니다.", ToolTipIcon.Info);
            notifications++;
            if (!ContainsFocus) Flash(true);
        }

        private void Resync()
        {
            // Deadline uses wall time, so sleep/minimize never adds time to a session.
            CheckDeadline();
            Post("timer:resync");
        }
        private void OnPowerChanged(object sender, PowerModeChangedEventArgs e) { if (e.Mode == PowerModes.Resume) QueueResync(); }
        private void OnSessionSwitch(object sender, SessionSwitchEventArgs e) { if (e.Reason == SessionSwitchReason.SessionUnlock) QueueResync(); }
        private void QueueResync() { if (IsHandleCreated && !IsDisposed) try { BeginInvoke(new Action(Resync)); } catch (InvalidOperationException) { } }

        private void Flash(bool on)
        {
            var info = new FlashInfo { Size = (uint)Marshal.SizeOf(typeof(FlashInfo)), Window = Handle, Flags = on ? 3u : 0u, Count = on ? 4u : 0u };
            FlashWindowEx(ref info);
        }
        internal void RestoreWindow() { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); }
        private void Fail(Exception ex)
        {
            ExitCode = 1;
            if (testing) { File.WriteAllText(Path.Combine(store.DirectoryPath, "failure.txt"), ex.ToString()); Close(); }
            else { MessageBox.Show(ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error); Close(); }
        }
    }
}
