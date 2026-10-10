# -*- coding: utf-8 -*-
"""从一张"整颗西瓜"的照片里定位瓜的圆心与半径，并裁成正方形素材。

`photo` 模式要求源图里那个物体近似正圆、且圆心/半径给准 —— 给歪了的后果是
球边缘一圈会吸到背景（木桌、藤筐），而且因为球本身还挺好看，很容易漏过去。
所以这里不做"目测估计"，而是：① 用颜色掩膜算面积/质心；② 把拟合出的圆画回图上
让人看一眼确认。

用法: python melon_fit.py <源图> <输出jpg> [--preview out.png]
"""
import sys

import numpy as np
from PIL import Image, ImageDraw

SRC = sys.argv[1]
DST = sys.argv[2]
PREVIEW = None
if '--preview' in sys.argv:
    PREVIEW = sys.argv[sys.argv.index('--preview') + 1]

im = Image.open(SRC).convert('RGB')
W, H = im.size
work = 520
scale = work / max(W, H)
small = im.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.BILINEAR)
a = np.asarray(small, dtype=np.float32)
w, h = small.size
R, G, B = a[..., 0], a[..., 1], a[..., 2]

# 瓜皮是绿的：G 不小于 R、明显高于 B、且不太暗。木桌/藤筐是棕黄（R>G），
# 标签纸是白（三者接近且很亮），都能被这条排除。
mx = a.max(axis=2); mn = a.min(axis=2)
sat = (mx - mn) / np.maximum(mx, 1.0)
mask = (G >= R * 0.98) & (G > B * 1.06) & (G > 55) & (sat > 0.18)

# 只保留中心附近的大连通块：用行/列投影的稳健区间代替连通域标记
ys, xs = np.nonzero(mask)
if len(xs) < 200:
    print('掩膜几乎为空，参数需要调整'); sys.exit(1)
# ⚠️ 别用"到质心距离的分位数"当半径 —— 瓜是**椭圆**（竖长横短），上下两端到质心的
# 距离比左右长得多，分位数一取大，半径就超出瓜的左右边缘，球边上会吸到木桌和藤筐。
# 正解是分别取 x/y 的稳健包围盒，圆心取其中点、半径取**较小的那半边**（内接圆）。
x0p, x1p = np.percentile(xs, [0.6, 99.4])
y0p, y1p = np.percentile(ys, [0.6, 99.4])
cx = float((x0p + x1p) / 2)
cy = float((y0p + y1p) / 2)
r = float(min(x1p - x0p, y1p - y0p) / 2) * 0.985   # 0.985：再让开两像素，吃肉更稳

# 换算回原图
k = 1 / scale
CX, CY, RAD = cx * k, cy * k, r * k
print('原图 %dx%d  圆心 (%.0f, %.0f)  半径 %.0f  (归一化 cx=%.4f cy=%.4f rr=%.4f)'
      % (W, H, CX, CY, RAD, CX / W, CY / H, RAD / min(W, H)))

# 裁出以圆心为中心、边长 2R 的正方形 → 存成 sz 见方，于是 cx=cy=0.5、rr=0.5
SZ = 760
left = CX - RAD
top = CY - RAD
im2 = im.crop((int(round(left)), int(round(top)), int(round(left + 2 * RAD)), int(round(top + 2 * RAD))))
im2 = im2.resize((SZ, SZ), Image.LANCZOS)

# ---- 色调规整：把"棚拍灯"的痕迹压掉
# 原片左上一大片镜面高光是打光灯打出来的。球面重投影会把它当成"瓜皮本身的颜色"
# 搬到球面上，再叠我们自己的高光，结果就是一颗发白的瓜。这里做两件事：
#   ① 高光滚降（只压最亮的 1/4 档，暗部与中间调不动）
#   ② 轻微提饱和，补回"浓绿"
a = np.asarray(im2, dtype=np.float32) / 255.0
a = a * (1.0 - 0.22 * a ** 3)
g = a.mean(axis=2, keepdims=True)
a = np.clip(g + (a - g) * 1.22, 0.0, 1.0)
im2 = Image.fromarray((a * 255.0).astype('uint8'))
im2.save(DST, quality=88, optimize=True)
import os
print('->', DST, im2.size, os.path.getsize(DST) // 1024, 'KB')

if PREVIEW:
    pv = small.copy()
    dr = ImageDraw.Draw(pv)
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 40, 40), width=2)
    dr.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=(255, 40, 40))
    # 再叠一张裁好后的缩略图，方便一起看
    th = im2.copy(); th.thumbnail((260, 260))
    sheet = Image.new('RGB', (pv.width + th.width + 12, max(pv.height, th.height)), (24, 24, 28))
    sheet.paste(pv, (0, 0)); sheet.paste(th, (pv.width + 12, 0))
    sheet.save(PREVIEW)
    print('preview ->', PREVIEW)
