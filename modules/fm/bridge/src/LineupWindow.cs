extern alias UnityCore;
using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using UnityCore::UnityEngine;
using UnityEngine;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace Archivix;

// Compo d'avant-match FM Immersion dans FM27 (0.6.5). Image posée PAR-DESSUS l'interface du jeu à l'entrée du match :
// elle n'envoie aucun événement au jeu et ne change rien à la partie.
//
// - Le jour du match, FM Immersion dessine la carte (le onze sur le terrain, photos, schéma, rapport sur l'adversaire) et
//   la dépose dans <Dossier>\fmimmersion-compo.png avec sa fiche <Dossier>\fmimmersion-compo.json (format fmi-compo/1 :
//   key, image, seconds, close). Elle les retire quand il n'y a pas de match ce jour-là.
// - Le plugin relit la fiche toutes les 3 s (thread à part). Quand un match commence (Plugin.InMatch, tenu par la lecture
//   du direct, sinon IsDuringMatch), il montre la carte une seule fois par match (clé), puis la ferme au clic ou après
//   `seconds` secondes.
// - Même panneau UI Toolkit que la conférence de presse (FM27 n'a plus IMGUI) ; l'image est décodée par ImageConversion.
public class LineupWindow : MonoBehaviour
{
    public LineupWindow(IntPtr p) : base(p) { }

    internal const string CardFile = "fmimmersion-compo.json";
    internal const string ImageFile = "fmimmersion-compo.png";

    static readonly Color Veil = new(0.03f, 0.06f, 0.1f, 0.72f);
    static readonly Color Amber = new(1f, 0.71f, 0.28f);
    static readonly Color Ink = new(0.06f, 0.11f, 0.18f);

    // Échanges avec le thread de lecture : carte à montrer (fiche et octets de l'image).
    static volatile Card? _pending;
    static string? _shownKey;

    bool _stopped, _fontOk;
    int _errors;
    float _closeAt = -1f;
    GameObject? _go;
    VisualElement? _layer;
    Texture2D? _tex;

    internal static void StartWatcher()
    {
        new Thread(() =>
        {
            bool? wasInMatch = null;
            while (true)
            {
                Thread.Sleep(3_000);
                try
                {
                    var path = Path.Combine(Plugin.DataDir, CardFile);
                    if (!File.Exists(path)) { wasInMatch = null; continue; }
                    var card = Card.Parse(File.ReadAllText(path));
                    if (card == null || card.Key == _shownKey) continue;
                    var inMatch = Plugin.ReadLive ? Plugin.InMatch : FmBindingReader.DuringMatch() == true;
                    // On attend le passage au match : une carte déposée pendant un match déjà commencé n'est pas montrée.
                    if (inMatch && wasInMatch == false)
                    {
                        var img = Path.Combine(Plugin.DataDir, ImageFile);
                        if (File.Exists(img))
                        {
                            card.Png = File.ReadAllBytes(img);
                            _shownKey = card.Key;
                            _pending = card;
                        }
                    }
                    wasInMatch = inMatch;
                }
                catch (Exception e) { Plugin.Log.LogWarning($"Compo : lecture de {CardFile} impossible ({e.Message})."); }
            }
        }) { IsBackground = true, Name = "ArchivixCompoAvantMatch" }.Start();
    }

    void Update()
    {
        if (_stopped) return;
        try
        {
            var c = _pending;
            if (c != null)
            {
                _pending = null;
                Show(c);
            }
            if (_closeAt > 0 && Time.unscaledTime > _closeAt) Hide();
        }
        catch (Exception e) { Fail("image", e); }
    }

    void Show(Card c)
    {
        if (c.Png == null || c.Png.Length == 0) return;
        if (_layer == null)
        {
            var root = OwnPanel();
            if (root == null) { _pending = c; return; }   // interface pas encore prête : nouvel essai à l'image suivante
            _layer = new VisualElement { pickingMode = PickingMode.Position };
            _layer.style.position = Position.Absolute;
            _layer.style.left = 0; _layer.style.top = 0; _layer.style.right = 0; _layer.style.bottom = 0;
            _layer.style.alignItems = Align.Center;
            _layer.style.justifyContent = Justify.Center;
            _layer.style.backgroundColor = Veil;
            _layer.RegisterCallback<ClickEvent>((EventCallback<ClickEvent>)(_ => Hide()));
            root.Add(_layer);
            _layer.BringToFront();
        }
        EnsureFont();
        _layer.Clear();
        _tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
        if (!ImageConversion.LoadImage(_tex, (Il2CppStructArray<byte>)c.Png, false))
        {
            Plugin.Log.LogWarning("Compo : image illisible.");
            return;
        }
        _tex.filterMode = FilterMode.Bilinear;
        var pic = new VisualElement { pickingMode = PickingMode.Ignore };
        pic.style.width = 1200;
        pic.style.height = 600;
        pic.style.backgroundImage = _tex;
        Round(pic, 14);
        _layer.Add(pic);
        var close = new Label(c.Close);
        close.style.marginTop = 14;
        close.style.fontSize = 16;
        close.style.color = Ink;
        close.style.backgroundColor = Amber;
        close.style.unityFontStyleAndWeight = FontStyle.Bold;
        close.style.paddingLeft = 22; close.style.paddingRight = 22; close.style.paddingTop = 8; close.style.paddingBottom = 8;
        close.pickingMode = PickingMode.Ignore;
        Round(close, 8);
        _layer.Add(close);
        _layer.style.display = DisplayStyle.Flex;
        _closeAt = Time.unscaledTime + Math.Clamp(c.Seconds, 5, 120);
        Plugin.Log.LogInfo($"Compo : carte d'avant-match affichée ({c.Key}).");
    }

