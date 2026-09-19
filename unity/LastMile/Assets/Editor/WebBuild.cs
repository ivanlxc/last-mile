using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace LastMile.Editor
{
    public static class WebBuild
    {
        private const string ScenePath = "Assets/Scenes/LastMile.unity";

        [MenuItem("Last Mile/Create or Reset Map Scene")]
        public static void CreateScene()
        {
            if (!Application.isBatchMode && !EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            Directory.CreateDirectory("Assets/Resources");
            Directory.CreateDirectory("Assets/Scenes");
            CreateMaterial("MapSurface", "LastMile/MapSurface");
            CreateMaterial("MapInk", "LastMile/MapInk");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var bridge = new GameObject("LastMileBridge");
            bridge.AddComponent<LastMileBridge>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("Last Mile Blender map scene created. Press Play to inspect geography; live convoy data comes from the browser.");
        }

        private static void CreateMaterial(string name, string shaderName)
        {
            string path = "Assets/Resources/" + name + ".mat";
            var shader = Shader.Find(shaderName);
            if (shader == null) throw new InvalidOperationException("Map shader was not imported: " + shaderName);
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null) existing.shader = shader;
            else AssetDatabase.CreateAsset(new Material(shader), path);
        }

        // Called by scripts/build-unity.mjs. It owns staging and atomically publishes the manifest.
        public static void Build()
        {
            try
            {
                if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL))
                    throw new InvalidOperationException("Web Build Support is missing. Add it to this editor installation in Unity Hub.");
                string destination = Environment.GetEnvironmentVariable("LAST_MILE_UNITY_BUILD_PATH");
                if (string.IsNullOrEmpty(destination) || !Path.IsPathRooted(destination))
                    throw new InvalidOperationException("Use the repository's pnpm build:unity command to select a safe staging directory.");
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
                LastMileArtImporter.PrepareArt();
                CreateScene();
                PlayerSettings.companyName = "Last Mile Team";
                PlayerSettings.productName = "Last Mile";
                PlayerSettings.bundleVersion = "0.1.0";
                PlayerSettings.defaultWebScreenWidth = 1280;
                PlayerSettings.defaultWebScreenHeight = 720;
                PlayerSettings.runInBackground = true;
                // React already provides a loading screen and gates departure on ready.
                PlayerSettings.SplashScreen.show = false;
                // Same-origin local hosting: uncompressed output avoids mismatched Content-Encoding.
                PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
                PlayerSettings.WebGL.decompressionFallback = false;
                PlayerSettings.WebGL.dataCaching = false;
                PlayerSettings.WebGL.threadsSupport = false;
                QualitySettings.antiAliasing = 4;
                QualitySettings.shadows = ShadowQuality.All;
                QualitySettings.shadowResolution = ShadowResolution.High;
                QualitySettings.shadowDistance = 80;
                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath }, locationPathName = destination,
                    target = BuildTarget.WebGL, options = BuildOptions.StrictMode
                });
                if (report.summary.result != BuildResult.Succeeded)
                    throw new InvalidOperationException("Unity Web build failed: " + report.summary.result + ". See the editor build log.");
                Debug.Log("Last Mile Web build completed: " + destination);
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
        }
    }
}
