using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using SI.Bindable;
using SI.Core;
using DateTime = System.DateTime;

namespace Archivix;

// Lecteur de l'effectif du club humain via les bindings du jeu (lecture seule).
// Read() bloque le thread appelant : ne jamais l'appeler depuis le thread principal Unity
// (les requêtes y sont exécutées via MainThread et attendues ici).
public class FmBindingReader : IGameReader
{
    const string Team = "game.GameCurrentManagerClubTeam";
    const string Squad = Team + "/Club/Squad";
    const int TimeoutMs = 8000;

    static readonly string[] AttributeNames =
    {
        "Corners", "Crossing", "Dribbling", "Finishing", "FirstTouch", "FreeKicks", "Heading", "LongShots", "LongThrows",
        "Marking", "Passing", "PenaltyTaking", "Tackling", "Technique",
        "Aggression", "Anticipation", "Bravery", "Composure", "Concentration", "Decisions", "Determination", "Flair",
        "Leadership", "Movement", "Positioning", "Teamwork", "Vision", "WorkRate",
        "Acceleration", "Agility", "Balance", "JumpingReach", "NaturalFitness", "Pace", "Stamina", "Strength",
        "AerialReach", "CommandOfArea", "Communication", "Eccentricity", "Handling", "Kicking", "OneOnOnes",
        "Reflexes", "RushingOut", "TendencyToPunch", "Throwing",
    };

    // Propriétés lues pour chaque joueur ("a/b" = propriété b de la valeur a)
    static readonly string[] PlayerProps =
    {
        "UniqueId", "Name", "Age", "SquadNumber", "NationalityText", "PositionCombinedString", "BestPositionShortString",
        "Footedness/PreferredFootString", "Condition", "Sharpness",
        "FullContract/EndDate", "FullContract/Wage/DisplayValue", "FullContract/AgreedPlayingTime/DisplayValue",
        "TransferValueRange/TransferValueRangeString",
        "ClubAppearancesThisSeason", "ClubGoalsThisSeason", "ClubAverageRatingThisSeason",
        "CurrentInjury/IsActive", "CurrentInjury/InjuryDescription", "CurrentInjury/InjuryReturnDays",
        "MoraleString", "Morale",   // moral : pas toujours exposé hors de son écran (null si muet)
    };

    // Familiarité du joueur à chaque poste (1-20), libellé FR du jeu → propriété Ability*
    static readonly (string Fr, string Path)[] PositionAbilities =
    {
        ("GB", "AbilityGoalkeeper"), ("D (C)", "AbilityCentreBack"), ("D (G)", "AbilityLeftBack"), ("D (D)", "AbilityRightBack"),
        ("DL (G)", "AbilityLeftWingBack"), ("DL (D)", "AbilityRightWingBack"), ("MD (C)", "AbilityDefensiveMidfielder"),
        ("M (C)", "AbilityCentreMidfielder"), ("M (G)", "AbilityLeftMidfielder"), ("M (D)", "AbilityRightMidfielder"),
        ("MO (C)", "AbilityAttackingMidfielder"), ("MO (G)", "AbilityLeftWinger"), ("MO (D)", "AbilityRightWinger"), ("BT (C)", "AbilityForward"),
    };

    // Suivi joueur (clé JSON → chemin). Valeurs simples ; null si le jeu ne répond pas.
    static readonly (string Key, string Path)[] PlayerExtras =
    {
        ("injuryRisk", "OverallInjuryRisk"), ("injuryRiskLevel", "InjuryRiskLevel"),
        ("hierarchy", "HierarchyInfluenceCategoryString"), ("happiness", "HierarchyOverallHappinessLevel"),
        ("socialGroup", "SocialGroupString"), ("playingTimeHappiness", "PlayingTimeHappinessLevel"),
        ("activePromises", "ActivePromisesCount"), ("interestedClubs", "ActiveInterestedClubsCount"),
        ("rumouredClubs", "RumouredInterestedClubsCount"), ("transferStatus", "TransferStatusDetails/TransferStatusCategory"),
        ("sharpnessStatus", "SharpnessStatusDescription"), ("worldReputationStars", "PlayerWorldReputationStarRating/MaxValue"),
    };

    // Club : finances, direction, formation (clé JSON → chemin depuis le club, profond = JSON brut)
    static readonly (string Key, string Path, bool Deep)[] ClubFields =
    {
        ("transferBudget", "TransferBudget", false), ("wageBudget", "WageBudget", false),
        ("remainingWageBudget", "RemainingWageBudgetWithText", false), ("currentWageSpending", "CurrentWageSpendingWithText", false),
        ("totalWageCostsThisMonth", "TotalWageCostsThisMonth", false), ("balance", "OverallBalance", false),
        ("projectionBalance", "ProjectionBalance", true), ("transferPolicy", "TransferPolicy", true),
        ("visionThisYear", "VisionObjectiveThisYearObjective", true), ("visionObjectives", "VisionObjectiveList", true),
        ("boardRecruitmentObjectives", "BoardRecruitmentObjectives", true), ("youthIntakeRating", "YouthIntakeRating", false),
        ("daysUntilYouthIntake", "DaysUntilYouthIntake", false), ("youthCandidates", "YouthCandidatesRanked", true),
        ("dofTransferTargets", "DofTransferTargets", true),
    };

    // Prochain match et calendrier (depuis l'équipe)
    static readonly (string Key, string Path, bool Deep)[] MatchFields =
    {
        ("opponent", "NextMatchOpponent/Name", false), ("competition", "NextMatchCompetition/Name", false),
        ("next5Opponent0", "Next5Fixtures/#0/PropertyValue/Name", false), ("next5Opponent1", "Next5Fixtures/#1/PropertyValue/Name", false),
        ("next5Opponent2", "Next5Fixtures/#2/PropertyValue/Name", false), ("next5Opponent3", "Next5Fixtures/#3/PropertyValue/Name", false),
        ("next5Opponent4", "Next5Fixtures/#4/PropertyValue/Name", false),
        ("location", "NextMatchLocationString", false), ("inDays", "NextMatchDaysText", false),
        ("threatLevel", "NextOppositionThreatLevelAssessment", true), ("next5", "Next5Fixtures", true),
        ("recentForm", "RecentFormFixtures", true), ("lastMatchAnalysis", "LastMatchAnalysis", true),
    };

    const string Tactic = "tactic.";
    // Propriété de contexte : sans {human}, le jeu ne répond jamais (decouverte.json, TeamTacticReference).
    const string TE = Tactic + "TacticalEffectiveness{human=@human}";
    static readonly string[] UnderstandingAreas =
        { "BuildUpStrategy", "ChanceCreation", "InPossessionShape", "OutOfPossessionShape", "LineOfEngagement", "PassingStyle", "PressingIntensity", "PressingTrap" };
    static readonly string[] StatusFlags =
    {
        "NoTacticError", "NoUpcomingMatchError", "NoLineupWarning", "IncompleteLineupWarning", "PlayerBelowThresholdWarning",
        "MultiplePlayersBelowThresholdWarning", "PlayerNotFullyScoutedWarning", "PlayerNotInTeamWarning", "PlayerNotSelectedWarning",
    };

    // Les attributs changent peu : relus seulement quand la date de jeu change.
    string? _attrDate;
    readonly Dictionary<long, Dictionary<string, object>> _attrCache = new();

    public static bool GameLoaded() => Batch.Run(new[] { new Req(null, Team) }, 3000)[0] != null;

    // Date de jeu courante (yyyy-MM-dd), ou null si aucune partie n'est chargée.
    // Au menu (aucune partie), le jeu renvoie une date nulle (1900-01-01) : on l'ignore.
    public static string? CurrentDate()
    {
        if (!GameLoaded()) return null;
        var d = DecodeDate(Batch.Run(new[] { new Req(null, "game.CurrentGameDate") }, 3000)[0] as string);
        return d == null || d.StartsWith("1900") ? null : d;
    }

    // 0.6.1 (partie « New One » commencée sans emploi, 11/11/2026) : au début d'une partie sans club, le jeu renvoie
    // quand même une équipe, mais sans nom ni joueurs. Vrai quand le jeu répond sur la date et pas sur le nom : on la
    // traite alors comme « sans club » (archivix-status.json avec club null) au lieu d'attendre un effectif qui ne vient pas.
    public static bool TeamWithoutName()
    {
        var r = Batch.Run(new[] { new Req(null, Team + "/Name"), new Req(null, "game.CurrentGameDate") }, 3000);
        var d = DecodeDate(r[1] as string);
        return d != null && !d.StartsWith("1900") && string.IsNullOrEmpty(CleanName(r[0] as string));
    }

    // Date de jeu et club du manager en une seule requête (0.5.3, DateLoop). (null, null) sans équipe chargée.
    public static (string? Date, string? Club) CurrentDateAndClub()
    {
        var r = Batch.Run(new[] { new Req(null, Team + "/Name"), new Req(null, "game.CurrentGameDate") }, 3000);
        var club = CleanName(r[0] as string);
        var d = DecodeDate(r[1] as string);
        if (string.IsNullOrEmpty(club) || d == null || d.StartsWith("1900")) return (null, null);
        return (d, club);
    }

    // Date de jeu quand aucune équipe n'est chargée (manager sans club, 0.4.2, accord du joueur le 01/11) : seule
    // lecture faite sans équipe. null au menu (1900-01-01) ou sans réponse.
    public static string? DateWithoutTeam()
    {
        var d = DecodeDate(Batch.Run(new[] { new Req(null, "game.CurrentGameDate") }, 3000)[0] as string);
        return d == null || d.StartsWith("1900") ? null : d;
    }

    // --- Match en direct (0.5.0) ---

    // Vrai pendant un match du manager humain (match en direct ou résultat rapide), null si le jeu ne répond pas.
    public static bool? DuringMatch()
    {
        var v = Batch.Run(new[] { new Req(null, "game.IsDuringMatch") }, 3000)[0];
        return v switch
        {
            double d => d != 0,
            string s => s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1",
            _ => null,
        };
    }

    const string LiveFixture = "game.GameCurrentManager/LatestScoresHumanFixtures/#0/";
    static readonly (string Key, string Path, bool Deep)[] LiveFields =
    {
        ("home", "HomeTeam/Name", false), ("away", "AwayTeam/Name", false),
        ("result", "Result", false), ("minute", "LatestScoreTime", false), ("final", "HasFinalResult", false),
        ("scorers", "GoalscorersString", false),
        ("homeEvents", "HomeEventInfos", true), ("awayEvents", "AwayEventInfos", true),
    };