    void Hide()
    {
        _closeAt = -1f;
        if (_layer != null) { _layer.style.display = DisplayStyle.None; _layer.Clear(); }
        if (_tex != null) { UnityCore::UnityEngine.Object.Destroy(_tex); _tex = null; }
    }

    // Notre panneau, réglé comme le panneau FM le plus haut, placé au-dessus de toute l'interface du jeu (comme la presse).
    VisualElement? OwnPanel()
    {
        var docs = UnityCore::UnityEngine.Object.FindObjectsOfType<UIDocument>();
        if (docs == null || docs.Length == 0) return null;
        UIDocument? best = null; float order = float.MinValue;
        foreach (var d in docs)
        {
            if (d == null || d.panelSettings == null || d.rootVisualElement == null) continue;
            if (d.panelSettings.sortingOrder > order) { order = d.panelSettings.sortingOrder; best = d; }
        }
        if (best == null) return null;
        try
        {
            var settings = UnityCore::UnityEngine.Object.Instantiate(best.panelSettings);
            settings.name = "FMImmersionCompo";
            settings.sortingOrder = order + 90f;
            settings.targetTexture = null;
            _go = new GameObject("FMImmersionCompo");
            UnityCore::UnityEngine.Object.DontDestroyOnLoad(_go);
            _go.hideFlags = HideFlags.HideAndDontSave;
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            doc.sortingOrder = 990;
            var r = doc.rootVisualElement;
            if (r != null)
            {
                r.pickingMode = PickingMode.Ignore;
                r.style.position = Position.Absolute;
                r.style.left = 0; r.style.top = 0; r.style.right = 0; r.style.bottom = 0;
                return r;
            }
        }
        catch (Exception e) { Fail("panneau", e); }
        return best.rootVisualElement;
    }

    // Police du jeu pour le bouton (sans police, UI Toolkit n'affiche aucun texte).
    void EnsureFont()
    {
        if (_fontOk || _layer == null) return;
        try
        {
            var all = Resources.FindObjectsOfTypeAll<FontAsset>();
            if (all != null && all.Length > 0)
            {
                FontAsset pick = all[0];
                foreach (var a in all) if (a != null && a.name != null && a.name.Contains("Regular")) { pick = a; break; }
                _layer.style.unityFontDefinition = FontDefinition.FromSDFFont(pick);
                _fontOk = true;
                return;
            }
            var f = Font.CreateDynamicFontFromOSFont("Segoe UI", 18) ?? Font.CreateDynamicFontFromOSFont("Arial", 18);
            if (f != null) { _layer.style.unityFontDefinition = FontDefinition.FromFont(f); _fontOk = true; }
        }
        catch (Exception e) { Fail("police", e); }
    }

    static void Round(VisualElement e, float r) { e.style.borderTopLeftRadius = r; e.style.borderTopRightRadius = r; e.style.borderBottomLeftRadius = r; e.style.borderBottomRightRadius = r; }

    void Fail(string where, Exception e)
    {
        _errors++;
        Plugin.Log.LogWarning($"Compo : erreur ({where}) {_errors}/20 : {e.GetType().Name} {e.Message}");
        if (_errors == 1) Plugin.Log.LogWarning(e.ToString());
        if (_errors >= 20) { _stopped = true; Plugin.Log.LogError("Compo : trop d'erreurs, carte d'avant-match arrêtée."); }
    }

    // Fiche écrite par FM Immersion (fmi-compo/1).
    sealed class Card
    {
        public string Format { get; init; } = "";
        public string Key { get; init; } = "";
        public int Seconds { get; init; } = 20;
        public string Close { get; init; } = "Fermer";
        public byte[]? Png { get; set; }

        static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };

        internal static Card? Parse(string text)
        {
            var c = JsonSerializer.Deserialize<Card>(text, Opts);
            return c == null || c.Format != "fmi-compo/1" || string.IsNullOrEmpty(c.Key) ? null : c;
        }
    }
}
