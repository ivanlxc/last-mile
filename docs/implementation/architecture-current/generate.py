"""Generate native, editable draw.io diagrams for implementation e31f794.

No raster objects, Mermaid embeds, or external resources are used in the source.
Preview files are exported with the official draw.io desktop CLI.
"""
from pathlib import Path
from copy import deepcopy
import html
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent
INK = '#182D44'
MUTED = '#53677D'
COLORS = {
    'blue': ('#EDF4FF', '#6187B9'),
    'green': ('#EDF8F3', '#5F9B83'),
    'purple': ('#F3EFFF', '#9376BE'),
    'orange': ('#FFF4E6', '#C79A60'),
    'gray': ('#F2F5F8', '#8B9CAC'),
    'red': ('#FFF0F0', '#C87777'),
}


class Page:
    def __init__(self, name, title, subtitle, height=1280):
        self.name = name
        self.width, self.height = 1680, height
        self.diagram = ET.Element('diagram', id=name, name=title)
        model = ET.SubElement(self.diagram, 'mxGraphModel', dx='1680', dy=str(height),
            grid='1', gridSize='10', guides='1', tooltips='1', connect='1',
            arrows='1', fold='1', page='1', pageScale='1', pageWidth='1680',
            pageHeight=str(height), math='0', shadow='0', background='#FFFFFF')
        self.root = ET.SubElement(model, 'root')
        ET.SubElement(self.root, 'mxCell', id='0')
        ET.SubElement(self.root, 'mxCell', id='1', parent='0')
        self.text('brand', 'LAST MILE  /  IMPLEMENTATION ARCHITECTURE', 40, 22, 1300, 25, 14, MUTED)
        self.text('title', title, 40, 57, 1600, 48, 31, INK, bold=True)
        self.text('subtitle', subtitle, 40, 111, 1600, 30, 17, MUTED)
        self.text('footer', '源码基线：e31f794 · 游戏 v0.3.0 · 2026-09-18   |   实线：运行数据 / 调用；虚线：依赖或返回',
            40, height-42, 1600, 25, 13, MUTED)

    def vertex(self, key, value, x, y, w, h, style):
        cell = ET.SubElement(self.root, 'mxCell', id=key, value=value,
            style=style, vertex='1', parent='1')
        ET.SubElement(cell, 'mxGeometry', x=str(x), y=str(y), width=str(w),
            height=str(h), **{'as': 'geometry'})
        return cell

    def text(self, key, value, x, y, w, h, size=17, color=INK, bold=False, align='left'):
        return self.vertex(key, value, x, y, w, h,
            f'text;html=0;whiteSpace=wrap;align={align};verticalAlign=middle;'
            f'fontColor={color};fontSize={size};fontFamily=Helvetica;'
            f'fontStyle={1 if bold else 0};spacing=0;')

    def group(self, key, label, x, y, w, h, fill='#FAFBFD', stroke='#D8E1EA'):
        self.vertex(key, label, x, y, w, h,
            f'swimlane;html=0;rounded=1;arcSize=8;horizontal=1;startSize=43;'
            f'fillColor={fill};swimlaneFillColor={fill};strokeColor={stroke};'
            f'fontColor={MUTED};fontSize=17;fontFamily=Helvetica;align=left;'
            'spacingLeft=18;fontStyle=1;collapsible=0;')

    def box(self, key, title, lines, x, y, w, h, color='green', file=None):
        fill, stroke = COLORS[color]
        value = '<b style="font-size:21px">' + html.escape(title) + '</b>'
        if lines:
            value += '<br><span style="font-size:17px">' + '<br>'.join(html.escape(s) for s in lines) + '</span>'
        if file:
            value += '<br><span style="font-size:13px;color:'+MUTED+'">' + html.escape(file) + '</span>'
        self.vertex(key, value, x, y, w, h,
            f'rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor={fill};'
            f'strokeColor={stroke};strokeWidth=1.5;fontColor={INK};fontSize=17;'
            'fontFamily=Helvetica;spacing=14;align=center;verticalAlign=middle;')

    def edge(self, key, source=None, target=None, label='', points=None,
             start=None, end=None, exit=None, entry=None, both=False, dashed=False,
             color='#6B7F94', arrow='block', label_y=None):
        style = ('edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;'
            f'html=0;strokeColor={color};strokeWidth=1.6;endArrow={arrow};endFill=1;'
            f'fontColor={MUTED};fontSize=14;fontFamily=Helvetica;labelBackgroundColor=#FFFFFF;'
            'spacing=5;')
        if both:
            style += 'startArrow=block;startFill=1;'
        if dashed:
            style += 'dashed=1;dashPattern=5 4;'
        if exit:
            style += f'exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;'
        if entry:
            style += f'entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;'
        attrs = dict(id=key, value=label, style=style, edge='1', parent='1')
        if source: attrs['source'] = source
        if target: attrs['target'] = target
        cell = ET.SubElement(self.root, 'mxCell', **attrs)
        geo = ET.SubElement(cell, 'mxGeometry', relative='1', **{'as': 'geometry'})
        if label_y is not None: geo.set('y', str(label_y))
        for point, role in [(start, 'sourcePoint'), (end, 'targetPoint')]:
            if point:
                ET.SubElement(geo, 'mxPoint', x=str(point[0]), y=str(point[1]), **{'as': role})
        if points:
            arr = ET.SubElement(geo, 'Array', **{'as': 'points'})
            for x, y in points:
                ET.SubElement(arr, 'mxPoint', x=str(x), y=str(y))


