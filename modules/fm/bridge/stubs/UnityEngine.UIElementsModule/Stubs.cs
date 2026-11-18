// Modèle de compilation : signatures seulement, aucun code du jeu (voir ../Directory.Build.props).
// Les styles sont simplifiés (une classe au lieu de l'interface IStyle) : seules comptent les écritures du plugin.
using System;
using UnityEngine.TextCore.Text;

namespace UnityEngine.UIElements
{
    public enum PickingMode { Position, Ignore }
    public enum Position { Relative, Absolute }
    public enum Align { Auto, FlexStart, Center, FlexEnd, Stretch }
    public enum Justify { FlexStart, Center, FlexEnd, SpaceBetween, SpaceAround, SpaceEvenly }
    public enum DisplayStyle { Flex, None }
    public enum FlexDirection { Column, ColumnReverse, Row, RowReverse }
    public enum WhiteSpace { Normal, NoWrap, Pre, PreWrap }
    public enum LengthUnit { Pixel, Percent }

    public struct Length { public Length(float value, LengthUnit unit) => throw null; }
    public struct StyleLength
    {
        public static implicit operator StyleLength(float v) => throw null;
        public static implicit operator StyleLength(Length v) => throw null;
    }
    public struct StyleFloat { public static implicit operator StyleFloat(float v) => throw null; }
    public struct StyleColor { public static implicit operator StyleColor(Color v) => throw null; }
    public struct StyleEnum<T> where T : struct { public static implicit operator StyleEnum<T>(T v) => throw null; }
    public struct FontDefinition
    {
        public static FontDefinition FromSDFFont(FontAsset f) => throw null;
        public static FontDefinition FromFont(Font f) => throw null;
    }
    public struct StyleFontDefinition { public static implicit operator StyleFontDefinition(FontDefinition v) => throw null; }
    public struct StyleBackground { public static implicit operator StyleBackground(Texture2D v) => throw null; }

    public class IStyle : Il2CppSystem.Object
    {
        public IStyle(IntPtr pointer) : base(pointer) { }
        public StyleEnum<Position> position { get => throw null; set => throw null; }
        public StyleLength left { get => throw null; set => throw null; }
        public StyleLength top { get => throw null; set => throw null; }
        public StyleLength right { get => throw null; set => throw null; }
        public StyleLength bottom { get => throw null; set => throw null; }
        public StyleLength width { get => throw null; set => throw null; }
        public StyleLength height { get => throw null; set => throw null; }
        public StyleLength minWidth { get => throw null; set => throw null; }
        public StyleLength minHeight { get => throw null; set => throw null; }
        public StyleLength marginTop { get => throw null; set => throw null; }
        public StyleLength marginBottom { get => throw null; set => throw null; }
        public StyleLength marginLeft { get => throw null; set => throw null; }
        public StyleLength marginRight { get => throw null; set => throw null; }
        public StyleLength paddingTop { get => throw null; set => throw null; }
        public StyleLength paddingBottom { get => throw null; set => throw null; }
        public StyleLength paddingLeft { get => throw null; set => throw null; }
        public StyleLength paddingRight { get => throw null; set => throw null; }
        public StyleLength borderTopLeftRadius { get => throw null; set => throw null; }
        public StyleLength borderTopRightRadius { get => throw null; set => throw null; }
        public StyleLength borderBottomLeftRadius { get => throw null; set => throw null; }
        public StyleLength borderBottomRightRadius { get => throw null; set => throw null; }
        public StyleFloat borderLeftWidth { get => throw null; set => throw null; }
        public StyleFloat borderRightWidth { get => throw null; set => throw null; }
        public StyleFloat borderTopWidth { get => throw null; set => throw null; }
        public StyleFloat borderBottomWidth { get => throw null; set => throw null; }
        public StyleColor borderLeftColor { get => throw null; set => throw null; }
        public StyleColor borderRightColor { get => throw null; set => throw null; }
        public StyleColor borderTopColor { get => throw null; set => throw null; }
        public StyleColor borderBottomColor { get => throw null; set => throw null; }
        public StyleColor color { get => throw null; set => throw null; }
        public StyleColor backgroundColor { get => throw null; set => throw null; }
        public StyleLength fontSize { get => throw null; set => throw null; }
        public StyleEnum<Align> alignItems { get => throw null; set => throw null; }
        public StyleEnum<Align> alignSelf { get => throw null; set => throw null; }
        public StyleEnum<Justify> justifyContent { get => throw null; set => throw null; }
        public StyleEnum<DisplayStyle> display { get => throw null; set => throw null; }
        public StyleEnum<FlexDirection> flexDirection { get => throw null; set => throw null; }
        public StyleFloat flexGrow { get => throw null; set => throw null; }
        public StyleEnum<WhiteSpace> whiteSpace { get => throw null; set => throw null; }
        public StyleEnum<FontStyle> unityFontStyleAndWeight { get => throw null; set => throw null; }
        public StyleEnum<TextAnchor> unityTextAlign { get => throw null; set => throw null; }
        public StyleFontDefinition unityFontDefinition { get => throw null; set => throw null; }
        public StyleBackground backgroundImage { get => throw null; set => throw null; }
    }