    // Rapport de match (0.5.4). Sonde Carnet du 08/11/2026 : pendant le match, HomeLineup/AwayLineup du match en cours
    // sont vides et le passeur (Player2 des événements longs) n'est pas encore renseigné ; tout cela n'existe que sur
    // GameCurrentManagerClubTeam/LastFixture, qui désigne le match en cours dès les dernières minutes. On le lit donc
    // à la fin : événements longs (buteur, passeur) et feuille de match (joueur, note, événements du joueur, bruts).
    const string LastFixture = "game.GameCurrentManagerClubTeam/LastFixture/";
    const int LineupMax = 20, EventMax = 12;

    // Match du manager humain en cours (chemins validés en jeu le 07/11/2026 avec la sonde Carnet : 15 lectures en
    // 15-20 s sans gêne). Format archivix-live/1 : home, away, homeScore, awayScore, result ("2 - 5"), minute ("19 min.",
    // "FDM" à la fin), final, scorers (texte du jeu), homeEvents/awayEvents [{type: 0 but, 2 penalty, time: "11', 90+1'"}].
    // null si aucun match n'est lisible.
    public static Dictionary<string, object?>? ReadLive()
    {
        var res = Batch.Run(LiveFields.Select(f => new Req(null, LiveFixture + f.Path, f.Deep)).ToArray(), 4000);
        var d = new Dictionary<string, object?>();
        for (int i = 0; i < LiveFields.Length; i++) d[LiveFields[i].Key] = res[i];
        d["home"] = CleanName(d["home"] as string);
        d["away"] = CleanName(d["away"] as string);
        if (d["home"] == null || d["away"] == null) return null;
        var score = Regex.Match(d["result"] as string ?? "", @"^\s*(\d+)\s*-\s*(\d+)");
        d["homeScore"] = score.Success ? int.Parse(score.Groups[1].Value) : null;
        d["awayScore"] = score.Success ? int.Parse(score.Groups[2].Value) : null;
        d["final"] = Flag(d["final"]);
        var home = LiveEvents(d["homeEvents"]);
        var away = LiveEvents(d["awayEvents"]);
        // 0.5.6 : joueur de chaque événement (buteur, expulsé), quand le jeu le donne pendant le match ; null sinon.
        var reqs = new List<Req>();
        foreach (var (side, evs) in new[] { ("Home", home), ("Away", away) })
            for (int j = 0; j < Math.Min(evs.Count, EventMax); j++) reqs.Add(new Req(null, $"{LiveFixture}{side}EventInfos/#{j}/Player/Name"));
        if (reqs.Count > 0)
        {
            var names = Batch.Run(reqs.ToArray(), 4000);
            int at = 0;
            foreach (var evs in new[] { home, away })
                for (int j = 0; j < Math.Min(evs.Count, EventMax); j++) evs[j]["player"] = CleanName(names[at++] as string);
        }
        d["homeEvents"] = home;
        d["awayEvents"] = away;
        return d;
    }

    // Complète le relevé de fin de match avec le rapport du dernier match du club, s'il s'agit bien du même match
    // (mêmes équipes) : homeEvents/awayEvents gagnent player (buteur) et assist (passeur), homeLineup/awayLineup
    // donnent [{name, rating, events}] (events : liste brute du jeu, à cartographier quand on en aura vu). Sans effet si
    // le jeu ne répond pas.
    public static bool AddMatchReport(Dictionary<string, object?> live)
    {
        var head = Batch.Run(new[]
        {
            new Req(null, LastFixture + "HomeTeam/Name"), new Req(null, LastFixture + "AwayTeam/Name"),
            new Req(null, LastFixture + "HomeEventInfosLong", true), new Req(null, LastFixture + "AwayEventInfosLong", true),
        }, 4000);
        if (CleanName(head[0] as string) != live["home"] as string || CleanName(head[1] as string) != live["away"] as string) return false;
        var home = LiveEvents(head[2]);
        var away = LiveEvents(head[3]);
        var reqs = new List<Req>();
        foreach (var (side, evs) in new[] { ("Home", home), ("Away", away) })
            for (int j = 0; j < Math.Min(evs.Count, EventMax); j++)
            {
                reqs.Add(new Req(null, $"{LastFixture}{side}EventInfosLong/#{j}/Player/Name"));
                reqs.Add(new Req(null, $"{LastFixture}{side}EventInfosLong/#{j}/Player2/Name"));
            }
        foreach (var side in new[] { "Home", "Away" })
            for (int i = 0; i < LineupMax; i++)
            {
                reqs.Add(new Req(null, $"{LastFixture}{side}Lineup/#{i}/Player/Name"));
                reqs.Add(new Req(null, $"{LastFixture}{side}Lineup/#{i}/Rating"));
                reqs.Add(new Req(null, $"{LastFixture}{side}Lineup/#{i}/PlayerEvents", true));
            }
        var res = Batch.Run(reqs.ToArray(), 6000);
        int at = 0;
        foreach (var evs in new[] { home, away })
            for (int j = 0; j < Math.Min(evs.Count, EventMax); j++)
            {
                evs[j]["player"] = CleanName(res[at++] as string);
                evs[j]["assist"] = CleanName(res[at++] as string);
            }
        foreach (var key in new[] { "homeLineup", "awayLineup" })
        {
            var players = new List<Dictionary<string, object?>>();
            for (int i = 0; i < LineupMax; i++)
            {
                var name = CleanName(res[at] as string);
                var rating = res[at + 1];
                var events = res[at + 2];
                at += 3;
                if (string.IsNullOrWhiteSpace(name)) continue;
                players.Add(new Dictionary<string, object?> { ["name"] = name, ["rating"] = rating is double r ? Math.Round(r, 1) : null, ["events"] = events });
            }
            live[key] = players;
        }
        if (home.Count > 0) live["homeEvents"] = home;
        if (away.Count > 0) live["awayEvents"] = away;
        return true;
    }

    static bool Flag(object? v) => v switch
    {
        bool b => b,
        double x => x != 0,
        string s => s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1",
        _ => false,
    };

    static int? NumInt(object? v) => v switch
    {
        double x => (int)Math.Round(x),
        string s when int.TryParse(s, out var n) => n,
        _ => null,
    };

    // Garde de chaque événement le type et le temps affiché (le joueur est une référence que l'on ne résout pas).
    static List<Dictionary<string, object?>> LiveEvents(object? raw) =>
        raw is List<object?> l
            ? l.OfType<Dictionary<string, object?>>().Select(e => new Dictionary<string, object?>
            {
                ["type"] = e.GetValueOrDefault("EventType"),
                ["time"] = e.GetValueOrDefault("TimeString"),
                ["slice"] = e.GetValueOrDefault("MatchTimeSlice"),
            }).ToList()
            : new();

    /// <summary>La partie a été quittée ou remplacée pendant une lecture : on abandonne l'instantané.</summary>
    public sealed class GameChanged : Exception { }

    /// <summary>0.6.3 : un match a commencé pendant une lecture complète : on l'abandonne, elle repartira après le match.</summary>
    public sealed class MatchStarted : Exception { }

    // Lecture complète en cours sur ce thread (RefreshLoop) : elle seule s'arrête quand un match commence. Le direct
    // (ReadLive) et les petites questions (date, match en cours ?) passent par Batch.Run sur d'autres threads.
    [ThreadStatic] static bool _fullRead;
    static void StopIfMatch() { if (_fullRead && Plugin.InMatch) throw new MatchStarted(); }

    public Snapshot Read()
    {
        _fullRead = true;
        Plugin.Reading = true;
        try { return ReadAll(); }
        finally { _fullRead = false; Plugin.Reading = false; }
    }

