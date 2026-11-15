document.addEventListener("DOMContentLoaded", () => {
  if (!window.AeonWebHighlight) {
    return;
  }

  window.AeonWebHighlight.renderStaticBlocks();

  let runtimeReady = null;

  function loadRuntime() {
    if (!runtimeReady) {
      runtimeReady = import("@aeon/runtime").catch((error) => ({ error }));
    }
    return runtimeReady;
  }

  function diagnosticLine(diagnostic) {
    const label = diagnostic?.level === "warning" ? "Warning" : "Issue";
    const code = diagnostic?.code ? `${diagnostic.code}: ` : "";
    return `${label}: ${code}${diagnostic?.message ?? "Unable to validate source."}`;
  }

  function setStatus(status, message, state = "neutral") {
    status.textContent = message;
    status.dataset.state = state;
  }

  async function verifyEditor(textarea, status, requestIdRef) {
    const requestId = ++requestIdRef.current;
    setStatus(status, "Checking...");

    try {
      const runtime = await loadRuntime();
      if (requestId !== requestIdRef.current) {
        return;
      }
      if (runtime.error) {
        throw runtime.error;
      }

      const result = runtime.runRuntime(textarea.value, {
        mode: "loose",
        datatypePolicy: "reserved_only",
        includeAnnotations: true,
        output: "json"
      });
      const issue = result.meta?.errors?.[0] ?? result.meta?.warnings?.[0] ?? null;
      setStatus(
        status,
        issue ? diagnosticLine(issue) : "No issues detected.",
        issue ? "issue" : "ok"
      );
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setStatus(status, error instanceof Error ? `Issue: ${error.message}` : `Issue: ${String(error)}`, "issue");
    }
  }

  document.querySelectorAll("[data-aeon-editor]").forEach((editor) => {
    const textarea = editor.querySelector("textarea");
    const backdrop = editor.querySelector(".highlight-backdrop");
    if (!textarea || !backdrop) {
      return;
    }

    window.AeonWebHighlight.attachHighlightEditor(textarea, backdrop);

    if (!editor.hasAttribute("data-aeon-verify")) {
      return;
    }

    const status = editor.closest(".walkthrough-editor-card")?.querySelector("[data-aeon-editor-status]");
    if (!status) {
      return;
    }

    const requestIdRef = { current: 0 };
    const scheduleVerify = () => {
      window.clearTimeout(editor._aeonVerifyTimer);
      editor._aeonVerifyTimer = window.setTimeout(() => {
        verifyEditor(textarea, status, requestIdRef);
      }, 160);
    };

    textarea.addEventListener("input", scheduleVerify);
    verifyEditor(textarea, status, requestIdRef);
  });
});
