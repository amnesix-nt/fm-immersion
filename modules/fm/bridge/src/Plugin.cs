using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;

namespace Archivix;

// Pont en lecture seule entre FM27 et le compagnon Archivix.
// Serveur local facultatif (réglage ServeurLocal, coupé par défaut depuis 0.4.5) : GET / (archivix.html à côté de la DLL),
// GET /api/snapshot, GET /api/discover?q=, sondes /api/probe… FM Immersion ne s'en sert pas : il lit les fichiers JSON.
[BepInPlugin("fr.archivix.bridge", "Archivix Bridge", Version)]
public class Plugin : BasePlugin
{
    public const string Version = "0.6.4";
    internal static ManualLogSource Log = null!;
    // Dossier où le plugin écrit ses instantanés (réglage BepInEx\config\fr.archivix.bridge.cfg,
    // que FM Immersion renseigne à l'installation ; par défaut le dossier de données FM27 dans Documents).
    internal static string DataDir = null!;
    internal static bool ReadTactic = true, ReadEffectiveness, ReadLineup, ReadExtended, ReadTargets, WriteDiscovery = true, LocalServer, ReadLive = true, PressInGame = true;
    bool _discovered;
    internal static int RereadSeconds = 300;
    // 0.6.3 : match en cours (tenu par LiveLoop) et lecture complète en cours. Une lecture complète lancée juste avant le
    // coup d'envoi continuait pendant le match (13/11/2026 : 63 s de lecture, images jusqu'à 108 ms, « le match 3D rame »).
    internal static volatile bool InMatch, Reading;
    const string Prefix = "http://localhost:8727/";
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    HttpListener? _http;
    IGameReader _reader = new FmBindingReader();
    Snapshot? _last;
    readonly object _lock = new();

    public override void Load()
    {
        Log = base.Log;
        DataDir = Config.Bind("Archivix", "Dossier",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Sports Interactive", "Football Manager 27", "archivix"),
            "Dossier où écrire archivix-snapshot.json (en général <données FM27>\\archivix).").Value;
        // Réglages de prudence : chaque lecture passe par le système d'affichage du jeu, qui doit rester fluide.
        // Désactivé par défaut : lire la tactique pendant que l'écran Tactique est ouvert a figé puis planté FM27
        // (31/10/2026, erreur TacticalPlannerTool « Out of bounds index: -1 »).
        ReadTactic = Config.Bind("Archivix", "LireTactique", false,
            "Lire la tactique active (nom, mentalité, postes, consignes). Risqué : peut figer FM27 si l'écran Tactique est ouvert.").Value;
        ReadEffectiveness = Config.Bind("Archivix", "LireEfficacite", true,
            "Lire l'efficacité tactique FM27 (note, 4 piliers, complexité, adhésion, conseils), jamais pendant que l'écran Tactique est ouvert.").Value;
        ReadLineup = Config.Bind("Archivix", "LireCompo", false,
            "Lire la compo (joueur à chaque poste) et les rôles personnalisés. Expérimental ; jamais pendant que l'écran Tactique est ouvert.").Value;
        ReadExtended = Config.Bind("Archivix", "LireJoueursEtendus", false,
            "Lire moral, satisfaction, hiérarchie, étoiles du staff et niveau des joueurs (expérimental).").Value;
        ReadTargets = Config.Bind("Archivix", "LireCibles", false,
            "Lire les cibles du mercato : ta liste de suivi et les cibles du recrutement (joueurs d'autres clubs, avis des recruteurs). Expérimental.").Value;
        WriteDiscovery = Config.Bind("Archivix", "Decouverte", true,
            "Écrire archivix\\config\\decouverte.json (propriétés et contextes du jeu, sans requête au jeu) une fois par lancement.").Value;
        RereadSeconds = Math.Max(60, Config.Bind("Archivix", "RelectureSecondes", 300,
            "Relecture complète au plus tard toutes les N secondes même sans changement de date (60 au minimum).").Value);
        // 0.4.5 (audit du 03/11/2026) : serveur local coupé par défaut. Ouvert, n'importe quelle page web du navigateur
        // pouvait l'appeler et déclencher des lectures dans le jeu (/api/probe, /api/squad). FM Immersion ne s'en sert pas.
        LocalServer = Config.Bind("Archivix", "ServeurLocal", false,
            "Ouvrir le serveur local http://localhost:8727 (ancienne page archivix.html et sondes de découverte). Inutile pour FM Immersion ; à n'activer que pour du diagnostic.").Value;
        ReadLive = Config.Bind("Archivix", "LireMatchDirect", true,
            "Pendant un match, écrire toutes les 15 s archivix-live.json (score, minute, buteurs) pour le direct Discord de FM Immersion.").Value;
        PressInGame = Config.Bind("Archivix", "ConferenceEnJeu", true,
            "Afficher dans FM27 les conférences de presse préparées par FM Immersion (fenêtre par-dessus le jeu, F8 pour l'ouvrir ou la fermer). Ne change rien à la partie.").Value;
        AddComponent<MainThread>();
        if (PressInGame) { AddComponent<PressWindow>(); PressWindow.StartWatcher(); }
        new Thread(RefreshLoop) { IsBackground = true, Name = "ArchivixRefresh" }.Start();
        new Thread(DateLoop) { IsBackground = true, Name = "ArchivixDate" }.Start();
        if (ReadLineup || ReadTactic) new Thread(SelectionLoop) { IsBackground = true, Name = "ArchivixCompo" }.Start();
        if (ReadLive) new Thread(LiveLoop) { IsBackground = true, Name = "ArchivixLive" }.Start();
        if (LocalServer) StartServer();
        Log.LogInfo($"Archivix Bridge {Version} : instantanés dans {DataDir}" + (_http != null ? $", serveur local sur {Prefix}" : ""));
    }