    Snapshot ReadAll()
    {
        // 0.5.9 : durée de la lecture et temps pris au thread du jeu, écrits dans collecte.duree.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        MainThread.TakeStats();
        var head = Batch.Run(new[]
        {
            new Req(null, Team + "/Name"), new Req(null, "game.CurrentGameDate"),
            new Req(null, Team + "/MostUsedFormation"), new Req(null, Squad + "/#count"),
        }, TimeoutMs);
        var club = CleanName(head[0] as string) ?? "";
        var date = DecodeDate(head[1] as string) ?? DateTime.Today.ToString("yyyy-MM-dd");
        int count = head[3] is double c ? (int)c : 0;
        // Entre deux blocs de lecture : la partie est-elle toujours chargée, avec le même club ? Sinon on arrête tout.
        // 0.4.6 : un jour qui passe pendant la lecture (le joueur avance dans le calendrier) ne l'arrête plus. Avant,
        // chaque lecture lancée pendant que le jeu avançait était abandonnée, et FM Immersion n'avait rien de neuf tant que
        // le joueur ne s'arrêtait pas assez longtemps sur un écran (04/11/2026 : aucun instantané de 20h10 à 21h36).
        // L'instantané garde la date de son début ; le suivant relit le nouveau jour.
        void Guard()
        {
            var now = Batch.Run(new[] { new Req(null, Team + "/Name"), new Req(null, "game.CurrentGameDate") }, 3000);
            var d = DecodeDate(now[1] as string);
            if (d == null || d.StartsWith("1900") || (CleanName(now[0] as string) ?? "") != club) throw new GameChanged();
        }
        Guard();

        var reqs = new List<Req>();
        for (int i = 0; i < count; i++)
        {
            foreach (var p in PlayerProps) reqs.Add(new Req(i, p));
            foreach (var (_, p) in PlayerExtras) reqs.Add(new Req(i, p));
            foreach (var (_, p) in PositionAbilities) reqs.Add(new Req(i, p));
        }
        var values = Batch.Run(reqs, TimeoutMs);
        var rows = new Dictionary<string, object?>[count];
        for (int i = 0; i < count; i++) rows[i] = new();
        for (int k = 0; k < reqs.Count; k++) rows[reqs[k].Item!.Value][reqs[k].Path] = values[k];

        Guard();
        if (_attrDate != date && ReadAttributes(count, rows)) _attrDate = date;

        var players = rows.Select(r => ToPlayer(r)).Where(p => p != null).Cast<PlayerDto>().ToList();
        TacticDto? tactic = null; Dictionary<string, object?>? effectiveness = null;
        List<Dictionary<string, object?>>? lineup = null;
        var collecte = new Dictionary<string, string>();
        // Toute lecture liée à la tactique attend que l'écran Tactique soit fermé (null = état inconnu : on s'abstient aussi).
        var screen = TacticsScreen.IsOpen();
        _tacticsAllowed = screen == false;
        string why = screen == true ? "sautée : écran Tactique ouvert" : "sautée : état de l'écran Tactique inconnu";
        void Block(string key, bool enabled, Action read)
        {
            if (!enabled) { collecte[key] = "désactivée (réglage)"; return; }
            if (!_tacticsAllowed) { collecte[key] = why; return; }
            try { read(); collecte[key] = "lue"; }
            catch (Exception e) { collecte[key] = "erreur : " + e.Message; Plugin.Log.LogWarning($"{key} : {e.Message}"); }
        }
        Guard();
        Block("tactique", Plugin.ReadTactic, () => tactic = ReadTactic(head[2] as string));
        Block("efficacite", Plugin.ReadEffectiveness, () => effectiveness = ReadEffectiveness());
        Block("compo", Plugin.ReadLineup, () => lineup = ReadLineup());

        Guard();
        // Moral, satisfaction, hiérarchie, étoiles du staff : lectures de contexte par joueur (sans lien avec la tactique).
        Dictionary<string, Dictionary<string, object?>>? extended = null;
        if (!Plugin.ReadExtended) collecte["joueursEtendus"] = "désactivée (réglage)";
        else
            try { extended = ReadExtended(count); collecte["joueursEtendus"] = extended == null ? "pas de réponse" : "lue"; }
            catch (Exception e) { collecte["joueursEtendus"] = "erreur : " + e.Message; Plugin.Log.LogWarning($"joueursEtendus : {e.Message}"); }
        tactic ??= new TacticDto(head[2] as string, "MostUsedFormation", null, new(), new());

        Guard();
        // Cibles du mercato (liste de suivi, cibles du recrutement) : sans lien avec la tactique, relues à chaque nouveau jour.
        if (!Plugin.ReadTargets) collecte["cibles"] = "désactivée (réglage)";
        else if (_targetsDate == date && _targets != null && TargetCounts() == _targetCounts) collecte["cibles"] = "lue (même jour, listes inchangées)";
        else
            try
            {
                var (read, sources) = ReadTargets();
                // La recherche « Sélections » du jeu n'est remplie que pendant que son écran est affiché : ailleurs, elle
                // revient vide. Une liste vide après une liste non vide garde donc la dernière lue (vérifié le 01/11).
                if (read.Count == 0 && _targets is { Count: > 0 })
                    collecte["cibles"] = $"gardée : {_targets.Count} joueur(s) (liste vide, écran Sélections sans doute fermé)";
                else
                {
                    _targets = read;
                    collecte["cibles"] = $"lue : {read.Count} joueur(s)";
                }
                _targetSources = sources;
                _targetsDate = date;
                _targetCounts = TargetCounts();
            }
            catch (Exception e) { collecte["cibles"] = "erreur : " + e.Message; Plugin.Log.LogWarning($"cibles : {e.Message}"); }

        Guard();
        // Club et prochain match : blocs optionnels
        Dictionary<string, object?>? clubInfo = null, nextMatch = null;
        try
        {
            var extra = ClubFields.Select(f => new Req(null, $"{Team}/Club/{f.Path}", f.Deep))
                .Concat(MatchFields.Select(f => new Req(null, $"{Team}/{f.Path}", f.Deep))).ToList();
            var ev = Batch.Run(extra, TimeoutMs);
            object? Clean(object? x) => x is string s ? CleanName(s) : x;
            clubInfo = ClubFields.Select((f, i) => (f.Key, V: Clean(ev[i]))).Where(x => x.V != null).ToDictionary(x => x.Key, x => x.V);
            nextMatch = MatchFields.Select((f, i) => (f.Key, V: Clean(ev[ClubFields.Length + i]))).Where(x => x.V != null).ToDictionary(x => x.Key, x => x.V);
        }
        catch (Exception e) { Plugin.Log.LogWarning($"Club / prochain match illisibles : {e.Message}"); }

        Guard();
        // Données supplémentaires définies dans archivix\config\chemins.json (relu à chaque instantané, sans recompiler)
        Dictionary<string, object?>? custom = null;
        Batch.TakeStats();
        try { custom = ReadCustom(count); }
        catch (Exception e) { Plugin.Log.LogWarning($"chemins.json : {e.Message}"); }
        // 0.5.7 : une lecture où le jeu n'a répondu ni sur les joueurs ni sur la tactique est marquée incomplète ;
        // Plugin.RefreshLoop la refait une minute plus tard et ne remplace pas une lecture complète du même jour.
        var (late, recovered) = Batch.TakeStats();
        LastIncomplete = false;
        if (custom != null)
        {
            var (answered, total, incomplete) = CustomHealth(custom);
            LastIncomplete = incomplete;
            collecte["chemins"] = $"{(incomplete ? "incomplète" : "lue")} : {answered}/{total} valeurs"
                + (late > 0 ? $", {late} sans réponse au premier envoi dont {recovered} récupérées par paquets" : "");
            if (incomplete || late > 0) Plugin.Log.LogWarning($"chemins.json {collecte["chemins"]}");
        }

        var (busyMs, worstMs) = MainThread.TakeStats();
        collecte["duree"] = string.Format(CultureInfo.InvariantCulture, "{0:0} s ; thread du jeu : {1:0} ms au total, {2:0.0} ms au plus par image",
            clock.Elapsed.TotalSeconds, busyMs, worstMs);
        Plugin.Log.LogInfo($"Lecture du {date} : {collecte["duree"]}");

        return new Snapshot("archivix/1", "FM27", club, date, players, tactic)
        {
            Custom = custom,
            Effectiveness = effectiveness,
            ClubInfo = clubInfo is { Count: > 0 } ? clubInfo : null,
            NextMatch = nextMatch is { Count: > 0 } ? nextMatch : null,
            Lineup = lineup,
            PlayersExtended = extended,
            Shortlist = Plugin.ReadTargets ? _targets : null,
            TargetSources = Plugin.ReadTargets ? _targetSources : null,
            Collecte = collecte,
        };
    }

    // --- Cibles du mercato (réglage LireCibles) : joueurs d'autres clubs suivis par le joueur ---
    // Sources par défaut (propriétés trouvées dans decouverte.json, sans requête au jeu). Remplaçables sans recompiler
    // par la section "cibles" de chemins.json : { "nom": "chemin depuis game." }. Chaque source peut renvoyer une liste
    // de joueurs, une liste de Records qui contiennent un joueur, ou un Record qui contient la liste (voir Batch.Persons).
    static readonly (string Key, string Path)[] DefaultTargetSources =
    {
        // Joueurs de la sélection affichée (Recrutement > Sélections) : HumanShortlistSearchType{IsPlayerRecruitment=true}
        // vaut 0, et la liste n'est remplie que pendant que l'écran est ouvert (test en jeu du 01/11/2026).
        // HumanSelectedShortlist et HumanShortlists ne donnent que la fiche de la sélection (nom, « 2 joueurs »).
        ("selection", "GameCurrentManager/HumanPersonSearch{team=@team,Type=0}/PersonList"),
        ("cibles", "GameCurrentManagerClubTeam/Club/PlayerTargetsList{human=@human}"),
    };

    // Propriétés lues pour chaque cible ; celles du recrutement sont « de contexte » (staff du club humain).
    static readonly string[] TargetProps =
    {
        "UniqueId", "Name", "Age", "NationalityText", "PositionCombinedString", "BestPositionShortString",
        "Footedness/PreferredFootString", "FullContract/EndDate", "FullContract/Wage/DisplayValue",
        "TransferValueRange/TransferValueRangeString", "ClubAppearancesThisSeason", "ClubGoalsThisSeason", "ClubAverageRatingThisSeason",
        "CurrentInjury/IsActive", "CurrentInjury/InjuryDescription", "CurrentInjury/InjuryReturnDays", "Club/Name",
    };

    static readonly (string Key, string Path, bool Deep)[] ScoutFields =
    {
        ("currentStars", "CurrentAbilityStarRange{team=@team,human=@human}", true),
        ("potentialStars", "PotentialAbilityStarRange{team=@team,human=@human}", true),
        ("scoutCurrentStars", "ScoutCurrentAbilityStarRange{team=@team,human=@human}", true),
        ("scoutPotentialStars", "ScoutPotentialAbilityStarRange{team=@team,human=@human}", true),
        // Connaissance et salaires : SI.Bindable.DynamicReference, une fiche (Record) à lire en profond
        // (connaissance : ActualValue/MaxValue sur 5 + Text ; salaires : SortValue + DisplayValue « 3,22K € p/m »).
        ("knowledge", "ScoutingKnowledgeLevel{human=@human,team=@team}", true),
        ("recommendation", "ScoutRecommendationGrade{human=@human,team=@team}", false),
        ("recommendationText", "ShortScoutRecommendation{human=@human}", false),
        ("bestPosition", "ScoutedBestPosition{human=@human,team=@team}", false),
        ("bestRole", "ScoutedBestRole{human=@human,team=@team}", false),
        ("bestRoleOop", "ScoutedBestRoleOop{human=@human,team=@team}", false),
        ("minValue", "ScoutedMinValue{human=@human,team=@team}", false),
        ("maxValue", "ScoutedMaxValue{human=@human,team=@team}", false),
        ("minWage", "ScoutedMinWage{human=@human,team=@team}", true),
        ("maxWage", "ScoutedMaxWage{human=@human,team=@team}", true),
        ("interestedClubs", "ActiveInterestedClubsCount{human=@human}", false),
        ("transferStatus", "TransferStatusDetails/TransferStatusCategory", false),
        ("personality", "Personality", false),
        ("daysLeftOnShortlist", "DaysLeftOnShortlist", false),
        ("worldReputationStars", "PlayerWorldReputationStarRating/MaxValue", false),
    };

    // Les cibles bougent peu : relues seulement quand la date de jeu change, par paquets de joueurs pour ménager le jeu.
    const int TargetChunk = 10, MaxTargets = 40;
    string? _targetsDate;
    // Nombre de joueurs de chaque source à la dernière lecture : un ajout ou un retrait dans une liste du jeu
    // déclenche une relecture sans attendre le jour suivant (une requête par source à chaque instantané).
    string? _targetCounts;

