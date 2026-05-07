# Gesture math

How four kg-scale floats become "pan north 200 px/sec" or "zoom in at 1.8x speed."

## Inputs per frame

```
TL  TR     ┌────┬────┐
BL  BR     │ TL │ TR │
           ├────┼────┤
           │ BL │ BR │
           └────┴────┘
            (player faces "up")
```

After calibration, each corner is a kg-equivalent number ≥ 0.

## Derived quantities

```
total       = TL + TR + BL + BR
left        = TL + BL
right       = TR + BR
front       = TL + TR
back        = BL + BR
left_share  = left  / total      (0..1)
right_share = right / total      (0..1)
cop_x       = (right - left) / total    (-1..+1)
cop_y       = (front - back) / total    (-1..+1)
```

`cop_*` is what the literature calls "center of pressure": where your
combined body weight is centered on the support surface. It's the cleanest
single signal for tilt direction.

## Mode discrimination

The naive trap: "left foot pushes harder than right" can mean either
"player tilted left" or "player raised their right leg." Both push COP
sideways. The discriminator is `min(left_share, right_share)`:

| Condition                                    | Mode      |
| -------------------------------------------- | --------- |
| `total < 15 kg`                              | `ABSENT`  |
| `left_share  < 0.15`                         | `ZOOM_IN` (left leg up)    |
| `right_share < 0.15`                         | `ZOOM_OUT` (right leg up)  |
| otherwise                                    | `PAN`     |

Tilting still keeps significant weight on both feet (typical tilt: 30/70
split, both shares > 0.15). Lifting a leg drops one side near zero.

## Pan velocity

In `PAN` mode, with deadzone `D = 0.08`:

```
ax = sgn(cop_x) · max(0, |cop_x| - D)
ay = sgn(cop_y) · max(0, |cop_y| - D)
panX = sgn(ax) · ax² · GAIN
panY = -sgn(ay) · ay² · GAIN     // forward = north = up = negative pixel-y
```

The squared response gives fine control near center and accelerates as you
commit to a lean. Linear response felt twitchy in early sketches.

## Zoom velocity + bob scaling

In `ZOOM_IN` / `ZOOM_OUT`, base zoom rate is multiplied by a bob factor
computed from a 1-second rolling window of `total`:

```
amp = max(total) - min(total)   over last 1 s
if amp ≤ 1.5 kg:  scale = 1.0
elif amp ≥ 8 kg:  scale = 3.0
else:             scale = 1.0 + (amp - 1.5)/(8 - 1.5) · (3.0 - 1.0)

zoom_rate = ±0.6 zoom-levels/sec · scale
```

This solves a real failure mode: if zoom were always at full speed when a
leg is raised, you'd overshoot constantly. Bobbing is a deliberate effort —
standing still on one leg is the "slow zoom" gesture, bobbing is "fast
zoom."

## Commit gesture (BalanceGuessr)

Simply **step off the board** — `present` transitions from `true` to
`false`, firing the `footoff` event in `GestureInterpreter`. The game
consumes this event to advance the state machine:

| Phase    | step-off action                |
| -------- | ------------------------------ |
| `STUDY`  | enter `GUESS` (navigate the overview map) |
| `GUESS`  | commit guess → `REVEAL`        |

Stepping **back on** advances `REVEAL → next STUDY` and `SUMMARY → new game`,
so the interaction loop is: stand → look → step off → navigate → step off
→ read results → step back on → repeat.

Tunables (deadzone, bob window, zoom rates, etc.) live in
`web/src/gestures.ts` under `DEFAULTS`. All thresholds are in kg,
fractions, or milliseconds — no magic numbers in raw evdev units.
