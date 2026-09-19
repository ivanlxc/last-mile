Shader "LastMile/MapSurface" {
    Properties { _Color ("Color", Color) = (1,1,1,1) }
    SubShader {
        Tags { "RenderType"="Opaque" }
        Pass {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            fixed4 _Color;
            struct v2f { float4 position : SV_POSITION; float light : TEXCOORD0; };
            v2f vert(appdata_base v) {
                v2f o;
                o.position = UnityObjectToClipPos(v.vertex);
                float3 normal = UnityObjectToWorldNormal(v.normal);
                o.light = 0.66 + 0.34 * max(0, dot(normalize(normal), normalize(float3(-0.5, 1, 0.2))));
                return o;
            }
            fixed4 frag(v2f i) : SV_Target { return fixed4(_Color.rgb * i.light, _Color.a); }
            ENDCG
        }
    }
}
