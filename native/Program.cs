using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace QuestTimer
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var option = args.FirstOrDefault(a => a.StartsWith("--data-dir=", StringComparison.Ordinal));
            var data = option == null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Quest Timer WebView2")
                : Path.GetFullPath(option.Substring("--data-dir=".Length));
            var testing = args.Contains("--smoke");
            if (testing && option == null) throw new ArgumentException("--smoke requires an isolated --data-dir");
            using (var hash = SHA256.Create())
            {
                var key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data.ToUpperInvariant()))).Replace("-", "");
                using (var mutex = new Mutex(true, "Local\\QuestTimer-WebView2-" + key, out var first))
                using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\QuestTimer-Activate-" + key))
                {
                    if (!first) { activate.Set(); return 0; }
                    try
                    {
                        var store = new StateStore(data);
                        if (option == null) store.ImportLegacy();
                        using (var form = new TimerWindow(store, testing))
                        {
                            RegisteredWaitHandle waiter = null;
                            form.Shown += (s, e) => waiter = ThreadPool.RegisterWaitForSingleObject(activate, (o, timedOut) =>
                            {
                                try { form.BeginInvoke(new Action(form.RestoreWindow)); } catch (InvalidOperationException) { }
                            }, null, -1, false);
                            Application.Run(form);
                            waiter?.Unregister(null);
                            return form.ExitCode;
                        }
                    }
                    catch (Exception ex)
                    {
                        if (testing) File.WriteAllText(Path.Combine(data, "failure.txt"), ex.ToString());
                        else MessageBox.Show(ex.Message, "Quest Timer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return 1;
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
        }
    }
}
