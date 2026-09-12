using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace QuestTimer
{
    internal sealed partial class TimerWindow
    {
        private readonly List<string> checks = new List<string>();
        private async Task<object> Js(string expression) => store.Json.DeserializeObject(await web.CoreWebView2.ExecuteScriptAsync(expression));
        private async Task ClickElement(string id) { await Js("document.getElementById('" + id + "').click(); true"); await Task.Delay(100); }
        private void Check(string name, bool pass)
        {
            checks.Add((pass ? "PASS " : "FAIL ") + name);
            File.WriteAllLines(Path.Combine(store.DirectoryPath, "smoke.log"), checks);
            if (!pass) throw new Exception("Smoke failed: " + name);
        }
        private async Task CheckJs(string name, string expression) => Check(name, Equals(await Js(expression), true));
        private async Task CaptureScreen(string name)
        {
            using (var file = File.Create(Path.Combine(store.DirectoryPath, name + ".png")))
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        }

        private async Task RunSmoke()
        {
            try
            {
                await Task.Delay(500);
                // Validate recovery/import without touching this app's actual test state.
                var sample = "{\"version\":1,\"totalXp\":12,\"settings\":{},\"quests\":[],\"sessions\":[]}";
                var legacy = Path.Combine(store.DirectoryPath, "legacy", "Quest Timer");
                Directory.CreateDirectory(legacy);
                File.WriteAllText(Path.Combine(legacy, "data.json"), sample);
                var migration = new StateStore(Path.Combine(store.DirectoryPath, "migration-test"));
                migration.ImportLegacy(Path.GetDirectoryName(legacy));
                Check("legacy import preserves original", File.ReadAllText(Path.Combine(legacy, "data.json")) == sample && File.ReadAllText(migration.DataPath) == sample);
                migration.Save(sample.Replace(":12", ":24"));
                Check("atomic backup", File.ReadAllText(migration.DataPath + ".bak") == sample);
                File.WriteAllText(migration.DataPath, "broken");
                Check("corrupt main recovers backup", Convert.ToInt32(((Dictionary<string, object>)migration.Load())["totalXp"]) == 12);
                migration.Save(sample);
                migration.ImportLegacy(Path.GetDirectoryName(legacy));
                Check("migration does not replace existing data", File.ReadAllText(migration.DataPath) == sample);

                await CheckJs("host initializes", "!!window.api && document.getElementById('clock').textContent==='25:00'");
                await Js("document.querySelector('[data-view=profile]').click(); true");
                await CheckJs("profile replaces achievements tab", "!document.getElementById('viewProfile').hidden && !document.querySelector('[data-view=badges]')");
                await CheckJs("profile level matches header", "document.getElementById('profileLevel').textContent===document.getElementById('rankLevel').textContent");
                await CheckJs("profile includes all achievements", "document.querySelectorAll('#badges .badge').length===Game.ACHIEVEMENTS.length");
                await CaptureScreen("webview-profile");
                await Js("document.querySelector('[data-view=field]').click(); true");
                await CaptureScreen("webview-idle");
                await Js("document.getElementById('composeOpen').click(); document.getElementById('questTitle').value='WebView2 시험'; document.getElementById('questMinutes').value='1'; document.getElementById('compose').requestSubmit(); true");
                await Task.Delay(600);
                await CheckJs("quest added", "document.querySelectorAll('#listOnce .quest').length===1");
                await Js("document.querySelector('#listOnce .quest').click(); true");
                await CheckJs("quest selected", "document.getElementById('clock').textContent==='01:00'");
                await Js("window.api.setAlwaysOnTop(true); true"); await Task.Delay(200);
                Check("always on top", TopMost);
                await Js("window.api.setAlwaysOnTop(false); true"); await Task.Delay(200);
                Check("always on top off", !TopMost);
                await ClickElement("btnGo"); await Task.Delay(1500);
                await CheckJs("panel collapses", "document.getElementById('questPanel').inert");
                await CheckJs("gradient fades", "getComputedStyle(document.querySelector('.content'),'::before').opacity==='0'");
                Check("native deadline armed", deadline.HasValue);
                var before = deadline.Value;
                await ClickElement("btnPlus5");
                Check("five minutes extend native deadline", Math.Abs(deadline.Value - before - 300000) < 200);
                await CaptureScreen("webview-running");
                await ClickElement("btnHold"); await Task.Delay(1400);
                Check("pause disarms native timer", !deadline.HasValue);
                await CheckJs("pause restores blur", "getComputedStyle(document.querySelector('.content'),'::before').opacity==='1'");
                var held = await Js("document.getElementById('clock').textContent");
                await Task.Delay(1100);
                Check("pause keeps remaining time", Equals(held, await Js("document.getElementById('clock').textContent")));
                await CaptureScreen("webview-paused");
                await ClickElement("btnStop");
                await Task.Delay(1300);
                await CheckJs("stop restores sidebar", "!document.getElementById('questPanel').inert");
                await ClickElement("btnGo");
                WindowState = FormWindowState.Minimized;
                var end = DateTime.UtcNow.AddSeconds(70);
                while (DateTime.UtcNow < end && notifications == 0) await Task.Delay(500);
                RestoreWindow(); Resync(); await Task.Delay(1800);
                Check("native completion while minimized", notifications == 1);
                await CheckJs("completion recorded", "document.getElementById('clock').textContent==='00:00' && document.querySelectorAll('#history li').length===1");
                await CheckJs("completion restores sidebar", "!document.getElementById('questPanel').inert");
                Check("saved state exists", FlushSave() && File.Exists(store.DataPath));
                var saved = (Dictionary<string, object>)store.Load();
                Check("experience saved", Convert.ToInt32(saved["totalXp"]) == 2);
                await CaptureScreen("webview-complete");
                web.CoreWebView2.Reload();
                for (var i = 0; i < 50 && !ready; i++) await Task.Delay(100);
                await Task.Delay(800);
                await CheckJs("saved record survives reload", "document.querySelectorAll('#history li').length===1");
                await Js("document.querySelector('[data-view=profile]').click(); true");
                await CheckJs("profile updates after completion", "document.getElementById('profileCompleted').textContent==='1번' && document.getElementById('profileMeter').getAttribute('aria-valuenow')==='2'");
                // Simulate the race where the renderer reaches zero before the native tick.
                deadline = Now - 1;
                await Js("window.api.disarmTimer(); true"); await Task.Delay(200);
                Check("renderer-first completion still notifies", notifications == 2);
                await Js("window.api.disarmTimer(); true"); await Task.Delay(100);
                Check("completion is not notified twice", notifications == 2);
                deadline = Now - 10000;
                Resync(); Resync();
                Check("resume resync handles elapsed deadline once", notifications == 3 && !deadline.HasValue);
                var original = web.Source.AbsoluteUri;
                web.CoreWebView2.Navigate("https://example.com/"); await Task.Delay(300);
                Check("external navigation blocked", web.Source.AbsoluteUri == original);
                File.WriteAllText(Path.Combine(store.DirectoryPath, "success.txt"), checks.Count + " checks passed");
                Close();
            }
            catch (Exception ex) { Fail(ex); }
        }
    }
}