overview = Page('01-system', '01  系统总览', 'React / Three.js + Node.js / Fastify 模块化单体；游戏状态由服务端统一管理。')
overview.group('browser', '浏览器 · 玩家界面', 40, 165, 355, 440)
overview.group('server', 'Node.js 服务端 · 同一应用进程', 460, 165, 750, 980)
overview.box('ui', 'React 游戏界面', ['任务 / 情报 / 调查 / 顾问 / 复盘', 'Three.js 3D 地图 + 2D 回退', '中文 / English'], 65, 230, 305, 155, 'blue', 'client/src/components/')
overview.box('client', 'useGame + API Client', ['状态同步 · SSE · 展示回执'], 65, 470, 305, 100, 'blue', 'client/src/lib/')
overview.box('http', 'Fastify HTTP', ['REST /api/v1 + SSE', '鉴权 · 契约校验 · 静态资源'], 500, 235, 320, 130, file='server/http/app.ts')
overview.box('clock', '调度器 / Scheduler', ['每 1 秒 tick', '命令前补齐到期事件'], 900, 235, 280, 130, 'orange')
overview.box('core', 'CoreGameService · 权威游戏核心', ['命令与版本校验 · 状态机 · 调查与资源 · 路线后果', '公开视图 · AI 任务与调用账本 · 决策快照 · 终局封存'], 500, 455, 680, 145, file='server/core/implementation.ts')
overview.box('world', 'World · 场景规则', ['两套隐藏剧本 / 三个关卡', '路线计划 · 条件等待 · 位置解析'], 500, 725, 300, 145, 'orange', 'server/core/world.ts')
overview.box('ai', 'AI Gateway', ['Advisor / 独立 Evaluator', '白名单输入 · 输出校验 · 降级'], 880, 725, 300, 145, 'purple', 'server/ai/')
overview.box('store', 'Store · 统一存储接口', ['串行操作 / 数据库事务 / 状态、事件、额度与任务持久化'], 500, 1010, 680, 95, 'gray', 'server/core/store.ts')
overview.box('contracts', 'API 接口契约', ['OpenAPI · JSON Schema', '运行时读取的版本化资产'], 40, 665, 355, 140, 'gray', 'docs/engineering_v0.5/')
overview.box('content', '版本化剧情内容', ['campaign-reference / reference-policy', 'public-map / public-actions'], 40, 890, 355, 140, 'orange', 'docs/engineering_v0.5/content/')
overview.text('ext-title', '外部服务 / 部署存储', 1305, 195, 330, 34, 17, MUTED, True)
overview.box('provider', '模型供应商', ['OpenAI / Anthropic', 'HTTPS · 结构化响应'], 1305, 735, 330, 130, 'purple')
overview.box('sqlite', '本地：SQLite', ['本机文件数据库'], 1305, 945, 330, 95, 'gray')
overview.box('pg', '云端：PostgreSQL', ['Render 配置 + Neon 部署说明', '数据库锁保证单个运行引擎'], 1305, 1080, 330, 110, 'gray')
overview.text('offline-note', '本地可离线运行；实时调用失败时\n返回有明确标识的离线模板。', 1305, 595, 330, 85, 16, MUTED)
overview.text('deploy-note', '部署模式来自代码与配置；\n不表示已确认线上服务状态。', 1305, 260, 330, 70, 16, MUTED)
overview.edge('e-ui-client', 'ui', 'client', both=True)
overview.edge('e-client-http', 'client', 'http', points=[(430,520),(430,300)], exit=(1,.5), entry=(0,.5), both=True)
overview.text('rest-label', 'REST\n+ SSE', 395, 392, 65, 50, 14, MUTED, align='center')
overview.edge('e-http-core', 'http', 'core', '命令 / 公开视图', exit=(.5,1), entry=(.235,0), both=True)
overview.edge('e-clock-core', 'clock', 'core', '到期推进', exit=(.5,1), entry=(.794,0))
overview.edge('e-world-core', 'world', 'core', '场景与路线规则', exit=(.5,0), entry=(.22,1))
overview.edge('e-core-ai', 'core', 'ai', '冻结输入 / 校验后结果', exit=(.779,1), entry=(.5,0), both=True)
overview.edge('e-core-store', 'core', 'store', '事务 / 日志', exit=(.5,1), entry=(.5,0), both=True)
overview.edge('e-contracts-http', 'contracts', 'http', points=[(475,735),(475,410),(545,410)], exit=(1,.5), entry=(.14,1), dashed=True)
overview.edge('e-content-world', 'content', 'world', points=[(440,960),(440,797)], exit=(1,.5), entry=(0,.5), dashed=True)
overview.edge('e-ai-provider', 'ai', 'provider', 'HTTPS', exit=(1,.5), entry=(0,.5), both=True)
overview.edge('e-store-sqlite', 'store', 'sqlite', 'local', points=[(1250,1057),(1250,992)], exit=(1,.5), entry=(0,.5), both=True)
overview.edge('e-store-pg', 'store', 'pg', 'cloud', points=[(1230,1080),(1230,1135)], exit=(1,.75), entry=(0,.5), both=True)


