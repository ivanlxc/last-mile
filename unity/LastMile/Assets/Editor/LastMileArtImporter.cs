using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace LastMile.Editor
{
    // Native FBX import keeps the Web player independent of network/package/runtime glTF loaders.
    public sealed class LastMileArtImporter : AssetPostprocessor
    {
        private const string ArtDirectory = "Assets/Resources/Art";
        private const string FbxPath = ArtDirectory + "/LastMileMap.fbx";

        [Serializable] private sealed class ArtManifest { public ArtMaterial[] materials; }
        [Serializable] private sealed class ArtMaterial
        {
            public string name;
            public float[] color;
            public float roughness;
            public float metallic;
            public string albedoTexture;
            public string normalTexture;
            public float normalScale;
        }

        private void OnPreprocessModel()
        {
            if (assetPath != FbxPath) return;
            var importer = (ModelImporter)assetImporter;
            importer.globalScale = 1;
            importer.useFileScale = true;
            importer.bakeAxisConversion = true;
            importer.preserveHierarchy = true;
            importer.importCameras = false;
            importer.importLights = false;
            importer.importAnimation = false;
            importer.addCollider = false;
            importer.isReadable = false;
            importer.importNormals = ModelImporterNormals.Import;
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
        }

        private void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith(ArtDirectory + "/textures/", StringComparison.Ordinal)) return;
            var importer = (TextureImporter)assetImporter;
            importer.maxTextureSize = 1024;
            importer.mipmapEnabled = true;
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.filterMode = FilterMode.Trilinear;
            if (Path.GetFileNameWithoutExtension(assetPath).EndsWith("_Normal", StringComparison.Ordinal))
            {
                importer.textureType = TextureImporterType.NormalMap;
                importer.sRGBTexture = false;
            }
            else importer.sRGBTexture = true;
        }

        [MenuItem("Last Mile/Prepare Blender Art")]
        public static void PrepareArt()
        {
            if (!File.Exists(FbxPath))
                throw new InvalidOperationException("Blender FBX is missing. Run pnpm build:art before building Unity.");
            string textureDirectory = ArtDirectory + "/textures";
            if (Directory.Exists(textureDirectory))
                foreach (var texture in Directory.GetFiles(textureDirectory, "*.png"))
                    AssetDatabase.ImportAsset(texture.Replace('\\', '/'), ImportAssetOptions.ForceSynchronousImport);
            AssetDatabase.ImportAsset(FbxPath, ImportAssetOptions.ForceSynchronousImport);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(FbxPath);
            if (prefab == null) throw new InvalidOperationException("Unity could not import LastMileMap.fbx.");
            var shader = Shader.Find("Standard");
            if (shader == null) throw new InvalidOperationException("Unity's Standard shader is unavailable.");
            string materialDirectory = ArtDirectory + "/Materials";
            Directory.CreateDirectory(materialDirectory);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var importer = (ModelImporter)AssetImporter.GetAtPath(FbxPath);
            string manifestPath = ArtDirectory + "/materials.json";
            if (!File.Exists(manifestPath))
                throw new InvalidOperationException("The Blender material manifest is missing. Export art again.");
            var manifest = JsonUtility.FromJson<ArtManifest>(File.ReadAllText(manifestPath));
            var authoredMaterials = manifest.materials.ToDictionary(material => material.name);
            var sourceMaterials = prefab.GetComponentsInChildren<Renderer>(true)
                .SelectMany(renderer => renderer.sharedMaterials).Where(material => material != null)
                .GroupBy(material => material.name).Select(group => group.First()).ToArray();
            foreach (var source in sourceMaterials)
            {
                string name = source.name.Replace(" (Instance)", "");
                string safeName = string.Concat(name.Select(character => char.IsLetterOrDigit(character) || character == '_' || character == '-' ? character : '_'));
                string materialPath = materialDirectory + "/" + safeName + ".mat";
                var material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                if (material == null)
                {
                    material = new Material(source) { name = name, shader = shader };
                    AssetDatabase.CreateAsset(material, materialPath);
                }
                else material.shader = shader;
                authoredMaterials.TryGetValue(name.Split('.')[0], out ArtMaterial authored);
                string albedoPath = authored == null ? "" : authored.albedoTexture;
                string normalPath = authored == null ? "" : authored.normalTexture;
                var albedo = string.IsNullOrEmpty(albedoPath) ? null :
                    AssetDatabase.LoadAssetAtPath<Texture2D>(ArtDirectory + "/" + albedoPath);
                var normal = string.IsNullOrEmpty(normalPath) ? null :
                    AssetDatabase.LoadAssetAtPath<Texture2D>(ArtDirectory + "/" + normalPath);
                if (authored != null && authored.color != null && authored.color.Length >= 4)
                    material.SetColor("_Color", new Color(authored.color[0], authored.color[1], authored.color[2], authored.color[3]));
                if (albedo != null)
                {
                    material.SetTexture("_MainTex", albedo);
                    // Authored albedo textures include their base color.
                    material.SetColor("_Color", Color.white);
                }
                if (normal != null)
                {
                    material.SetTexture("_BumpMap", normal);
                    material.SetFloat("_BumpScale", authored == null ? 0.65f : authored.normalScale);
                    material.EnableKeyword("_NORMALMAP");
                }
                material.SetFloat("_Glossiness", authored == null ? 0.17f : 1 - authored.roughness);
                material.SetFloat("_Metallic", authored == null ? 0 : authored.metallic);
                EditorUtility.SetDirty(material);
                importer.AddRemap(new AssetImporter.SourceAssetIdentifier(typeof(Material), name), material);
            }
            AssetDatabase.SaveAssets();
            importer.SaveAndReimport();
            ValidateArt();
        }

        public static void ValidateArt()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(FbxPath);
            var map = JsonUtility.FromJson<PublicMap>(Resources.Load<TextAsset>("PublicMap").text);
            var transforms = prefab.GetComponentsInChildren<Transform>(true);
            foreach (string id in new[] { "N00", "N01", "N07" })
            {
                var anchor = transforms.FirstOrDefault(item => item.name == "LM_ANCHOR_" + id);
                var node = map.nodes.First(item => item.nodeId == id);
                Vector3 expected = new Vector3(node.position.x, node.position.y, -node.position.z);
                if (anchor == null || Vector3.Distance(anchor.position, expected) > 0.025f)
                    throw new InvalidOperationException("Blender / Unity coordinate mismatch at " + id +
                        ": expected " + expected + ", received " + (anchor == null ? "missing anchor" : anchor.position.ToString()) +
                        ". Check FBX axis conversion and unit scale.");
            }
            for (int i = 1; i <= 3; i++)
            {
                string actor = "LM_CONVOY_" + i.ToString("00");
                var model = transforms.FirstOrDefault(item => item.name == actor);
                if (model == null) throw new InvalidOperationException("Missing authored convoy actor: " + actor);
                if (model.GetComponentsInChildren<Transform>().Count(item => item.name.StartsWith("LM_WHEEL_", StringComparison.Ordinal)) < 4)
                    throw new InvalidOperationException("Authored convoy actor must retain at least four wheel pivots: " + actor);
            }
            int triangles = prefab.GetComponentsInChildren<MeshFilter>(true).Sum(filter => filter.sharedMesh == null ? 0 :
                Enumerable.Range(0, filter.sharedMesh.subMeshCount).Sum(index => (int)filter.sharedMesh.GetIndexCount(index) / 3));
            Debug.Log("Blender art validated: " + prefab.GetComponentsInChildren<MeshRenderer>(true).Length +
                " renderers, " + triangles + " triangles; three convoy actors and map anchors match the public route contract.");
        }
    }
}
