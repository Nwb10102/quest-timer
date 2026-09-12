using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace QuestTimer
{
    /// <summary>
    /// GitHub 릴리스를 보고 새 판을 받아온다.
    ///
    /// 받는 것까지만 알아서 하고 설치는 사용자가 눌러야 한다 - 공부 중에 앱이
    /// 꺼지면 안 된다. 실행 중인 exe 는 스스로를 덮어쓸 수 없으므로, 새 파일을
    /// 임시 폴더에 풀어두고 앱이 닫힌 뒤에 복사하는 작은 배치를 띄운다.
    /// </summary>
    internal sealed class Updater
    {
        /// <summary>시험용: 버전 문자열 비교가 맞는지 밖에서 확인할 수 있게.</summary>
        internal static int CompareVersions(string mine, string theirs)
        {
            var a = Parse(mine);
            var b = Parse(theirs);
            if (a == null || b == null) return 0;
            return b.CompareTo(a);   // 0 보다 크면 theirs 가 더 새 판
        }

        private const string Api = "https://api.github.com/repos/Nwb10102/quest-timer/releases/latest";
        private const string Agent = "QuestTimer-Updater";

        private readonly JavaScriptSerializer json;
        private readonly string workRoot;
        private readonly Action<object> report;
        private string readyFolder;   // 풀어둔 새 판의 위치
        private bool busy;

        internal string Status { get; private set; } = "idle";
        internal string NextVersion { get; private set; }
        internal int Percent { get; private set; }
        internal string Error { get; private set; }
        internal bool AutoDownload { get; set; } = true;

        /// <summary>앱 폴더. 여기에 새 파일을 덮어쓴다.</summary>
        internal static string AppFolder => AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        /// <summary>지금 돌고 있는 판. 어셈블리 버전에서 읽는다.</summary>
        internal static string CurrentVersion
        {
            get
            {
                var v = Assembly.GetExecutingAssembly().GetName().Version;
                return v.Major + "." + v.Minor + "." + v.Build;
            }
        }

        private readonly string mineText;

        /// <param name="currentVersion">비교 기준이 될 현재 판. 시험할 때 바꿔 넣는다.</param>
        internal Updater(JavaScriptSerializer serializer, string dataDirectory, Action<object> onState,
                         string currentVersion = null)
        {
            json = serializer;
            report = onState;
            workRoot = Path.Combine(dataDirectory, "updates");
            mineText = currentVersion ?? CurrentVersion;
        }

        internal object Snapshot()
        {
            return new
            {
                status = Status,
                version = NextVersion,
                percent = Percent,
                error = Error,
                writable = IsAppFolderWritable(),
            };
        }

        private void Set(string status, string version = null, int percent = -1, string error = null)
        {
            Status = status;
            if (version != null) NextVersion = version;
            if (percent >= 0) Percent = percent;
            Error = error;
            report(Snapshot());
        }

        /// <summary>앱 폴더에 쓸 수 있는지. Program Files 에 풀어두면 권한이 없다.</summary>
        internal static bool IsAppFolderWritable()
        {
            try
            {
                var probe = Path.Combine(AppFolder, ".write-probe-" + Guid.NewGuid().ToString("N"));
                using (File.Create(probe)) { }
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        private static HttpClient NewClient()
        {
            // .NET Framework 는 기본 프로토콜이 낮게 잡힐 수 있다. GitHub 는 TLS 1.2 이상만 받는다.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            client.DefaultRequestHeaders.Add("User-Agent", Agent);
            return client;
        }

        /// <summary>"v1.2.3" / "1.2.3" 을 Version 으로. 실패하면 null.</summary>
        private static Version Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var t = text.Trim();
            if (t.StartsWith("v", StringComparison.OrdinalIgnoreCase)) t = t.Substring(1);
            var cut = t.IndexOfAny(new[] { '-', '+' });     // 1.2.3-beta 같은 꼬리는 버린다
            if (cut > 0) t = t.Substring(0, cut);
            Version parsed;
            return Version.TryParse(t, out parsed) ? parsed : null;
        }

        internal async Task CheckAsync()
        {
            if (busy || Status == "downloading" || Status == "ready") return;
            busy = true;
            try
            {
                Set("checking");
                string body;
                using (var client = NewClient())
                    body = await client.GetStringAsync(Api).ConfigureAwait(true);

                var release = json.DeserializeObject(body) as Dictionary<string, object>;
                if (release == null) throw new InvalidDataException("릴리스 정보를 읽지 못했습니다.");
                if (release.ContainsKey("draft") && Convert.ToBoolean(release["draft"]))
                    throw new InvalidDataException("아직 공개되지 않은 릴리스입니다.");

                var tag = release.ContainsKey("tag_name") ? Convert.ToString(release["tag_name"]) : null;
                var latest = Parse(tag);
                var mine = Parse(mineText);
                if (latest == null) throw new InvalidDataException("릴리스 번호를 알아볼 수 없습니다: " + tag);

                if (mine != null && latest <= mine) { Set("current", percent: 0); return; }

                // WebView2 판은 zip 으로 배포한다. 같은 릴리스에 Electron 설치 파일이
                // 섞여 있을 수 있으므로 zip 만 고른다.
                var assets = (release["assets"] as object[] ?? new object[0])
                    .OfType<Dictionary<string, object>>()
                    .Select(a => new
                    {
                        Name = Convert.ToString(a.ContainsKey("name") ? a["name"] : ""),
                        Url = Convert.ToString(a.ContainsKey("browser_download_url") ? a["browser_download_url"] : ""),
                    })
                    .Where(a => !string.IsNullOrEmpty(a.Url))
                    .ToList();

                var zip = assets.FirstOrDefault(a => a.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)
                                                     && a.Name.IndexOf("webview2", StringComparison.OrdinalIgnoreCase) >= 0)
                          ?? assets.FirstOrDefault(a => a.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase));
                if (zip == null) throw new InvalidDataException("이 릴리스에는 WebView2 zip 이 없습니다.");

                pending = new Asset
                {
                    Version = latest.Major + "." + latest.Minor + "." + latest.Build,
                    Name = zip.Name,
                    Url = zip.Url,
                    // 체크섬 파일이 함께 올라와 있으면 받아서 대조한다
                    ChecksumUrl = assets.FirstOrDefault(a =>
                        a.Name.IndexOf("sha256", StringComparison.OrdinalIgnoreCase) >= 0)?.Url,
                };

                Set("available", pending.Version, 0);
                if (AutoDownload) { busy = false; await DownloadAsync().ConfigureAwait(true); return; }
            }
            catch (Exception ex) { Set("error", error: Describe(ex)); }
            finally { busy = false; }
        }

        private sealed class Asset
        {
            internal string Version;
            internal string Name;
            internal string Url;
            internal string ChecksumUrl;
        }
        private Asset pending;

        internal async Task DownloadAsync()
        {
            if (busy || pending == null || Status == "ready") return;
            busy = true;
            try
            {
                Set("downloading", pending.Version, 0);
                var work = Path.Combine(workRoot, pending.Version);
                if (Directory.Exists(work)) Directory.Delete(work, true);
                Directory.CreateDirectory(work);

                var zipPath = Path.Combine(work, pending.Name);
                using (var client = NewClient())
                {
                    using (var response = await client.GetAsync(pending.Url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(true))
                    {
                        response.EnsureSuccessStatusCode();
                        var total = response.Content.Headers.ContentLength ?? 0L;
                        var done = 0L;
                        var buffer = new byte[81920];
                        using (var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(true))
                        using (var target = File.Create(zipPath))
                        {
                            int read;
                            var lastShown = -1;
                            while ((read = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(true)) > 0)
                            {
                                await target.WriteAsync(buffer, 0, read).ConfigureAwait(true);
                                done += read;
                                if (total <= 0) continue;
                                var pct = (int)(done * 100 / total);
                                if (pct != lastShown) { lastShown = pct; Set("downloading", pending.Version, pct); }
                            }
                        }
                    }

                    if (pending.ChecksumUrl != null)
                    {
                        var published = await client.GetStringAsync(pending.ChecksumUrl).ConfigureAwait(true);
                        Verify(zipPath, published);
                    }
                }

                var unpacked = Path.Combine(work, "app");
                if (Directory.Exists(unpacked)) Directory.Delete(unpacked, true);
                ZipFile.ExtractToDirectory(zipPath, unpacked);

                // zip 안에 "Quest Timer" 폴더가 한 겹 들어 있다. exe 가 있는 곳을 찾는다.
                readyFolder = FindAppRoot(unpacked);
                if (readyFolder == null) throw new InvalidDataException("zip 안에서 실행 파일을 찾지 못했습니다.");

                Set("ready", pending.Version, 100);
            }
            catch (Exception ex)
            {
                readyFolder = null;
                Set("error", error: Describe(ex));
            }
            finally { busy = false; }
        }

        /// <summary>체크섬 파일에서 이 zip 의 sha256 을 찾아 대조한다.</summary>
        private static void Verify(string zipPath, string published)
        {
            string actual;
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(zipPath))
                actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();

            // "<hash>  <파일명>" 형식을 줄 단위로 훑는다. 파일명이 없으면 해시만 비교한다.
            var hashes = published
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => line.Trim())
                .Where(line => line.Length >= 64)
                .Select(line => new
                {
                    Hash = new string(line.TakeWhile(c => Uri.IsHexDigit(c)).ToArray()).ToLowerInvariant(),
                    Line = line,
                })
                .Where(x => x.Hash.Length == 64)
                .ToList();
            if (hashes.Count == 0) return;   // 형식을 모르면 그냥 넘어간다

            // 이름으로 줄을 찾지 않고 해시를 직접 맞춰본다. GitHub 는 올릴 때
            // 파일명의 공백을 점으로 바꾸므로 체크섬 파일 안의 이름과 어긋난다.
            if (!hashes.Any(x => string.Equals(x.Hash, actual, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("받은 파일의 체크섬이 맞지 않습니다. 내려받기를 다시 시도해 주세요.");
        }

        private static string FindAppRoot(string folder)
        {
            if (File.Exists(Path.Combine(folder, "Quest Timer.exe"))) return folder;
            foreach (var child in Directory.GetDirectories(folder))
            {
                var found = FindAppRoot(child);
                if (found != null) return found;
            }
            return null;
        }

        /// <summary>
        /// 앱을 닫고 새 파일로 덮어쓴 뒤 다시 띄운다.
        /// 실행 중인 파일은 자기 자신을 덮어쓸 수 없으므로 배치에 맡긴다.
        /// </summary>
        internal bool Install()
        {
            if (Status != "ready" || readyFolder == null) return false;
            if (!IsAppFolderWritable())
            {
                Set("error", error: "앱 폴더에 쓸 권한이 없습니다. zip 을 직접 풀어 덮어써 주세요.");
                return false;
            }

            var script = Path.Combine(workRoot, "apply-" + NextVersion + ".cmd");
            var exe = Path.Combine(AppFolder, "Quest Timer.exe");
            var lines = new[]
            {
                "@echo off",
                "chcp 65001 > nul",
                // 앱이 완전히 닫히기를 기다린다
                ":wait",
                "tasklist /fi \"PID eq " + Process.GetCurrentProcess().Id + "\" | find \"" + Process.GetCurrentProcess().Id + "\" > nul",
                "if not errorlevel 1 ( timeout /t 1 /nobreak > nul & goto wait )",
                // 새 파일을 덮어쓴다. /E 라서 기존 파일을 지우지는 않는다.
                "robocopy \"" + readyFolder + "\" \"" + AppFolder + "\" /E /IS /R:3 /W:1 /NFL /NDL /NJH /NJS > nul",
                "start \"\" \"" + exe + "\"",
                // 배치 자신을 지운다
                "(goto) 2>nul & del \"%~f0\"",
            };
            File.WriteAllLines(script, lines, new UTF8Encoding(false));

            Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + script + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetTempPath(),
            });
            return true;
        }

        private static string Describe(Exception ex)
        {
            if (ex is HttpRequestException || ex is WebException)
                return "인터넷에 연결하지 못했습니다.";
            if (ex is TaskCanceledException) return "시간이 초과되었습니다.";
            return ex.Message;
        }
    }
}