    // Un port déjà pris ne doit pas empêcher le plugin de démarrer : les instantanés continuent sans serveur.
    void StartServer()
    {
        try
        {
            var http = new HttpListener();
            http.Prefixes.Add(Prefix);
            http.Start();
            _http = http;
            new Thread(Serve) { IsBackground = true, Name = "ArchivixHttp" }.Start();
        }
        catch (Exception e)
        {
            _http = null;
            Log.LogWarning($"Serveur local {Prefix} impossible à ouvrir ({e.Message}) : instantanés seulement.");
        }
    }

    // Vérifie la date de jeu toutes les 10 s ; instantané complet au chargement d'une partie, à chaque nouveau
    // jour de jeu, et au plus tard toutes les RelectureSecondes (300 s par défaut). Les lectures IL2CPP sont exécutées sur le thread principal
    // par MainThread ; ce thread-ci ne fait qu'attendre les réponses et écrire les fichiers.
    //
    // 0.4.2 (plantage du 01/11 à 18h02, lecture lancée juste après un chargement puis sortie de partie) :
    // - après un chargement, on attend que la partie soit chargée sans interruption depuis SettleSeconds avant de lire ;
    // - une lecture en cours s'arrête dès que la partie n'est plus la même (sortie, autre sauvegarde), voir FmBindingReader.Read.
    const int SettleSeconds = 45;