    string TargetCounts()
    {
        var sources = TargetSources();
        var v = Batch.Run(sources.Select(x => new Req(null, "#count", false, "game." + x.Path)).ToList(), TimeoutMs);
        return string.Join(",", v.Select(x => Num(x) is double n ? ((int)n).ToString(CultureInfo.InvariantCulture) : "?"));
    }
    List<PlayerDto>? _targets;
    Dictionary<string, object?>? _targetSources;

    (string Key, string Path)[] TargetSources()
    {
        try
        {
            if (System.IO.File.Exists(CustomFile))
            {
                using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(CustomFile));
                if (doc.RootElement.TryGetProperty("cibles", out var c) && c.ValueKind == System.Text.Json.JsonValueKind.Object)
                {
                    var list = c.EnumerateObject().Where(p => p.Value.ValueKind == System.Text.Json.JsonValueKind.String && !p.Name.StartsWith('_'))
                        .Select(p => (p.Name, p.Value.GetString()!)).ToArray();
                    if (list.Length > 0) return list;
                }
            }
        }
        catch (Exception e) { Plugin.Log.LogWarning($"chemins.json (cibles) : {e.Message}"); }
        return DefaultTargetSources;
    }

    // Lit les joueurs de chaque source : mêmes données que l'effectif (attributs en fourchette selon la connaissance
    // du recrutement) + avis du recrutement. Une cible présente dans plusieurs sources n'est lue qu'une fois.
    (List<PlayerDto> Targets, Dictionary<string, object?> Sources) ReadTargets()
    {
        var byId = new Dictionary<int, PlayerDto>();
        var sources = new Dictionary<string, object?>();
        foreach (var (key, rel) in TargetSources())
        {
            var path = "game." + rel;
            var info = new Dictionary<string, object?> { ["chemin"] = rel };
            sources[key] = info;
            try
            {
                int count = Num(Batch.Run(new[] { new Req(null, "#count", false, path) }, TimeoutMs)[0]) is double n ? (int)n : 0;
                info["joueurs"] = count;
                if (count == 0)
                {
                    // Rien de reconnu : on décrit ce que le jeu renvoie, pour ajuster le chemin dans chemins.json.
                    try { info["forme"] = Batch.Describe(path, TimeoutMs); } catch (Exception e) { info["forme"] = "erreur : " + e.Message; }
                    continue;
                }
                for (int start = 0; start < count && byId.Count < MaxTargets; start += TargetChunk)
                {
                    int end = Math.Min(count, start + TargetChunk);
                    var reqs = new List<Req>();
                    for (int i = start; i < end; i++)
                    {
                        foreach (var p in TargetProps) reqs.Add(new Req(i, p, false, path));
                        foreach (var (_, p) in PositionAbilities) reqs.Add(new Req(i, p, false, path));
                        foreach (var f in ScoutFields) reqs.Add(new Req(i, f.Path, f.Deep, path));
                        foreach (var a in AttributeNames)
                        {
                            reqs.Add(new Req(i, $"Attribute{a}/AttributeMinValue", false, path));
                            reqs.Add(new Req(i, $"Attribute{a}/AttributeMaxValue", false, path));
                        }
                    }
                    var v = Batch.Run(reqs, TimeoutMs * 2);
                    var rows = new Dictionary<int, Dictionary<string, object?>>();
                    for (int k = 0; k < reqs.Count; k++)
                    {
                        int i = reqs[k].Item!.Value;
                        if (!rows.TryGetValue(i, out var row)) rows[i] = row = new Dictionary<string, object?>();
                        row[reqs[k].Path] = v[k];
                    }
                    foreach (var (i, row) in rows)
                    {
                        if (Num(row.GetValueOrDefault("UniqueId")) is not double id) continue;
                        if (byId.TryGetValue((int)id, out var known))
                        {
                            byId[(int)id] = known with { Sources = known.Sources!.Append(key).ToArray() };
                            continue;
                        }
                        var at = new Dictionary<string, object>();
                        foreach (var a in AttributeNames)
                            if (Num(row.GetValueOrDefault($"Attribute{a}/AttributeMinValue")) is double min && min > 0
                                && Num(row.GetValueOrDefault($"Attribute{a}/AttributeMaxValue")) is double max)
                                at[a] = min == max ? (int)min : new AttrRange((int)min, (int)max);
                        var sc = ScoutFields.Select(f => (f.Key, V: row.GetValueOrDefault(f.Path) is string s ? (object?)(Num(s) ?? (object)CleanName(s)!) : row.GetValueOrDefault(f.Path)))
                            .Where(x => x.V != null).ToDictionary(x => x.Key, x => x.V);
                        var basic = ToPlayer(row, at.Count > 0 ? at : null);
                        if (basic == null) continue;
                        byId[(int)id] = basic with
                        {
                            Club = CleanName(row.GetValueOrDefault("Club/Name") as string),
                            Scout = sc.Count > 0 ? sc : null,
                            Sources = new[] { key },
                        };
                        if (byId.Count >= MaxTargets) break;
                    }
                }
            }
            catch (Exception e) { info["erreur"] = e.Message; Plugin.Log.LogWarning($"cibles ({key}) : {e.Message}"); }
        }
        return (byId.Values.ToList(), sources);
    }

    bool _tacticsAllowed;
    const int SelectionSlots = 11;

    // Compo : pour chaque index de sélection (0-10), joueur, poste et rôles (y compris le rôle personnalisé).
    // Propriétés « de contexte » de TeamTacticReference, d'après decouverte.json :
    //   PlayerFromTeamSelectionIndex, IPRole, OOPRole, PositionRoleOverride {TeamSelectionIndex} ;
    //   PositionFromTeamSelectionIndex, PlayerUsesPersonalisedInstructions {TeamSelectionIndex, InPossession}.
    static readonly (string Key, string Path, bool Deep)[] LineupFields =
    {
        ("playerId", "PlayerFromTeamSelectionIndex{TeamSelectionIndex=#}/UniqueId", false),
        ("playerName", "PlayerFromTeamSelectionIndex{TeamSelectionIndex=#}/Name", false),
        ("positionIP", "PositionFromTeamSelectionIndex{TeamSelectionIndex=#,InPossession=true}", false),
        ("positionOOP", "PositionFromTeamSelectionIndex{TeamSelectionIndex=#,InPossession=false}", false),
        ("ipRole", "IPRole{TeamSelectionIndex=#}", false),
        ("oopRole", "OOPRole{TeamSelectionIndex=#}", false),
        ("roleOverride", "PositionRoleOverride{TeamSelectionIndex=#}", true),
        ("personalisedIP", "PlayerUsesPersonalisedInstructions{TeamSelectionIndex=#,InPossession=true}", false),
        ("personalisedOOP", "PlayerUsesPersonalisedInstructions{TeamSelectionIndex=#,InPossession=false}", false),
    };

    // Par joueur de l'effectif (propriétés de PersonReference, contextes d'après decouverte.json).
    static readonly (string Key, string Path, bool Deep)[] ExtendedFields =
    {
        ("morale", "Morale{team=@team,human=@human}", false),
        ("moraleText", "MoraleString{team=@team,human=@human}", false),
        ("happinessClub", "HappinessClub{human=@human,team=@team}", false),
        ("happinessManagement", "HappinessManagement{human=@human,team=@team}", false),
        ("happinessPlayingTime", "HappinessPlayingTime{human=@human,team=@team}", false),
        ("happinessTraining", "HappinessTraining{human=@human,team=@team}", false),
        ("hierarchy", "HierarchyInfluenceCategoryString{team=@team}", false),
        ("currentStars", "CurrentAbilityStarRange{team=@team,human=@human}", true),
        ("potentialStars", "PotentialAbilityStarRange{team=@team,human=@human}", true),
        ("personality", "Personality", false),
        ("mediaHandling", "MediaHandling{human=@human}", false),
        ("currentAbility", "PlayerCurrentAbility", false),
        ("potentialAbility", "PlayerPotentialAbility", false),
    };

    Dictionary<string, Dictionary<string, object?>>? ReadExtended(int count)
    {
        var reqs = new List<Req>();
        for (int i = 0; i < count; i++)
        {
            reqs.Add(new Req(i, "UniqueId"));
            foreach (var f in ExtendedFields) reqs.Add(new Req(i, f.Path, f.Deep));
        }
        var v = Batch.Run(reqs, TimeoutMs * 2);
        int stride = ExtendedFields.Length + 1;
        var res = new Dictionary<string, Dictionary<string, object?>>();
        for (int i = 0; i < count; i++)
        {
            if (Num(v[i * stride]) is not double id) continue;
            var row = new Dictionary<string, object?>();
            for (int f = 0; f < ExtendedFields.Length; f++)
            {
                var x = v[i * stride + 1 + f];
                if (x != null) row[ExtendedFields[f].Key] = x is string s ? CleanName(s) : x;
            }
            if (row.Count > 0) res[((long)id).ToString(CultureInfo.InvariantCulture)] = row;
        }
        return res.Count > 0 ? res : null;
    }

    List<Dictionary<string, object?>>? ReadLineup()
    {
        var reqs = new List<Req>();
        for (int i = 0; i < SelectionSlots; i++)
            foreach (var f in LineupFields)
                reqs.Add(new Req(null, Tactic + f.Path.Replace("#", i.ToString(CultureInfo.InvariantCulture)), f.Deep));
        var v = Batch.Run(reqs, TimeoutMs);
        if (v.All(x => x == null)) return null;
        var res = new List<Dictionary<string, object?>>();
        for (int i = 0; i < SelectionSlots; i++)
        {
            var row = new Dictionary<string, object?> { ["index"] = i };
            for (int f = 0; f < LineupFields.Length; f++)
            {
                var x = v[i * LineupFields.Length + f];
                row[LineupFields[f].Key] = LineupFields[f].Key == "playerId" ? (Num(x) is double d ? (long)d : null)
                    : x is string s ? CleanName(s) : x;
            }
            res.Add(row);
        }
        return res;
    }

    // 0.6.4 : relecture légère de la compo (SelectionLoop). `ProbeSelection` : les 11 lignes de la compo et le nom de la
    // tactique active, pour voir si quelque chose a changé ; `ReadSelection` : la tactique entière en plus, seulement
    // quand c'est le cas. Rien n'est lu tant que l'écran Tactique est ouvert ou dans un état inconnu (même règle que
    // la lecture complète) : null.
    public (string? Name, List<Dictionary<string, object?>>? Lineup)? ProbeSelection()
    {
        if (TacticsScreen.IsOpen() != false) return null;
        var lineup = Plugin.ReadLineup ? ReadLineup() : null;
        var v = Batch.Run(new[] { new Req(null, Tactic + "Name"), new Req(null, Tactic + "CurrentTacticSlotName") }, 3000);
        var name = CleanName(v[0] as string) ?? CleanName(v[1] as string);
        return (name, lineup);
    }

    public TacticDto? ReadSelectionTactic(string? mostUsed) => Plugin.ReadTactic && TacticsScreen.IsOpen() == false ? ReadTactic(mostUsed) : null;

    // --- Tactique active et efficacité tactique (blocs optionnels : null si le jeu ne répond pas) ---

    TacticDto ReadTactic(string? mostUsed)
    {
        var reqs = new List<Req>();
        int Add(string path, bool deep = false) { reqs.Add(new Req(null, path, deep)); return reqs.Count - 1; }

        int name = Add(Tactic + "Name"), fName = Add(Tactic + "FormationName"), fIP = Add(Tactic + "TacticCreatorIPFormation", true),
            fOOP = Add(Tactic + "TacticCreatorOOPFormation", true), ment = Add(Tactic + "MentalityString"), mentRaw = Add(Tactic + "Mentality"),
            style = Add(Tactic + "TacticalStyle", true), cx = Add(Tactic + "TacticComplexity", true), it = Add(Tactic + "TacticalIntensity", true),
            cxS = Add(Tactic + "TacticalStyleComplexityString"), itS = Add(Tactic + "TacticalStyleIntensityString"),
            slotName = Add(Tactic + "CurrentTacticSlotName"), s1 = Add(Tactic + "TacticSlot1Name"), s2 = Add(Tactic + "TacticSlot2Name"), s3 = Add(Tactic + "TacticSlot3Name"),
            ip = Add(Tactic + "InPossessionInstructionList", true), oop = Add(Tactic + "OutOfPossessionInstructionList", true),
            rec = Add(Tactic + "RecommendedFormations", true), recIP = Add(Tactic + "RecommendedIPFormations", true), recOOP = Add(Tactic + "RecommendedOOPFormations", true),
            // Les 11 postes (avec et sans ballon combinés) : liste de Records, convertie telle quelle
            combined = Add(Tactic + "TacticalPositionsCombined", true);
        // (TacticalPositions/#i n'a jamais répondu en jeu : 154 lectures en délai dépassé à chaque instantané, retirées en 0.2.1.)

        var v = Batch.Run(reqs, TimeoutMs);
        string? S(int k) => v[k] as string is { } s ? CleanName(s) : null;

        return new TacticDto(S(fName) ?? mostUsed, S(fName) != null ? "Tactic" : "MostUsedFormation", S(ment), new(), new())
        {
            Name = S(name), FormationIP = v[fIP], FormationOOP = v[fOOP], MentalityRaw = v[mentRaw], Style = v[style],
            Complexity = v[cx], Intensity = v[it], ComplexityLabel = S(cxS), IntensityLabel = S(itS),
            ActiveSlot = S(slotName), SlotNames = new[] { S(s1), S(s2), S(s3) },
            InPossessionInstructions = v[ip], OutOfPossessionInstructions = v[oop],
            Recommended = new Dictionary<string, object?> { ["all"] = v[rec], ["inPossession"] = v[recIP], ["outOfPossession"] = v[recOOP] },
            PositionsCombined = v[combined],
        };
    }

    // Efficacité tactique (réglage LireEfficacite) : répond depuis 0.5.5, lue sur la tactique renvoyée par l'équipe.
    Dictionary<string, object?>? ReadEffectiveness()
    {
        var reqs = new List<Req>();
        int Add(string path, bool deep = false) { reqs.Add(new Req(null, path, deep)); return reqs.Count - 1; }

        // Efficacité : note globale, 4 composantes, zones de compréhension, sous-scores, alertes, conseils
        (int, int) Range(string p) => (Add(p + "/MinValue"), Add(p + "/MaxValue"));
        var overall = Range(TE + "/OverallEffectiveness");
        var comps = new[] { "TacticalUnderstanding", "PlayerAbility", "PlayerBuyIn", "NextMatchInformation" }
            .ToDictionary(c => c, c => Range($"{TE}/{c}/OverallEffectiveness"));
        var areas = UnderstandingAreas.ToDictionary(a => a, a => (Range($"{TE}/TacticalUnderstanding/{a}/OverallEffectiveness"), Range($"{TE}/TacticalUnderstanding/{a}")));
        var complexity = Range($"{TE}/TacticalUnderstanding/TacticalComplexity/OverallEffectiveness");
        var cxParts = new[] { "TeamInstructionComplexity", "PlayerInstructionComplexity", "OppositionInstructionComplexity" }
            .ToDictionary(c => c, c => Add($"{TE}/TacticalUnderstanding/TacticalComplexity/{c}", true));
        var comprehension = Range($"{TE}/TacticalUnderstanding/TacticalComprehension/OverallEffectiveness");
        var subs = new Dictionary<string, (int, int)>
        {
            ["capability"] = Range($"{TE}/PlayerAbility/CapabilityScore"),
            ["roleSuitability"] = Range($"{TE}/PlayerAbility/RoleSuitabilityScore"),
            ["managerSupport"] = Range($"{TE}/PlayerBuyIn/ManagerSupportScore"),
            ["relationships"] = Range($"{TE}/PlayerBuyIn/TeammateAndStaffRelationshipsScore"),
        };
        var flags = StatusFlags.ToDictionary(f => f, f => Add($"{TE}/StatusFlags/{f}"));
        int tePlayers = Add(TE + "/Players", true), advAreas = Add(TE + "/TacticalUnderstanding/AdviceForTacticalAreas", true),
            advAbility = Add(TE + "/PlayerAbility/AdviceForComponent", true), advBuyIn = Add(TE + "/PlayerBuyIn/AdviceForComponent", true),
            advNext = Add(TE + "/NextMatchInformation/AdviceForComponent", true);

        var v = Batch.Run(reqs, TimeoutMs);
        object? R((int min, int max) r) => Num(v[r.min]) is double a && Num(v[r.max]) is double b ? new Dictionary<string, object?> { ["min"] = a, ["max"] = b } : null;
        bool? B(int k) => v[k] is string s ? string.Equals(s, "True", StringComparison.OrdinalIgnoreCase) : null;

        var eff = new Dictionary<string, object?>
        {
            ["overall"] = R(overall),
            ["components"] = comps.ToDictionary(c => Camel(c.Key), c => R(c.Value)),
            ["understandingAreas"] = areas.ToDictionary(a => Camel(a.Key), a => R(a.Value.Item1) ?? R(a.Value.Item2)),
            ["complexity"] = R(complexity),
            ["complexityParts"] = cxParts.ToDictionary(c => Camel(c.Key), c => v[c.Value]),
            ["comprehension"] = R(comprehension),
            ["subScores"] = subs.ToDictionary(s => s.Key, s => R(s.Value)),
            ["statusFlags"] = flags.ToDictionary(f => Camel(f.Key), f => (object?)B(f.Value)),
            ["players"] = v[tePlayers],
            ["advice"] = new Dictionary<string, object?> { ["tacticalAreas"] = v[advAreas], ["playerAbility"] = v[advAbility], ["playerBuyIn"] = v[advBuyIn], ["nextMatch"] = v[advNext] },
        };
        bool anyEff = eff["overall"] != null || ((Dictionary<string, object?>)eff["components"]!).Values.Any(x => x != null);
        return anyEff ? eff : null;
    }

    static string Camel(string s) => char.ToLowerInvariant(s[0]) + s[1..];

    // --- Chemins configurables (mise à jour sans recompiler) ---
    // archivix\config\chemins.json : { "partie": {"clé":"chemin"}, "equipe": {…}, "club": {…}, "tactique": {…}, "joueur": {…}, "profond": ["clé", …] }
    // Racines : partie = game., equipe = équipe du club humain, club = son club, tactique = tactic., joueur = chaque joueur de l'effectif.
    // "profond" : clés dont la valeur composée (liste, objet) est convertie en JSON. Fichier absent = rien de plus.
    static string CustomFile => System.IO.Path.Combine(Plugin.DataDir, "config", "chemins.json");

    /// <summary>Dernière lecture : au moins un joueur sans aucune valeur, ou aucune consigne de la tactique (chemins.json).</summary>
    public bool LastIncomplete { get; private set; }

    // Valeurs obtenues sur demandées dans le bloc custom, et lecture incomplète : un joueur sans aucune valeur
    // (hors identifiant), ou une section « tactique » demandée et entièrement vide.
    static (int Answered, int Total, bool Incomplete) CustomHealth(Dictionary<string, object?> custom)
    {
        int answered = 0, total = 0; bool incomplete = false;
        foreach (var (section, value) in custom)
        {
            if (value is Dictionary<string, Dictionary<string, object?>> players)
            {
                // 0.5.8 : un seul joueur sans aucune valeur suffit (10/11/2026 : un paquet entier de 300 requêtes resté sans
                // réponse pendant un match, trois ou quatre joueurs sans stats dans un instantané marqué « lue »).
                int got = 0, asked = 0;
                foreach (var row in players.Values)
                {
                    int rowGot = 0, rowAsked = 0;
                    foreach (var (k, v) in row) { if (k == "id") continue; rowAsked++; if (v != null) rowGot++; }
                    got += rowGot; asked += rowAsked;
                    if (rowAsked > 0 && rowGot == 0) incomplete = true;
                }
                answered += got; total += asked;
            }
            else if (value is Dictionary<string, object?> sec)
            {
                int got = sec.Values.Count(v => v != null);
                answered += got; total += sec.Count;
                if (section == "tactique" && sec.Count >= 10 && got == 0) incomplete = true;
            }
        }
        return (answered, total, incomplete);
    }

    Dictionary<string, object?>? ReadCustom(int squadCount)
    {
        if (!System.IO.File.Exists(CustomFile)) return null;
        using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(CustomFile));
        var root = doc.RootElement;
        var deep = root.TryGetProperty("profond", out var d) ? d.EnumerateArray().Select(x => x.GetString()).ToHashSet() : new HashSet<string?>();
        Dictionary<string, string> Section(string name) => root.TryGetProperty(name, out var s) && s.ValueKind == System.Text.Json.JsonValueKind.Object
            ? s.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "") : new();
        var prefixes = new Dictionary<string, string> { ["partie"] = "game.", ["equipe"] = Team + "/", ["club"] = Team + "/Club/", ["tactique"] = Tactic };

        var reqs = new List<Req>(); var keys = new List<(string Section, string Key, int? Item)>();
        foreach (var (section, prefix) in prefixes)
            foreach (var (key, path) in section == "tactique" && !_tacticsAllowed ? new() : Section(section))
            {
                // 0.5.5 : un chemin d'une autre section qui passe par une tactique (« Tactic{…} ») suit la même prudence.
                if (!_tacticsAllowed && path.Contains("Tactic{", StringComparison.Ordinal)) continue;
                reqs.Add(new Req(null, prefix + path, deep.Contains(key))); keys.Add((section, key, null));
            }
        var perPlayer = Section("joueur");
        if (perPlayer.Count > 0) perPlayer.TryAdd("id", "UniqueId");   // pour relier chaque ligne au joueur (players[].id)
        for (int i = 0; i < squadCount; i++)
            foreach (var (key, path) in perPlayer) { reqs.Add(new Req(i, path, deep.Contains(key))); keys.Add(("joueur", key, i)); }
        if (reqs.Count == 0) return null;

        var v = Batch.Run(reqs, TimeoutMs);
        var result = new Dictionary<string, object?>();
        object? Clean(object? x) => x is string s ? CleanName(s) : x;
        for (int k = 0; k < keys.Count; k++)
        {
            var (section, key, item) = keys[k];
            if (item == null)
            {
                if (!result.TryGetValue(section, out var sec)) result[section] = sec = new Dictionary<string, object?>();
                ((Dictionary<string, object?>)sec!)[key] = Clean(v[k]);
            }
            else
            {
                if (!result.TryGetValue("joueurs", out var list)) result["joueurs"] = list = new Dictionary<string, Dictionary<string, object?>>();
                var byItem = (Dictionary<string, Dictionary<string, object?>>)list!;
                if (!byItem.TryGetValue(item.Value.ToString(), out var row)) byItem[item.Value.ToString()] = row = new();
                row[key] = Clean(v[k]);
            }
        }
        return result;
    }

    bool ReadAttributes(int count, Dictionary<string, object?>[] rows)
    {
        var reqs = new List<Req>();
        for (int i = 0; i < count; i++)
            foreach (var a in AttributeNames)
            {
                reqs.Add(new Req(i, $"Attribute{a}/AttributeMinValue"));
                reqs.Add(new Req(i, $"Attribute{a}/AttributeMaxValue"));
            }
        var values = Batch.Run(reqs, TimeoutMs * 2);
        if (values.All(v => v == null)) return false;

        _attrCache.Clear();
        for (int i = 0; i < count; i++)
        {
            if (Num(rows[i].GetValueOrDefault("UniqueId")) is not double id) continue;
            var attrs = new Dictionary<string, object>();
            for (int a = 0; a < AttributeNames.Length; a++)
            {
                int k = (i * AttributeNames.Length + a) * 2;
                // 0 = attribut non applicable au joueur (ex. attributs de gardien pour un joueur de champ)
                if (Num(values[k]) is double min && min > 0 && Num(values[k + 1]) is double max)
                    // Valeur exacte si le staff la connaît, sinon fourchette {min,max}
                    attrs[AttributeNames[a]] = min == max ? (int)min : new AttrRange((int)min, (int)max);
            }
            _attrCache[(long)id] = attrs;
        }
        return _attrCache.Count > 0;
    }

    PlayerDto? ToPlayer(Dictionary<string, object?> r) => ToPlayer(r, Num(r.GetValueOrDefault("UniqueId")) is double id ? _attrCache.GetValueOrDefault((long)id) : null);

    PlayerDto? ToPlayer(Dictionary<string, object?> r, Dictionary<string, object>? attributes)
    {
        if (Num(r.GetValueOrDefault("UniqueId")) is not double id) return null;
        string? S(string k) => r.GetValueOrDefault(k) as string;
        int? I(string k) => Num(r.GetValueOrDefault(k)) is double d ? (int)d : null;

        var wageText = S("FullContract/Wage/DisplayValue");
        var valueText = S("TransferValueRange/TransferValueRangeString");
        bool injured = string.Equals(S("CurrentInjury/IsActive"), "True", StringComparison.OrdinalIgnoreCase);
        // Valeur affichée en fourchette ("0 € - 2K €") : Value = borne haute
        var valueParts = (valueText ?? "").Split(" - ");
        long? valueMin = ParseMoney(valueParts[0]), valueMax = ParseMoney(valueParts[^1]);

        return new PlayerDto(
            (int)id, CleanName(S("Name")) ?? "", I("Age") ?? 0,
            (S("PositionCombinedString") ?? "").Split(", ", StringSplitOptions.RemoveEmptyEntries),
            S("Footedness/PreferredFootString"),
            null, null, I("Condition"), S("MoraleString") ?? S("Morale"),
            DecodeDate(S("FullContract/EndDate")), MonthlyWage(wageText), valueMax,
            S("FullContract/AgreedPlayingTime/DisplayValue"),
            I("ClubAppearancesThisSeason"), I("ClubGoalsThisSeason"),
            Num(r.GetValueOrDefault("ClubAverageRatingThisSeason")) is double avg ? Math.Round(avg, 2) : null,
            injured ? S("CurrentInjury/InjuryDescription") ?? "Blessé" : null,
            attributes)
        {
            PositionsText = S("PositionCombinedString"),
            PositionRatings = PositionAbilities.Select(x => (x.Fr, V: I(x.Path))).Where(x => x.V != null)
                .ToDictionary(x => x.Fr, x => x.V!.Value) is { Count: > 0 } pr ? pr : null,
            SquadNumber = I("SquadNumber"),
            Nationality = S("NationalityText"),
            BestPosition = S("BestPositionShortString"),
            Sharpness = I("Sharpness"),
            WageText = wageText,
            ValueText = valueText,
            ValueMin = valueMin,
            InjuryReturnDays = injured ? I("CurrentInjury/InjuryReturnDays") : null,
            Tracking = PlayerExtras.Select(x => (x.Key, V: r.GetValueOrDefault(x.Path) is string s ? (object?)(Num(s) ?? (object)CleanName(s)!) : r.GetValueOrDefault(x.Path)))
                .Where(x => x.V != null).ToDictionary(x => x.Key, x => x.V) is { Count: > 0 } t ? t : null,
        };
    }

    // --- Conversions ---

    static double? Num(object? v) => v switch
    {
        double d => d,
        string s when double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
        _ => null,
    };

    // Le jeu entoure les noms de balises : "\u0001<méta base64>\u0002Nom\u0001"
    static string? CleanName(string? s)
    {
        if (s == null) return null;
        var m = Regex.Match(s, "\u0002([^\u0001\u0002]*)\u0001\\s*$");
        return m.Success ? m.Groups[1].Value : s;
    }

    // GameDate { Data1 = N } : année = N >> 17, jour de l'année (1-366) = (N >> 8) & 0x1FF
    static string? DecodeDate(string? s)
    {
        if (s == null) return null;
        var m = Regex.Match(s, @"Data1 = (\d+)");
        if (!m.Success) return null;
        long d = long.Parse(m.Groups[1].Value);
        int year = (int)(d >> 17), doy = (int)((d >> 8) & 0x1FF);
        if (year < 1900 || doy < 1 || doy > 366) return null;
        return new DateTime(year, 1, 1).AddDays(doy - 1).ToString("yyyy-MM-dd");
    }

    // Salaire ramené au mois selon l'unité affichée par le jeu : p/m (mois), p/s (semaine), p/a (an)
    static long? MonthlyWage(string? s)
    {
        if (ParseMoney(s) is not long n) return null;
        if (s!.Contains("p/s") || s.Contains("p/w")) return (long)Math.Round(n * 52 / 12.0);
        if (s.Contains("p/a") || s.Contains("p/y")) return (long)Math.Round(n / 12.0);
        return n;
    }

    // "95 € p/m", "1,2 M €", "3,22K €", "1,5 Md €" → montant entier.
    // 0.5.8 : aussi l'affichage anglais ("€1.2K p/w", "€1,250", "£3.5M", "€1.25B") : la 0.5.7 lisait 1 € et 3 €,
    // et un « Md » (milliard) valait un million. Un séparateur unique suivi de trois chiffres, sans suffixe, sépare les milliers.
    static long? ParseMoney(string? s)
    {
        if (string.IsNullOrEmpty(s)) return null;
        var m = Regex.Match(s, @"(\d[\d\s\u00A0\u202F.,]*)\s*((?:Mrd|Md|Mio|[kKMB])(?![A-Za-z]))?");
        if (!m.Success) return null;
        var suffix = m.Groups[2].Value;
        var t = Regex.Replace(m.Groups[1].Value, @"[\s\u00A0\u202F]", "").TrimEnd('.', ',');
        int dot = t.LastIndexOf('.'), com = t.LastIndexOf(',');
        char? dec = null;
        if (dot >= 0 && com >= 0) dec = dot > com ? '.' : ',';
        else if (dot >= 0 || com >= 0)
        {
            char c = dot >= 0 ? '.' : ','; int last = Math.Max(dot, com);
            if (t.IndexOf(c) == last && !(t.Length - last - 1 == 3 && suffix == "")) dec = c;
        }
        var digits = new System.Text.StringBuilder();
        foreach (var ch in t)
            if (ch == dec) digits.Append('.');
            else if (ch != '.' && ch != ',') digits.Append(ch);
        if (!double.TryParse(digits.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
        n *= suffix switch { "k" or "K" => 1e3, "M" or "Mio" => 1e6, "Md" or "Mrd" or "B" => 1e9, _ => 1 };
        return (long)Math.Round(n);
    }

    // --- Moteur de requêtes groupées ---

    // Item = index dans l'effectif (null = chemin absolu "game.…" ou "tactic.…"). "#count" = taille de la liste.
    // Segment "#N" = N-ième élément de la liste courante. Deep = valeur composée convertie en JSON (Record, liste).
    // List = autre liste de joueurs que l'effectif (chemin absolu "game.…", contextes permis) : Item indexe alors
    // les joueurs trouvés dans cette liste (voir Batch.Persons) ; Path "#count" = leur nombre.
    public sealed record Req(int? Item, string Path, bool Deep = false, string? List = null);

    static class Batch
    {
        static Il2CppSystem.Object? _owner;

        sealed class State
        {
            public TypedValue? Cur;
            public string[] Segs = Array.Empty<string>();
            public object? Result;
            public bool Failed;
            public bool Deep;
            public int Signalled;
            // Requête en cours au niveau courant : gardée pour la désinscrire si le jeu ne répond pas à temps.
            public Bindings.Key Key;
            public Bindings.ValueChangedCallback? Cb;
            public bool Bound;
            // Envoi en cours : une réponse arrivée pour un envoi précédent est ignorée.
            public object? Token;
            // Références utilisables comme contexte (@team, @human, @person)
            public TypedValue? Team, Human, Person;
        }

        // Résout chaque chemin niveau par niveau : toutes les requêtes d'un niveau partent dans la même frame.
        public static object?[] Run(IReadOnlyList<Req> reqs, int timeoutMs)
        {
            var states = reqs.Select(r => new State { Deep = r.Deep }).ToArray();
            TypedValue? squad = null, team = null, tactic = null;
            bool needSquad = reqs.Any(r => (r.Item != null && r.List == null) || r.Path.StartsWith(Squad));
            bool needTactic = reqs.Any(r => r.Path.StartsWith(Tactic)) || reqs.Any(r => r.Path.Contains("@team") || (r.List?.Contains("@team") ?? false));
            TypedValue? human = null;
            if (reqs.Any(r => r.Path.Contains("@human") || (r.List?.Contains("@human") ?? false)))
            {
                var h = new State { Segs = new[] { "GameCurrentManager" } };
                Resolve(new[] { h }, () => Root(), timeoutMs);
                human = h.Cur;
            }

            if (needSquad)
            {
                var s = new State { Segs = new[] { "GameCurrentManagerClubTeam", "Club", "Squad" } };
                Resolve(new[] { s }, () => Root(), timeoutMs);
                squad = s.Cur;
            }
            if (needTactic)
            {
                var t = new State { Segs = new[] { "GameCurrentManagerClubTeam" } };
                Resolve(new[] { t }, () => Root(), timeoutMs);
                team = t.Cur;
                // 0.5.5 : la tactique du joueur est celle que l'équipe renvoie (Tactic{Boolean=true}) : nom, créneaux et
                // efficacité tactique réels (« 4-1-5 … », 43 %). La référence construite à la main (TacticRoot) tombait
                // sur une tactique « 4-4-2 » par défaut, sans efficacité ; elle ne sert plus que de secours.
                if (team != null && reqs.Any(r => r.Path.StartsWith(Tactic)))
                {
                    var tt = new State { Segs = new[] { "GameCurrentManagerClubTeam", "Tactic{Boolean=true}" } };
                    Resolve(new[] { tt }, () => Root(), timeoutMs);
                    tactic = tt.Failed ? null : tt.Cur;
                }
            }
            // Autres listes de joueurs (liste de suivi, cibles…) : résolues une fois, puis réduites aux joueurs qu'elles contiennent.
            var lists = new Dictionary<string, List<TypedValue>>();
            foreach (var lp in reqs.Select(r => r.List).Where(x => x != null).Distinct())
            {
                var l = new State { Segs = lp!.Substring("game.".Length).Split('/'), Team = team, Human = human };
                Resolve(new[] { l }, () => Root(), timeoutMs);
                var cur = l.Failed ? null : l.Cur;
                lists[lp] = cur == null ? new() : MainThread.Run(() => Persons(cur, MaxListPersons)).Result;
            }

            // 0.5.9 : préparation par tranches de SetupSlice requêtes. D'un seul tenant pour plusieurs milliers de requêtes,
            // elle prenait une image de 77 ms (mesure du 10/11/2026) malgré le plafond de MainThread.
            for (int off = 0; off < reqs.Count; off += SetupSlice)
            {
            int lo = off, hi = Math.Min(reqs.Count, off + SetupSlice);
            MainThread.Run(() =>
            {
                for (int k = lo; k < hi; k++)
                {
                    var r = reqs[k]; var st = states[k];
                    st.Team = team; st.Human = human;
                    if (r.Path == Squad + "/#count") { st.Result = (double?)Count(squad); st.Failed = true; continue; }
                    if (r.List != null && r.Path == "#count") { st.Result = (double)lists[r.List].Count; st.Failed = true; continue; }
                    if (r.Item != null)
                    {
                        var el = r.List == null ? ItemAt(squad, r.Item.Value)
                            : r.Item.Value < lists[r.List].Count ? lists[r.List][r.Item.Value] : null;
                        if (el == null) { st.Failed = true; continue; }
                        st.Cur = el;
                        st.Person = el;
                        st.Segs = r.Path.Split('/');
                    }
                    else if (r.Path.StartsWith(Tactic))
                    {
                        var tr = tactic != null ? TypedValue.CreateCopyFrom(tactic) : TacticRoot(team);
                        if (tr == null) { st.Failed = true; continue; }
                        st.Cur = tr;
                        st.Segs = r.Path.Substring(Tactic.Length).Split('/');
                    }
                    else
                    {
                        st.Cur = Root();
                        st.Segs = r.Path.Substring("game.".Length).Split('/');
                    }
                }
                return 0;
            }).Wait();
            }

            Resolve(states.Where(s => !s.Failed).ToArray(), null, timeoutMs);
            return states.Select(s => s.Result).ToArray();
        }

        static TypedValue Root()
        {
            var r = TypedValue.GetReferenceTypedValue();
            r.SetValue(FM.UI.GameReference.GetInstance() ?? new FM.UI.GameReference());
            return r;
        }

        // Référence de tactique de l'équipe du club humain (type Team + index), construite comme le fait l'écran Tactiques.
        static TypedValue? TacticRoot(TypedValue? team)
        {
            var dr = team?.TryCast<ReferenceTypedValue>()?.Value?.TryCast<FM.UI.DatabaseRecordReference>();
            if (dr == null) return null;
            var t = new FM.UI.TeamTacticReference();
            t.m_type = dr.Type;
            t.m_index = dr.m_index;
            t.m_is_full_tactic = true;
            t.SetCombinedIndexAndType(dr.CombinedIndexAndType);
            var r = TypedValue.GetReferenceTypedValue();
            r.SetValue(t);
            return r;
        }

        // 0.5.7 : au-delà de RetryMin requêtes restées sans réponse à un niveau, on les renvoie par paquets de RetryChunk.
        // Le 09/11/2026, les 4 500 requêtes de chemins.json parties dans la même frame n'ont reçu en 8 s que les réponses
        // immédiates : toutes les stats des joueurs et les consignes de la tactique sont revenues vides, cinq jours de suite.
        const int RetryMin = 20, RetryChunk = 300, FrameSlice = 50, SetupSlice = 100;
        /// <summary>Requêtes restées sans réponse (avant relance), récupérées par la relance, depuis le dernier TakeStats.</summary>
        static int _late, _recovered;
        public static (int Late, int Recovered) TakeStats() => (Interlocked.Exchange(ref _late, 0), Interlocked.Exchange(ref _recovered, 0));

        static void Resolve(State[] states, Func<TypedValue>? root, int timeoutMs)
        {
            int depth = states.Length == 0 ? 0 : states.Max(s => s.Segs.Length);
            for (int level = 0; level < depth; level++)
            {
                StopIfMatch();
                var active = states.Where(s => !s.Failed && s.Segs.Length > level).ToArray();
                if (active.Length == 0) break;
                var late = Send(active, level, root, timeoutMs);
                if (late.Count >= RetryMin)
                {
                    Interlocked.Add(ref _late, late.Count);
                    var still = new List<State>();
                    bool several = late.Count > RetryChunk;
                    for (int i = 0; i < late.Count; i += RetryChunk)
                    {
                        StopIfMatch();
                        var chunk = late.Skip(i).Take(RetryChunk).ToArray();
                        var lost = Send(chunk, level, root, timeoutMs);
                        // 0.5.8 : un paquet resté entièrement sans réponse (jeu occupé, ex. pendant un match) est renvoyé
                        // une fois, avec un délai double. Seulement quand il y a plusieurs paquets : un paquet unique est
                        // en général fait des chemins qui ne répondent jamais.
                        if (several && lost.Count == chunk.Length && chunk.Length >= RetryMin)
                            lost = Send(chunk, level, root, timeoutMs * 2);
                        still.AddRange(lost);
                    }
                    Interlocked.Add(ref _recovered, late.Count - still.Count);
                    late = still;
                }
                foreach (var s in late) s.Failed = true;
            }
        }

        // Envoie les requêtes d'un niveau dans la même frame et attend les réponses. Renvoie celles restées sans réponse,
        // déjà désinscrites. On attend tant que des réponses arrivent : timeoutMs sans aucune réponse, ou 3 s sans nouvelle
        // réponse une fois les premières arrivées, et jamais plus de trois fois timeoutMs.
        static List<State> Send(State[] active, int lvl, Func<TypedValue>? root, int timeoutMs)
        {
            using var done = new CountdownEvent(active.Length);
            var token = new object();
            void Sig() { try { done.Signal(); } catch (ObjectDisposedException) { } catch (InvalidOperationException) { } }
            foreach (var s in active) { s.Signalled = 0; s.Token = token; s.Bound = false; }
            // 0.5.9 : par tranches de FrameSlice requêtes, pour que MainThread puisse les étaler sur plusieurs images.
            for (int off = 0; off < active.Length; off += FrameSlice)
            {
            int lo = off, hi = Math.Min(active.Length, off + FrameSlice);
            bool full = _fullRead;
            MainThread.Enqueue(() =>
            {
                // 0.6.3 : match commencé pendant une lecture complète : les tranches déjà en file ne partent plus.
                if (full && Plugin.InMatch) { for (int idx = lo; idx < hi; idx++) Sig(); return; }
                var b = GameSubsystems.Get<BindingSubsystem>();
                _owner ??= new Il2CppSystem.Object();
                for (int idx = lo; idx < hi; idx++)
                {
                    var st = active[idx];
                    if (!ReferenceEquals(st.Token, token)) continue;   // envoi périmé (thread principal en retard) : la relance s'en charge
                    var src = st.Cur ?? root?.Invoke() ?? TypedValue.Null;
                    bool last = lvl == st.Segs.Length - 1;
                    if (st.Segs[lvl].StartsWith('#'))   // élément de liste : pas de requête au jeu
                    {
                        // 0.5.8 : une erreur ici ne doit pas interrompre les requêtes suivantes de la frame.
                        try
                        {
                            var el = int.TryParse(st.Segs[lvl].AsSpan(1), out var n) && n >= 0 ? ItemAt(src, n) : null;
                            if (el == null) st.Failed = true;
                            else { st.Cur = TypedValue.CreateCopyFrom(el); if (last) st.Result = st.Deep ? Dump(el, 3) : Simple(el); }
                        }
                        catch { st.Failed = true; }
                        if (Interlocked.Exchange(ref st.Signalled, 1) == 0) Sig();
                        continue;
                    }
                    Bindings.ValueChangedCallback? cb = null;
                    cb = (Action<Bindings.Key, TypedValue>)((k, v) =>
                    {
                        // Toujours se désinscrire, même pour une réponse arrivée après le délai :
                        // une liaison oubliée reste active dans le jeu et s'ajoute à chaque instantané.
                        var key = k;
                        MainThread.Enqueue(() => { try { b.Unbind(ref key, cb!); } catch { } });
                        // Réponse d'un envoi précédent (relance en cours, ou niveau suivant) : ignorée.
                        if (!ReferenceEquals(st.Token, token)) return;
                        if (Interlocked.Exchange(ref st.Signalled, 1) != 0) return;
                        st.Bound = false;
                        if (v == null || v.IsNull) { st.Failed = true; st.Cur = null; }
                        else if (last) { st.Result = st.Deep ? Dump(v, 3) : Simple(v); st.Cur = TypedValue.CreateCopyFrom(v); }
                        else st.Cur = TypedValue.CreateCopyFrom(v);
                        Sig();
                    });
                    try
                    {
                        st.Cb = cb;
                        var ctx = ContextRequest.Parse(st.Segs[lvl]);   // "Prop{Contexte=n,…}" : propriété de contexte
                        if (ctx is { } c)
                        {
                            var key = ContextRequest.Bind(b, src, c.Prop, c.Ctxs,
                                name => name switch { "team" => st.Team, "human" => st.Human, "person" => st.Person, _ => null },
                                _owner, cb);
                            if (key == null) { if (Interlocked.Exchange(ref st.Signalled, 1) == 0) { st.Failed = true; Sig(); } continue; }
                            st.Key = key.Value;
                        }
                        else st.Key = BindingUtils.Request(b, src, st.Segs[lvl], _owner, cb);
                        st.Bound = st.Signalled == 0;   // réponse immédiate : déjà désinscrite par le callback
                    }
                    catch { if (Interlocked.Exchange(ref st.Signalled, 1) == 0) { st.Failed = true; Sig(); } }
                }
            });
            }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int left = active.Length; long lastProgress = 0; bool any = false;
            while (!done.Wait(200))
            {
                int now = done.CurrentCount;
                if (now < left) { left = now; lastProgress = sw.ElapsedMilliseconds; any = true; }
                long idle = sw.ElapsedMilliseconds - lastProgress;
                if (idle >= (any ? Math.Min(timeoutMs, 3000) : timeoutMs) || sw.ElapsedMilliseconds >= 3L * timeoutMs) break;
            }
            var late = new List<State>();
            var expired = new List<(Bindings.Key Key, Bindings.ValueChangedCallback Cb)>();
            foreach (var s in active)
                if (Interlocked.Exchange(ref s.Signalled, 1) == 0)   // délai dépassé
                {
                    late.Add(s);
                    if (s.Bound && s.Cb != null) expired.Add((s.Key, s.Cb));
                    s.Bound = false;
                    // 0.5.8 : si le thread principal n'a pas encore traité cet envoi (jeu figé), il ne doit plus le lancer
                    // après coup : la liaison ne serait jamais retirée.
                    s.Token = null;
                }
            // Délai dépassé : on retire les requêtes restées en attente, pour ne pas encombrer le jeu
            // (cause probable des gels de l'écran Tactique en 0.2.0 / 0.2.1).
            if (expired.Count > 0)
                MainThread.Enqueue(() =>
                {
                    var b = GameSubsystems.Get<BindingSubsystem>();
                    foreach (var (k, cb) in expired)
                    {
                        var key = k;
                        try { b.Unbind(ref key, cb); } catch { }
                    }
                });
            return late;
        }

        // Valeur IL2CPP → valeur managée (double, string) ; lue dans le callback, sur le thread principal.
        static object? Simple(TypedValue v)
        {
            var n = v.TryCast<NumericTypedValue>();
            if (n != null) try { return n.Value.GetDouble(); } catch { }
            try { return v.AsString(); } catch { return null; }
        }

        // Valeur composée → objets managés sérialisables : Record → dictionnaire (noms de propriétés), liste → tableau (40 max),
        // référence → "Type#index", sinon nombre ou texte. Profondeur limitée.
        static object? Dump(TypedValue? v, int depth)
        {
            if (v == null || v.IsNull) return null;
            var n = v.TryCast<NumericTypedValue>();
            if (n != null) try { return n.Value.GetDouble(); } catch { }
            var o = v.TryCast<ReferenceTypedValue>()?.Value;
            if (o != null && depth > 0)
            {
                var rec = o.TryCast<Record>();
                if (rec != null)
                {
                    var d = new Dictionary<string, object?>();
                    foreach (var kv in rec) d[Probe.PropName(kv.Key)] = Dump(kv.Value, depth - 1);
                    return d;
                }
                var list = o.TryCast<Il2CppSystem.Collections.IList>();
                if (list != null)
                {
                    var res = new List<object?>();
                    for (int i = 0; i < Math.Min(Count(v) ?? 0, 40); i++) res.Add(Dump(list[i]?.TryCast<TypedValue>(), depth - 1));
                    return res;
                }
                var dr = o.TryCast<FM.UI.DatabaseRecordReference>();
                if (dr != null) return $"{dr.Type}#{dr.m_index}";
            }
            try { var s = v.AsString(); return s == null ? null : CleanName(s); } catch { return null; }
        }

        // Une liste du recrutement n'est pas forcément une liste de joueurs : élément = joueur, ou Record qui en contient un
        // (ex. {Player, DaysLeft…}) ; la liste elle-même peut être un Record qui contient la liste. On garde les joueurs.
        public const int MaxListPersons = 60;

        static List<TypedValue> Persons(TypedValue value, int max)
        {
            var res = new List<TypedValue>();
            var list = AsList(value, 2);
            if (list == null) { if (AsPerson(value, 0) is { } one) res.Add(TypedValue.CreateCopyFrom(one)); return res; }
            int n = Count(list) ?? 0;
            for (int i = 0; i < n && res.Count < max; i++)
                if (ItemAt(list, i) is { } el && AsPerson(el, 2) is { } p) res.Add(TypedValue.CreateCopyFrom(p));
            return res;
        }

        static TypedValue? AsList(TypedValue v, int depth)
        {
            var o = v.TryCast<ReferenceTypedValue>()?.Value;
            if (o == null) return null;
            if (o.TryCast<Il2CppSystem.Collections.IList>() != null) return v;
            var rec = o.TryCast<Record>();
            if (rec == null || depth == 0) return null;
            foreach (var kv in rec)
                if (kv.Value != null && AsList(kv.Value, depth - 1) is { } l && (Count(l) ?? 0) > 0) return l;
            return null;
        }

        static TypedValue? AsPerson(TypedValue v, int depth)
        {
            var o = v.TryCast<ReferenceTypedValue>()?.Value;
            if (o == null) return null;
            var dr = o.TryCast<FM.UI.DatabaseRecordReference>();
            if (dr != null) return dr.Type.ToString() is "Person" or "Player" ? v : null;
            var rec = depth > 0 ? o.TryCast<Record>() : null;
            if (rec == null) return null;
            TypedValue? found = null;
            foreach (var kv in rec)
            {
                if (kv.Value == null || AsPerson(kv.Value, depth - 1) is not { } p) continue;
                var name = Probe.PropName(kv.Key);
                if (name is "Player" or "Person") return p;
                found ??= p;
            }
            return found;
        }

        // Forme d'une source de joueurs, pour le rapport de collecte : nombre d'éléments, joueurs reconnus, premier élément.
        public static Dictionary<string, object?> Describe(string listPath, int timeoutMs)
        {
            TypedValue? team = null, human = null;
            if (listPath.Contains("@team")) { var t = new State { Segs = new[] { "GameCurrentManagerClubTeam" } }; Resolve(new[] { t }, () => Root(), timeoutMs); team = t.Cur; }
            if (listPath.Contains("@human")) { var h = new State { Segs = new[] { "GameCurrentManager" } }; Resolve(new[] { h }, () => Root(), timeoutMs); human = h.Cur; }
            var l = new State { Segs = listPath.Substring("game.".Length).Split('/'), Team = team, Human = human };
            Resolve(new[] { l }, () => Root(), timeoutMs);
            var cur = l.Failed ? null : l.Cur;
            if (cur == null) return new() { ["reponse"] = false };
            return MainThread.Run(() =>
            {
                var list = AsList(cur, 2);
                return new Dictionary<string, object?>
                {
                    ["reponse"] = true,
                    ["elements"] = list == null ? null : Count(list),
                    ["joueurs"] = Persons(cur, MaxListPersons).Count,
                    ["premier"] = list != null && ItemAt(list, 0) is { } el ? Dump(el, 2) : Dump(cur, 2),
                };
            }).Result;
        }

        static int? Count(TypedValue? list) =>
            list?.TryCast<ReferenceTypedValue>()?.Value?.TryCast<Il2CppSystem.Collections.ICollection>()?.Count;

        static TypedValue? ItemAt(TypedValue? list, int i)
        {
            var o = list?.TryCast<ReferenceTypedValue>()?.Value;
            var l = o?.TryCast<Il2CppSystem.Collections.IList>();
            if (l == null || i >= (Count(list) ?? 0)) return null;
            return l[i]?.TryCast<TypedValue>();
        }
    }
}