    public class EventCallback<T> : Il2CppSystem.MulticastDelegate
    {
        public EventCallback(IntPtr pointer) : base(pointer) { }
        public static implicit operator EventCallback<T>(System.Action<T> a) => throw null;
    }

    public class EventBase : Il2CppSystem.Object { public EventBase(IntPtr pointer) : base(pointer) { } }
    public class MouseEnterEvent : EventBase { public MouseEnterEvent(IntPtr pointer) : base(pointer) { } }
    public class MouseLeaveEvent : EventBase { public MouseLeaveEvent(IntPtr pointer) : base(pointer) { } }
    public class ClickEvent : EventBase { public ClickEvent(IntPtr pointer) : base(pointer) { } }

    public class VisualElement : Il2CppSystem.Object
    {
        public VisualElement(IntPtr pointer) : base(pointer) { }
        public VisualElement() : base(IntPtr.Zero) => throw null;
        public PickingMode pickingMode { get => throw null; set => throw null; }
        public IStyle style => throw null;
        public void Add(VisualElement child) => throw null;
        public void Clear() => throw null;
        public void BringToFront() => throw null;
        public void RegisterCallback<TEventType>(EventCallback<TEventType> callback) where TEventType : EventBase => throw null;
    }

    public class TextElement : VisualElement
    {
        public TextElement(IntPtr pointer) : base(pointer) { }
        public TextElement() : base(IntPtr.Zero) => throw null;
        public virtual string text { get => throw null; set => throw null; }
    }

    public class Label : TextElement
    {
        public Label(IntPtr pointer) : base(pointer) { }
        public Label(string text) : base(IntPtr.Zero) => throw null;
    }

    public class Button : TextElement
    {
        public Button(IntPtr pointer) : base(pointer) { }
        public Button() : base(IntPtr.Zero) => throw null;
        public void add_clicked(Il2CppSystem.Action value) => throw null;
    }

    public class TextField : VisualElement
    {
        public TextField(IntPtr pointer) : base(pointer) { }
        public TextField() : base(IntPtr.Zero) => throw null;
        public bool multiline { get => throw null; set => throw null; }
        public int maxLength { get => throw null; set => throw null; }
        public string value { get => throw null; set => throw null; }
    }

    public class PanelSettings : ScriptableObject
    {
        public PanelSettings(IntPtr pointer) : base(pointer) { }
        public float sortingOrder { get => throw null; set => throw null; }
        public RenderTexture targetTexture { get => throw null; set => throw null; }
    }

    public sealed class UIDocument : MonoBehaviour
    {
        public UIDocument(IntPtr pointer) : base(pointer) { }
        public PanelSettings panelSettings { get => throw null; set => throw null; }
        public VisualElement rootVisualElement => throw null;
        public float sortingOrder { get => throw null; set => throw null; }
    }
}
