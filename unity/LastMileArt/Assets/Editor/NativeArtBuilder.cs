using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace LastMile.Art.Editor
{
    public sealed class NativeArtImporter : AssetPostprocessor
    {
        private void OnPreprocessModel()
        {
            if (assetPath != "Assets/Art/MarketSample.fbx") return;
            var importer = (ModelImporter)assetImporter;
            importer.globalScale = 1;
            importer.useFileScale = true;
            importer.bakeAxisConversion = true;
            importer.importCameras = false;
            importer.importLights = false;
            importer.importAnimation = false;
            importer.importNormals = ModelImporterNormals.Import;
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            importer.isReadable = false;
        }
        private void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith("Assets/Art/Textures/", StringComparison.Ordinal)) return;
            var importer = (TextureImporter)assetImporter;
            importer.maxTextureSize = 2048;
            importer.mipmapEnabled = true;
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.filterMode = FilterMode.Trilinear;
            importer.anisoLevel = 4;
            bool normal = assetPath.Contains("_normal");
            bool rough = assetPath.Contains("_roughness");
            importer.textureType = normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            importer.sRGBTexture = !normal && !rough;
            importer.isReadable = rough;
        }
    }

    public static class NativeArtBuilder
    {
        private const string Generated = "Assets/Generated";
        private const string ScenePath = "Assets/Scenes/MarketArt.unity";
        private const string Fbx = "Assets/Art/MarketSample.fbx";
        [Serializable] private sealed class MaterialManifest { public MaterialRecord[] materials; }
        [Serializable] private sealed class MaterialRecord
        {
            public string name, baseColor, normal, roughnessMap;
            public float[] color;
            public float metallic, roughness, normalScale;
            public bool doubleSided;
        }
        private static Texture2D Texture(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Art/Textures/" + name + ".jpg");
            if (texture == null) throw new InvalidOperationException("Missing source texture: " + name);
            return texture;
        }

        private static void Materials()
        {
            var manifest = JsonUtility.FromJson<MaterialManifest>(File.ReadAllText("Assets/Art/materials.json"));
            var model = AssetDatabase.LoadAssetAtPath<GameObject>(Fbx);
            if (model == null) throw new InvalidOperationException("Run node scripts/prepare-native-art.mjs before opening this project.");
            var importer = (ModelImporter)AssetImporter.GetAtPath(Fbx);
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null) throw new InvalidOperationException("URP Lit shader is not available.");
            foreach (var record in manifest.materials)
            {
                string id = record.name.Substring(0, 2);
                string path = Generated + "/Material-" + id + ".mat";
                var material = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (material == null) { material = new Material(shader); AssetDatabase.CreateAsset(material, path); }
                material.name = record.name;
                material.shader = shader;
                var linear = new Color(record.color[0], record.color[1], record.color[2], record.color[3]);
                material.SetColor("_BaseColor", linear.gamma);
                material.SetFloat("_Metallic", record.metallic);
                material.SetFloat("_Smoothness", 1 - record.roughness);
                material.SetFloat("_Cull", record.doubleSided ? 0 : 2);
                material.SetTexture("_BaseMap", Texture(record.baseColor));
                material.SetTexture("_BumpMap", Texture(record.normal));
                material.SetFloat("_BumpScale", record.normalScale);
                if (!string.IsNullOrEmpty(record.normal)) material.EnableKeyword("_NORMALMAP");
                var roughness = Texture(record.roughnessMap);
                if (roughness != null)
                {
                    // URP Lit uses metallic in R and smoothness in A; source is linear roughness.
                    var packed = new Texture2D(roughness.width, roughness.height, TextureFormat.RGBA32, false, true);
                    var pixels = roughness.GetPixels();
                    for (int i = 0; i < pixels.Length; i++) pixels[i] = new Color(record.metallic, 0, 0, 1 - pixels[i].r * record.roughness);
                    packed.SetPixels(pixels); packed.Apply();
                    string packedPath = Generated + "/Smoothness-" + id + ".png";
                    File.WriteAllBytes(packedPath, packed.EncodeToPNG());
                    UnityEngine.Object.DestroyImmediate(packed);
                    AssetDatabase.ImportAsset(packedPath, ImportAssetOptions.ForceSynchronousImport);
                    var ti = (TextureImporter)AssetImporter.GetAtPath(packedPath);
                    ti.sRGBTexture = false; ti.mipmapEnabled = true; ti.maxTextureSize = 2048; ti.SaveAndReimport();
                    material.SetTexture("_MetallicGlossMap", AssetDatabase.LoadAssetAtPath<Texture2D>(packedPath));
                    material.SetFloat("_Smoothness", 1);
                    material.EnableKeyword("_METALLICSPECGLOSSMAP");
                }
                var sources = model.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials)
                    .Where(m => m != null && m.name.StartsWith(id, StringComparison.Ordinal)).GroupBy(m => m.name).Select(g => g.First()).ToArray();
                if (sources.Length == 0) throw new InvalidOperationException("No FBX material matches source ID " + id);
                foreach (var source in sources) importer.AddRemap(new AssetImporter.SourceAssetIdentifier(typeof(Material), source.name), material);
                EditorUtility.SetDirty(material);
            }
            AssetDatabase.SaveAssets(); importer.SaveAndReimport();
            var imported = AssetDatabase.LoadAssetAtPath<GameObject>(Fbx);
            var renderedMaterials = imported.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).ToArray();
            if (renderedMaterials.Any(m => m == null || m.shader != shader))
                throw new InvalidOperationException("FBX material remapping did not resolve every surface to URP Lit.");
            Debug.Log("LAST_MILE_ART_MATERIALS: " + renderedMaterials.Distinct().Count() + " URP materials mapped");
        }

        [MenuItem("Last Mile Art/Prepare Sample")]
        public static void Prepare()
        {
            Directory.CreateDirectory(Generated); Directory.CreateDirectory("Assets/Scenes");
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            Materials();
            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(Generated + "/Renderer.asset");
            if (renderer == null)
            {
                renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
                AssetDatabase.CreateAsset(renderer, Generated + "/Renderer.asset");
            }
            ResourceReloader.ReloadAllNullIn(renderer, "Packages/com.unity.render-pipelines.universal");
            EditorUtility.SetDirty(renderer);
            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(Generated + "/Pipeline.asset");
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                AssetDatabase.CreateAsset(pipeline, Generated + "/Pipeline.asset");
            }
            pipeline.msaaSampleCount = 2; pipeline.renderScale = 1; pipeline.shadowDistance = 35;
            pipeline.mainLightShadowmapResolution = 2048;
            GraphicsSettings.defaultRenderPipeline = pipeline; QualitySettings.renderPipeline = pipeline;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.companyName = "Last Mile Team"; PlayerSettings.productName = "LAST MILE — Market Art Study";
            PlayerSettings.defaultScreenWidth = 1280; PlayerSettings.defaultScreenHeight = 720;
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.SetScriptingBackend(UnityEditor.Build.NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.SetArchitecture(UnityEditor.Build.NamedBuildTarget.Standalone, 1); // macOS ARM64
            if (!File.Exists(ScenePath)) CreateScene();
            else EditorSceneManager.OpenScene(ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            EditorUtility.SetDirty(pipeline); AssetDatabase.SaveAssets();
            Debug.Log("LAST_MILE_ART_READY: " + ScenePath);
        }

        private static void CreateScene()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var model = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(Fbx));
            model.name = "Authored Market / neutral art";
            foreach (var mesh in model.GetComponentsInChildren<MeshFilter>())
            {
                var collider = mesh.gameObject.AddComponent<MeshCollider>(); collider.sharedMesh = mesh.sharedMesh;
            }
            var shop = model.GetComponentsInChildren<Renderer>().Where(r => r.name.StartsWith("shop", StringComparison.Ordinal)).ToArray();
            if (shop.Length == 0) throw new InvalidOperationException("Imported FBX has no shop geometry; check mesh naming and axis conversion.");
            Bounds bounds = shop[0].bounds; foreach (var item in shop) bounds.Encapsulate(item.bounds);
            if (bounds.size.y < 5 || bounds.size.y > 12) throw new InvalidOperationException("Unexpected import scale: " + bounds);
            var sun = new GameObject("Afternoon sun").AddComponent<Light>();
            sun.type = LightType.Directional; sun.intensity = 2.4f; sun.color = new Color(1, .88f, .73f);
            sun.shadows = LightShadows.Soft; sun.shadowBias = .02f; sun.shadowNormalBias = .2f;
            sun.transform.rotation = Quaternion.Euler(43, -40, 0); RenderSettings.sun = sun;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(.5f, .65f, .8f);
            RenderSettings.ambientEquatorColor = new Color(.44f, .47f, .47f);
            RenderSettings.ambientGroundColor = new Color(.32f, .27f, .21f);
            RenderSettings.fog = true; RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(.68f, .75f, .76f); RenderSettings.fogStartDistance = 30; RenderSettings.fogEndDistance = 90;
            var sky = new Material(Shader.Find("Skybox/Procedural"));
            sky.SetColor("_SkyTint", new Color(.5f, .58f, .65f)); sky.SetFloat("_Exposure", 1.1f);
            AssetDatabase.CreateAsset(sky, Generated + "/Sky.mat"); RenderSettings.skybox = sky;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.Add<Tonemapping>().mode.Override(TonemappingMode.ACES);
            var colors = profile.Add<ColorAdjustments>(); colors.contrast.Override(8); colors.saturation.Override(-7);
            AssetDatabase.CreateAsset(profile, Generated + "/Grade.asset");
            foreach (var component in profile.components) AssetDatabase.AddObjectToAsset(component, profile);
            var volume = new GameObject("Colour and exposure").AddComponent<Volume>(); volume.isGlobal = true; volume.sharedProfile = profile;
            var player = new GameObject("Art observer"); var body = player.AddComponent<CharacterController>();
            body.height = 1.8f; body.radius = .27f; body.center = new Vector3(0, .9f, 0); body.stepOffset = .2f;
            var cameraObject = new GameObject("Player eye"); cameraObject.tag = "MainCamera"; cameraObject.transform.SetParent(player.transform);
            cameraObject.transform.localPosition = Vector3.up * 1.68f;
            var camera = cameraObject.AddComponent<Camera>(); camera.fieldOfView = 65; camera.nearClipPlane = .05f; camera.farClipPlane = 150;
            cameraObject.AddComponent<AudioListener>();
            camera.GetUniversalAdditionalCameraData().renderPostProcessing = true;
            var walk = player.AddComponent<ArtWalkthrough>(); walk.eye = camera;
            walk.home = new Vector3(0, .16f, bounds.center.z + 4);
            walk.lookAt = new Vector3(bounds.center.x, 2.2f, bounds.center.z);
            player.transform.position = walk.home;
            camera.transform.LookAt(walk.lookAt);
            var probe = new GameObject("Courtyard reflection").AddComponent<ReflectionProbe>();
            probe.transform.position = new Vector3(0, 2, bounds.center.z); probe.size = new Vector3(30, 16, 40);
            probe.resolution = 128; probe.mode = ReflectionProbeMode.Realtime; probe.refreshMode = ReflectionProbeRefreshMode.OnAwake;
            EditorSceneManager.SaveScene(scene, ScenePath);
            Debug.Log("LAST_MILE_ART_BOUNDS: " + bounds);
        }

        public static void BuildMac()
        {
            Prepare();
            Directory.CreateDirectory("Builds");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
                scenes = new[] { ScenePath }, locationPathName = "Builds/LastMileArt.app",
                target = BuildTarget.StandaloneOSX, options = BuildOptions.Development
            });
            if (report.summary.result != BuildResult.Succeeded) throw new InvalidOperationException("Native build failed: " + report.summary.result);
            Debug.Log("LAST_MILE_ART_BUILD_OK: " + report.summary.totalSize + " bytes");
        }
    }
}
