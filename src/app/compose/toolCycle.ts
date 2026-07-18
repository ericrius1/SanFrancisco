// Click-tool selection + cycling. Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md: the active click-tool is circularly coupled with
// the Toolbar (whose constructor calls back into setTool) and with fetchBall
// (null until it is built after Corona Heights). Owning `tool` here and reading
// the toolbar / fetchBall through late-bound getters breaks that cycle without
// captured-let ordering games — the getters resolve at call time, long after
// both objects exist.
import { TOOL_ORDER, TOOL_VERB, type ToolName } from "../../ui/toolbar";
import type { Toolbar } from "../../ui/toolbar";
import type { HUD } from "../../ui/hud";
import type { FetchBall } from "../../gameplay/fetchBall";

export function createToolCycle({
  hud,
  getToolbar,
  getFetchBall,
  ensurePaintAudio,
  ensureBubbleAudio
}: {
  hud: HUD;
  /** Late-bound: the Toolbar constructor calls setTool, so it cannot be a
   * constructor argument here without a captured-let cycle. */
  getToolbar: () => Toolbar;
  /** Late-bound: fetchBall is built after Corona Heights, but setTool("ball")
   * runs during boot before it exists. Optional-chained until then. */
  getFetchBall: () => FetchBall | null;
  ensurePaintAudio: () => void;
  ensureBubbleAudio: () => void;
}): {
  readonly tool: ToolName;
  setTool: (t: ToolName) => void;
  /** Ctrl+digit: focus the tool row and select the Nth tool (no-op past the
   * end). Returns nothing; the caller always `continue`s the digit loop. */
  pickByIndex: (index: number) => void;
  /** setTool ran before fetchBall existed — re-assert the held prop once it is
   * built so the ball tool's throw prop matches the active tool. */
  syncHeldProp: () => void;
} {
  let tool: ToolName = "ball";
  const setTool = (t: ToolName) => {
    tool = t;
    if (t === "spray") void ensurePaintAudio();
    else if (t === "bubbles") void ensureBubbleAudio();
    getToolbar().setTool(t);
    hud.setToolVerb(TOOL_VERB[t]);
    // ball tool → hold-to-throw prop; leaving it hides the prop, but free balls,
    // in-flight fetch + pet follow keep running because fetchBall.update runs every frame
    getFetchBall()?.setActive(t === "ball");
  };
  return {
    get tool() {
      return tool;
    },
    setTool,
    pickByIndex: (index: number) => {
      const nextTool = TOOL_ORDER[index];
      if (!nextTool) return;
      getToolbar().focusTools();
      setTool(nextTool);
    },
    syncHeldProp: () => {
      getFetchBall()?.setActive(tool === "ball");
    }
  };
}
