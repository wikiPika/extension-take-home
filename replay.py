import argparse
import json
import os
import sys
from typing import Any, Dict, List


ALLOWED_STEP_TYPES = {
    "navigate",
    "click",
    "type",
    "change",
    "select",
    "scroll",
    "wait",
}


def load_trace(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _is_selector_list(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    for item in value:
        if isinstance(item, str):
            continue
        if not isinstance(item, dict):
            return False
        if item.get("type") not in {"css", "text", "aria", "xpath"}:
            return False
        if not isinstance(item.get("value"), str):
            return False
    return True


def validate_trace_structure(trace: Dict[str, Any]) -> List[str]:
    errors: List[str] = []

    if not isinstance(trace, dict):
        return ["Trace must be a JSON object."]

    # Top-level checks
    if not isinstance(trace.get("version"), str):
        errors.append("Top-level 'version' must be a string.")
    if not isinstance(trace.get("createdAt"), str):
        errors.append("Top-level 'createdAt' must be an ISO string.")
    if "steps" not in trace or not isinstance(trace["steps"], list):
        errors.append("Top-level 'steps' must be an array.")

    steps = trace.get("steps", [])
    for idx, step in enumerate(steps):
        prefix = f"steps[{idx}]"
        if not isinstance(step, dict):
            errors.append(f"{prefix} must be an object.")
            continue
        stype = step.get("type")
        if stype not in ALLOWED_STEP_TYPES:
            errors.append(f"{prefix}.type must be one of {sorted(ALLOWED_STEP_TYPES)}.")
        if not isinstance(step.get("ts"), (int, float)):
            errors.append(f"{prefix}.ts (relative ms) must be a number.")

        # Per-type required fields
        if stype == "navigate":
            if not isinstance(step.get("url"), str):
                errors.append(f"{prefix}.url must be a string.")
        elif stype == "click":
            if not _is_selector_list(step.get("selectors")):
                errors.append(f"{prefix}.selectors must be a non-empty selector list.")
        elif stype == "type":
            if not _is_selector_list(step.get("selectors")):
                errors.append(f"{prefix}.selectors must be a non-empty selector list.")
            if not isinstance(step.get("text"), str):
                errors.append(f"{prefix}.text must be a string.")
        elif stype == "change":
            if not _is_selector_list(step.get("selectors")):
                errors.append(f"{prefix}.selectors must be a non-empty selector list.")
            if "value" not in step:
                errors.append(f"{prefix}.value is required.")
        elif stype == "select":
            if not _is_selector_list(step.get("selectors")):
                errors.append(f"{prefix}.selectors must be a non-empty selector list.")
            val = step.get("value")
            if not (isinstance(val, str) or (isinstance(val, list) and all(isinstance(v, str) for v in val))):
                errors.append(f"{prefix}.value must be a string or array of strings.")
        elif stype == "scroll":
            target = step.get("target")
            if target not in {"window", "element"}:
                errors.append(f"{prefix}.target must be 'window' or 'element'.")
            if not isinstance(step.get("x"), (int, float)) or not isinstance(step.get("y"), (int, float)):
                errors.append(f"{prefix}.x and .y must be numbers.")
            if target == "element" and not _is_selector_list(step.get("selectors")):
                errors.append(f"{prefix}.selectors must be a non-empty selector list for element scroll.")
        elif stype == "wait":
            wait_for = step.get("for")
            if not isinstance(wait_for, dict):
                errors.append(f"{prefix}.for must be an object.")
            else:
                if not any(k in wait_for for k in ("selector", "url", "ms", "networkIdle")):
                    errors.append(f"{prefix}.for must include one of selector/url/ms/networkIdle.")

    return errors


def normalize_timestamps(trace: Dict[str, Any]) -> Dict[str, Any]:
    steps = trace.get("steps", [])
    if not steps:
        return trace
    # If timestamps look absolute or simply not starting at 0, shift so first step is 0.
    first_ts = steps[0].get("ts")
    if not isinstance(first_ts, (int, float)):
        return trace
    # Heuristic: if any ts > ~year 2001 epoch ms threshold, consider absolute.
    looks_absolute = any(isinstance(s.get("ts"), (int, float)) and s["ts"] > 1_000_000_000_000 for s in steps)
    shift = first_ts if first_ts != 0 else (steps[0]["ts"] if looks_absolute else 0)
    if shift:
        for s in steps:
            if isinstance(s.get("ts"), (int, float)):
                s["ts"] = s["ts"] - shift
        trace["_normalizedTsShift"] = shift
    # Ensure non-decreasing order; if not, sort by ts but preserve stable order for ties.
    if any(steps[i]["ts"] > steps[i+1]["ts"] for i in range(len(steps)-1)):
        steps.sort(key=lambda s: s.get("ts", 0))
        trace["_sortedByTs"] = True
    return trace


def summarize_trace(trace: Dict[str, Any]) -> str:
    steps = trace.get("steps", [])
    counts: Dict[str, int] = {}
    for s in steps:
        t = s.get("type", "unknown")
        counts[t] = counts.get(t, 0) + 1
    parts = [f"Total steps: {len(steps)}"]
    for t in sorted(counts):
        parts.append(f"  - {t}: {counts[t]}")
    return "\n".join(parts)


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate and summarize an action trace JSON.")
    parser.add_argument(
        "--trace",
        default=os.path.join("traces", "sample.json"),
        help="Path to the trace JSON file.",
    )
    args = parser.parse_args(argv)

    if not os.path.exists(args.trace):
        print(f"Trace file not found: {args.trace}", file=sys.stderr)
        return 2

    try:
        trace = load_trace(args.trace)
    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON: {e}", file=sys.stderr)
        return 2

    errors = validate_trace_structure(trace)
    if errors:
        print("Trace validation failed:")
        for err in errors:
            print(f"- {err}")
        return 1

    # Normalize timestamps relative to the first step.
    normalized = normalize_timestamps(trace)
    if normalized.get("_normalizedTsShift"):
        print(f"Note: normalized timestamps by subtracting {int(normalized['_normalizedTsShift'])} ms.")
    if normalized.get("_sortedByTs"):
        print("Note: steps were sorted by timestamp to be non-decreasing.")

    print("Trace looks valid.\n")
    print(summarize_trace(trace))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
