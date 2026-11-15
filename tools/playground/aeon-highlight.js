import * as lexer from '@aeon/lexer';
import {createAeonHighlighter} from './aeon-token-highlight.mjs';
import {highlightJson} from './presentation-highlight.mjs';

const {highlightAeon} = createAeonHighlighter(lexer);

function attachHighlightEditor(textarea, backdrop) {
  const editor = textarea.closest(".highlight-editor");
  let gutter = editor?.querySelector(".highlight-line-numbers") ?? null;
  if (editor && !gutter) {
    gutter = document.createElement("div");
    gutter.className = "highlight-line-numbers";
    gutter.setAttribute("aria-hidden", "true");
    editor.insertBefore(gutter, editor.firstChild);
  }

  const sync = () => {
    const code = backdrop.querySelector("code");
    const diagnosticLine = Number.parseInt(textarea.dataset.aeonDiagnosticLine ?? "", 10);
    const diagnosticColumn = Number.parseInt(textarea.dataset.aeonDiagnosticColumn ?? "", 10);
    code.innerHTML = highlightAeon(
      textarea.value,
      Number.isInteger(diagnosticLine) && diagnosticLine > 0 ? diagnosticLine : null,
      Number.isInteger(diagnosticColumn) && diagnosticColumn > 0 ? diagnosticColumn : 1
    ) + "\n";
    if (gutter) {
      const lineCount = Math.max(1, textarea.value.split("\n").length);
      gutter.innerHTML = Array.from({ length: lineCount }, (_, index) => {
        const line = index + 1;
        const className = line === diagnosticLine ? ' class="has-diagnostic"' : "";
        return `<span${className}>${line}</span>`;
      }).join("");
    }
  };

  textarea.addEventListener("input", sync);
  textarea.addEventListener("aeon:diagnostic-change", sync);
  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
    if (gutter) {
      gutter.scrollTop = textarea.scrollTop;
    }
  });

  sync();
}

function setEditorDiagnosticLine(textarea, line, column = null) {
  if (Number.isInteger(line) && line > 0) {
    textarea.dataset.aeonDiagnosticLine = String(line);
    if (Number.isInteger(column) && column > 0) {
      textarea.dataset.aeonDiagnosticColumn = String(column);
    } else {
      delete textarea.dataset.aeonDiagnosticColumn;
    }
  } else {
    delete textarea.dataset.aeonDiagnosticLine;
    delete textarea.dataset.aeonDiagnosticColumn;
  }
  textarea.dispatchEvent(new Event("aeon:diagnostic-change"));
}

function renderStaticBlocks() {
  document.querySelectorAll("[data-aeon-static]").forEach((block) => {
    block.innerHTML = highlightAeon(block.textContent || "") + "\n";
  });
}

window.AeonWebHighlight = {
  highlightAeon,
  highlightJson,
  attachHighlightEditor,
  setEditorDiagnosticLine,
  renderStaticBlocks
};
