"""Master a rendered music audition with repeatable fades and matched loudness.

Requires ffmpeg with libmp3lame; Python standard library only.
Usage: python3 scripts/master-music-audition.py score.json input.wav output.mp3
"""
import json
from pathlib import Path
import subprocess
import sys


def measure(args):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", *args],
        check=True, capture_output=True, text=True,
    )
    start = result.stderr.rfind("{\n")
    if start < 0:
        raise RuntimeError("Missing loudness report")
    return json.loads(result.stderr[start:result.stderr.find("}", start) + 1])


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    score_path, raw_path, output_path = map(Path, sys.argv[1:])
    score = json.loads(score_path.read_text())
    duration = score["bars"] * score["beatsPerBar"] * 60 / score["bpm"] + score["tailSeconds"]
    fades = f"afade=t=in:d=1.2,afade=t=out:st={duration - 4:.6f}:d=4"
    target = "loudnorm=I=-19:TP=-2:LRA=11"
    first = measure(["-i", str(raw_path), "-af", f"{fades},{target}:print_format=json", "-f", "null", "-"])
    normalization = (
        f"{target}:measured_I={first['input_i']}:measured_TP={first['input_tp']}"
        f":measured_LRA={first['input_lra']}:measured_thresh={first['input_thresh']}"
        f":offset={first['target_offset']}:linear=true:print_format=json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    second = measure([
        "-y", "-i", str(raw_path), "-af", f"{fades},{normalization}",
        "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-q:a", "2",
        "-metadata", f"title={score['title']}",
        "-metadata", f"album=LAST MILE - Music Auditions {output_path.parent.name}",
        "-metadata", "comment=Original instrumental prototype; virtual instruments; audition only",
        str(output_path),
    ])
    encoded = measure([
        "-i", str(output_path), "-af", f"{target}:print_format=json", "-f", "null", "-",
    ])
    if not -20.0 < float(encoded["input_i"]) < -18.0:
        raise RuntimeError(f"Unexpected final loudness: {encoded['input_i']} LUFS")
    if float(encoded["input_tp"]) > -1.5:
        raise RuntimeError(f"Unexpected final true peak: {encoded['input_tp']} dBTP")
    report = {
        "score": score_path.name, "audio": output_path.name,
        "durationSeconds": round(duration, 3), "sampleRate": 48000,
        "channels": 2, "codec": "MP3 VBR quality 2",
        "normalization": second["normalization_type"],
        "integratedLoudnessLUFS": float(encoded["input_i"]),
        "truePeakDBTP": float(encoded["input_tp"]),
        "loudnessRangeLU": float(encoded["input_lra"]),
        "fadeInSeconds": 1.2, "fadeOutSeconds": 4,
    }
    output_path.with_suffix(".mix.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
