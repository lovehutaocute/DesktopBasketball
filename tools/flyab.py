#!/usr/bin/env python3
"""tools/flyab.py -- pair a screen-capture burst with the app's FLYSTATE log and
score the lead-on / lead-off arms of the "ball clipped while flying" fix.

WHY THIS EXISTS
  The --fly-test fixture drives ball 0 around an ellipse and writes its position
  to runtime.log every 100 ms (FLYSTATE). tools/screencap.ps1 grabs the real
  screen in a separate process and stamps each frame with an offset from its own
  START wall-clock. Neither side knows about the other, so a frame can only be
  scored if it is paired with the ball position that was true when it was taken.

  webContents.capturePage() is useless here (it reads the renderer's own
  composite and cannot see SetWindowRgn at all -- 43/43 frames were complete
  discs while the real screen showed half-moons). So the whole verdict rests on
  getting this pairing right.

PAIRING RULES
  * frame time = START + t_ms (t is stamped BEFORE CopyFromScreen, so it is the
    capture instant, not the post-encode instant). Ignore that and every frame
    looks ~70 ms late.
  * the ball position is INTERPOLATED between the two FLYSTATE samples that
    bracket the frame. Snapping to the nearest one instead is not good enough:
    the log is only 100 ms apart and the ball does 1300 px/s, so a snap can be
    65 px off -- wide enough to push the ball half out of the scanner's crop box
    and fake a "clipped" reading. Linear interpolation of the ellipse over 100 ms
    is accurate to about (1/8)*omega^2*r*dt^2 ~= 6 px.
  * drop frames with no bracketing pair, or with a bracket wider than --max-gap.
  * drop frames within +/- --edge ms of a FLYLEAD toggle: at the boundary the
    region is mid-flip and the frame does not belong cleanly to either arm.
  * CopyFromScreen itself trails the desktop by ~30-45 ms, so a residual of that
    order is measurement floor, not a defect.

USAGE
  # 1) build the manifest the scanner will eat
  python tools/flyab.py --log %APPDATA%/DesktopBasketball/runtime.log \
      --shots tools/shots/shots.txt --manifest tools/shots/burst/manifest.csv

  # 2) score it
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/flyscan.ps1 `
      -Manifest tools/shots/burst/manifest.csv -R 34 -Box 100 > tools/shots/flyscan.txt

  # 3) join
  python tools/flyab.py --report tools/shots/flyscan.txt --manifest tools/shots/burst/manifest.csv

THE METRIC
  "ratio" = the ball's extent along its direction of travel divided by its extent
  across that direction. A window region that lags a fast ball bites its leading
  edge, which shortens the along-travel extent while leaving the across-travel one
  alone, so the ratio drops. An undamaged ball measures ~0.97 here at every speed
  from 600 to 1400 px/s, which makes the verdict independent of ball radius, of
  the sprite's dark limb (which shaves a fixed ~7% off both extents equally) and
  of the ball's spin phase.
  Plain pixel counting was tried first and abandoned: the seam band splits the
  orange into pieces whose sizes swing 2x with the spin phase, so a visually
  perfect disc scored "0.39 of a disc".
"""

import argparse
import bisect
import json
import os
import re
import statistics as st
from datetime import datetime, timezone


TS = re.compile(r"^\[(?P<t>[^\]]+)\]\s+(?P<tag>\S+)\s*(?P<rest>.*)$")
SHOT = re.compile(r"^SHOT\s+(?P<p>\S+)\s+t=(?P<t>-?\d+)ms\s+copy=(?P<c>-?\d+)ms")


def parse_iso(s):
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def load_states(log_path):
    """FLYSTATE lines -> [(t_utc, {...})] plus the FLYLEAD toggle instants."""
    states, leads = [], []
    with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = TS.match(line.strip())
            if not m:
                continue
            tag, rest = m.group("tag"), m.group("rest").strip()
            try:
                t = parse_iso(m.group("t"))
            except ValueError:
                continue
            if tag == "FLYSTATE":
                try:
                    states.append((t, json.loads(rest)))
                except json.JSONDecodeError:
                    pass
            elif tag == "FLYLEAD":
                leads.append(t)
    states.sort(key=lambda x: x[0])
    leads.sort()
    return states, leads


