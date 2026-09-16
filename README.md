# 四季羊毛 · 换装互动 — web

## 跑起来

```bash
npm install
npm run dev
```

打开 http://localhost:5173 。摄像头必须走 `localhost` 或 HTTPS，普通内网 HTTP 调不起 `getUserMedia`。

## 当前进度：step 0

全屏摄像头 + 骨骼识别 + 左侧折叠工具栏。还没有任何正式 UI，等 Figma。

- 左边中间的小把手点开工具栏，或按 <kbd>`</kbd>
- `?src=/test/pose-full-body.jpg` 直接喂素材，跳过摄像头。调锚点和现场演示兜底都用它
- 文件可以直接拖到页面上

## 结构

```
src/
  core/
    stage.ts    Fit Best 舞台 + 旋转 / 镜像 + 环境判定
    source.ts   输入源抽象：摄像头 / 本地视频 / 本地图片 / 屏幕捕获 / URL
    vision.ts   wasm 单例，Pose 和 Hand 共用
    pose.ts     MediaPipe Pose Landmarker 封装（33 点）
    hands.ts    MediaPipe Hand Landmarker 封装（21 点 / 手）
    draw.ts     骨骼与手部绘制
  ui/
    toolbar.ts  开发工具栏开合
  styles/
    tokens.css  设计 token 占位，Figma Variables 出来后整体替换
public/
  mediapipe/wasm/   本地 wasm，园区离线部署用
  models/           lite / full / heavy 三个模型
  test/             测试素材
```

## 设计 token

**Figma 是唯一来源。改颜色改 Figma，不要改 CSS。**

文件 `天猫ui` → 变量集合 `AOE / Tokens`。命名机械对应，不留例外：

```
Figma  a/b/c                 ↔  CSS  --a-b-c
color/desk-paper             ↔  --color-desk-paper
color/persona/editor         ↔  --color-persona-editor
space/16                     ↔  --space-16
dev/text/3                   ↔  --dev-text-3
```

三个命名空间：`color/ space/ radius/ font/ motion/ stroke/` 是产品设计系统，`dev/` 是开发工具栏专用（上线前整组删掉），`_legacy/` 是待清理的重复项。

`app.css` 里不允许出现字面量颜色。校验：

```bash
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' src/styles/app.css
```

## 两条约定

**Fit Best，不裁切。** 舞台就是视频矩形本身，居中留边。MediaPipe 的归一化坐标直接乘舞台宽高就是屏幕坐标，没有裁切偏移。留边区域后面会变成「桌面」。

**元素分两类。** `hud/` 屏幕锚定，位置来自 Figma 绝对坐标；`body/` 人体锚定，位置由骨骼点算，Figma 只提供样式。

## 画板与尺寸档

| 环境 | 判定 | 画板 | 档位 |
|---|---|---|---|
| 手机竖屏 | 竖向 & 短边 < 768 | 1080×1920 | compact ×0.85 |
| 平板竖屏 | 竖向 & 短边 ≥ 768 | 1080×1920 | regular ×1 |
| 平板横屏 | 横向 & 短边 < 900 | 1920×1080 | compact ×0.85 |
| 桌面 | 横向 & 短边 ≥ 900 | 1920×1080 | regular ×1 |
| 大屏 kiosk | 横向 & 宽 ≥ 1920 | 1920×1080 | large ×1.15 |

档位以 CSS 变量 `--tier` 暴露，只作用于字号、图标、间距。

## 关键点编号

**身体 33 点**，贴合只用这几个：肩 `11 / 12`，髋 `23 / 24`，膝 `25 / 26`。工具栏里勾「显示关键点编号」可以看全部，对照根目录的 `pose_landmarks_index.png`。

**手部 21 点 / 手**，指尖 `4 / 8 / 12 / 16 / 20`。拇指尖 `4` 和食指尖 `8` 单独标红并连了一条虚线 —— 捏取拖拽和毛线绘画都靠这两点的距离做判定。左右手用不同颜色区分，勾「显示关键点编号」会显示 Left / Right 标签。

Pose 只给到手腕和几个粗略手部点，拿不到手指，所以文件夹停留命中、捏取、绘画必须用 Hand Landmarker。

## 性能

Pose 和 Hand 同时跑会明显吃帧。正式流程里手部识别**只在需要的阶段开**（文件夹选择、拖拽试穿、毛线互动），纯展示阶段关掉。工具栏里的两个「推理」读数分开显示，方便判断瓶颈在哪一边。

注意静态图片走的是 IMAGE 模式，每次都是完整检测、没有帧间跟踪，耗时比实时视频高得多，别拿它的数字判断性能 —— 看摄像头下的 FPS。

## 用 iPhone 当摄像头

macOS + iOS 的连续互通相机会直接作为系统摄像头出现在设备列表里，插上 USB 摄像头、开 OBS / NDI 虚拟摄像头同理，列表会自动刷新。

**拍摄前务必在控制中心关掉「人物居中」和「人像模式」** —— 自动裁切追人会让距离引导失效、骨骼点漂移。

园区版仍然用 USB 摄像头，连续互通会因为手机锁屏或掉线中断，不适合无人值守。
