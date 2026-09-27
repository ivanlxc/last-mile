using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace LastMile.Art.Editor
{
    // Neutral props only; no report text, scenario flags or case-specific visual clues.
    public static class FieldStationBuilder
    {
        private const string RootName = "Field workstations / v1";
        public static void Ensure()
        {
            if (GameObject.Find(RootName) != null) return;
            var root = new GameObject(RootName);
            var metal = Material("Field-metal", new Color(.16f, .20f, .17f), .65f, .33f);
            var caseMat = Material("Field-cases", new Color(.22f, .27f, .21f), .1f, .25f);
            var wood = Material("Field-wood", new Color(.36f, .25f, .15f), 0, .25f);
            var paper = Material("Field-paper", new Color(.73f, .72f, .61f), 0, .15f);
            var screen = Material("Field-screen", new Color(.09f, .25f, .22f), .2f, .6f);
            // Three compact temporary desks along the existing street. Noah uses the authored radio table.
            Desk(root.transform, new Vector3(4.2f, .16f, 2), "Civil liaison", 1);
            Desk(root.transform, new Vector3(-4.5f, .16f, 9), "Recon console", 2);
            Desk(root.transform, new Vector3(5.3f, .16f, -10), "Convoy command", 3);
            EditorSceneManager.MarkSceneDirty(root.scene);
            EditorSceneManager.SaveScene(root.scene);

            void Desk(Transform parent, Vector3 p, string name, int type)
            {
                var desk = new GameObject(name); desk.transform.SetParent(parent); desk.transform.position = p;
                Box(desk.transform, "weathered table top", new Vector3(0, .77f, 0), new Vector3(1.45f, .07f, 1.9f), wood);
                foreach (float x in new[] { -.61f, .61f }) foreach (float z in new[] { -.81f, .81f })
                    Box(desk.transform, "folding steel leg", new Vector3(x, .37f, z), new Vector3(.038f, .74f, .038f), metal);
                foreach (float x in new[] { -.62f, .62f }) Box(desk.transform, "steel crossbar", new Vector3(x, .24f, 0), new Vector3(.03f, .03f, 1.65f), metal);
                Box(desk.transform, "equipment case", new Vector3(.09f, .19f, .4f), new Vector3(.84f, .35f, .53f), caseMat);
                foreach (float z in new[] { .18f, .62f }) Box(desk.transform, "case reinforcement", new Vector3(.09f, .37f, z), new Vector3(.87f, .035f, .036f), metal);
                for (int i = 0; i < 3; i++) Box(desk.transform, "document stack", new Vector3(-.24f + i * .05f, .815f + i * .009f, -.46f), new Vector3(.42f, .008f, .53f), paper);
                if (type > 1)
                {
                    Box(desk.transform, "rugged terminal base", new Vector3(.10f, .85f, .31f), new Vector3(.55f, .07f, .42f), caseMat);
                    Box(desk.transform, "terminal bezel", new Vector3(.1f, 1.06f, .49f), new Vector3(.57f, .4f, .04f), metal);
                    Box(desk.transform, "inactive display", new Vector3(.1f, 1.06f, .464f), new Vector3(.49f, .31f, .012f), screen);
                    for (int row = 0; row < 4; row++) for (int col = 0; col < 9; col++)
                        Box(desk.transform, "key", new Vector3(-.12f + col * .055f, .89f, .17f + row * .05f), new Vector3(.043f, .008f, .036f), metal, false);
                }
                else
                {
                    Box(desk.transform, "field radio", new Vector3(.1f, .94f, .3f), new Vector3(.35f, .25f, .24f), caseMat);
                    Box(desk.transform, "antenna", new Vector3(.22f, 1.27f, .34f), new Vector3(.015f, .46f, .015f), metal, false);
                    for (int i = 0; i < 6; i++) Box(desk.transform, "speaker grille", new Vector3(.06f + i * .022f, .94f, .17f), new Vector3(.01f, .13f, .01f), metal, false);
                }
            }
        }
        private static Material Material(string name, Color color, float metallic, float smoothness)
        {
            string path = "Assets/Generated/" + name + ".mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) { m = new Material(Shader.Find("Universal Render Pipeline/Lit")); AssetDatabase.CreateAsset(m, path); }
            m.color = color; m.SetFloat("_Metallic", metallic); m.SetFloat("_Smoothness", smoothness); return m;
        }
        private static void Box(Transform parent, string name, Vector3 pos, Vector3 size, Material mat, bool collision = true)
        {
            var box = GameObject.CreatePrimitive(PrimitiveType.Cube); box.name = name;
            box.transform.SetParent(parent); box.transform.localPosition = pos; box.transform.localScale = size;
            box.GetComponent<Renderer>().sharedMaterial = mat;
            if (!collision) Object.DestroyImmediate(box.GetComponent<Collider>());
            box.isStatic = true;
        }
    }
}
