import {highlightAeon} from './index.js';
import {darkVariables, lightVariables, tokenStyles} from './themes.js';

const shellStyles = `
:host { display:block; min-width:0; ${darkVariables} color:var(--aeon-fg); }
:host([theme="light"]) { ${lightVariables} }
.frame { border:1px solid var(--aeon-border); background:var(--aeon-bg); }
.header { display:flex; align-items:center; justify-content:space-between; gap:1rem;
  padding:.65rem .8rem; border-bottom:1px solid var(--aeon-border); background:var(--aeon-panel); }
.title, button { font:inherit; }
button { color:var(--aeon-fg); background:var(--aeon-bg); border:1px solid var(--aeon-border);
  padding:.25rem .55rem; cursor:pointer; }
button:focus-visible { outline:2px solid var(--aeon-key); outline-offset:2px; }
[hidden] { display:none; }
pre { margin:0; padding:.8rem; overflow:auto; tab-size:2; white-space:pre;
  font: .78rem/1.45 "IBM Plex Mono", "SFMono-Regular", Consolas, monospace; }
code { font:inherit; }
${tokenStyles}`;

export interface AeonCodeBlockElement extends HTMLElement { code: string; }
export type AeonCodeBlockConstructor = new () => AeonCodeBlockElement;
const ownedDefinitions = new WeakSet<CustomElementConstructor>();

/** Explicit registration. Importing this module has no DOM side effects. */
export function defineAeonCodeBlock(tagName = 'aeon-code-block'): AeonCodeBlockConstructor {
    if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') {
        throw new Error('defineAeonCodeBlock requires a browser with custom elements.');
    }
    const existing = customElements.get(tagName);
    if (existing) {
        if (!ownedDefinitions.has(existing)) throw new Error(`Custom element ${tagName} is already defined by another implementation.`);
        return existing as AeonCodeBlockConstructor;
    }
    class AeonCodeBlock extends HTMLElement {
        static get observedAttributes(): string[] { return ['title', 'show-copy', 'code']; }
        private sourceOverride: string | undefined;
        private readonly codeElement: HTMLElement;
        private readonly titleElement: HTMLElement;
        private readonly copyButton: HTMLButtonElement;
        private readonly status: HTMLElement;
        private readonly observer: MutationObserver;
        private readonly templateObserver: MutationObserver;
        private observedTemplate: DocumentFragment | null = null;
        constructor() {
            super();
            const shadow = this.attachShadow({mode: 'open'});
            const style = document.createElement('style'); style.textContent = shellStyles;
            const frame = document.createElement('div'); frame.className = 'frame';
            const header = document.createElement('div'); header.className = 'header';
            this.titleElement = document.createElement('span'); this.titleElement.className = 'title';
            this.copyButton = document.createElement('button'); this.copyButton.type = 'button';
            this.copyButton.textContent = 'Copy'; this.copyButton.setAttribute('aria-label', 'Copy AEON source');
            this.status = document.createElement('span'); this.status.setAttribute('role', 'status');
            const pre = document.createElement('pre');
            this.codeElement = document.createElement('code'); pre.append(this.codeElement);
            header.append(this.titleElement, this.copyButton, this.status); frame.append(header, pre);
            shadow.append(style, frame);
            this.copyButton.addEventListener('click', () => { void this.copySource(); });
            this.observer = new MutationObserver(() => this.render());
            this.templateObserver = new MutationObserver(() => this.render());
        }
        /** Exact authored source; assigning it does not rewrite light DOM. */
        get code(): string { return this.readSource().text; }
        private readSource(): {text: string; template: DocumentFragment | null} {
            if (this.sourceOverride !== undefined) return {text: this.sourceOverride, template: null};
            const attribute = this.getAttribute('code');
            if (attribute !== null) return {text: attribute, template: null};
            const script = this.querySelector('script[type="text/plain"]');
            if (script) return {text: script.textContent ?? '', template: null};
            const template = this.querySelector('template');
            if (template instanceof HTMLTemplateElement) {
                return {text: template.content.textContent ?? '', template: template.content};
            }
            return {text: this.textContent ?? '', template: null};
        }
        set code(source: string) { this.sourceOverride = source; this.render(); }
        connectedCallback(): void {
            this.observer.observe(this, {childList: true, characterData: true, subtree: true,
                attributes: true, attributeFilter: ['type']});
            this.render();
        }
        disconnectedCallback(): void {
            this.observer.disconnect();
            this.templateObserver.disconnect();
            this.observedTemplate = null;
        }
        attributeChangedCallback(): void { this.render(); }
        private render(): void {
            const source = this.readSource();
            const template = this.isConnected ? source.template : null;
            if (template !== this.observedTemplate) {
                this.templateObserver.disconnect();
                this.observedTemplate = template;
                if (template) this.templateObserver.observe(template,
                    {childList: true, characterData: true, subtree: true});
            }
            this.titleElement.textContent = this.getAttribute('title') ?? 'Code';
            this.copyButton.hidden = this.getAttribute('show-copy') === 'false';
            this.codeElement.innerHTML = highlightAeon(source.text);
            this.status.textContent = '';
        }
        private async copySource(): Promise<void> {
            try { await navigator.clipboard.writeText(this.code); this.status.textContent = 'Copied'; }
            catch { this.status.textContent = 'Copy unavailable'; }
        }
    }
    customElements.define(tagName, AeonCodeBlock);
    ownedDefinitions.add(AeonCodeBlock);
    return AeonCodeBlock;
}