boundary = Page('02-information', '02  信息边界与双 AI', '玩家可见、明确上传、行为评价三个输入域分别构造；模型没有完整世界或数据库访问权。', 1320)
boundary.group('advisor-area', '任务中 · Advisor 的授权信息链', 40, 165, 1595, 590)
boundary.group('eval-area', '任务后 · 独立 Evaluator 的行为评价链', 40, 820, 1595, 405)
boundary.box('truth', '服务端私有世界', ['隐藏剧本 A/B · 未揭示证据', '路线条件 · 完整运行状态'], 65, 245, 310, 145, 'orange', 'World + State')
boundary.box('reports', '玩家可见信息', ['到达的报告 · 已揭示来源关系', '任务 / 地图 / 时间 / 资源'], 465, 245, 340, 145, 'blue', 'SessionProjection / ReportView')
boundary.box('uploads', '主动上传快照', ['玩家选择当前关卡报告', '固定 evidence ID + revision'], 895, 245, 300, 145, 'green', 'UploadSnapshot')
boundary.box('input', 'AdvisorInput 白名单', ['已上传报告 + 公开任务 / 背景', '玩家陈述标为 unverified', 'contextVersion + inputHash'], 1285, 245, 315, 145, 'green', 'ai/context.ts')
boundary.box('no-truth', '不进入 Advisor 的信息', ['隐藏真相 / case ID / 未上传报告', '完整私有状态与实时倒计时', '模型不直接决定世界后果'], 65, 535, 310, 155, 'red')
boundary.box('advice-ui', '顾问建议卡片', ['依据 · 引用 · 未知项 · 核查建议', '标明 live_model / offline_template'], 465, 545, 340, 135, 'blue', 'AdvisorPanel.tsx')
boundary.box('guard', '输出与发布检查', ['结构 / 引用 / 语言检查', '场景与上下文仍须有效'], 895, 545, 300, 135, 'green', 'ai/guards.ts + Core.publishJob')
boundary.box('advisor', 'Advisor', ['独立提示词与冻结输入', '异步模型调用 / 离线模板'], 1285, 545, 315, 135, 'purple', 'ai/index.ts')
boundary.edge('b-truth-reports', 'truth', 'reports', '按规则揭示')
boundary.edge('b-reports-uploads', 'reports', 'uploads', '明确选择上传')
boundary.edge('b-uploads-input', 'uploads', 'input', '过滤 / 构造')
boundary.edge('b-input-advisor', 'input', 'advisor', '冻结输入', exit=(.5,1), entry=(.5,0))
boundary.edge('b-advisor-guard', 'advisor', 'guard', '生成输出', exit=(0,.5), entry=(1,.5))
boundary.edge('b-guard-ui', 'guard', 'advice-ui', '有效才发布', exit=(0,.5), entry=(1,.5))
boundary.text('advice-note', '报告到达 ≠ 上传给 AI；来源关系只在已揭示且满足上传条件时进入模型。', 465, 705, 1090, 28, 16, MUTED)
boundary.box('snapshots', '决策时快照', ['已展示 / 已上传的信息', '当时建议 · 操作 · 理由', '展示回执只证明展示'], 65, 915, 310, 160, 'blue', 'decision_snapshots / display_receipts')
boundary.box('facts', '行为事实与评价边界', ['按决策截止时间筛选', '规则生成 facts / contexts / bounds', '排除隐藏真相与结果内容'], 465, 915, 340, 160, 'green', 'ai/facts.ts · buildEvaluatorInput')
boundary.box('evaluator', '独立 Evaluator', ['终局封存后才可请求', '独立输入与提示词', '评价已记录行为'], 895, 915, 300, 160, 'purple', 'EvaluatorInput / Output')
boundary.box('debrief', 'Debrief 复盘', ['行为评价 · 决策回放', '任务结果单独展示', 'JSON 导出'], 1285, 915, 315, 160, 'blue', 'Debrief.tsx')
boundary.box('outcome', '游戏核心计算的 Outcome', [], 65, 1130, 310, 55, 'orange')
boundary.edge('b-snap-facts', 'snapshots', 'facts', '封存后构造')
boundary.edge('b-facts-eval', 'facts', 'evaluator', '允许的事实')
boundary.edge('b-eval-review', 'evaluator', 'debrief', '校验后评价')
boundary.edge('b-outcome-review', 'outcome', 'debrief', '任务结果独立呈现，不输入 Evaluator', points=[(1442,1157)], exit=(1,.5), entry=(.5,1))


