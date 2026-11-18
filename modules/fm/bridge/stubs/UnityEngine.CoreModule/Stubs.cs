// Modèle de compilation : signatures seulement, aucun code du jeu (voir ../Directory.Build.props).
using System;
using Il2CppInterop.Runtime.InteropTypes.Arrays;

namespace UnityEngine
{
    public class Object : Il2CppSystem.Object
    {
        public Object(IntPtr pointer) : base(pointer) { }
        public string name { get => throw null; set => throw null; }
        public HideFlags hideFlags { get => throw null; set => throw null; }
        public static Il2CppArrayBase<T> FindObjectsOfType<T>() where T : Object => throw null;
        public static T Instantiate<T>(T original) where T : Object => throw null;
        public static void DontDestroyOnLoad(Object target) => throw null;
        public static void Destroy(Object obj) => throw null;
    }

    public class Component : Object
    {
        public Component(IntPtr pointer) : base(pointer) { }
    }

    public class Behaviour : Component
    {
        public Behaviour(IntPtr pointer) : base(pointer) { }
    }

    public class MonoBehaviour : Behaviour
    {
        public MonoBehaviour(IntPtr pointer) : base(pointer) { }
    }

    public class ScriptableObject : Object
    {
        public ScriptableObject(IntPtr pointer) : base(pointer) { }
    }

    public sealed class GameObject : Object
    {
        public GameObject(IntPtr pointer) : base(pointer) { }
        public GameObject(string name) : base(IntPtr.Zero) => throw null;
        public T AddComponent<T>() where T : Component => throw null;
    }

    public class Texture : Object
    {
        public Texture(IntPtr pointer) : base(pointer) { }
        public FilterMode filterMode { get => throw null; set => throw null; }
    }

    public sealed class Texture2D : Texture
    {
        public Texture2D(IntPtr pointer) : base(pointer) { }
        public Texture2D(int width, int height, TextureFormat textureFormat, bool mipChain) : base(IntPtr.Zero) => throw null;
    }

    public enum TextureFormat { Alpha8 = 1, RGB24 = 3, RGBA32 = 4, ARGB32 = 5 }
    public enum FilterMode { Point, Bilinear, Trilinear }

    public class RenderTexture : Texture
    {
        public RenderTexture(IntPtr pointer) : base(pointer) { }
    }

    [Flags]
    public enum HideFlags { None = 0, HideInHierarchy = 1, HideInInspector = 2, DontSaveInEditor = 4, NotEditable = 8, DontSaveInBuild = 16, DontUnloadUnusedAsset = 32, DontSave = 52, HideAndDontSave = 61 }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b) => throw null;
        public Color(float r, float g, float b, float a) => throw null;
        public static Color white => throw null;
    }

    public sealed class Time
    {
        public static float unscaledTime => throw null;
    }

    public sealed class Resources
    {
        public static Il2CppArrayBase<T> FindObjectsOfTypeAll<T>() where T : Object => throw null;
    }
}
