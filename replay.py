import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple


ALLOWED_STEP_TYPES = {
    "navigate",
    "click",
    "type",
    "change",
    "select",
    "scroll",
    "wait",
    "submit",
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
        elif stype == "submit":
            if not _is_selector_list(step.get("formSelectors")):
                errors.append(f"{prefix}.formSelectors must be a non-empty selector list.")

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


def segment_by_navigation(trace: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
    steps = sorted(trace.get("steps", []), key=lambda s: s.get("ts", 0))
    start_url = trace.get("startUrl")
    # Find first navigate url if no startUrl
    if not start_url:
        for s in steps:
            if s.get("type") == "navigate" and isinstance(s.get("url"), str):
                start_url = s["url"]
                break
    # Build segments: [(url, [steps_without_navigate])]
    segments: List[Dict[str, Any]] = []
    current_url = start_url
    current_steps: List[Dict[str, Any]] = []
    for s in steps:
        if s.get("type") == "navigate" and isinstance(s.get("url"), str):
            # flush current segment
            if current_steps:
                segments.append({"url": current_url, "steps": current_steps})
                current_steps = []
            current_url = s["url"]
            continue
        current_steps.append(s)
    if current_steps:
        segments.append({"url": current_url, "steps": current_steps})
    return start_url or "about:blank", segments


def rebase_steps(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not steps:
        return []
    base = steps[0].get("ts", 0) or 0
    rebased = []
    for s in steps:
        s2 = dict(s)
        s2["ts"] = (s.get("ts", 0) or 0) - base
        rebased.append(s2)
    return rebased


def run_playback(trace: Dict[str, Any], verbose: bool = False) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        print("Playwright is required. Install with: pip install playwright && playwright install", file=sys.stderr)
        print(f"Import error: {e}", file=sys.stderr)
        return 2

    # Load reusable replayer script from the extension folder
    here = os.path.dirname(os.path.abspath(__file__))
    replayer_path = os.path.join(here, "extension", "shared", "replayer.js")
    if not os.path.exists(replayer_path):
        print(f"Could not find replayer script at {replayer_path}", file=sys.stderr)
        return 2
    with open(replayer_path, "r", encoding="utf-8") as f:
        replayer_js = f.read()

    progress_js = """
      (function(){
        try {
          window.addEventListener('message', function(ev){
            var d = ev && ev.data; if (!d || !d.__altera) return;
            try { console.log('[altera] ' + JSON.stringify(d)); } catch {}
            if (d.kind === 'state' && (d.state === 'finished' || d.state === 'stopped')) {
              window.__alteraDone = true;
            }
          });
        } catch (e) {}
      })();
    """

    start_url, segments = segment_by_navigation(trace)
    if not start_url:
        start_url = "about:blank"

    if verbose:
        print(f"Starting URL: {start_url}")
        print(f"Segments: {len(segments)}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        # Ensure scripts are injected on every navigation (CSP-safe)
        page.add_init_script(script=replayer_js)
        page.add_init_script(script=progress_js)

        # Verbose console relay
        console_handler = None
        if verbose:
            def on_console(msg):
                try:
                    # Playwright versions differ: text may be a property or a method
                    txt_attr = getattr(msg, "text", None)
                    txt = txt_attr() if callable(txt_attr) else (txt_attr if isinstance(txt_attr, str) else str(msg))
                except Exception:
                    txt = str(msg)
                if isinstance(txt, str) and txt.startswith('[altera]'):
                    print(txt)
            console_handler = on_console
            page.on("console", console_handler)

        # Navigate to the first URL
        page.goto(start_url, wait_until="load")
        # UX: give the page a moment to settle resources
        page.wait_for_timeout(1000)

        # Play each segment (rebased timestamps)
        for idx, seg in enumerate(segments):
            if seg.get("url") and page.url != seg["url"]:
                if verbose:
                    print(f"Navigating to segment[{idx}] URL: {seg['url']}")
                page.goto(seg["url"], wait_until="load")
            steps = rebase_steps(seg.get("steps", []))
            if not steps:
                continue
            if verbose:
                print(f"Playing segment[{idx}] with {len(steps)} steps")
                # Pretty-print the schedule: "  3.40s - type"
                last_ts = steps[-1].get("ts", 0) if steps else 0
                # width includes "s" at end
                width = max(len(f"{(last_ts/1000):.2f}s"), 7)
                for s in steps:
                    t_sec = f"{(s.get('ts', 0)/1000):.2f}s"
                    t_field = t_sec.rjust(width)
                    name = s.get("type", "unknown")
                    print(f"  {t_field} - {name}")
            # Execute controlled replay in-page and wait for it to finish
            result = page.evaluate(
                "trace => (window.AlteraReplayer ? window.AlteraReplayer.replay(trace, { realTime: true, speed: 1.0 }) : { ok:false, error:'replayer missing' })",
                {"steps": steps},
            )
            if verbose:
                print(f"Segment[{idx}] result: {result}")

        if verbose:
            print("All segments played.")
        # UX: Keep the browser open until the user chooses to exit
        print("Replay complete. Browser will remain open. Press Enter to close and exit...")
        try:
            input()
        except (KeyboardInterrupt, EOFError):
            pass
        finally:
            try:
                if console_handler is not None:
                    # Best-effort detach to avoid teardown errors
                    page.off("console", console_handler)  # type: ignore[attr-defined]
            except Exception:
                pass
            try:
                browser.close()
            except Exception:
                pass
        return 0


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Replay an action trace in Chromium using Playwright.")
    parser.add_argument("--file", required=True, help="Path to the trace JSON file.")
    parser.add_argument("-v", action="store_true", dest="verbose", help="Verbose: print replay progress.")
    args = parser.parse_args(argv)

    if not os.path.exists(args.file):
        print(f"Trace file not found: {args.file}", file=sys.stderr)
        return 2

    try:
        trace = load_trace(args.file)
    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON: {e}", file=sys.stderr)
        return 2

    errors = validate_trace_structure(trace)
    if errors:
        print("Trace validation failed:")
        for err in errors:
            print(f"- {err}")
        return 1

    # Normalize timestamps to ensure non-decreasing and relative
    normalize_timestamps(trace)
    return run_playback(trace, verbose=args.verbose)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
