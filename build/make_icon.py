from PIL import Image, ImageDraw
import math
S = 2048  # draw big, downsample for smooth edges
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# rounded-square background with vertical gradient
bg = Image.new('RGBA', (S, S))
px = bg.load()
top, bot = (52, 192, 120), (17, 133, 70)
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    for x in range(S):
        px[x, y] = c
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
img.paste(bg, (0, 0), mask)

# foreground in warm gold gradient (applied via mask)
fg = Image.new('L', (S, S), 0)
d = ImageDraw.Draw(fg)
cx, cy = S // 2, int(S * 0.60)
w = int(S * 0.062)

def cap(x, y):
    d.ellipse([x - w // 2, y - w // 2, x + w // 2, y + w // 2], fill=255)

# the "ark": an arched doorway (open at the bottom)
Ra = int(S * 0.30); acy = int(S * 0.44); base = int(S * 0.79)
d.arc([cx - Ra - w // 2, acy - Ra - w // 2, cx + Ra + w // 2, acy + Ra + w // 2], 180, 360, fill=255, width=w)
for sign in (-1, 1):
    lx = cx + sign * Ra
    d.rectangle([lx - w // 2, acy, lx + w // 2, base - w // 2], fill=255)
    d.ellipse([lx - w // 2, base - w, lx + w // 2, base], fill=255)

# the "J" sheltered inside the arch
jw = int(S * 0.078)
hr = int(S * 0.095)
sx = cx + int(S * 0.045)
top = int(S * 0.355); yb = int(S * 0.605)
d.rounded_rectangle([sx - jw // 2, top, sx + jw // 2, yb + jw // 4], radius=jw // 2, fill=255)
hcx = sx - hr
d.arc([hcx - hr - jw // 2, yb - hr - jw // 2, hcx + hr + jw // 2, yb + hr + jw // 2], 0, 180, fill=255, width=jw)
ex = hcx - hr
d.ellipse([ex - jw // 2, yb - jw // 2, ex + jw // 2, yb + jw // 2], fill=255)

gold = Image.new('RGBA', (S, S))
gp = gold.load()
a, b = (255, 255, 255), (222, 243, 230)
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    for x in range(S):
        gp[x, y] = c
img.paste(gold, (0, 0), fg)

master = img.resize((1024, 1024), Image.LANCZOS)
master.save('icon.png')
master.resize((512, 512), Image.LANCZOS).save('icon-512.png')
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
master.save('icon.ico', sizes=sizes)
print('ok')
