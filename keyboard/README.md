# voidstar-keyboard

A personalized fork of **[FUTO Keyboard](https://keyboard.futo.org/)** for the Samsung
Galaxy S26 Ultra, built to fix the specific failures of Gboard, SwiftKey, and the
Samsung default keyboard.

> **Status:** R&D staging area. This directory lives on the `claude/android-keyboard-rnd-*`
> branch of `voidstar.sh` only because that was the one writable git target from the
> remote build container — it is **not** meant to ship inside the website. The intended
> home is a dedicated repo (`randbrown/voidstar-keyboard`), created by forking FUTO on
> GitHub. See [Getting this into its own repo](#getting-this-into-its-own-repo).

## Why fork FUTO instead of the others

Your complaints split into two different problems with two different root causes:

| Complaint | Root cause | Who can fix it |
|---|---|---|
| Gboard never learns my phrases; wrong singular/plural; wrong part-of-speech | Prediction is an **n-gram frequency table** — it counts word sequences, it cannot reason about morphology or POS | Only a **language-model**-based keyboard |
| SwiftKey wastes space, no theme I like | UI/UX | Any customizable open keyboard |
| Samsung layout is best but has **no arrow keys**, terrible predictions, fights me | Missing feature + n-gram predictions | Customizable + LM-based keyboard |

Gboard, SwiftKey, Samsung, HeliBoard, and AnySoftKeyboard **all use n-gram dictionary
prediction** — the exact thing you keep fighting. **FUTO is the only mature open base
with a real on-device transformer language model** plus an on-device *personal* model
that fine-tunes on your own typing. That transformer is the expensive, hard-to-build
part, and it's the part that actually fixes your #1 complaint — so we keep it and
re-tune everything around it.

## What this fork changes

FUTO already ships arrow keys, a number row, custom layouts, themes, and the
transformer LM — but several of the things you want are **off by default**. The
personalization is four baked-in default changes
([`patches/0001-voidstar-personalization-defaults.patch`](patches/0001-voidstar-personalization-defaults.patch)):

| Setting (pref key) | FUTO default | voidstar default | Fixes |
|---|---|---|---|
| `pref_enable_arrow_row` | `false` | **`true`** | The Samsung arrow-key gap. Renders a real arrow-key row above the spacebar. |
| `useTransformerFinetuning2` | `false` | **`true`** | "It never learns my phrases." Turns on the **on-device personal LM** that fine-tunes on what you type (while the phone is idle/charging — nothing leaves the device). **This is the big one.** |
| `lm_autocorrect_threshold` | `4.0` | **`8.0`** *(range 0–25)* | "Constantly fighting wrong suggestions." The model now has to be much more confident before it auto-replaces what you actually typed. |
| `binary_dict_result_weight` | `3.4` | **`4.5`** | Wrong singular/plural & part-of-speech. Leans harder on the transformer (which has morphological sense) over the n-gram dictionary. Confirmed direction: this value multiplies the **transformer** suggestion scores (`mScore * weight`); `−∞` = pure dictionary, higher = more transformer. |

All four remain user-adjustable in-app (Settings → Typing, and the autocorrect/weight
sliders under the prediction *Advanced Parameters* dev page) — these just change what a
fresh install starts with, so your daily driver is dialed in from first boot.

### Tuning knobs to experiment with on-device

These are personal-taste dials; start from the defaults above and nudge live:

- **`lm_autocorrect_threshold` (T, 0–25):** higher = fewer/less aggressive
  autocorrections (less fighting), lower = more eager. 8.0 is a deliberately
  conservative starting point — drop toward 5–6 if it stops correcting real typos.
- **`binary_dict_result_weight` (a):** higher = trust the transformer's grammar more
  (better plural/POS, slight risk of occasional odd words); toward `−∞` = pure
  dictionary. Try 4.5 → 6.0 if plural/POS is still wrong.

## Building the APK

> The remote container these files were authored in has **no Android SDK** and is
> firewalled off from `gitlab.futo.org` (several FUTO submodules live there), so the
> build has to happen on your machine. Requirements: Android Studio (or the cmdline
> SDK) + NDK (for the ggml native prediction lib) + Java 21.

```bash
# 1. Fork futo-org/android-keyboard on GitHub -> randbrown/voidstar-keyboard, then:
git clone --recurse-submodules https://github.com/randbrown/voidstar-keyboard.git
cd voidstar-keyboard

# 2. Apply the personalization (pins to FUTO base 8ae14c4, 2026-06-02; see note below)
git apply --3way /path/to/keyboard/patches/0001-voidstar-personalization-defaults.patch

# 3. (optional) add the custom layout canvas
mkdir -p java/assets/layouts/Voidstar
cp /path/to/keyboard/layouts/voidstar.yaml java/assets/layouts/Voidstar/

# 4. Build a debug APK and install on the S26U (USB debugging on)
./gradlew :assembleUnstableDebug   # or the variant your checkout exposes; see ./gradlew tasks
adb install -r java/build/outputs/apk/**/futo-keyboard-*.apk
```

`setup.sh` automates steps 1–3. If the patch context has drifted on a newer FUTO base,
`git apply --3way` will fall back to a 3-way merge; the changes are tiny and the four
anchor strings are documented above for manual reapplication.

## Getting this into its own repo

The build container couldn't create a GitHub repo (the integration token is scoped to
`voidstar.sh` and can't create repos), which is why this is staged here. To give it a
real home:

1. On github.com, **Fork** `futo-org/android-keyboard` and rename it `voidstar-keyboard`
   (keeps the upstream link so you can pull FUTO's updates — it's an active alpha).
2. Copy this `keyboard/` directory's contents (or just the patch + layout) into it, or
   run `setup.sh` against the fresh clone.
3. The personalization commit message and patch are ready to cherry-pick onto a branch.

## License

FUTO Keyboard is under the **FUTO Source First License 1.1** — source-available, not
OSI open source. Personal modification and non-commercial distribution are explicitly
permitted, which covers a personal build for your own phone. Keep FUTO's `LICENSE.md`
and `NOTICE` intact in the fork. This directory adds only a patch + layout + docs and
does not relicense anything.

## Provenance

- Base: `futo-org/android-keyboard` @ `8ae14c4` ("Update submodules", 2026-06-02)
- Layout format: `futo-org/futo-keyboard-layouts` (see its `LayoutSpec.md`)
