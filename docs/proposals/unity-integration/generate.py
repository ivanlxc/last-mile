"""Editable draw.io proposal; this does not implement Unity integration."""
from pathlib import Path
import xml.etree.ElementTree as E

base = Path(__file__).resolve().parent
doc = E.Element('mxfile', host='app.diagrams.net', version='31.4.5', type='device')
page = E.SubElement(doc, 'diagram', id='unity-web-proposal', name='Unity Web 接入方案（待实现）')
model = E.SubElement(page, 'mxGraphModel', grid='1', gridSize='10', page='1', pageScale='1', pageWidth='1540', pageHeight='1040', background='#FFFFFF')
root = E.SubElement(model, 'root')
E.SubElement(root, 'mxCell', id='0')
E.SubElement(root, 'mxCell', id='1', parent='0')

def cell(key, value, x, y, w, h, style):
    c = E.SubElement(root, 'mxCell', id=key, value=value, style=style, vertex='1', parent='1')
    E.SubElement(c, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), **{'as':'geometry'})

def text(key, value, x, y, w, h, size=17, bold=False):
    cell(key,value,x,y,w,h,f'text;html=0;whiteSpace=wrap;align=left;fontSize={size};fontFamily=Helvetica;fontColor=#233A50;fontStyle={1 if bold else 0};')

def box(key, value, x, y, w, h, fill, stroke):
    cell(key,value,x,y,w,h,f'rounded=1;arcSize=12;whiteSpace=wrap;html=0;fillColor={fill};strokeColor={stroke};strokeWidth=1.5;fontColor=#233A50;fontSize=19;fontFamily=Helvetica;spacing=16;')

def group(key,label,x,y,w,h):
    cell(key,label,x,y,w,h,'swimlane;horizontal=1;startSize=45;rounded=1;arcSize=8;fillColor=#F8FAFD;swimlaneFillColor=#F8FAFD;strokeColor=#D8E1EA;fontColor=#53677D;fontFamily=Helvetica;fontSize=18;fontStyle=1;align=left;spacingLeft=20;collapsible=0;')

def edge(key,a,b,label='',both=True,exit=None,entry=None):
    style='edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;strokeColor=#6B7F94;strokeWidth=1.6;endArrow=block;endFill=1;fontColor=#53677D;fontFamily=Helvetica;fontSize=15;labelBackgroundColor=#FFFFFF;'
    if both: style += 'startArrow=block;startFill=1;'
    if exit: style += f'exitX={exit[0]};exitY={exit[1]};'
    if entry: style += f'entryX={entry[0]};entryY={entry[1]};'
    c=E.SubElement(root,'mxCell',id=key,value=label,style=style,edge='1',parent='1',source=a,target=b)
    E.SubElement(c,'mxGeometry',relative='1',**{'as':'geometry'})

text('brand','LAST MILE / UNITY INTEGRATION PROPOSAL',40,25,1450,28,14)
text('title','Unity Web 接入方案 · 待实现',40,65,1450,50,31,True)
text('sub','第一阶段：Unity 接管场景呈现与地图交互；React 继续管理网页界面、网络会话与操作提交。',40,120,1450,32,18)
group('browser','浏览器 · React 外壳 + Unity Web',40,180,1450,440)
group('server','现有 Node.js 后端 · 继续作为游戏状态与规则的权威来源',40,665,1450,270)
box('react','保留：React + useGame\n情报 / AI 对话 / 调查 / 复盘\nCookie · REST · SSE · 幂等请求\nTacticalMap 增加 Unity 显示入口',80,245,380,160,'#EDF4FF','#6187B9')
box('bridge','新增：JS ↔ C# Bridge\n公开渲染状态 / 快照恢复\n地图选择与调查意图\nReady / 版本 / 错误处理',590,245,310,160,'#EDF8F3','#5F9B83')
box('unity','新增：Unity Web 场景\n地形 / 车队 / 镜头 / 动画 / 音效\n按服务端位置平滑呈现\n点击实体 → 返回操作意图',1030,245,420,160,'#F3EFFF','#9376BE')
text('bridge-notes','桥接消息是拟新增契约。\nSendMessage：JS → Unity\n.jslib 回调：Unity → JS',590,460,350,95,17)
text('unity-notes','只渲染玩家获准看到的状态。\n不打包隐藏剧本，不自行解锁证据。\nUnity 加载完成后，才允许开始任务。',1030,460,420,105,17)
box('http','Fastify HTTP / 静态托管\n现有鉴权与 API 校验\nUnity 资源 / 响应头 / CSP',80,745,380,135,'#EDF8F3','#5F9B83')
box('core','CoreGameService\n时钟 / 资源 / 调查 / 路线后果\n验证并执行玩家操作',590,745,310,135,'#FFF4E6','#C79A60')
box('existing','复用：AI / 内容 / 数据库\nAdvisor + Evaluator\nWorld + SQLite / PostgreSQL',1030,745,420,135,'#F2F5F8','#8B9CAC')
edge('react-bridge','react','bridge','状态 / 意图')
edge('bridge-unity','bridge','unity','浏览器桥接')
edge('react-http','react','http','现有 REST + SSE',exit=(.5,1),entry=(.5,0))
edge('http-core','http','core','命令 / 视图')
edge('core-existing','core','existing','内部调用')
text('footer','基于当前源码 e31f794 的设计建议 · 2026-09-18  |  尚未新增 Unity 工程，也未修改游戏运行代码。',40,980,1450,35,14)
E.indent(doc,space='  ')
E.ElementTree(doc).write(base/'Unity_Web_Integration_Proposal.drawio',encoding='utf-8',xml_declaration=True)