sequence = Page('03-sequence', '03  调查、上传与 AI 分析时序', '模型调用在数据库事务之外运行；游戏时间持续推进，过期结果不能覆盖新上下文。', 1510)
xs = [175, 495, 815, 1135, 1455]
titles = [('前端 / 玩家操作','React + useGame','blue'), ('HTTP 接口','Fastify','green'), ('游戏核心 / 调度器','CoreGameService','orange'), ('数据库','SQLite / PostgreSQL','gray'), ('AI Gateway / 模型','Advisor','purple')]
for i, (x, (title, sub, color)) in enumerate(zip(xs, titles)):
    sequence.box(f'p{i}', title, [sub], x-130, 175, 260, 90, color)
    sequence.edge(f'life{i}', start=(x,265), end=(x,1360), dashed=True, color='#C3CDD8', arrow='none')

def msg(key, a, b, y, text, dashed=False):
    sequence.edge(key, start=(xs[a],y), end=(xs[b],y), label=text, dashed=dashed,
        color='#667D94', label_y=-12)

msg('s01',0,1,315,'1  POST /tasks · 幂等键 / 状态版本 / runEpoch')
msg('s02',1,2,375,'2  鉴权与契约校验 → createTask')
msg('s03',2,3,435,'3  事务：任务 + 资源账本 + 事件 + 回执')
msg('s04',1,0,500,'4  202 Accepted · 调查已安排',True)
sequence.box('time-note', '世界时间继续推进', ['调度器检查调查是否到期'], 670, 545, 290, 65, 'orange')
msg('s05',2,3,655,'5  到期后保存报告与公开事件')
msg('s06',2,1,705,'6  发布报告事件')
msg('s07',1,0,755,'7  SSE：report.received / projection.changed',True)
msg('s08',0,1,830,'8  玩家选报告 → POST /uploads')
msg('s09',1,2,880,'9  uploadReports · 检查版本与上传额度')
msg('s10',2,3,930,'10  事务：上传快照 + 输入清单 + queued job')
msg('s11',2,3,980,'11  持久化本次模型调用额度')
msg('s12',2,4,1045,'12  事务外异步调用 · 冻结的 AdvisorInput')
msg('s13',4,2,1110,'13  已校验结果 / 明确标识的离线模板',True)
msg('s14',2,3,1175,'14  上下文仍有效才保存并发布')
msg('s15',2,1,1235,'15  advice.updated')
msg('s16',1,0,1295,'16  SSE：更新顾问建议',True)
sequence.box('idem-note', '重复请求', ['同一幂等键返回原结果，避免重复扣费 / 执行'], 45, 1390, 640, 65, 'gray')
sequence.box('stale-note', '场景变更 / 上下文更新 / 任务结束', ['保留调用账本；不发布晚到的 Advisor 结果'], 745, 1390, 840, 65, 'gray')

pages = [overview, boundary, sequence]

def save(path, diagrams):
    root = ET.Element('mxfile', host='app.diagrams.net', version='31.4.5', type='device')
    for d in diagrams:
        root.append(deepcopy(d))
    ET.indent(root, space='  ')
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)

save(OUT / 'LAST_MILE_Current_Architecture.drawio', [p.diagram for p in pages])
for p in pages:
    save(OUT / f'{p.name}.drawio', [p.diagram])
    ids = [c.attrib['id'] for c in p.root.findall('mxCell')]
    assert len(ids) == len(set(ids)), f'Duplicate IDs in {p.name}'
    for cell in p.root.findall('mxCell'):
        for attr in ('source', 'target'):
            assert attr not in cell.attrib or cell.attrib[attr] in ids
    print(f'{p.name}: {len(ids)} native cells')