    void RefreshLoop()
    {
        string? lastDate = null;
        var lastFull = DateTime.MinValue;
        int retries = 0;
        DateTime? loadedSince = null;
        // Sans équipe (manager sans club) : la date seule, au plus une fois par minute, après SettleSeconds sans équipe
        // (jamais pendant un chargement ou une sortie de partie), pour archivix-status.json avec club null.
        DateTime? noTeamSince = null, lastNoTeamRead = null;
        string? lastNoTeamDate = null;
        while (true)
        {
            Thread.Sleep(10_000);
            try
            {
                var date = FmBindingReader.CurrentDate();
                if (date != null && FmBindingReader.TeamWithoutName()) date = null;   // 0.6.1 : sans club dès le début de la partie
                if (date == null)   // pas d'équipe chargée : menu, chargement, ou manager sans club
                {
                    lastDate = null; loadedSince = null;
                    var now = DateTime.UtcNow;
                    noTeamSince ??= now;
                    if (now - noTeamSince >= TimeSpan.FromSeconds(SettleSeconds) && (lastNoTeamRead == null || now - lastNoTeamRead >= TimeSpan.FromSeconds(60)))
                    {
                        lastNoTeamRead = now;
                        var d = FmBindingReader.DateWithoutTeam();
                        if (d != null && d != lastNoTeamDate) { WriteStatus(d, null); lastNoTeamDate = d; }
                    }
                    continue;
                }
                noTeamSince = null; lastNoTeamRead = null; lastNoTeamDate = null;
                loadedSince ??= DateTime.UtcNow;
                if (DateTime.UtcNow - loadedSince < TimeSpan.FromSeconds(SettleSeconds)) continue;   // partie tout juste chargée
                if (date == lastDate && DateTime.UtcNow - lastFull < TimeSpan.FromSeconds(RereadSeconds)) continue;
                // 0.5.8 : pas de lecture complète pendant un match (plusieurs milliers de requêtes pendant que le moteur de
                // match tourne : jeu ralenti et réponses perdues, 10/11/2026). Elle part dès la fin du match ; le direct
                // (LiveLoop) continue de son côté.
                if (FmBindingReader.DuringMatch() == true) continue;
                bool complete = Refresh();
                // 0.5.7 : lecture incomplète (le jeu n'a pas répondu à temps) : on relit une minute plus tard, trois fois
                // au plus par jour de jeu, au lieu d'attendre RereadSeconds ou le jour suivant.
                if (date != lastDate) retries = 0;
                lastDate = date;
                lastFull = DateTime.UtcNow;
                if (!complete && retries < 3)
                {
                    retries++;
                    lastFull = DateTime.UtcNow - TimeSpan.FromSeconds(Math.Max(0, RereadSeconds - 60));
                    Log.LogInfo($"Lecture incomplète du {date} : nouvelle lecture dans une minute ({retries}/3).");
                }
            }
            catch (FmBindingReader.MatchStarted) { lastDate = null; Log.LogInfo("Match commencé : lecture complète arrêtée, elle repartira après le match."); }
            catch (FmBindingReader.GameChanged) { lastDate = null; loadedSince = null; Log.LogInfo("Partie quittée ou changée pendant la lecture : instantané abandonné."); }
            catch (Exception e) { Log.LogWarning($"Instantané impossible : {e.Message}"); }
        }
    }

    // Date de jeu en direct (0.5.3) : toutes les 10 s, une seule lecture (club + date), et archivix-status.json dès que
    // la date change. Un instantané complet prend 1 à 2 minutes et garde la date de son début : pendant que le joueur
    // avance, FM Immersion affichait jusqu'à 3 jours de retard (08/11/2026). Rien pendant un chargement (SettleSeconds).
    void DateLoop()
    {
        string? last = null;
        DateTime? loadedSince = null;
        while (true)
        {
            Thread.Sleep(10_000);
            try
            {
                var (date, club) = FmBindingReader.CurrentDateAndClub();
                if (date == null || club == null) { last = null; loadedSince = null; continue; }
                loadedSince ??= DateTime.UtcNow;
                if (DateTime.UtcNow - loadedSince < TimeSpan.FromSeconds(SettleSeconds)) continue;
                var key = club + "|" + date;
                if (key == last) continue;
                WriteStatus(date, club, live: true);
                last = key;
            }
            catch (Exception e) { Log.LogWarning($"Date de jeu : {e.Message}"); }
        }
    }

