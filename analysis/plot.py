"""Summary and charts for a run-experiment.mjs JSONL file.
Usage: python plot.py <results.jsonl> [--out <dir>]
"""
import argparse
import json
import statistics as st
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

BLUE, INK, MUTED, GRID = "#2a78d6", "#0b0b0b", "#52514e", "#e4e3df"
plt.rcParams.update({
    "font.family": "serif", "font.size": 8, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
    "xtick.color": MUTED, "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
})
SIZE = (4.8, 2.4)


def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def stats(xs):
    return {"mean": st.mean(xs), "median": st.median(xs), "p95": pct(xs, 95),
            "min": min(xs), "max": max(xs), "stdev": st.stdev(xs) if len(xs) > 1 else 0.0}


def save(fig, out, name):
    fig.tight_layout()
    fig.savefig(out / f"{name}.pdf")
    fig.savefig(out / f"{name}.png", dpi=200)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("--out")
    a = ap.parse_args()
    src = Path(a.jsonl)
    out = Path(a.out) if a.out else src.with_suffix("")
    out.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(l) for l in src.read_text().splitlines() if l.strip()]
    ok = [r for r in rows if r.get("ok")]
    meas = [r for r in ok if not r.get("warmup")]
    if not meas:
        raise SystemExit("no successful measured runs")

    lat = [r["latency"]["a_to_b_ms"] / 1000 for r in meas]
    e2e = [r["latency"]["submit_to_b_ms"] / 1000 for r in meas]
    chain = [r["latency"]["onchain_a_to_b_ms"] / 1000 for r in meas]
    relay = [r["latency"]["relay_blocks"] for r in meas]
    parab = [r["latency"]["para_b_blocks"] for r in meas]
    unit = 1e12  # tokenDecimals = 12 in the chain specs

    summary = {
        "runs": len(rows), "successful": len(ok), "success_rate": len(ok) / len(rows),
        "measured_runs": len(meas), "failures": [{"run": r["run"], "error": r.get("error")} for r in rows if not r.get("ok")],
        "latency_a_to_b_s": stats(lat), "latency_submit_to_b_s": stats(e2e), "latency_onchain_a_to_b_s": stats(chain),
        "relay_blocks": stats(relay), "para_b_blocks": stats(parab),
        "tx_fee_a": stats([int(r["para_a"]["tx_fee"]) / unit for r in meas]),
        "delivery_fee_a": stats([int(r["para_a"]["delivery_fee"]) / unit for r in meas]),
        "cost_b": stats([int(r["para_b"]["cost"]) / unit for r in meas]),
        "weight_ref_time_b": stats([int(r["para_b"]["weight_ref_time"]) for r in meas if r["para_b"]["weight_ref_time"]]),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2))

    lines = ["| Metric | Mean | Median | P95 | Min | Max |", "|---|---|---|---|---|---|"]
    for k, label in [("latency_a_to_b_s", "Latency A→B (s)"), ("latency_submit_to_b_s", "Submit→B (s)"),
                     ("latency_onchain_a_to_b_s", "On-chain A→B (s)"), ("relay_blocks", "Relay blocks"),
                     ("para_b_blocks", "Para B blocks"), ("tx_fee_a", "Tx fee A (UNIT)"),
                     ("delivery_fee_a", "Delivery fee A (UNIT)"), ("cost_b", "Cost B (UNIT)")]:
        s = summary[k]
        lines.append(f"| {label} | {s['mean']:.4g} | {s['median']:.4g} | {s['p95']:.4g} | {s['min']:.4g} | {s['max']:.4g} |")
    head = f"Runs: {len(rows)}, successful: {len(ok)} ({summary['success_rate']:.0%}), measured: {len(meas)}\n\n"
    (out / "summary.md").write_text(head + "\n".join(lines) + "\n")

    runs = [r["run"] for r in meas]
    fig, ax = plt.subplots(figsize=SIZE)
    ax.plot(runs, lat, color=BLUE, linewidth=2, marker="o", markersize=4)
    med = st.median(lat)
    ax.axhline(med, color=MUTED, linewidth=1, linestyle="--")
    ax.annotate(f"median {med:.1f} s", (runs[-1], med), xytext=(0, 4), textcoords="offset points", ha="right", color=MUTED)
    ax.set_xlabel("Run")
    ax.xaxis.set_major_locator(MaxNLocator(integer=True))
    ax.set_ylabel("Latency A→B (s)")
    ax.set_ylim(0, max(lat) * 1.25)
    save(fig, out, "latency_per_run")

    fig, ax = plt.subplots(figsize=SIZE)
    lo, hi = int(min(lat)), int(max(lat)) + 1
    bins = [lo + i * 0.25 for i in range(int((hi - lo) / 0.25) + 1)]
    ax.hist(lat, bins=bins, color=BLUE, edgecolor="white", linewidth=1)
    ax.set_xlabel("Latency A→B (s)")
    ax.set_ylabel("Runs")
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    save(fig, out, "latency_distribution")

    fig, ax = plt.subplots(figsize=SIZE)
    c = Counter(relay)
    xs = sorted(c)
    ax.bar(xs, [c[x] for x in xs], color=BLUE, width=0.5, edgecolor="white", linewidth=1)
    for x in xs:
        ax.annotate(str(c[x]), (x, c[x]), xytext=(0, 2), textcoords="offset points", ha="center", color=INK)
    ax.set_xticks(range(min(xs) - 1, max(xs) + 2))
    ax.set_xlim(min(xs) - 1.5, max(xs) + 1.5)
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.set_xlabel("Relay chain blocks between Para A inclusion and Para B execution")
    ax.set_ylabel("Runs")
    ax.grid(axis="x", visible=False)
    save(fig, out, "relay_blocks")

    print(head + "\n".join(lines))
    print(f"\nWritten to {out}/")


if __name__ == "__main__":
    main()
