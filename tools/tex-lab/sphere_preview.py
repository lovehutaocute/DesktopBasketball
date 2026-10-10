# -*- coding: utf-8 -*-
"""球面材质预览器 —— 与 render.js 里 bakeSphereSkin() 完全同一套公式。

目的：把「源图 + 映射方式」在本机先渲染成球，对着 68px 实际大小看效果，
避免每改一次参数都要启动 Electron 打包截图。Python 版只用于选型，产品代码是 JS。

用法:
  python sphere_preview.py <源图> <mode> <输出.png> [选项]
    mode = equirect | photo | tile
    --center X,Y       photo 模式下物体中心（像素）
    --radius R         photo 模式下物体在源图里的半径（像素）
    --repeat U,V       tile/equirect 模式下的重复次数（默认 1,1）
    --flip             equirect 竖直翻转（有些贴图南北极是反的）
    --spec S           高光强度（默认 0.55）
    --sheen S          柔光强度（默认 0.22）
    --diffuse S        漫反射权重（默认 0.78）
    --ambient S        环境光（默认 0.34）
    --limb S           边缘暗化（默认 0.72）
    --tint RRGGBB      整体染色（与 albedo 相乘）
    --sat S            饱和度倍数（1 = 不变）
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

S = 320
R = S / 2.0
# 与 JS 侧保持一致的常量
L = (-0.42, -0.52, 0.74)
LR = (0.56, 0.60, 0.57)          # 右下反弹光
TAU = math.pi * 2


def norm(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def main():
    src = sys.argv[1]
    mode = sys.argv[2]
    out = sys.argv[3]
    o = {'center': None, 'radius': None, 'repeat': (1.0, 1.0), 'flip': False,
         'spec': 0.55, 'sheen': 0.22, 'diffuse': 0.78, 'ambient': 0.34, 'limb': 0.72,
         'tint': None, 'sat': 1.0}
    i = 4
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == '--center':
            o['center'] = tuple(float(x) for x in sys.argv[i + 1].split(','))
        elif a == '--radius':
            o['radius'] = float(sys.argv[i + 1])
        elif a == '--repeat':
            o['repeat'] = tuple(float(x) for x in sys.argv[i + 1].split(','))
        elif a == '--flip':
            o['flip'] = True
        elif a == '--tint':
            o['tint'] = np.array([int(sys.argv[i + 1][j:j + 2], 16) / 255.0 for j in (0, 2, 4)])
        elif a == '--sat':
            o['sat'] = float(sys.argv[i + 1])
        else:
            o[a.lstrip('-')] = float(sys.argv[i + 1])
        i += 2

    im = Image.open(src).convert('RGB')
    if o['flip']:
        im = im.transpose(Image.FLIP_TOP_BOTTOM)
    W, H = im.size
    if mode == 'photo':
        cx, cy = o['center'] or (W / 2.0, H / 2.0)
        rad = o['radius'] or min(W, H) * 0.46
    a = np.asarray(im, dtype=np.float32)

    Ln = norm(L)
    LRn = norm(LR)
    Hv = norm((Ln[0], Ln[1], Ln[2] + 1.0))

    out_rgba = np.zeros((S, S, 4), dtype=np.uint8)
    yy, xx = np.mgrid[0:S, 0:S]
    nx = (xx + 0.5 - R) / R
    ny = (yy + 0.5 - R) / R
    r2 = nx * nx + ny * ny
    inside = r2 <= 1.0
    nz = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))

    # --- 采样坐标
    if mode == 'photo':
        sx = cx + nx * rad
        sy = cy + ny * rad
    elif mode == 'equirect':
        lon = np.arctan2(nx, np.maximum(nz, 1e-6))
        lat = np.arcsin(np.clip(ny, -1, 1))
        # ⚠️ 屏幕的 ny 向下为正，而等距圆柱贴图的 v=0 在**北**极。
        # 写成 (0.5 - lat/pi) 会把南北极整个倒过来（地球变成南极朝上、木星条带反着转）。
        u = (lon / TAU + 0.5) * o['repeat'][0]
        v = (0.5 + lat / math.pi) * o['repeat'][1]
        sx = u * W
        sy = v * H
    else:  # tile
        lon = np.arctan2(nx, np.maximum(nz, 1e-6))
        lat = np.arcsin(np.clip(ny, -1, 1))
        u = (lon / TAU + 0.5) * o['repeat'][0]
        v = (lat / math.pi + 0.5) * o['repeat'][1]
        sx = u * W
        sy = v * H

    # 双线性采样（x 方向环绕，y 方向 clamp）
    x0 = np.floor(sx - 0.5).astype(np.int32)
    y0 = np.floor(sy - 0.5).astype(np.int32)
    fx = (sx - 0.5) - x0
    fy = (sy - 0.5) - y0
    if mode == 'photo':
        xa = np.clip(x0, 0, W - 1); xb = np.clip(x0 + 1, 0, W - 1)
    else:
        xa = np.mod(x0, W); xb = np.mod(x0 + 1, W)
    ya = np.clip(y0, 0, H - 1); yb = np.clip(y0 + 1, 0, H - 1)

    def px(xi, yi):
        return a[yi, xi]

    fx4 = fx[..., None]
    fy4 = fy[..., None]
    albedo = (px(xa, ya) * (1 - fx4) * (1 - fy4) + px(xb, ya) * fx4 * (1 - fy4) +
              px(xa, yb) * (1 - fx4) * fy4 + px(xb, yb) * fx4 * fy4)

    if o['sat'] != 1.0:
        g = albedo.mean(axis=2, keepdims=True)
        albedo = np.clip(g + (albedo - g) * o['sat'], 0, 255)
    if o['tint'] is not None:
        albedo = albedo * o['tint']

    alb = albedo / 255.0
    ndl = np.clip(nx * Ln[0] + ny * Ln[1] + nz * Ln[2], 0, None)
    ndh = np.clip(nx * Hv[0] + ny * Hv[1] + nz * Hv[2], 0, None)
    # 半兰伯特：直接 clamp 会在球上留一条硬邦邦的明暗界线，照片皮肤尤其出戏
    shade = o['ambient'] + o['diffuse'] * ((ndl + 0.22) / 1.22)
    # 高光分三层：锐利镜面点 + 中等光泽 + 大面积柔光。
    # 只用一层的话，要么是"塑料大头灯"，要么完全没有体积。
    s1 = np.power(ndh, 220.0) * o['spec']
    s2 = np.power(ndh, 26.0) * o['sheen']
    glow = np.power(ndl, 5.0) * 0.05
    rim = np.power(np.clip(nx * LRn[0] + ny * LRn[1] + nz * LRn[2], 0, None), 2.4) * 0.10

    rgb = alb * shade[..., None]
    rgb = rgb + (s1 + s2 + glow)[..., None] * np.array([1.0, 0.985, 0.95])
    rgb = rgb * (1 - rim[..., None]) + rim[..., None] * np.array([1.0, 0.87, 0.68])
    limb = 1.0 - o['limb'] * np.power(np.clip(1.0 - nz, 0, 1), 2.2)
    rgb = rgb * limb[..., None]

    rgb = np.clip(rgb, 0, 1) ** (1 / 1.02)
    img = np.clip(rgb * 255.0, 0, 255)
    # 抗锯齿 alpha：离圆心 1px 内做软过渡
    dist = np.sqrt(r2)
    alpha = np.clip((1.0 - dist) * R / 1.2 + 0.5, 0, 1)
    out_rgba[..., :3] = img.astype(np.uint8)
    out_rgba[..., 3] = (alpha * 255).astype(np.uint8)
    out_rgba[~inside] = 0

    sphere = Image.fromarray(out_rgba, 'RGBA')

    # 拼一张对照：320 原图 / 68px / 68px×4 放大 / 浅底与深底各一
    big = sphere.resize((68, 68), Image.LANCZOS)
    zoom = big.resize((68 * 4, 68 * 4), Image.NEAREST)
    canvas = Image.new('RGB', (S + 68 + 68 * 4 + 40, max(S, 68 * 4) + 20), (240, 240, 244))
    canvas.paste(sphere, (6, 10), sphere)
    for k, (bg, x0) in enumerate([((250, 250, 252), S + 12), ((46, 48, 54), S + 12)]):
        pass
    light = Image.new('RGB', (68, 68), (250, 250, 252)); light.paste(big, (0, 0), big)
    dark = Image.new('RGB', (68, 68), (40, 42, 48)); dark.paste(big, (0, 0), big)
    canvas.paste(light, (S + 12, 10))
    canvas.paste(dark, (S + 12, 86))
    canvas.paste(zoom, (S + 96, 10))
    canvas.save(out)
    print('->', out, canvas.size, 'src', im.size)

    # 顺便报一下球面平均色，方便判断"是不是一片糊"
    m = inside & (nz > 0.35)
    print('   球面平均 RGB %s  饱和 %s' % (
        np.round(img[m].mean(axis=0)).astype(int).tolist(),
        round(float((img[m].max(axis=1) - img[m].min(axis=1)).mean()), 1)))


main()