def load_shots(shots_path):
    """screencap stdout -> (start_utc, [(path, t_ms, copy_ms)])."""
    start, shots = None, []
    root = os.path.dirname(os.path.abspath(shots_path))
    with open(shots_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("START "):
                start = parse_iso(line[6:])
                continue
            m = SHOT.match(line.strip())
            if m:
                p = m.group("p").replace("\\", "/")
                shots.append((p, int(m.group("t")), int(m.group("c"))))
    return start, shots, root


def nearest(states, times, t):
    """Interpolate the ball state at time t from the two bracketing FLYSTATE lines.

    Returns (state_dict, bracket_ms) or (None, None) when t is not bracketed.
    A 100 ms linear interpolation of the elliptical track is accurate to a few px;
    snapping to the nearest sample instead can be 65 px off at 1300 px/s.
    """
    i = bisect.bisect_left(times, t)
    if i <= 0 or i >= len(states):
        return None, None
    t0, d0 = states[i - 1]
    t1, d1 = states[i]
    span = (t1 - t0).total_seconds() * 1000.0
    if span <= 0 or span > 250.0:
        return None, None
    f = (t - t0).total_seconds() * 1000.0 / span
    out = {"lead": int(d0.get("lead", 1))}
    for k in ("x", "y", "vx", "vy", "speed"):
        a, b = d0.get(k), d1.get(k)
        if a is None or b is None:
            return None, None
        out[k] = a + (b - a) * f
    return out, span


def cmd_manifest(a):
    states, leads = load_states(a.log)
    start, shots, _ = load_shots(a.shots)
    if not states:
        raise SystemExit("no FLYSTATE in %s -- did the app actually run --fly-test?" % a.log)
    if start is None or not shots:
        raise SystemExit("no START/SHOT in %s -- did screencap.ps1 actually run?" % a.shots)

    os.makedirs(os.path.dirname(os.path.abspath(a.manifest)), exist_ok=True)
    times = [s[0] for s in states]
    pairs, dropped = [], 0
    with open(a.manifest, "w", encoding="utf-8", newline="") as fh:
        for path, t_ms, copy_ms in shots:
            t = datetime.fromtimestamp(start.timestamp() + t_ms / 1000.0, tz=timezone.utc)
            st_d, span = nearest(states, times, t)
            if st_d is None:
                dropped += 1
                continue
            if st_d.get("speed", 0) < a.min_speed:
                dropped += 1
                continue
            # ms since the nearest lead toggle; 1e9 means "no toggle has happened yet"
            edge = min([abs((t - L).total_seconds() * 1000.0) for L in leads], default=1e9)
            if edge < a.edge:
                dropped += 1
                continue
            pairs.append({
                "file": os.path.abspath(path),
                "t": t.isoformat(),
                "lead": int(st_d.get("lead", 1)),
                "bx": round(st_d["x"]), "by": round(st_d["y"]),
                "vx": round(st_d.get("vx", 0)), "vy": round(st_d.get("vy", 0)),
                "speed": round(st_d.get("speed", 0)),
                "span_ms": round(span, 1),
                "edge_ms": round(edge, 1),
                "copy_ms": copy_ms,
            })
            fh.write("%s,%d,%d,%d,%d\n" % (os.path.abspath(path), round(st_d["x"]),
                                           round(st_d["y"]), round(st_d.get("vx", 0)),
                                           round(st_d.get("vy", 0))))

    with open(a.manifest + ".pairs.json", "w", encoding="utf-8") as fh:
        json.dump(pairs, fh, indent=1)

    spans = [p["span_ms"] for p in pairs]
    edges = [p["edge_ms"] for p in pairs]
    print("PAIR  kept=%d dropped=%d  (log states=%d, shots=%d, toggles=%d)"
          % (len(pairs), dropped, len(states), len(shots), len(leads)))
    if spans:
        print("PAIR  interp bracket  median=%.0fms  max=%.0fms  (lerp error ~<=6px)"
              % (st.median(spans), max(spans)))
        print("PAIR  distance to nearest toggle  min=%.0fms  median=%.0fms"
              % (min(edges), st.median(edges)))
    arm = {}
    for p in pairs:
        arm[p["lead"]] = arm.get(p["lead"], 0) + 1
    print("PAIR  lead steps: " + "  ".join("%s=%d" % (k, arm[k]) for k in sorted(arm)))


def read_text(path):
    """Read a text file whose encoding we do not control.

    flyscan.ps1's output normally reaches the disk through PowerShell's `*>`
    redirection, which writes UTF-16LE by default. A BOM check is cheaper than
    another round of "why did the parser find zero frames".
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    return raw.decode("utf-8", errors="replace")


def cmd_report(a):
    with open(a.manifest + ".pairs.json", "r", encoding="utf-8") as fh:
        pairs = json.load(fh)
    by_name = {os.path.basename(p["file"]): p for p in pairs}

    rows = []
    blanks = set()
    for line in read_text(a.report).splitlines():
        if not line.startswith("FRAME "):
            continue
        parts = line.split()
        name = parts[1]
        kv = {}
        for tok in parts:
            if "=" in tok:
                k, v = tok.split("=", 1)
                kv[k] = v
        p = by_name.get(name)
        if p is None:
            continue
        if "upx" not in kv:
            continue  # MISSING
        # Blank-frame guard (see flyscan.ps1's lit= doc). A black capture has
        # upx=0, which reads as "the region ate the whole ball" -- but it is a
        # capture failure, not a verdict. Drop it here, before it can skew the
        # dose-response table, and say how many were dropped.
        lit = int(kv.get("lit", 100))
        if lit < a.lit_min:
            blanks.add(name)
            continue
        speed = p["speed"] or 0.0
        d_par = float(kv["dPar"])
        d_perp = float(kv["dPerp"])
        upx = int(kv["upx"])
        # Two segmentations, two metrics (see flyscan.ps1's header):
        #
        # magenta (--fly-flat): the fixture draws the ball as a flat magenta disc,
        #   which nothing else on screen matches. So upx is the disc's true area
        #   and "fill" = upx / (pi r^2) is exact: 1.00 undamaged, lower when the
        #   window region takes a bite. This is the metric to quote.
        #
        # orange: the baked seam band splits the disc into pieces whose sizes swing
        #   2x with the spin phase, so a plain area test is meaningless there. Use
        #   the shape instead: extent along travel / extent across travel, ~0.97 on
        #   an undamaged ball at every speed from 600 to 1400 px/s.
        fill = upx / (3.141592653589793 * a.ball_r * a.ball_r)
        rows.append({
            "name": name, "lead": p["lead"], "span": p["span_ms"],
            "edge": p["edge_ms"],
            "speed": speed, "bx": p["bx"], "by": p["by"],
            "upx": upx,
            "b1": int(kv.get("b1", 0)),
            "b2": int(kv.get("b2", 0)),
            "b3": int(kv.get("b3", 0)),
            "dPar": d_par, "dPerp": d_perp,
            "fill": fill,
            "ratio": d_par / d_perp if d_perp > 0 else 1.0,
            "d": float(kv.get("dCent", 0)),
            "fb": 1 if "fb=1" in kv else 0,
        })

    if not rows:
        raise SystemExit("no scorable frames -- check flyscan.ps1 output")

    if blanks:
        print("BLANK %d frame(s) dropped (lit < %d%%, i.e. the capture came back black):"
              % (len(blanks), a.lit_min))
        print("      " + " ".join(sorted(blanks)))

    off = [r["d"] for r in rows]
    bad_pair = [r for r in rows if r["d"] > a.max_off or r["fb"]]
    print("PAIR  |detected - predicted|  median=%.1fpx  p90=%.1fpx  max=%.1fpx  (> %d px: %d rows)"
          % (st.median(off), sorted(off)[int(len(off) * 0.9)], max(off), a.max_off, len(bad_pair)))
    if bad_pair:
        print("PAIR  WARNING these rows are misaligned and are excluded:")
        for r in bad_pair:
            print("        %s d=%.0fpx span=%sms edge=%sms%s" % (r["name"], r["d"], r["span"], r["edge"],
                                                                " (no blob near centre)" if r["fb"] else ""))
    rows = [r for r in rows if r["d"] <= a.max_off and not r["fb"]]
    if not rows:
        raise SystemExit("all rows misaligned -- do not draw any conclusion")

    mag = (a.mode == "magenta")
    if mag:
        metric, cut = "fill", a.fill_min

        def score(r):
            return r["fill"]
    else:
        # A union that swallowed a second orange object (tray icon, hoop rim,
        # a run of red syntax highlighting) shows up as a dPerp far off the
        # burst's own norm -- the ball's across-travel extent is a property of
        # the sprite, not of the flight. Drop those rows rather than let them
        # invent a "clipped" verdict.
        med_perp = st.median([r["dPerp"] for r in rows])
        odd_name = {r["name"] for r in rows if not (0.88 * med_perp <= r["dPerp"] <= 1.12 * med_perp)}
        if odd_name:
            print("SIZE  dPerp median=%.1fpx; dropping %d row(s) whose union is not a ball:" % (med_perp, len(odd_name)))
            for r in rows:
                if r["name"] in odd_name:
                    print("        %s dPar=%.0f dPerp=%.0f upx=%d b=%d/%d/%d" %
                          (r["name"], r["dPar"], r["dPerp"], r["upx"], r["b1"], r["b2"], r["b3"]))
            rows = [r for r in rows if r["name"] not in odd_name]
        if not rows:
            raise SystemExit("nothing left after the size filter")
        metric, cut = "ratio", a.min_ratio

        def score(r):
            return r["ratio"]

    sc = sorted(score(r) for r in rows)
    print("CALIB %s  p10=%.3f  p50=%.3f  p90=%.3f  max=%.3f"
          % (metric, sc[int(len(sc) * 0.1)], st.median(sc), sc[int(len(sc) * 0.9)], max(sc)))
    if mag:
        print("VERDICT clipped if %s < %.2f   (a flat magenta disc is exactly pi*r^2 pixels;"
              " antialiasing costs ~1%%, and only the window region can remove more)" % (metric, cut))
    else:
        print("VERDICT clipped if %s < %.2f   (undamaged ball = 0.97..1.03 at every speed"
              " from 600 to 1400 px/s); use magma mode for numbers worth quoting" % (metric, cut))
    print()

    def verdict(r):
        return "CLIPPED" if score(r) < cut else "ok"

    print("%-12s %-4s %-6s %-7s %-6s %-6s %-6s %-6s %s"
          % ("frame", "lead", "speed", "fill", "dPar", "dPerp", "ratio", "d", "verdict"))
    for r in sorted(rows, key=lambda x: x["name"]):
        print("%-12s %-4d %-6.0f %-7.3f %-6.0f %-6.0f %-6.2f %-6.0f %s"
              % (r["name"], r["lead"], r["speed"], r["fill"], r["dPar"], r["dPerp"],
                 r["ratio"], r["d"], verdict(r)))

    print()
    print("DOSE-RESPONSE  (lead = ball-disc lead in physics steps; 0 = the old fixed circle)")
    print("%-6s %-4s %-7s %-9s %-9s %-9s %-9s %s"
          % ("lead", "n", "speed", "fillMed", "fillP10", "fillMin", "ratioMed", "clipped%"))
    for lead in sorted({r["lead"] for r in rows}):
        sel = [r for r in rows if r["lead"] == lead]
        fl = sorted(r["fill"] for r in sel)
        bad = [r for r in sel if verdict(r) == "CLIPPED"]
        print("%-6d %-4d %-7.0f %-9.3f %-9.3f %-9.3f %-9.2f %.0f%%"
              % (lead, len(sel), st.median([r["speed"] for r in sel]),
                 st.median(fl), fl[max(0, int(len(fl) * 0.1))], min(fl),
                 st.median([r["ratio"] for r in sel]),
                 100.0 * len(bad) / len(sel)))

    allbad = [r for r in rows if verdict(r) == "CLIPPED"]
    print()
    print("worst frames  (%d/%d = %.0f%% of all scorable frames)"
          % (len(allbad), len(rows), 100.0 * len(allbad) / len(rows)))
    for r in sorted(allbad, key=score)[:14]:
        print("      lead=%-2d %s fill=%.3f ratio=%.2f dPar=%-5.0f dPerp=%-5.0f speed=%-5.0f upx=%-5d src=%d,%d d=%.0f"
              % (r["lead"], r["name"], r["fill"], r["ratio"], r["dPar"], r["dPerp"], r["speed"],
                 r["upx"], r["bx"], r["by"], r["d"]))


def cmd_probe(a):
    """Interpret a --fly-probe run: the magenta blob IS the window region circle.

    With the fixture drawing a 400 px magenta disc, the visible magenta is
    region ∩ disc, and the region circle is always small enough to sit entirely
    inside that disc -- so the blob's area gives the region radius and its
    centroid gives the region's centre. Comparing that centre with the ball's
    logged position yields the pipeline lag directly, with no inference from how
    the ball looks. This is what settles "how late is SetWindowRng really?".
    """
    with open(a.manifest + ".pairs.json", "r", encoding="utf-8") as fh:
        pairs = json.load(fh)
    by_name = {os.path.basename(p["file"]): p for p in pairs}

    step_s = 1.0 / 60.0
    rows = []
    blanks = set()
    for line in read_text(a.report).splitlines():
        if not line.startswith("FRAME "):
            continue
        parts = line.split()
        name = parts[1]
        kv = {}
        for tok in parts:
            if "=" in tok:
                k, v = tok.split("=", 1)
                kv[k] = v
        p = by_name.get(name)
        if p is None or "upx" not in kv:
            continue
        upx = int(kv["upx"])
        if upx <= 0:
            # Blank captures land here too (upx=0); count them separately so a
            # display hiccup is never read as "the region hid the whole ball".
            if int(kv.get("lit", 100)) < a.lit_min:
                blanks.add(name)
            continue
        sp = p["speed"] or 1.0
        reg_r = (upx / 3.141592653589793) ** 0.5
        lag_px = float(kv.get("dCent", 0))
        cx, cy = kv["centroid"].split(",")
        rows.append({
            "name": name, "lead": p["lead"], "speed": sp,
            "regR": reg_r,
            # region radius is grab + |v|*lead*step, so the slope of (regR-46) vs
            # speed is exactly the lead the renderer actually applied
            "lead_s": (reg_r - a.grab_pad - a.ball_r) / sp if sp > 1 else 0.0,
            "lag_px": lag_px, "lag_ms": lag_px / sp * 1000.0 if sp > 1 else 0.0,
            "bx": p["bx"], "by": p["by"],
            "cxx": float(cx), "cyy": float(cy),
        })

    if not rows:
        raise SystemExit("no scorable probe frames")

    if blanks:
        print("BLANK %d frame(s) dropped (lit < %d%%, i.e. the capture came back black):"
              % (len(blanks), a.lit_min))
        print("      " + " ".join(sorted(blanks)))

    print("PROBE  %d frame(s)   grab = ballRadius(%g) + GRAB_PAD(%g) = %g"
          % (len(rows), a.ball_r, a.grab_pad, a.ball_r + a.grab_pad))
    print()
    print("%-6s %-4s %-8s %-9s %-11s %-12s %-10s" %
          ("lead", "n", "speedMed", "regRMed", "measuredLead", "expectedLead", "lagMed"))
    for lead in sorted({r["lead"] for r in rows}):
        sel = [r for r in rows if r["lead"] == lead]
        sp = [r["speed"] for r in sel]
        lsd = [r["lead_s"] for r in sel]
        lag = [r["lag_ms"] for r in sel]
        print("%-6d %-4d %-8.0f %-9.1f %-11s %-12s %-10s"
              % (lead, len(sel), st.median(sp), st.median([r["regR"] for r in sel]),
                 "%.1fms" % (1000 * st.median(lsd)),
                 "%.1fms" % (1000 * lead * step_s),
                 "%.1fms" % st.median(lag)))
    print()
    lag = sorted(r["lag_ms"] for r in rows)
    lpx = sorted(r["lag_px"] for r in rows)
    print("LAG   region centre vs ball position (measured, not inferred)")
    print("      ms : p10=%.1f  p50=%.1f  p90=%.1f  max=%.1f"
          % (lag[int(len(lag) * .1)], st.median(lag), lag[int(len(lag) * .9)], max(lag)))
    print("      px : p10=%.1f  p50=%.1f  p90=%.1f  max=%.1f"
          % (lpx[int(len(lpx) * .1)], st.median(lpx), lpx[int(len(lpx) * .9)], max(lpx)))
    print()
    print("worst 10 by lag:")
    for r in sorted(rows, key=lambda x: -x["lag_ms"])[:10]:
        print("      lead=%-2d %s lag=%.0fms (%.0fpx) speed=%-5.0f regR=%-6.1f ball@%d,%d region@%.0f,%.0f"
              % (r["lead"], r["name"], r["lag_ms"], r["lag_px"], r["speed"], r["regR"],
                 r["bx"], r["by"], r["cxx"], r["cyy"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log")
    ap.add_argument("--shots")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--report")
    ap.add_argument("--edge", type=float, default=200.0,
                    help="drop frames within this many ms of a lead toggle")
    ap.add_argument("--min-speed", type=float, default=200.0,
                    help="ignore frames where the ball is not actually flying (px/s)")
    ap.add_argument("--mode", choices=("orange", "magenta", "probe"), default="orange",
                    help="must match the -Mode given to flyscan.ps1; magenta is the exact one."
                         " probe reads a --fly-probe run where the magenta blob is the window"
                         " region itself")
    ap.add_argument("--ball-r", type=float, default=34.0,
                    help="ballRadius from config.json (=ball.r in the renderer); magenta mode uses it")
    ap.add_argument("--grab-pad", type=float, default=12.0,
                    help="GRAB_PAD from the renderer: region radius = ballRadius + GRAB_PAD + lead")
    ap.add_argument("--min-ratio", type=float, default=0.92,
                    help="orange mode: dPar/dPerp below this counts as clipped")
    ap.add_argument("--fill-min", type=float, default=0.95,
                    help="magenta mode: upx/(pi r^2) below this counts as clipped."
                         " A calm run measures 0.982 -- the missing 1.8%% is circle-edge"
                         " antialiasing -- so this threshold means 'lost more than a"
                         " ~7 px deep cap', which is plainly visible on screen")
    ap.add_argument("--max-off", type=float, default=20.0,
                    help="drop rows where the measured blob centre is further than this from the"
                         " interpolated ball position (px) -- those pairings are wrong")
    ap.add_argument("--lit-min", type=int, default=3,
                    help="drop frames whose lit%% (see flyscan.ps1) is below this: a black capture"
                         " has upx=0, which otherwise looks identical to 'the region clipped the"
                         " whole ball away'")
    a = ap.parse_args()
    if a.report:
        if a.mode == "probe":
            cmd_probe(a)
        else:
            cmd_report(a)
    else:
        if not a.log or not a.shots:
            raise SystemExit("--log and --shots are required to build a manifest")
        cmd_manifest(a)


if __name__ == "__main__":
    main()
