using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace QuestTimer
{
    internal sealed class StateStore
    {
        internal readonly string DirectoryPath;
        internal string DataPath => Path.Combine(DirectoryPath, "data.json");
        internal readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };

        internal StateStore(string directory) { DirectoryPath = directory; Directory.CreateDirectory(directory); }

        internal object ParseState(string text)
        {
            var data = Json.DeserializeObject(text) as Dictionary<string, object>;
            if (data == null || !data.ContainsKey("settings") || !data.ContainsKey("quests") || !data.ContainsKey("sessions"))
                throw new InvalidDataException("공부 기록 형식이 올바르지 않습니다.");
            return data;
        }

        internal object Load()
        {
            bool existed = false;
            foreach (var path in new[] { DataPath, DataPath + ".bak" })
            {
                if (!File.Exists(path)) continue;
                existed = true;
                try { return ParseState(File.ReadAllText(path, Encoding.UTF8)); }
                catch (Exception e) when (e is ArgumentException || e is InvalidDataException || e is InvalidOperationException)
                {
                    File.Move(path, path + ".corrupt-" + DateTime.UtcNow.Ticks);
                }
            }
            if (existed) throw new InvalidDataException("기록과 백업을 읽을 수 없습니다. 원본을 보존했습니다. 저장 폴더의 data.json을 확인해 주세요.");
            return null;
        }

        internal void Save(string text)
        {
            ParseState(text);
            var temp = DataPath + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var bytes = new UTF8Encoding(false).GetBytes(text);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            if (File.Exists(DataPath)) File.Replace(temp, DataPath, DataPath + ".bak", true);
            else File.Move(temp, DataPath);
        }

        // Original Electron files are read only. Once imported, the new host owns its copy.
        internal void ImportLegacy(string root = null)
        {
            if (File.Exists(DataPath) || File.Exists(DataPath + ".bak")) return;
            root = root ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var candidates = new[] { "Quest Timer", "quest-timer", "seungrim-timer", "승림이 타이머" }
                .SelectMany(name => new[] { Path.Combine(root, name, "data.json"), Path.Combine(root, name, "data.json.bak") })
                .Where(File.Exists).OrderByDescending(File.GetLastWriteTimeUtc).ToArray();
            foreach (var file in candidates)
            {
                try
                {
                    var text = File.ReadAllText(file, Encoding.UTF8);
                    ParseState(text);
                    File.WriteAllText(Path.Combine(DirectoryPath, "electron-original.json"), text, new UTF8Encoding(false));
                    Save(text);
                    File.WriteAllText(Path.Combine(DirectoryPath, "migration.txt"), "Imported: " + file + "\r\nUTC: " + DateTime.UtcNow.ToString("O"));
                    return;
                }
                catch (Exception e) when (e is ArgumentException || e is InvalidDataException || e is InvalidOperationException) { }
            }
            if (candidates.Length > 0) throw new InvalidDataException("이전 앱의 공부 기록을 읽을 수 없습니다. 이전 기록은 그대로 보존되어 있습니다.");
        }
    }
}