    // Compo et tactique presque en direct (0.6.4) : la lecture complète ne repart qu'à chaque nouveau jour de jeu, ou
    // toutes les RelectureSecondes (5 minutes) si la date ne bouge pas, et dure une minute. Un changement de onze ou de
    // tactique dans FM27 n'arrivait donc dans FM Immersion qu'après plusieurs minutes (13/11/2026 : « le refresh de
    // l'effectif se fait tardivement, ça devrait être quasiment instantané »). Toutes les 10 s, on relit seulement la
    // compo (11 lignes) et le nom de la tactique ; si l'un des deux a changé depuis le dernier instantané, la tactique
    // est relue et l'instantané réécrit avec la nouvelle compo, le reste gardé tel quel. Jamais pendant un match, une
    // lecture complète ou tant que l'écran Tactique est ouvert ; rien si le jour ou le club ne sont plus ceux de
    // l'instantané (la lecture complète s'en charge).
    void SelectionLoop()
    {
        if (_reader is not FmBindingReader reader) return;
        string? seen = null;
        while (true)
        {
            Thread.Sleep(10_000);
            try
            {
                Snapshot? last; lock (_lock) last = _last;
                if (last == null || InMatch || Reading) continue;
                var (date, club) = FmBindingReader.CurrentDateAndClub();
                if (date != last.GameDate || club != last.Club) { seen = null; continue; }
                if (reader.ProbeSelection() is not { } probe) continue;
                // Compo illisible (le jeu n'a pas répondu) : on ne remplace pas une compo lue par des trous.
                int Filled(List<Dictionary<string, object?>>? l) => l?.Count(r => r.GetValueOrDefault("playerId") != null) ?? 0;
                if (ReadLineup && Filled(probe.Lineup) < Math.Min(9, Filled(last.Lineup))) continue;
                if (probe.Name == null && last.Tactic?.Name != null) continue;
                string Sig(string? name, List<Dictionary<string, object?>>? l) => name + "|" + JsonSerializer.Serialize(l);
                var now = Sig(probe.Name, ReadLineup ? probe.Lineup : last.Lineup);
                if (now == Sig(last.Tactic?.Name, last.Lineup) || now == seen) { seen = now; continue; }
                // Lecture complète partie entre-temps : elle écrira la nouvelle compo elle-même.
                if (InMatch || Reading) continue;
                var mostUsed = last.Tactic?.FormationSource == "MostUsedFormation" ? last.Tactic.Formation : null;
                var tactic = reader.ReadSelectionTactic(mostUsed) ?? last.Tactic;
                var collecte = last.Collecte != null ? new Dictionary<string, string>(last.Collecte) : new Dictionary<string, string>();
                collecte["compoRapide"] = "relue à " + DateTime.Now.ToString("HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);
                var snap = last with { Tactic = tactic, Lineup = ReadLineup ? probe.Lineup : last.Lineup, Collecte = collecte };
                lock (_lock)
                {
                    // Un instantané complet a été écrit pendant la relecture : il est plus récent, on ne l'écrase pas.
                    if (!ReferenceEquals(_last, last)) continue;
                    _last = snap;
                }
                var json = JsonSerializer.Serialize(snap, Json);
                WriteAtomic(Path.Combine(DataDir, "archivix-snapshot.json"), json);
                WriteAtomic(Path.Combine(DataDir, $"archivix-{snap.GameDate}.json"), json);
                seen = now;
                Log.LogInfo($"Compo ou tactique changée dans le jeu : instantané du {snap.GameDate} réécrit (« {tactic?.Name} »).");
            }
            catch (Exception e) { Log.LogWarning($"Compo rapide : {e.Message}"); }
        }
    }

    // Match en direct (0.5.0) : toutes les 20 s, le plugin demande au jeu si un match est en cours ; pendant le match,
    // il relit toutes les 15 s le score du match du manager (FmBindingReader.ReadLive) et écrit archivix-live.json.
    // Lecture seule, comme le reste. Le fichier garde le dernier état (match fini compris) jusqu'au match suivant.
    // 0.5.4 : à la fin du match (dernière lecture, ou résultat final), le rapport du match (buteurs, passeurs, feuille de
    // match) est ajouté au relevé depuis LastFixture (FmBindingReader.AddMatchReport).
    // 0.5.6 : le jeu ne désigne pas toujours le match fini par LastFixture au coup de sifflet (08/11/2026 : relevé final
    // sans rapport). Le rapport est donc retenté toutes les 15 s pendant 3 minutes après le match, et le relevé réécrit
    // dès qu'il est lu.
    void LiveLoop()
    {
        bool was = false;
        int silent = 0;
        string? gameDate = null;
        Dictionary<string, object?>? last = null;
        Dictionary<string, object?>? pending = null;
        DateTime pendingUntil = DateTime.MinValue;
        void WriteLive(Dictionary<string, object?> live, bool inMatch)
        {
            var doc = new Dictionary<string, object?> { ["schema"] = "archivix-live/1", ["gameDate"] = gameDate, ["inMatch"] = inMatch, ["updatedAt"] = DateTime.UtcNow.ToString("o") };
            foreach (var kv in live) doc[kv.Key] = kv.Value;
            Directory.CreateDirectory(DataDir);
            WriteAtomic(Path.Combine(DataDir, "archivix-live.json"), JsonSerializer.Serialize(doc, Json));
        }
        bool Report(Dictionary<string, object?> live)
        {
            try { return FmBindingReader.AddMatchReport(live); }
            catch (Exception e) { Log.LogWarning($"Rapport de match : {e.Message}"); return false; }
        }
        while (true)
        {
            try
            {
                // 0.5.8 : sans réponse du jeu (null), on garde l'état précédent, quatre fois de suite au plus. Avant, une seule
                // réponse manquée pendant un match le déclarait fini, puis le rouvrait à la lecture suivante.
                var during = FmBindingReader.DuringMatch();
                silent = during == null ? silent + 1 : 0;
                var now = during ?? (was && silent <= 4);
                InMatch = now;
                if (now && !was) { gameDate = FmBindingReader.CurrentDate(); last = null; pending = null; Log.LogInfo("Match en cours : direct dans archivix-live.json"); }
                if (now || was)   // une dernière lecture après la fin du match, pour le résultat final
                {
                    var live = FmBindingReader.ReadLive();
                    // Match fini : le jeu ne répond plus toujours sur le match (0.5.0 laissait alors le relevé « en cours »
                    // à la dernière minute lue, et le direct Discord ne se terminait jamais). On ferme avec le dernier
                    // score connu, marqué final.
                    if (live == null && !now && last != null) { live = new Dictionary<string, object?>(last); live["final"] = true; live["minute"] = "FDM"; }
                    if (live != null)
                    {
                        if (!now) live["final"] = true;
                        var reported = (!now || live["final"] is true) && Report(live);
                        // Match fini sans rapport : on le retente pendant 3 minutes.
                        if (!now && !reported) { pending = live; pendingUntil = DateTime.UtcNow.AddMinutes(3); }
                        WriteLive(live, now);
                        last = now ? live : null;
                    }
                }
                else if (pending != null)
                {
                    if (Report(pending)) { WriteLive(pending, false); pending = null; Log.LogInfo("Rapport de match ajouté au relevé"); }
                    else if (DateTime.UtcNow > pendingUntil) pending = null;
                }
                was = now;
            }
            catch (Exception e) { Log.LogWarning($"Match en direct : {e.Message}"); }
            // 0.6.3 : pendant une lecture complète, on regarde toutes les 5 s si un match commence, pour l'arrêter à temps.
            Thread.Sleep(was || pending != null ? 15_000 : Reading ? 5_000 : 20_000);
        }
    }

    // Jour de jeu et club de la dernière lecture complète écrite : une lecture incomplète du même jour ne la remplace pas.
    string? _completeKey;

    /// <summary>Lit et écrit un instantané. Faux si la lecture est incomplète (voir FmBindingReader.LastIncomplete).</summary>
    internal bool Refresh()
    {
        var snap = _reader.Read();
        // Jamais d'instantané vide : il écraserait le dernier effectif valide (ex. partie en cours de chargement)
        if (snap.Players.Count == 0 || string.IsNullOrEmpty(snap.Club)) return true;
        bool complete = !_reader.LastIncomplete;
        var key = snap.Club + "|" + snap.GameDate;
        if (!complete && key == _completeKey) return false;
        if (complete) _completeKey = key;
        lock (_lock) _last = snap;
        var dir = DataDir;
        Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(snap, Json);
        WriteAtomic(Path.Combine(dir, "archivix-snapshot.json"), json);
        WriteAtomic(Path.Combine(dir, $"archivix-{snap.GameDate}.json"), json);
        WriteStatus(snap.GameDate, snap.Club, live: false);
        if (WriteDiscovery && !_discovered)
        {
            _discovered = true;
            try { Discovery.Write(dir); }
            catch (Exception e) { Log.LogWarning($"Rapport de découverte impossible : {e.Message}"); }
        }
        return complete;
    }

    // État courant pour FM Immersion (0.4.2) : date de jeu et club du manager (null = sans club). Aucune lecture en plus :
    // reprend les valeurs de l'instantané. Format : {"schema":"archivix-status/1","gameDate":"yyyy-MM-dd","club":"Nom"|null}
    // 0.5.3 : la date est aussi écrite par DateLoop, en avance sur l'instantané. Un instantané (live: false) ne la fait
    // donc jamais reculer pour le même club ; un retour en arrière réel (sauvegarde rechargée) passe par DateLoop.
    static string? _statusDate, _statusClub;
    static readonly object StatusLock = new();
    internal static void WriteStatus(string gameDate, string? club) => WriteStatus(gameDate, club, live: true);
    internal static void WriteStatus(string gameDate, string? club, bool live)
    {
        lock (StatusLock)
        {
            if (!live && club != null && club == _statusClub && _statusDate != null && string.CompareOrdinal(gameDate, _statusDate) < 0) return;
            _statusDate = gameDate; _statusClub = club;
        }
        try
        {
            var dir = DataDir;
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(new Dictionary<string, object?> { ["schema"] = "archivix-status/1", ["gameDate"] = gameDate, ["club"] = club });
            WriteAtomic(Path.Combine(dir, "archivix-status.json"), json);
        }
        catch (Exception e) { Log.LogWarning($"archivix-status.json : {e.Message}"); }
    }

    // Écriture atomique : fichier .tmp puis remplacement, pour qu'un lecteur ne voie jamais un JSON à moitié écrit.
    static void WriteAtomic(string path, string content)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    void Serve()
    {
        while (_http is { IsListening: true })
        {
            HttpListenerContext ctx;
            try { ctx = _http.GetContext(); } catch { break; }
            try { Handle(ctx); }
            catch (Exception e) { Log.LogError(e); Write(ctx, 500, "text/plain", e.Message); }
        }
    }

    // Pas d'en-tête CORS : seule la page servie par le plugin lui-même (même origine) peut lire ses réponses.
    void Handle(HttpListenerContext ctx)
    {
        switch (ctx.Request.Url!.AbsolutePath)
        {
            case "/":
                var html = Path.Combine(Path.GetDirectoryName(typeof(Plugin).Assembly.Location)!, "archivix.html");
                Write(ctx, 200, "text/html; charset=utf-8", File.Exists(html) ? File.ReadAllText(html) : "archivix.html introuvable");
                break;
            case "/api/snapshot":
                Snapshot? s; lock (_lock) s = _last;
                if (s == null) Write(ctx, 503, "application/json", "{\"error\":\"Aucun instantané : charge une partie\"}");
                else Write(ctx, 200, "application/json", JsonSerializer.Serialize(s, Json));
                break;
            case "/api/discover":
                var q = ctx.Request.QueryString["q"] ?? "Player";
                Write(ctx, 200, "application/json", JsonSerializer.Serialize(Discover(q), Json));
                break;
            case "/api/probe" or "/api/squad" when TacticsScreen.IsOpen() != false:
                // Sondes refusées tant que l'écran Tactique est ouvert (ou son état inconnu) : risque de figer FM27.
                Write(ctx, 409, "application/json", "{\"error\":\"Écran Tactique ouvert (ou état inconnu) : sonde refusée\"}");
                break;
            case "/api/probe":
                var qs = ctx.Request.QueryString;
                int? item = int.TryParse(qs["item"], out var n) ? n : null;
                Write(ctx, 200, "application/json", JsonSerializer.Serialize(Probe.Path(qs["path"] ?? "game.GameCurrentManagerClubTeam", item, qs["prop"]), Json));
                break;
            case "/api/squad":
                var max = int.TryParse(ctx.Request.QueryString["max"], out var m) ? m : 3;
                Write(ctx, 200, "application/json", JsonSerializer.Serialize(Probe.Squad(max, ctx.Request.QueryString["path"], ctx.Request.QueryString["props"]), Json));
                break;
            case "/api/properties":
                Write(ctx, 200, "application/json", JsonSerializer.Serialize(Probe.Properties(ctx.Request.QueryString["q"] ?? ""), Json));
                break;
            case "/api/refprops":
                Write(ctx, 200, "application/json", JsonSerializer.Serialize(Probe.RefProps(ctx.Request.QueryString["type"] ?? "PersonReference"), Json));
                break;
            default:
                Write(ctx, 404, "text/plain", "Introuvable");
                break;
        }
    }

    static object Discover(string q) =>
        AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(a => { try { return a.GetTypes(); } catch { return Array.Empty<Type>(); } })
            .Where(t => t.Name.Contains(q, StringComparison.OrdinalIgnoreCase))
            .Take(200)
            .Select(t => new
            {
                assembly = t.Assembly.GetName().Name,
                type = t.FullName,
                members = t.GetProperties().Select(p => $"{p.PropertyType.Name} {p.Name}")
                    .Concat(t.GetFields().Select(f => $"{f.FieldType.Name} {f.Name}")).Take(80).ToList()
            }).ToList();

    static void Write(HttpListenerContext ctx, int code, string type, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = type;
        ctx.Response.OutputStream.Write(bytes);
        ctx.Response.Close();
    }
}

public record Snapshot(string Schema, string Game, string Club, string GameDate, List<PlayerDto> Players, TacticDto? Tactic = null)
{
    // Efficacité tactique FM27 (null si non lisible) : overall, components, understandingAreas, complexity, … (voir FmBindingReader.ReadTactic)
    public Dictionary<string, object?>? Effectiveness { get; init; }
    // Données ajoutées par archivix\config\chemins.json (sans recompiler) ; joueurs indexés par rang dans l'effectif
    public Dictionary<string, object?>? Custom { get; init; }
    // Club (finances, direction, formation) et prochain match / calendrier ; null si non lisibles
    public Dictionary<string, object?>? ClubInfo { get; init; }
    public Dictionary<string, object?>? NextMatch { get; init; }
    // Compo (réglage LireCompo) : un élément par index de sélection 0-10 {index, playerId, playerName, position, raw} ; null si non lue
    public List<Dictionary<string, object?>>? Lineup { get; init; }
    // Réglage LireJoueursEtendus : par id de joueur {morale, moraleText, happiness*, hierarchy, currentStars, potentialStars,
    // personality, mediaHandling, currentAbility, potentialAbility} (champs absents si le jeu ne répond pas)
    public Dictionary<string, Dictionary<string, object?>>? PlayersExtended { get; init; }
    // Réglage LireCibles (0.4.0) : joueurs suivis hors du club (mêmes champs que players + club, scout, sources) ;
    // TargetSources : par source, chemin lu, nombre de joueurs, et la forme renvoyée par le jeu si aucun joueur n'est reconnu.
    public List<PlayerDto>? Shortlist { get; init; }
    public Dictionary<string, object?>? TargetSources { get; init; }
    // État de la collecte : blocs lus ou sautés et pourquoi (ex. {"tactique":"sautée : écran Tactique ouvert"})
    public Dictionary<string, string>? Collecte { get; init; }
}

// Ca/Pa : null, le jeu ne les expose pas à l'interface (voir StarRating).
// Wage : montant du contrat dans l'unité affichée par le jeu (voir WageText, ex. "95 € p/m").
// Attributes : fourchette {min,max} ; min == max quand l'attribut est connu précisément.
public record PlayerDto(
    int Id, string Name, int Age, string[] Positions, string? Foot,
    int? Ca, int? Pa, int? Condition, string? Morale,
    string? ContractEnd, long? Wage, long? Value, string? SquadStatus,
    int? Apps, int? Goals, double? AvgRating, string? Injury,
    Dictionary<string, object>? Attributes)   // valeur exacte (int) ou fourchette AttrRange {min,max}
{
    public string? PositionsText { get; init; }   // libellé FR du jeu, ex. "MO (DGC), BT (C)"
    public Dictionary<string, int>? PositionRatings { get; init; }   // familiarité 1-20 par poste, ex. {"D (C)":20,"D (D)":18}
    // Suivi : risque de blessure, hiérarchie, groupe social, satisfaction, promesses, clubs intéressés, statut de transfert…
    public Dictionary<string, object?>? Tracking { get; init; }
    public int? SquadNumber { get; init; }
    public string? Nationality { get; init; }
    public string? BestPosition { get; init; }
    public int? Sharpness { get; init; }
    public string? WageText { get; init; }
    public string? ValueText { get; init; }
    public long? ValueMin { get; init; }
    public int? InjuryReturnDays { get; init; }
    public AttrRange? StarRating { get; init; }   // à remplir : étoiles CA/PA du staff (propriété à confirmer)
    // Cibles du mercato seulement (absents pour l'effectif) : club actuel, avis du recrutement, listes où le joueur figure.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? Club { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Scout { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string[]? Sources { get; init; }
}

public record AttrRange(int Min, int Max);

// Formation : pour l'instant MostUsedFormation de l'équipe ; mentalité, postes et instructions à remplir
// une fois la référence de tactique validée en jeu.
public record TacticDto(string? Formation, string? FormationSource, string? Mentality,
    List<TacticSlotDto> Slots, List<string> TeamInstructions)
{
    // Champs lus sur la référence de tactique (null si le jeu ne répond pas). Les valeurs composées sont brutes (JSON du jeu).
    public string? Name { get; init; }
    public object? FormationIP { get; init; }
    public object? FormationOOP { get; init; }
    public object? MentalityRaw { get; init; }
    public object? Style { get; init; }
    public object? Complexity { get; init; }
    public object? Intensity { get; init; }
    public string? ComplexityLabel { get; init; }
    public string? IntensityLabel { get; init; }
    public string? ActiveSlot { get; init; }
    public string?[]? SlotNames { get; init; }
    public object? InPossessionInstructions { get; init; }
    public object? OutOfPossessionInstructions { get; init; }
    public Dictionary<string, object?>? Recommended { get; init; }
    public List<Dictionary<string, object?>>? Positions { get; init; }
    public object? PositionsCombined { get; init; }   // 11 postes, JSON brut du jeu (poste, rôles avec / sans ballon, joueur…)
}
public record TacticSlotDto(string Position, int? PlayerId, string? Role, string? Duty);

public interface IGameReader { Snapshot Read(); bool LastIncomplete => false; }

class PlaceholderReader : IGameReader
{
    public Snapshot Read() => new("archivix/1", "FM27", "À cartographier", DateTime.Today.ToString("yyyy-MM-dd"), new());
}
